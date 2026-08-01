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
  workspaceRole: RestaurantWorkspaceRole,
  evidenceId: string,
): string {
  return `kitchen-actionable:${restaurantId}:${workspaceRole}:${evidenceId}`;
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
      workspaceRole,
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
  | "LOCK_FAILED"
  | "SHOW_FAILED";

// --- Durable two-phase ledger (browser-wide, not PrototypeState) ---------------

/**
 * A durable, browser-wide delivery entry shared across tabs (localStorage + Web
 * Lock). PENDING is written BEFORE the OS notification appears and is promoted to
 * DELIVERED only after the worker SHOW_ACK. A tab that sees PENDING or DELIVERED
 * must not show the intent again. The per-tab quarantine Set is only an extra
 * layer — never the sole guarantee.
 */
export type NotificationDeliveryStateName = "PENDING" | "DELIVERED";

export interface NotificationLedgerEntry {
  key: string;
  tag: string;
  state: NotificationDeliveryStateName;
}

/**
 * Explicit ledger parse result. A corrupt stored array is NEVER silently treated
 * as a valid (empty) ledger: any element of unknown shape fails the whole read
 * closed, which degrades capability and blocks delivery until it is fixed.
 */
export type NotificationLedgerParseResult =
  | { ok: true; entries: NotificationLedgerEntry[]; migrated: boolean }
  | { ok: false; error: "INVALID_DATA" };

const KITCHEN_TAG_PREFIX = "kitchen-actionable:";

/** Split a `kitchen:<restaurantId>:<workspaceRole>` scope (role is last segment). */
function parseKitchenScope(
  scope: string,
): { restaurantId: string; workspaceRole: string } | null {
  if (!scope.startsWith("kitchen:")) return null;
  const rest = scope.slice("kitchen:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === rest.length - 1) return null;
  return {
    restaurantId: rest.slice(0, lastColon),
    workspaceRole: rest.slice(lastColon + 1),
  };
}

/**
 * Migrate one legacy bare-string ledger value into a structured entry, using the
 * audience `scope`. Returns null when the string cannot belong to this scope
 * (fail-closed). Driver strings keep their key/tag. A role-less kitchen string
 * `kitchen-actionable:<restaurantId>:<evidenceId>` gets a role-scoped `key` (so a
 * new role-scoped intent counts as already delivered) while keeping the original
 * role-less `tag` (so the old OS notification can still be closed). `evidenceId`
 * may itself contain colons — the known prefix is stripped, never split by count.
 */
function migrateLegacyLedgerString(
  value: string,
  scope: string,
): NotificationLedgerEntry | null {
  if (value.length === 0) return null;
  if (scope.startsWith("driver:")) {
    // Driver legacy keys are unchanged.
    return { key: value, tag: value, state: "DELIVERED" };
  }
  const kitchen = parseKitchenScope(scope);
  if (kitchen === null) return null;
  const roleScopedPrefix = `${KITCHEN_TAG_PREFIX}${kitchen.restaurantId}:${kitchen.workspaceRole}:`;
  const roleLessPrefix = `${KITCHEN_TAG_PREFIX}${kitchen.restaurantId}:`;
  if (value.startsWith(roleScopedPrefix)) {
    // Already new-format (defensive: bare strings are normally role-less legacy).
    if (value.length === roleScopedPrefix.length) return null;
    return { key: value, tag: value, state: "DELIVERED" };
  }
  if (value.startsWith(roleLessPrefix)) {
    const evidenceId = value.slice(roleLessPrefix.length);
    if (evidenceId.length === 0) return null;
    return {
      key: `${roleScopedPrefix}${evidenceId}`,
      tag: value,
      state: "DELIVERED",
    };
  }
  return null;
}

/**
 * Parse/migrate a stored ledger fail-closed. `[]` is a valid empty ledger; a
 * valid legacy `string[]` migrates (see migrateLegacyLedgerString); valid
 * structured entries are accepted. If ANY element has an unknown shape, a blank
 * key/tag, an unknown state or the whole value is not an array, the result is
 * `INVALID_DATA` (no silent drop). Duplicate keys are resolved conservatively:
 * the entry stays PENDING if any occurrence is PENDING (never loses a block). The
 * result is bounded (oldest-first pruning).
 */
export function parseNotificationLedger(
  raw: unknown,
  scope: string,
  max: number = NOTIFICATION_LEDGER_MAX,
): NotificationLedgerParseResult {
  if (!Array.isArray(raw)) return { ok: false, error: "INVALID_DATA" };
  const byKey = new Map<string, NotificationLedgerEntry>();
  let migrated = false;
  for (const item of raw) {
    let entry: NotificationLedgerEntry | null;
    if (typeof item === "string") {
      entry = migrateLegacyLedgerString(item, scope);
      if (entry === null) return { ok: false, error: "INVALID_DATA" };
      migrated = true;
    } else if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if (
        typeof record.key === "string" &&
        record.key.length > 0 &&
        typeof record.tag === "string" &&
        record.tag.length > 0 &&
        (record.state === "PENDING" || record.state === "DELIVERED")
      ) {
        entry = { key: record.key, tag: record.tag, state: record.state };
      } else {
        return { ok: false, error: "INVALID_DATA" };
      }
    } else {
      return { ok: false, error: "INVALID_DATA" };
    }
    const existing = byKey.get(entry.key);
    if (existing) {
      // Conflicting duplicate key → keep it PENDING (fail-closed: a PENDING
      // block is never downgraded to DELIVERED by a stray duplicate).
      const state =
        existing.state === "PENDING" || entry.state === "PENDING"
          ? "PENDING"
          : "DELIVERED";
      byKey.set(entry.key, { key: entry.key, tag: existing.tag, state });
    } else {
      byKey.set(entry.key, entry);
    }
  }
  let entries = [...byKey.values()];
  if (entries.length > max) entries = entries.slice(entries.length - max);
  return { ok: true, entries, migrated };
}

export function findLedgerEntry(
  entries: readonly NotificationLedgerEntry[],
  key: string,
): NotificationLedgerEntry | null {
  return entries.find((entry) => entry.key === key) ?? null;
}

/** Insert or replace an entry by key, bounded with oldest-first pruning. */
export function upsertLedgerEntry(
  entries: readonly NotificationLedgerEntry[],
  entry: NotificationLedgerEntry,
  max: number = NOTIFICATION_LEDGER_MAX,
): NotificationLedgerEntry[] {
  const next = entries.filter((existing) => existing.key !== entry.key);
  next.push(entry);
  return next.length > max ? next.slice(next.length - max) : next;
}

export function removeLedgerEntry(
  entries: readonly NotificationLedgerEntry[],
  key: string,
): NotificationLedgerEntry[] {
  return entries.filter((entry) => entry.key !== key);
}

/**
 * DELIVERED entries whose entity is no longer active → close candidates. Active
 * identity is compared by `key` (not `tag`), because a migrated legacy kitchen
 * entry has a role-scoped `key` but keeps the original role-less `tag`. The
 * reconciler closes the stored `entry.tag` (the real OS-notification tag) and
 * removes the entry by `entry.key`.
 */
export function selectStaleDeliveredEntries(
  entries: readonly NotificationLedgerEntry[],
  activeIntents: readonly DirectSystemNotificationIntent[],
): NotificationLedgerEntry[] {
  const active = new Set(activeIntents.map((intent) => intent.key));
  return entries.filter(
    (entry) => entry.state === "DELIVERED" && !active.has(entry.key),
  );
}

/**
 * Injectable ports for the delivery critical section. The pure reconciler drives
 * them; the hook wires real browser adapters (worker SHOW/CLOSE ACK over the
 * accepted MessageChannel protocol) and tests wire fakes (shared entry ledger +
 * serializing lock + async worker).
 */
export interface NotificationDeliveryPorts {
  readLedger: () => BrowserStorageReadResult<NotificationLedgerEntry[]>;
  writeLedger: (entries: NotificationLedgerEntry[]) => boolean;
  show: (intent: DirectSystemNotificationIntent) => Promise<boolean>;
  // Resolves true only after the worker ACKs the close; a stale entry is dropped
  // only on a confirmed close, so a failed/timed-out close is retried later.
  close: (tag: string) => Promise<boolean>;
  runExclusive: <T>(fn: () => Promise<T>) => Promise<NotificationLockResult<T>>;
}

export type NotificationReconcileOutcome =
  | { status: "OK"; shownKeys: string[] }
  | { status: "DEGRADED"; reason: NotificationDegradeReason; shownKeys: string[] };

/**
 * Fail-closed, browser-wide, exactly-once cross-tab delivery — the whole flow
 * runs inside a real exclusive lock (no unsynchronised fallback). Per intent:
 *  1. read the current durable ledger;
 *  2. if a PENDING/DELIVERED entry (any tab) or local quarantine exists — skip;
 *  3. write PENDING durably BEFORE showing (fail → DEGRADED, no show, stop);
 *  4. show via the accepted worker SHOW_ACK;
 *  5. on ACK, promote PENDING → DELIVERED (final-write fail → keep durable
 *     PENDING, await the worker CLOSE_ACK for the shown tag, quarantine locally,
 *     DEGRADED, stop — PENDING keeps blocking every tab);
 *  6. on no ACK, remove PENDING so it can be retried (removal fail → keep the
 *     durable PENDING as a fail-closed block, quarantine, DEGRADED, stop).
 * Stale DELIVERED entries are closed only after a confirmed CLOSE_ACK; a stale
 * PENDING is never auto-treated as shown and is never removed without proof.
 */
export async function reconcileNotificationDelivery(
  intents: readonly DirectSystemNotificationIntent[],
  quarantine: Set<string>,
  ports: NotificationDeliveryPorts,
): Promise<NotificationReconcileOutcome> {
  const locked = await ports.runExclusive(
    async (): Promise<{
      degraded: NotificationDegradeReason | null;
      shownKeys: string[];
    }> => {
      const read = ports.readLedger();
      if (!read.ok) return { degraded: "LEDGER_READ", shownKeys: [] };
      let entries = read.value;
      const shownKeys: string[] = [];

      for (const intent of intents) {
        // A durable PENDING/DELIVERED entry (any tab) or a local quarantine
        // blocks a repeat show.
        if (findLedgerEntry(entries, intent.key) !== null) continue;
        if (quarantine.has(intent.key)) continue;

        // Phase 1: durably record PENDING BEFORE the OS notification appears.
        const pending = upsertLedgerEntry(entries, {
          key: intent.key,
          tag: intent.tag,
          state: "PENDING",
        });
        if (!ports.writeLedger(pending)) {
          return { degraded: "LEDGER_WRITE", shownKeys };
        }
        entries = pending;

        // Phase 2: show and wait for the accepted worker SHOW_ACK.
        const acknowledged = await ports.show(intent);
        if (acknowledged) {
          const delivered = upsertLedgerEntry(entries, {
            key: intent.key,
            tag: intent.tag,
            state: "DELIVERED",
          });
          if (!ports.writeLedger(delivered)) {
            // Shown but final write failed: keep durable PENDING (still blocks
            // every tab), close the shown tag and WAIT for the CLOSE_ACK,
            // quarantine locally, degrade, stop.
            await ports.close(intent.tag);
            quarantine.add(intent.key);
            return { degraded: "LEDGER_WRITE", shownKeys };
          }
          entries = delivered;
          shownKeys.push(intent.key);
        } else {
          // No SHOW_ACK: remove PENDING so a later reconcile can retry.
          const cleaned = removeLedgerEntry(entries, intent.key);
          if (!ports.writeLedger(cleaned)) {
            // Cleanup failed: keep the durable PENDING as a fail-closed block.
            quarantine.add(intent.key);
            return { degraded: "LEDGER_WRITE", shownKeys };
          }
          entries = cleaned;
          return { degraded: "SHOW_FAILED", shownKeys };
        }
      }

      // Close DELIVERED notifications whose entity is no longer actionable, and
      // drop the entry ONLY after a confirmed CLOSE_ACK.
      const stale = selectStaleDeliveredEntries(entries, intents);
      if (stale.length > 0) {
        const closed: NotificationLedgerEntry[] = [];
        for (const entry of stale) {
          if (await ports.close(entry.tag)) closed.push(entry);
        }
        if (closed.length > 0) {
          let forgotten = entries;
          for (const entry of closed) forgotten = removeLedgerEntry(forgotten, entry.key);
          if (!ports.writeLedger(forgotten)) {
            return { degraded: "LEDGER_WRITE", shownKeys };
          }
          entries = forgotten;
        }
      }

      return { degraded: null, shownKeys };
    },
  );

  if (!locked.ok) {
    return { status: "DEGRADED", reason: locked.reason, shownKeys: [] };
  }
  const inner = locked.value;
  if (inner.degraded !== null) {
    return { status: "DEGRADED", reason: inner.degraded, shownKeys: inner.shownKeys };
  }
  return { status: "OK", shownKeys: inner.shownKeys };
}
