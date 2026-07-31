import { getOpenDriverOffersForDriver } from "./driver-offers";
import { getAudibleKitchenReviewOrders } from "./selectors";
import type { Order, PrototypeState, RestaurantWorkspaceRole } from "./models";
import type {
  DirectNotificationEntityKind,
  DirectNotificationPayload,
} from "./direct-notification-worker-contract";

/**
 * Pure core of Direct system (browser/OS) notifications for the driver and the
 * kitchen. Everything here is a pure function with no DOM/worker access, so it
 * is fully testable in node:test.
 *
 * System notifications are a SECOND channel, independent of sound: they never
 * replace sound, never toggle a sound preference and never repeat on the 10s/20s
 * sound cadence. Notification preferences are a browser/device setting and are
 * NOT stored in PrototypeState.
 *
 * Delivery scope is honest: notifications require an active Direct client (a tab
 * open, possibly backgrounded, or an installed worker receiving a message from a
 * live client). With every Direct tab fully closed the current architecture has
 * no authoritative server event stream and cannot deliver remote push.
 */

// --- Preferences (browser localStorage keys; never PrototypeState) -------------

export const DIRECT_DRIVER_NOTIFICATION_PREFERENCE_PREFIX =
  "direct-driver-notification-enabled";
export const DIRECT_KITCHEN_NOTIFICATION_PREFERENCE_PREFIX =
  "direct-kitchen-notification-enabled";

/** Per-driver preference key: one driver's choice never enables another's. */
export function driverNotificationPreferenceKey(driverId: string): string {
  return `${DIRECT_DRIVER_NOTIFICATION_PREFERENCE_PREFIX}:${driverId}`;
}

/**
 * Kitchen preference key scoped by restaurant AND workspace role: one kitchen's
 * choice never enables another restaurant's or the driver's, and COMBINED vs
 * OPERATOR keep independent preferences.
 */
export function kitchenNotificationPreferenceKey(
  restaurantId: string,
  workspaceRole: RestaurantWorkspaceRole,
): string {
  return `${DIRECT_KITCHEN_NOTIFICATION_PREFERENCE_PREFIX}:${restaurantId}:${workspaceRole}`;
}

// --- Capability model ----------------------------------------------------------

export type DirectNotificationDeliveryScope = "DIRECT_CLIENT_REQUIRED";

export type DirectNotificationCapability =
  | { status: "UNSUPPORTED"; deliveryScope: null }
  | { status: "PERMISSION_REQUIRED"; deliveryScope: DirectNotificationDeliveryScope }
  | { status: "DENIED"; deliveryScope: DirectNotificationDeliveryScope }
  | { status: "DISABLED"; deliveryScope: DirectNotificationDeliveryScope }
  | { status: "ENABLED"; deliveryScope: DirectNotificationDeliveryScope }
  | { status: "DEGRADED"; deliveryScope: DirectNotificationDeliveryScope };

export type BrowserNotificationPermission = "default" | "granted" | "denied";

const SCOPE: DirectNotificationDeliveryScope = "DIRECT_CLIENT_REQUIRED";

/**
 * Resolve capability from ALL inputs that must hold to guarantee
 * one-intent-one-notification: technical support, browser permission, the user's
 * durable Direct preference, worker readiness, preference-storage readiness,
 * ledger-storage readiness, cross-tab lock readiness and the absence of a runtime
 * delivery failure. `granted` permission does NOT imply an enabled preference,
 * and if we cannot durably dedupe (any storage/lock component down or a delivery
 * failure) the honest result is DEGRADED — never a false ENABLED. Defaults keep
 * the readiness inputs optional so existing callers stay valid.
 */
