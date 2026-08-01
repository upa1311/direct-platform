/**
 * Pure core of the driver's offline / connection-recovery model. Everything here
 * is a pure function/reducer with no DOM access, so it is fully testable in
 * node:test.
 *
 * Scope is honest: `navigator.onLine` is only the browser's network signal, not
 * proof of a working production backend, and "refresh" is a READ of the existing
 * authoritative persisted state (revision/updatedAt) — never a domain mutation.
 * Connection status is tab-local browser runtime state and is NEVER stored in
 * PrototypeState. Blocked actions are never buffered and never re-run
 * automatically — the driver simply re-triggers them once ONLINE.
 */

export type DriverConnectionStatus =
  | "INITIALIZING"
  | "ONLINE"
  | "OFFLINE"
  | "RECOVERING"
  | "DEGRADED";

// The refresh result lives with the persisted-state store; re-exported here so
// connection consumers have one import site.
export type { PrototypeRefreshResult } from "./prototype-store";
import type { PrototypeRefreshResult } from "./prototype-store";

export interface DriverConnectionState {
  status: DriverConnectionStatus;
  lastKnownRevision: number | null;
  lastStateUpdatedAt: string | null;
}

export const INITIAL_DRIVER_CONNECTION_STATE: DriverConnectionState = {
  status: "INITIALIZING",
  lastKnownRevision: null,
  lastStateUpdatedAt: null,
};

export type DriverConnectionEvent =
  | { type: "HYDRATED"; online: boolean }
  | { type: "BROWSER_OFFLINE" }
  | { type: "BROWSER_ONLINE" }
  | { type: "REFRESH_SUCCEEDED"; revision: number; updatedAt: string }
  | { type: "REFRESH_FAILED" }
  | { type: "RETRY" };

/**
 * Pure state machine. Key fail-closed rules:
 *  - a browser `offline` signal always wins → OFFLINE;
 *  - ONLINE is reachable ONLY via a successful refresh (never from a raw browser
 *    signal), and never while the browser is offline;
 *  - a failed refresh → DEGRADED (unless already OFFLINE);
 *  - `online`/`RETRY`/hydration-while-online move to RECOVERING, where actions
 *    stay blocked until the refresh confirms actuality.
 */
export function driverConnectionReducer(
  state: DriverConnectionState,
  event: DriverConnectionEvent,
): DriverConnectionState {
  switch (event.type) {
    case "HYDRATED":
      if (state.status !== "INITIALIZING") return state;
      return { ...state, status: event.online ? "RECOVERING" : "OFFLINE" };
    case "BROWSER_OFFLINE":
      return state.status === "OFFLINE" ? state : { ...state, status: "OFFLINE" };
    case "BROWSER_ONLINE":
    case "RETRY":
      return state.status === "RECOVERING" ? state : { ...state, status: "RECOVERING" };
    case "REFRESH_SUCCEEDED":
      // A refresh that lands after the browser went offline must not claim ONLINE;
      // we still record the confirmed revision/time we managed to read.
      if (state.status === "OFFLINE") {
        return {
          ...state,
          lastKnownRevision: event.revision,
          lastStateUpdatedAt: event.updatedAt,
        };
      }
      return {
        status: "ONLINE",
        lastKnownRevision: event.revision,
        lastStateUpdatedAt: event.updatedAt,
      };
    case "REFRESH_FAILED":
      return state.status === "OFFLINE" ? state : { ...state, status: "DEGRADED" };
    default:
      return state;
  }
}

export interface DriverConnectionView {
  status: DriverConnectionStatus;
  /** Driver mutations are allowed ONLY when fully ONLINE. */
  canMutate: boolean;
  lastKnownRevision: number | null;
  lastStateUpdatedAt: string | null;
  message: string;
}

const STATUS_MESSAGE: Record<DriverConnectionStatus, string> = {
  INITIALIZING: "Проверяем соединение…",
  ONLINE: "На связи",
  OFFLINE: "Нет соединения",
  RECOVERING: "Восстанавливаем связь",
  DEGRADED: "Не удалось обновить данные",
};

