"use client";

import {
  getPrototypeLockManager,
} from "@/prototype/browser-adapters";
import {
  intentToPayload,
  type BrowserNotificationPermission,
  type BrowserStorageReadResult,
  type DirectSystemNotificationIntent,
  type NotificationLedgerEntry,
  type NotificationLockResult,
} from "@/prototype/direct-notifications";
import {
  ledgerStorageKeyFor,
  readMigratedLedger,
  type LedgerStorage,
} from "@/prototype/notification-ledger-storage";
import { validateWorkerNotificationMessage } from "@/prototype/direct-notification-worker-contract";
import {
  isAckOk,
  nextNotificationRequestId,
  NOTIFICATION_ACK_TIMEOUT_MS,
} from "@/prototype/direct-notification-ack";

/**
 * Thin, fully-guarded browser adapters for Direct system notifications. None of
 * these may throw in an unsupported/insecure context: they degrade to safe
 * no-ops. All decision logic lives in the pure core; this file only touches the
 * DOM/worker/localStorage.
 */

export const DIRECT_NOTIFICATION_WORKER_URL = "/direct-notifications-sw.js";
const STORAGE_PROBE_KEY = "direct-notification-probe";

export function isSystemNotificationSupported(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      "Notification" in window &&
      "serviceWorker" in navigator
    );
  } catch {
    return false;
  }
}

export function getSystemNotificationPermission(): BrowserNotificationPermission | null {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return null;
    const permission = window.Notification.permission;
    if (
      permission === "granted" ||
      permission === "denied" ||
      permission === "default"
    ) {
      return permission;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Request browser permission. MUST be called only from an explicit user gesture
 * (the caller guarantees this) — never on load, login, background effect or a
 * repeat after `denied`.
 */
export async function requestSystemNotificationPermission(): Promise<BrowserNotificationPermission | null> {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return null;
    const result = await window.Notification.requestPermission();
    return result === "granted" || result === "denied" || result === "default"
      ? result
      : null;
  } catch {
    return null;
  }
}

/**
 * Register the dedicated notifications worker and wait for it to become active
 * (`serviceWorker.ready`), so the returned registration can actually show
 * notifications. Null on any failure.
 */
export async function registerDirectNotificationWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return null;
    }
    await navigator.serviceWorker.register(DIRECT_NOTIFICATION_WORKER_URL);
    const ready = await navigator.serviceWorker.ready;
    return ready ?? null;
  } catch {
    return null;
  }
}

/** Real localStorage bound to the ledger adapter: read distinguishes absent from
 * unavailable, write reports durability. */
const localStorageLedgerPort: LedgerStorage = {
  read: (storageKey) => {
    try {
      if (typeof window === "undefined") return { ok: false };
      return { ok: true, raw: window.localStorage.getItem(storageKey) };
    } catch {
      return { ok: false };
    }
  },
  write: (storageKey, value) => {
    try {
      if (typeof window === "undefined") return false;
      window.localStorage.setItem(storageKey, value);
      return true;
    } catch {
      return false;
    }
  },
};

/** Durable preference read distinguishing "off" from an unreadable store. */
export function readNotificationPreference(
  key: string,
): BrowserStorageReadResult<boolean> {
  try {
    if (typeof window === "undefined") return { ok: false, error: "UNAVAILABLE" };
    return { ok: true, value: window.localStorage.getItem(key) === "1" };
  } catch {
    return { ok: false, error: "UNAVAILABLE" };
  }
}

/** Durable preference write; true only when the value was actually persisted. */
export function writeNotificationPreference(key: string, on: boolean): boolean {
  try {
    if (typeof window === "undefined") return false;
    window.localStorage.setItem(key, on ? "1" : "0");
    // Confirm durability: read the value back.
    return window.localStorage.getItem(key) === (on ? "1" : "0");
  } catch {
    return false;
  }
}

/**
 * Ledger read via the scope-aware migrating adapter: reads the new role-scoped
 * key, and only when it is absent migrates a legacy shared kitchen key into it
 * (fail-closed parse; empty vs unreadable vs corrupt are distinguished).
 */
export function readNotificationLedger(
  scope: string,
): BrowserStorageReadResult<NotificationLedgerEntry[]> {
  return readMigratedLedger(localStorageLedgerPort, scope);
}

