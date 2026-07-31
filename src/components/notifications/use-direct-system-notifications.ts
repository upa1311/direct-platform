"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  driverNotificationPreferenceKey,
  kitchenNotificationPreferenceKey,
  ledgerAfterDeliveryAttempt,
  notificationAudienceScope,
  resolveDirectNotificationCapability,
  selectStaleNotificationTags,
  selectUndeliveredIntents,
  forgetDeliveredKeys,
  type BrowserNotificationPermission,
  type DirectNotificationCapability,
  type DirectSystemNotificationAudience,
  type DirectSystemNotificationIntent,
} from "@/prototype/direct-notifications";
import {
  closeNotificationViaWorker,
  getSystemNotificationPermission,
  isSystemNotificationSupported,
  readNotificationLedger,
  registerDirectNotificationWorker,
  requestSystemNotificationPermission,
  showNotificationViaWorker,
  withNotificationLock,
  writeNotificationLedger,
} from "./notification-runtime";

/** Preference storage key for an audience (driver per id; kitchen per restaurant+role). */
export function notificationPreferenceKey(
  audience: DirectSystemNotificationAudience,
): string {
  return audience.type === "DRIVER"
    ? driverNotificationPreferenceKey(audience.driverId)
    : kitchenNotificationPreferenceKey(
        audience.restaurantId,
        audience.workspaceRole,
      );
}

function readPreference(key: string): boolean {
  try {
    return typeof window !== "undefined"
      ? window.localStorage.getItem(key) === "1"
      : false;
  } catch {
    return false;
  }
}

/**
 * Orchestrates Direct system notifications for one audience (driver or kitchen)
 * as a channel independent of sound. It never requests permission automatically
 * — only from the explicit enable() user gesture — never writes a sound
 * preference, and shows at most one OS notification per intent across tabs using
 * a Web-Lock-guarded, audience-scoped browser delivery ledger.
 */
export function useDirectSystemNotifications({
  audience,
  intents,
  nowMs,
}: {
  audience: DirectSystemNotificationAudience;
  /**
   * Current intents for this audience. The caller gates them (empty when a
   * screen should not drive notifications, e.g. the SPLIT kitchen screen).
   */
  intents: DirectSystemNotificationIntent[];
  nowMs: number;
}): {
  capability: DirectNotificationCapability;
  enable: () => Promise<void>;
  disable: () => void;
} {
  const preferenceKey = notificationPreferenceKey(audience);
  const scope = notificationAudienceScope(audience);

  const [supported, setSupported] = useState(false);
  const [permission, setPermission] =
    useState<BrowserNotificationPermission | null>(null);
  const [preferenceEnabled, setPreferenceEnabled] = useState(false);
  const [workerReady, setWorkerReady] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reconcilingRef = useRef(false);

  // Initial browser read (client only) + cross-tab preference sync. Reading the
  // real browser state after mount (SSR renders "off") is the intended pattern,
  // same as useNowMs; the one-time client init is not a cascading render.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setSupported(isSystemNotificationSupported());
    setPermission(getSystemNotificationPermission());
    setPreferenceEnabled(readPreference(preferenceKey));
    /* eslint-enable react-hooks/set-state-in-effect */
    const onStorage = (event: StorageEvent) => {
      if (event.key === preferenceKey) {
        setPreferenceEnabled(readPreference(preferenceKey));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [preferenceKey]);

  // Register the worker only once the user has opted in and granted permission —
  // never speculatively. Registration is not a permission prompt.
  useEffect(() => {
    if (!supported || permission !== "granted" || !preferenceEnabled) return;
    // Already registered — workerReady is already set from the async result.
    if (registrationRef.current) return;
    let cancelled = false;
    void registerDirectNotificationWorker().then((registration) => {
      if (cancelled) return;
      registrationRef.current = registration;
      setWorkerReady(registration !== null && registration.active !== null);
    });
    return () => {
      cancelled = true;
    };
  }, [supported, permission, preferenceEnabled]);

  const capability = resolveDirectNotificationCapability({
    supported,
    permission,
    preferenceEnabled,
    workerReady,
  });

  // Reconcile: show undelivered intents once per key across tabs, close stale.
  useEffect(() => {
    if (capability.status !== "ENABLED") return;
    if (nowMs === 0) return;
    const registration = registrationRef.current;
    if (!registration) return;
    if (reconcilingRef.current) return;
    reconcilingRef.current = true;

    void withNotificationLock(scope, async () => {
      let ledger = readNotificationLedger(scope);

      const undelivered = selectUndeliveredIntents(intents, ledger);
      for (const intent of undelivered) {
        const shown = await showNotificationViaWorker(registration, intent);
        ledger = ledgerAfterDeliveryAttempt(ledger, intent.key, shown);
      }

      const staleTags = selectStaleNotificationTags(intents, ledger);
      for (const tag of staleTags) {
        closeNotificationViaWorker(registration, tag);
      }
      if (staleTags.length > 0) {
        ledger = forgetDeliveredKeys(ledger, staleTags);
      }

      writeNotificationLedger(scope, ledger);
    })
      .catch(() => {
        // Degraded path already handled inside the adapters; never throw.
      })
      .finally(() => {
        reconcilingRef.current = false;
      });
  }, [capability.status, intents, nowMs, scope]);

  const enable = useCallback(async () => {
    if (!isSystemNotificationSupported()) {
      setSupported(false);
      return;
    }
    setSupported(true);
    let current = getSystemNotificationPermission();
    // Request only when undecided — never re-prompt after a denial.
    if (current === "default") {
      current = await requestSystemNotificationPermission();
    }
    setPermission(current);
    if (current !== "granted") return;
    const registration = await registerDirectNotificationWorker();
    registrationRef.current = registration;
    setWorkerReady(registration !== null && registration.active !== null);
    try {
      window.localStorage.setItem(preferenceKey, "1");
    } catch {
      // ignore storage failure
    }
    setPreferenceEnabled(true);
  }, [preferenceKey]);

  const disable = useCallback(() => {
    try {
      window.localStorage.setItem(preferenceKey, "0");
    } catch {
      // ignore
    }
    setPreferenceEnabled(false);
  }, [preferenceKey]);

  return { capability, enable, disable };
}