export function getDriverConnectionView(
  state: DriverConnectionState,
): DriverConnectionView {
  return {
    status: state.status,
    canMutate: state.status === "ONLINE",
    lastKnownRevision: state.lastKnownRevision,
    lastStateUpdatedAt: state.lastStateUpdatedAt,
    message: STATUS_MESSAGE[state.status],
  };
}

// --- Runtime controller (pure over injected env/deps; no direct DOM) -----------

/** Minimal browser environment the controller needs (injectable for tests). */
export interface DriverConnectionEnv {
  addEventListener: (type: string, handler: () => void) => void;
  removeEventListener: (type: string, handler: () => void) => void;
  isOnline: () => boolean;
  isVisible: () => boolean;
}

export interface DriverConnectionDeps {
  dispatch: (event: DriverConnectionEvent) => void;
  refresh: () => Promise<PrototypeRefreshResult>;
}

export interface DriverConnectionController {
  start: () => void;
  stop: () => void;
  hydrate: () => void;
  retry: () => void;
}

/**
 * Wire browser events to the reducer via injected deps. Event-driven (no
 * aggressive polling): `offline`→OFFLINE, `online`→RECOVERING+refresh,
 * `focus`/`visibilitychange`(visible) while online → a silent freshness refresh.
 * Overlapping refreshes are prevented; after stop() no late async result mutates
 * state and all listeners are removed.
 */
export function createDriverConnectionController(
  env: DriverConnectionEnv,
  deps: DriverConnectionDeps,
): DriverConnectionController {
  let stopped = false;
  let refreshing = false;

  const runRefresh = (): void => {
    if (stopped || refreshing) return;
    // Fail-closed: never refresh (or reach ONLINE) while the browser is offline.
    // A successful persisted-state read is NOT proof of network connectivity.
    if (!env.isOnline()) {
      deps.dispatch({ type: "BROWSER_OFFLINE" });
      return;
    }
    refreshing = true;
    deps
      .refresh()
      .then((result) => {
        if (stopped) return;
        // The network may have dropped during the refresh — re-check right before
        // claiming ONLINE, so a stale success cannot flip state to ONLINE.
        if (!env.isOnline()) {
          deps.dispatch({ type: "BROWSER_OFFLINE" });
          return;
        }
        if (result.ok) {
          deps.dispatch({
            type: "REFRESH_SUCCEEDED",
            revision: result.revision,
            updatedAt: result.updatedAt,
          });
        } else {
          deps.dispatch({ type: "REFRESH_FAILED" });
        }
      })
      .catch(() => {
        if (stopped) return;
        deps.dispatch(
          env.isOnline() ? { type: "REFRESH_FAILED" } : { type: "BROWSER_OFFLINE" },
        );
      })
      .finally(() => {
        refreshing = false;
      });
  };

  const onOffline = (): void => {
    if (stopped) return;
    deps.dispatch({ type: "BROWSER_OFFLINE" });
  };
  const onOnline = (): void => {
    if (stopped) return;
    deps.dispatch({ type: "BROWSER_ONLINE" });
    runRefresh();
  };
  const onFocus = (): void => {
    if (stopped) return;
    if (env.isOnline()) runRefresh();
  };
  const onVisibility = (): void => {
    if (stopped) return;
    if (env.isVisible() && env.isOnline()) runRefresh();
  };

  return {
    start() {
      env.addEventListener("offline", onOffline);
      env.addEventListener("online", onOnline);
      env.addEventListener("focus", onFocus);
      env.addEventListener("visibilitychange", onVisibility);
    },
    stop() {
      stopped = true;
      env.removeEventListener("offline", onOffline);
      env.removeEventListener("online", onOnline);
      env.removeEventListener("focus", onFocus);
      env.removeEventListener("visibilitychange", onVisibility);
    },
    hydrate() {
      if (stopped) return;
      const online = env.isOnline();
      deps.dispatch({ type: "HYDRATED", online });
      if (online) runRefresh();
    },
    retry() {
      if (stopped) return;
      // Fail-closed: a retry while offline cannot reach ONLINE — reflect OFFLINE
      // and do not start a refresh.
      if (!env.isOnline()) {
        deps.dispatch({ type: "BROWSER_OFFLINE" });
        return;
      }
      deps.dispatch({ type: "RETRY" });
      runRefresh();
    },
  };
}