/** Ledger write to the new role-scoped key; true only when actually persisted. */
export function writeNotificationLedger(
  scope: string,
  entries: readonly NotificationLedgerEntry[],
): boolean {
  return localStorageLedgerPort.write(
    ledgerStorageKeyFor(scope),
    JSON.stringify(entries),
  );
}

/** Whether cross-tab serialization (Web Locks) is available at all. */
export function isNotificationLockAvailable(): boolean {
  return getPrototypeLockManager() !== null;
}

/**
 * Probe that storage is durably usable right now (read + write + cleanup).
 * Used to keep capability honest and to recover from a transient outage.
 */
export function isNotificationStorageReady(): boolean {
  try {
    if (typeof window === "undefined") return false;
    window.localStorage.setItem(STORAGE_PROBE_KEY, "1");
    const ok = window.localStorage.getItem(STORAGE_PROBE_KEY) === "1";
    window.localStorage.removeItem(STORAGE_PROBE_KEY);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Serialize a critical section across tabs with Web Locks. FAIL-CLOSED: there is
 * no unsynchronised fallback. A missing lock manager returns LOCK_UNAVAILABLE and
 * a failed/aborted request returns LOCK_FAILED — in both cases `fn` never runs,
 * so no notification is shown without exclusive coordination.
 */
export async function runWithNotificationLock<T>(
  scope: string,
  fn: () => Promise<T>,
): Promise<NotificationLockResult<T>> {
  const manager = getPrototypeLockManager();
  if (!manager) return { ok: false, reason: "LOCK_UNAVAILABLE" };
  try {
    const value = (await manager.request(
      `direct-notification-lock:${scope}`,
      fn,
    )) as T;
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "LOCK_FAILED" };
  }
}

/**
 * Post a validated SHOW message to the worker and confirm a same-tag notification
 * exists afterwards. Returns true only when the notification was actually shown,
 * so a failure never records the intent as delivered.
 */
/**
 * Post a message to the worker with an explicit requestId over a MessageChannel
 * and resolve to true only on a matching ACK. Fail-closed: a missing/mismatched
 * ACK or a bounded timeout resolves false, and the single-shot timer prevents any
 * retry storm. Never throws.
 */
export async function requestWorkerAck(
  worker: ServiceWorker,
  message: Record<string, unknown>,
  timeoutMs: number = NOTIFICATION_ACK_TIMEOUT_MS,
): Promise<boolean> {
  if (typeof MessageChannel === "undefined") return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const requestId = nextNotificationRequestId();
    const channel = new MessageChannel();
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        channel.port1.onmessage = null;
        channel.port1.close();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      finish(isAckOk(event.data, requestId));
    };
    try {
      worker.postMessage({ ...message, requestId }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

/**
 * Post a validated SHOW and confirm it via a worker ACK. Returns true only when
 * the worker acknowledged the show, so a failure never records the intent as
 * delivered (SHOW key written only after SHOW_ACK).
 */
export async function showNotificationViaWorker(
  registration: ServiceWorkerRegistration | null,
  intent: DirectSystemNotificationIntent,
): Promise<boolean> {
  try {
    const worker = registration?.active;
    if (!worker) return false;
    const message = validateWorkerNotificationMessage({
      type: "SHOW_DIRECT_NOTIFICATION",
      notification: intentToPayload(intent),
    });
    if (message === null) return false;
    return await requestWorkerAck(worker, message as unknown as Record<string, unknown>);
  } catch {
    return false;
  }
}

/**
 * Post a validated CLOSE and confirm it via a worker ACK. Returns true only when
 * the worker acknowledged the close, so the caller removes the ledger key only
 * after CLOSE_ACK; a failed/timed-out close keeps the key for a later retry.
 */
export async function closeNotificationViaWorker(
  registration: ServiceWorkerRegistration | null,
  tag: string,
): Promise<boolean> {
  try {
    const worker = registration?.active;
    if (!worker) return false;
    const message = validateWorkerNotificationMessage({
      type: "CLOSE_DIRECT_NOTIFICATION",
      tag,
    });
    if (message === null) return false;
    return await requestWorkerAck(worker, message as unknown as Record<string, unknown>);
  } catch {
    return false;
  }
}