export function resolveDirectNotificationCapability(input: {
  supported: boolean;
  permission: BrowserNotificationPermission | null;
  preferenceEnabled: boolean;
  workerReady: boolean;
  preferenceStorageReady?: boolean;
  ledgerStorageReady?: boolean;
  lockReady?: boolean;
  deliveryFailed?: boolean;
}): DirectNotificationCapability {
  if (!input.supported || input.permission === null) {
    return { status: "UNSUPPORTED", deliveryScope: null };
  }
  if (input.permission === "denied") return { status: "DENIED", deliveryScope: SCOPE };
  if (input.permission === "default") {
    return { status: "PERMISSION_REQUIRED", deliveryScope: SCOPE };
  }
  // permission === "granted"
  if (!input.preferenceEnabled) return { status: "DISABLED", deliveryScope: SCOPE };
  const preferenceStorageReady = input.preferenceStorageReady ?? true;
  const ledgerStorageReady = input.ledgerStorageReady ?? true;
  const lockReady = input.lockReady ?? true;
  const deliveryFailed = input.deliveryFailed ?? false;
  if (
    !input.workerReady ||
    !preferenceStorageReady ||
    !ledgerStorageReady ||
    !lockReady ||
    deliveryFailed
  ) {
    return { status: "DEGRADED", deliveryScope: SCOPE };
  }
  return { status: "ENABLED", deliveryScope: SCOPE };
}

// --- Intents -------------------------------------------------------------------

export type DirectSystemNotificationAudience =
  | { type: "DRIVER"; driverId: string }
  | {
      type: "KITCHEN";
      restaurantId: string;
      workspaceRole: RestaurantWorkspaceRole;
    };

export interface DirectSystemNotificationIntent {
  /** Stable identity for the delivery ledger (equals `tag`). */
  key: string;
  tag: string;
  audience: DirectSystemNotificationAudience;
  kind: "DRIVER_NEW_OFFER" | "KITCHEN_NEW_ACTIONABLE_ORDER";
  entityKind: DirectNotificationEntityKind;
  entityId: string;
  title: string;
  body: string;
  targetUrl: string;
}

export const DRIVER_NOTIFICATION_ROUTE = "/driver";

export function kitchenNotificationRoute(
  workspaceRole: RestaurantWorkspaceRole,
): string {
  return workspaceRole === "OPERATOR"
    ? "/restaurant/operator"
    : "/restaurant/kitchen";
}

export function driverOfferNotificationTag(offerId: string): string {
  return `driver-offer:${offerId}`;
}

export function kitchenOrderNotificationTag(
  restaurantId: string,
  evidenceId: string,
): string {
  return `kitchen-actionable:${restaurantId}:${evidenceId}`;
}

/**
 * Stable structured evidence for a kitchen-actionable order: the id of the
 * STATUS-history transition into RESTAURANT_REVIEW when present, otherwise the
 * immutable order id + createdAt. Never derived from human-readable message text.
 */
export function kitchenActionableEvidenceId(order: Order): string {
  const reviewEvent = order.history.find(
    (event) => event.type === "STATUS" && event.toStatus === "RESTAURANT_REVIEW",
  );
  if (reviewEvent) return reviewEvent.id;
  return `${order.id}:${order.createdAt}`;
}

/**
 * Driver offer intents from the canonical selector only. Privacy-safe: no name,
 * phone, full address or comment before acceptance — just a neutral prompt. One
 * intent per OPEN, non-expired offer belonging to this driver.
 */
export function buildDriverNotificationIntents(
  state: PrototypeState,
  driverId: string,
  nowMs: number,
): DirectSystemNotificationIntent[] {
  return getOpenDriverOffersForDriver(state, driverId, nowMs).map((offer) => {
    const tag = driverOfferNotificationTag(offer.id);
    return {
      key: tag,
      tag,
      audience: { type: "DRIVER", driverId },
      kind: "DRIVER_NEW_OFFER",
      entityKind: "DRIVER_OFFER",
      entityId: offer.id,
      title: "Новый заказ Direct",
      body: "Откройте Direct, чтобы посмотреть предложение.",
      targetUrl: DRIVER_NOTIFICATION_ROUTE,
    };
  });
}

/**
 * Kitchen intents from the SAME canonical actionable selector the sound uses
 * (RESTAURANT_REVIEW within the freshness window). One intent per order; the tag
 * is keyed by structured evidence so a repeat render never creates a second
 * notification. Privacy-safe: only the public number, no phone/address.
 */
