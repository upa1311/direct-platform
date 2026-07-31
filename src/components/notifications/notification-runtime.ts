"use client";

import {
  getPrototypeLockManager,
} from "@/prototype/browser-adapters";
import {
  intentToPayload,
  type BrowserNotificationPermission,
  type DirectSystemNotificationIntent,
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

export function readNotificationLedger(scope: string): string[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(ledgerStorageKey(scope));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeNotificationLedger(scope: string, keys: readonly string[]): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(ledgerStorageKey(scope), JSON.stringify(keys));
  } catch {
    // Storage unavailable — safe no-op (worst case a duplicate on another tab).
  }
}

/**
 * Serialize a critical section across tabs with Web Locks when available;
 * otherwise run directly (degraded — no domain mutation, at worst a rare
 * duplicate). Never throws.
 */
export async function withNotificationLock<T>(
  scope: string,
  fn: () => Promise<T>,
): Promise<T> {
  const manager = getPrototypeLockManager();
  if (!manager) return fn();
  try {
    return (await manager.request(
      `direct-notification-lock:${scope}`,
      fn,
    )) as T;
  } catch {
    return fn();
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
