"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  driverNotificationPreferenceKey,
  kitchenNotificationPreferenceKey,
  notificationAudienceScope,
  reconcileNotificationDelivery,
  resolveDirectNotificationCapability,
  type BrowserNotificationPermission,
  type DirectNotificationCapability,
  type DirectSystemNotificationAudience,
  type DirectSystemNotificationIntent,
  type NotificationDeliveryPorts,
} from "@/prototype/direct-notifications";
import { shouldRunNotificationReconcile } from "@/prototype/direct-notification-ack";
import {
  closeNotificationViaWorker,
  getSystemNotificationPermission,
  isNotificationLockAvailable,
  isNotificationStorageReady,
  isSystemNotificationSupported,
  readNotificationLedger,
  readNotificationPreference,
  registerDirectNotificationWorker,
  requestSystemNotificationPermission,
  runWithNotificationLock,
  showNotificationViaWorker,
  writeNotificationLedger,
  writeNotificationPreference,
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

/**
 * Orchestrates Direct system notifications for one audience (driver or kitchen)
 * as a channel independent of sound. Fail-closed: it never requests permission
 * automatically (only from the explicit enable() gesture), never writes a sound
 * preference, and shows at most one OS notification per intent across tabs. The
 * preference is considered ON only after a durable write; if preference storage,
 * ledger storage or the cross-tab lock is not ready, or a delivery attempt
 * fails, capability degrades to DEGRADED instead of risking duplicates.
 */
export function useDirectSystemNotifications({
  audience,
  intents,
  nowMs,
  active = true,
}: {
  audience: DirectSystemNotificationAudience;
  /**
   * Current intents for this audience. The caller gates them (empty when a
   * screen should not drive notifications, e.g. the SPLIT kitchen screen).
   */
  intents: DirectSystemNotificationIntent[];
  nowMs: number;
  /**
   * Whether this screen owns notification delivery. When false the reconcile
   * loop does nothing at all: it does not show, does not close stale tags, and
   * never reads or writes the shared audience ledger.
   */
  active?: boolean;
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
  const [preferenceStorageReady, setPreferenceStorageReady] = useState(false);
  const [ledgerStorageReady, setLedgerStorageReady] = useState(false);
  const [lockReady, setLockReady] = useState(false);
  const [deliveryFailed, setDeliveryFailed] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reconcilingRef = useRef(false);
  // Per-tab in-memory quarantine of shown-but-unpersisted intents: prevents a
  // failed ledger write from re-showing the same notification on a later tick.
  const quarantineRef = useRef<Set<string>>(new Set());

  // Probe browser readiness on mount, on every tick and on cross-tab changes.
  // Reading real browser state after mount (SSR renders "off") is the intended
  // pattern, same as useNowMs.
  useEffect(() => {
    const probe = () => {
      const storageReady = isNotificationStorageReady();
      const pref = readNotificationPreference(preferenceKey);
      const ledger = readNotificationLedger(scope);
      setSupported(isSystemNotificationSupported());
      setPermission(getSystemNotificationPermission());
      setPreferenceStorageReady(storageReady && pref.ok);
      setPreferenceEnabled(pref.ok ? pref.value : false);
      setLedgerStorageReady(storageReady && ledger.ok);
      setLockReady(isNotificationLockAvailable());
      // Recovery: once storage and lock are healthy again, clear the transient
      // delivery failure so a NEW intent can be delivered once.
      if (storageReady && pref.ok && ledger.ok && isNotificationLockAvailable()) {
        setDeliveryFailed(false);
      }
    };
    probe();
    const onStorage = (event: StorageEvent) => {
      if (event.key === preferenceKey) probe();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [preferenceKey, scope, nowMs]);

  // Register the worker only once the user has opted in and granted permission —
  // never speculatively. Registration is not a permission prompt.
  useEffect(() => {
    if (!supported || permission !== "granted" || !preferenceEnabled) return;
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
    preferenceStorageReady,
    ledgerStorageReady,
    lockReady,
    deliveryFailed,
  });

  // Reconcile only when we can guarantee one-intent-one-notification (ENABLED)
  // AND this screen is active. An inactive screen does nothing: no show, no
  // close of stale tags, and no read/write of the shared audience ledger.
  useEffect(() => {
    const registration = registrationRef.current;
    if (
      !shouldRunNotificationReconcile({
        active,
        enabled: capability.status === "ENABLED",
        nowMs,
        hasRegistration: registration !== null,
      })
    ) {
      return;
    }
    if (registration === null) return;
    if (reconcilingRef.current) return;
    reconcilingRef.current = true;

    const ports: NotificationDeliveryPorts = {
      readLedger: () => readNotificationLedger(scope),
      writeLedger: (keys) => writeNotificationLedger(scope, keys),
      show: (intent) => showNotificationViaWorker(registration, intent),
      close: (tag) => closeNotificationViaWorker(registration, tag),
      runExclusive: (fn) => runWithNotificationLock(scope, fn),
    };

    void reconcileNotificationDelivery(intents, quarantineRef.current, ports)
      .then((outcome) => {
        if (outcome.status === "DEGRADED") {
          // Fail-closed: stop reconciling until the next probe confirms recovery.
          setDeliveryFailed(true);
        }
      })
      .catch(() => {
        setDeliveryFailed(true);
      })
      .finally(() => {
        reconcilingRef.current = false;
      });
  }, [active, capability.status, intents, nowMs, scope]);

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
    // Preference is ON only after a confirmed durable write. If storage cannot
    // persist it, do not claim it is enabled.
    const durable = writeNotificationPreference(preferenceKey, true);
    setPreferenceStorageReady(durable);
    setPreferenceEnabled(durable);
    if (durable) {
      quarantineRef.current = new Set();
      setDeliveryFailed(false);
    }
  }, [preferenceKey]);

  const disable = useCallback(() => {
    writeNotificationPreference(preferenceKey, false);
    setPreferenceEnabled(false);
  }, [preferenceKey]);

  return { capability, enable, disable };
}