export function buildKitchenNotificationIntents(
  state: PrototypeState,
  restaurantId: string,
  workspaceRole: RestaurantWorkspaceRole,
  nowMs: number,
): DirectSystemNotificationIntent[] {
  return getAudibleKitchenReviewOrders(state, restaurantId, nowMs).map((order) => {
    const tag = kitchenOrderNotificationTag(
      restaurantId,
      kitchenActionableEvidenceId(order),
    );
    return {
      key: tag,
      tag,
      audience: { type: "KITCHEN", restaurantId, workspaceRole },
      kind: "KITCHEN_NEW_ACTIONABLE_ORDER",
      entityKind: "KITCHEN_ORDER",
      entityId: order.id,
      title: "Новый заказ для кухни",
      body: `Заказ ${order.publicNumber} готов к работе.`,
      targetUrl: kitchenNotificationRoute(workspaceRole),
    };
  });
}

/** Convert an intent to the safe worker payload (no extra fields, no functions). */
export function intentToPayload(
  intent: DirectSystemNotificationIntent,
): DirectNotificationPayload {
  return {
    tag: intent.tag,
    title: intent.title,
    body: intent.body,
    url: intent.targetUrl,
    entityKind: intent.entityKind,
    entityId: intent.entityId,
  };
}

// --- Cross-tab delivery ledger (browser, not PrototypeState) -------------------

/**
 * Audience scope for the delivery ledger. It must match the preference/intent
 * scope exactly: driver by id, kitchen by restaurant AND workspace role. One
 * role must never absorb another role's delivered key, close its notification as
 * stale, or touch its ledger. Cross-tab dedupe still holds within the same role.
 */
export function notificationAudienceScope(
  audience: DirectSystemNotificationAudience,
): string {
  return audience.type === "DRIVER"
    ? `driver:${audience.driverId}`
    : `kitchen:${audience.restaurantId}:${audience.workspaceRole}`;
}

export const NOTIFICATION_LEDGER_MAX = 100;

/** Intents not yet delivered on this browser profile (by stable key). */
export function selectUndeliveredIntents(
  intents: readonly DirectSystemNotificationIntent[],
  deliveredKeys: readonly string[],
): DirectSystemNotificationIntent[] {
  const delivered = new Set(deliveredKeys);
  return intents.filter((intent) => !delivered.has(intent.key));
}

/**
 * Record a delivered key. Deterministic bounded pruning: move the key to the
 * most-recent end and drop the oldest keys beyond `max`.
 */
export function recordDeliveredKey(
  deliveredKeys: readonly string[],
  key: string,
  max: number = NOTIFICATION_LEDGER_MAX,
): string[] {
  const next = deliveredKeys.filter((existing) => existing !== key);
  next.push(key);
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Ledger after a delivery attempt: record the key only when the show actually
 * succeeded. A failed show never marks the intent delivered, so it is retried.
 */
export function ledgerAfterDeliveryAttempt(
  deliveredKeys: readonly string[],
  key: string,
  showSucceeded: boolean,
  max: number = NOTIFICATION_LEDGER_MAX,
): string[] {
  return showSucceeded
    ? recordDeliveredKey(deliveredKeys, key, max)
    : [...deliveredKeys];
}

/**
 * Delivered keys whose entity is no longer an active intent → their notification
 * is stale and should be closed (offer accepted/declined/expired/cancelled, or
 * order started/cancelled/completed/out of the freshness window).
 */
export function selectStaleNotificationTags(
  activeIntents: readonly DirectSystemNotificationIntent[],
  deliveredKeys: readonly string[],
): string[] {
  const active = new Set(activeIntents.map((intent) => intent.tag));
  return deliveredKeys.filter((key) => !active.has(key));
}

/** Drop the given keys from the ledger (after their stale tags were closed). */
export function forgetDeliveredKeys(
  deliveredKeys: readonly string[],
  keysToForget: readonly string[],
): string[] {
  const forget = new Set(keysToForget);
  return deliveredKeys.filter((key) => !forget.has(key));
}

// --- Fail-closed delivery reconciliation --------------------------------------

/** Explicit browser-storage read result: empty is NOT the same as unreadable. */
export type BrowserStorageReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "UNAVAILABLE" | "INVALID_DATA" };

