"use client";

import {
  getPrototypeLockManager,
} from "@/prototype/browser-adapters";
import {
  intentToPayload,
  type BrowserNotificationPermission,
  type BrowserStorageReadResult,
  type DirectSystemNotificationIntent,
  type NotificationLockResult,
} from "@/prototype/direct-notifications";
import { validateWorkerNotificationMessage } from "@/prototype/direct-notification-worker-contract";

/**
 * Thin, fully-guarded browser adapters for Direct system notifications. None of
 * these may throw in an unsupported/insecure context: they degrade to safe
 * no-ops. All decision logic lives in the pure core; this file only touches the
 * DOM/worker/localStorage.
 */

export const DIRECT_NOTIFICATION_WORKER_URL = "/direct-notifications-sw.js";
const LEDGER_KEY_PREFIX = "direct-notification-ledger";
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

function ledgerStorageKey(scope: string): string {
  return `${LEDGER_KEY_PREFIX}:${scope}`;
}

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
 * Ledger read that distinguishes an empty ledger ({ok:true, value:[]}) from an
 * unreadable/corrupt store ({ok:false}) — the latter must never be treated as
 * "nothing delivered yet".
 */
export function readNotificationLedger(
  scope: string,
): BrowserStorageReadResult<string[]> {
  let raw: string | null;
  try {
    if (typeof window === "undefined") return { ok: false, error: "UNAVAILABLE" };
    raw = window.localStorage.getItem(ledgerStorageKey(scope));
  } catch {
    return { ok: false, error: "UNAVAILABLE" };
  }
  if (raw === null) return { ok: true, value: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, error: "INVALID_DATA" };
    return {
      ok: true,
      value: parsed.filter((item): item is string => typeof item === "string"),
    };
  } catch {
    return { ok: false, error: "INVALID_DATA" };
  }
}

/** Ledger write; true only when the keys were actually persisted. */
export function writeNotificationLedger(
  scope: string,
  keys: readonly string[],
): boolean {
  try {
    if (typeof window === "undefined") return false;
    window.localStorage.setItem(ledgerStorageKey(scope), JSON.stringify(keys));
    return true;
  } catch {
    return false;
  }
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
    worker.postMessage(message);
    // Confirm delivery: the worker shows synchronously enough that the tagged
    // notification is queryable. If we cannot confirm, do not mark delivered.
    const shown = await registration.getNotifications({ tag: intent.tag });
    return shown.length > 0;
  } catch {
    return false;
  }
}

export function closeNotificationViaWorker(
  registration: ServiceWorkerRegistration | null,
  tag: string,
): void {
  try {
    const worker = registration?.active;
    if (!worker) return;
    const message = validateWorkerNotificationMessage({
      type: "CLOSE_DIRECT_NOTIFICATION",
      tag,
    });
    if (message === null) return;
    worker.postMessage(message);
  } catch {
    // no-op
  }
}
