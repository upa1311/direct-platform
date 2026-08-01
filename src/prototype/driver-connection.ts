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
  | { type: "REFRESH_STARTED" }
  | { type: "REFRESH_SUCCEEDED"; revision: number; updatedAt: string }
  | { type: "REFRESH_FAILED" }
  | { type: "RETRY" };

/**
 * Pure state machine. Key fail-closed rules:
 *  - a browser `offline` signal always wins → OFFLINE;
 *  - ONLINE is reachable ONLY via a successful refresh (never from a raw browser
 *    signal), and never while the browser is offline;
 *  - a failed refresh → DEGRADED (unless already OFFLINE);
 *  - `online`/`RETRY`/hydration-while-online AND any refresh start move to
 *    RECOVERING, where actions stay blocked until the refresh confirms actuality
 *    — so even a focus/visibility freshness refresh blocks mutations while it runs.
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
      // An explicit reconnect intent always moves to RECOVERING (from OFFLINE too).
      return state.status === "RECOVERING" ? state : { ...state, status: "RECOVERING" };
    case "REFRESH_STARTED":
      // A refresh start blocks mutations, but never overrides a live OFFLINE.
      if (state.status === "OFFLINE") return state;
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
 * `focus`/`visibilitychange`(visible) while online → a blocking freshness refresh
 * (RECOVERING while it runs, canMutate:false).
 *
 * A monotonic `generation` serializes reconnect: every `offline`/`online`/`retry`/
 * hydration bumps it. A refresh captures the generation at start; on completion it
 * dispatches SUCCEEDED/FAILED only when NOT stopped, still online AND the captured
 * generation is still current — so a refresh begun before a reconnect can never
 * confirm ONLINE afterwards (a stale completion is fully ignored). Refreshes never
 * run in parallel: a request during an in-flight refresh is coalesced into a
 * single follow-up (one boolean flag — NOT a buffer of driver actions) that runs
 * once the in-flight one settles, keeping status RECOVERING until a current
 * refresh succeeds. After stop() no late completion or follow-up mutates state
 * and all listeners are removed.
 */
export function createDriverConnectionController(
  env: DriverConnectionEnv,
  deps: DriverConnectionDeps,
): DriverConnectionController {
  let stopped = false;
  let generation = 0;
  let inFlight = false;
  let rerunRequired = false;

  /**
   * The single offline transition. Every place the controller observes
   * `env.isOnline() === false` funnels through here: it bumps the generation (so
   * any in-flight or coalesced refresh is invalidated and a stale completion can
   * never confirm ONLINE/DEGRADED), clears the coalesced follow-up flag, and
   * closes the mutation gate via BROWSER_OFFLINE.
   */
  const markOffline = (): void => {
    generation += 1;
    rerunRequired = false;
    deps.dispatch({ type: "BROWSER_OFFLINE" });
  };

  const startRefresh = (): void => {
    if (stopped || inFlight) return;
    // Fail-closed: never refresh (or reach ONLINE) while the browser is offline.
    // A successful persisted-state read is NOT proof of network connectivity.
    if (!env.isOnline()) {
      markOffline();
      return;
    }
    inFlight = true;
    const capturedGeneration = generation;
    // Any actual refresh start blocks mutations until it confirms/fails.
    deps.dispatch({ type: "REFRESH_STARTED" });
    deps
      .refresh()
      .then((result) => {
        if (stopped) return;
        // Stale: a reconnect (offline/online/retry) happened after this refresh
        // began — fully ignore it, neither ONLINE nor DEGRADED for the new gen.
        if (capturedGeneration !== generation) return;
        // The network dropped mid-refresh (same generation): reflect OFFLINE, do
        // not claim ONLINE.
        if (!env.isOnline()) {
          markOffline();
          return;
        }
        deps.dispatch(
          result.ok
            ? {
                type: "REFRESH_SUCCEEDED",
                revision: result.revision,
                updatedAt: result.updatedAt,
              }
            : { type: "REFRESH_FAILED" },
        );
      })
      .catch(() => {
        if (stopped || capturedGeneration !== generation) return;
        if (!env.isOnline()) {
          markOffline();
          return;
        }
        deps.dispatch({ type: "REFRESH_FAILED" });
      })
      .finally(() => {
        inFlight = false;
        if (stopped) return;
        // A reconnect/freshness request arrived during the in-flight refresh:
        // run exactly one follow-up for the current generation.
        if (rerunRequired) {
          rerunRequired = false;
          startRefresh();
        }
      });
  };

  /** Start a refresh, or coalesce into a single follow-up if one is in flight. */
  const requestRefresh = (): void => {
    if (inFlight) {
      rerunRequired = true;
      return;
    }
    startRefresh();
  };

  /**
   * Confirmed-online recovery. The controller has just observed
   * `env.isOnline() === true`, so it dispatches BROWSER_ONLINE — which the reducer
   * allows FROM OFFLINE → RECOVERING (Variant A), fixing a missed `online` event —
   * bumps the generation, and requests a (coalesced) refresh. A stale in-flight
   * refresh from before the bump can no longer confirm; multiple calls while a
   * refresh is in flight collapse to a single follow-up.
   */
  const recoverFreshness = (): void => {
    generation += 1;
    deps.dispatch({ type: "BROWSER_ONLINE" });
    requestRefresh();
  };

  const onOffline = (): void => {
    if (stopped) return;
    markOffline();
  };
  const onOnline = (): void => {
    if (stopped) return;
    // A raw `online` signal is not proof of connectivity; verify before recovering.
    if (!env.isOnline()) {
      markOffline();
      return;
    }
    recoverFreshness();
  };
  const onFocus = (): void => {
    if (stopped) return;
    // Missed-event reconciliation: trust the current browser signal, not stale state.
    if (!env.isOnline()) {
      markOffline();
      return;
    }
    recoverFreshness();
  };
  const onVisibility = (): void => {
    if (stopped) return;
    if (!env.isVisible()) return;
    if (!env.isOnline()) {
      markOffline();
      return;
    }
    recoverFreshness();
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
      if (online) {
        generation += 1;
        requestRefresh();
      }
    },
    retry() {
      if (stopped) return;
      // Fail-closed: a retry while offline cannot reach ONLINE — invalidate any
      // in-flight refresh, close the gate and start no refresh.
      if (!env.isOnline()) {
        markOffline();
        return;
      }
      generation += 1; // fresh recovery attempt
      deps.dispatch({ type: "RETRY" });
      requestRefresh();
    },
  };
}