/** Explicit cross-tab lock result: no fallback execution on failure. */
export type NotificationLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "LOCK_UNAVAILABLE" | "LOCK_FAILED" };

export type NotificationDegradeReason =
  | "LEDGER_READ"
  | "LEDGER_WRITE"
  | "LOCK_UNAVAILABLE"
  | "LOCK_FAILED";

/**
 * Injectable ports for the delivery critical section. The pure reconciler drives
 * them; the hook wires real browser adapters and tests wire fakes (including a
 * shared ledger + serializing lock for concurrency).
 */
export interface NotificationDeliveryPorts {
  readLedger: () => BrowserStorageReadResult<string[]>;
  writeLedger: (keys: string[]) => boolean;
  show: (intent: DirectSystemNotificationIntent) => Promise<boolean>;
  close: (tag: string) => void;
  runExclusive: <T>(fn: () => Promise<T>) => Promise<NotificationLockResult<T>>;
}

export type NotificationReconcileOutcome =
  | { status: "OK"; shownKeys: string[] }
  | { status: "DEGRADED"; reason: NotificationDegradeReason; shownKeys: string[] };

/**
 * Fail-closed cross-tab delivery. Everything runs inside a real exclusive lock —
 * there is NO unsynchronised fallback. A delivered key is persisted only after a
 * confirmed show; if that persist fails the just-shown tag is closed, the intent
 * is quarantined in-memory (so the next tick cannot re-show it) and the run
 * degrades immediately without touching further intents. A missing/failed lock
 * or an unreadable ledger performs no show at all.
 *
 * `quarantine` is a caller-owned in-memory Set (per browser tab); it is mutated
 * only to record a shown-but-unpersisted key.
 */
export async function reconcileNotificationDelivery(
  intents: readonly DirectSystemNotificationIntent[],
  quarantine: Set<string>,
  ports: NotificationDeliveryPorts,
): Promise<NotificationReconcileOutcome> {
  const locked = await ports.runExclusive(async () => {
    const read = ports.readLedger();
    if (!read.ok) {
      return { degraded: "LEDGER_READ" as NotificationDegradeReason, shownKeys: [] };
    }
    let ledger = read.value;
    const shownKeys: string[] = [];

    const undelivered = selectUndeliveredIntents(intents, ledger).filter(
      (intent) => !quarantine.has(intent.key),
    );
    for (const intent of undelivered) {
      const shown = await ports.show(intent);
      // A failed show is never recorded — it is retried on a later tick.
      if (!shown) continue;
      const next = recordDeliveredKey(ledger, intent.key);
      if (!ports.writeLedger(next)) {
        // Shown but not persisted → quarantine, close, stop, degrade.
        quarantine.add(intent.key);
        ports.close(intent.tag);
        return { degraded: "LEDGER_WRITE" as NotificationDegradeReason, shownKeys };
      }
      ledger = next;
      shownKeys.push(intent.key);
    }

    const staleTags = selectStaleNotificationTags(intents, ledger);
    if (staleTags.length > 0) {
      for (const tag of staleTags) ports.close(tag);
      const forgotten = forgetDeliveredKeys(ledger, staleTags);
      if (!ports.writeLedger(forgotten)) {
        return { degraded: "LEDGER_WRITE" as NotificationDegradeReason, shownKeys };
      }
      ledger = forgotten;
    }

    return { degraded: null as NotificationDegradeReason | null, shownKeys };
  });

  if (!locked.ok) {
    return { status: "DEGRADED", reason: locked.reason, shownKeys: [] };
  }
  const inner = locked.value;
  if (inner.degraded !== null) {
    return { status: "DEGRADED", reason: inner.degraded, shownKeys: inner.shownKeys };
  }
  return { status: "OK", shownKeys: inner.shownKeys };
}
