import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import type {
  DriverOffer,
  Order,
  PrototypeState,
} from "./models.ts";
import { DRIVER_OFFER_SOUND_KEY } from "../components/driver/driver-offer-sound-logic.ts";
import {
  buildDriverNotificationIntents,
  buildKitchenNotificationIntents,
  driverNotificationPreferenceKey,
  driverOfferNotificationTag,
  forgetDeliveredKeys,
  kitchenActionableEvidenceId,
  kitchenNotificationPreferenceKey,
  kitchenOrderNotificationTag,
  ledgerAfterDeliveryAttempt,
  NOTIFICATION_LEDGER_MAX,
  notificationAudienceScope,
  recordDeliveredKey,
  resolveDirectNotificationCapability,
  selectStaleNotificationTags,
  selectUndeliveredIntents,
  type DirectSystemNotificationIntent,
} from "./direct-notifications.ts";
import {
  isApprovedNotificationRoute,
  validateWorkerNotificationMessage,
} from "./direct-notification-worker-contract.ts";
import { getAudibleKitchenReviewOrders } from "./selectors.ts";

const DRIVER = "driver-1";
const OTHER_DRIVER = "driver-2";
const REST = "restaurant-2";
const T0 = "2026-07-31T10:00:00.000Z";
const NOW = Date.parse("2026-07-31T10:01:00.000Z");
const FUTURE = "2026-07-31T10:05:00.000Z";
const PAST = "2026-07-31T10:00:30.000Z";

function offer(over: Partial<DriverOffer> = {}): DriverOffer {
  return {
    id: "offer-1",
    orderId: "o-1",
    driverId: DRIVER,
    status: "OPEN",
    offeredAt: T0,
    expiresAt: FUTURE,
    resolvedAt: null,
    ...over,
  } as unknown as DriverOffer;
}

function offerState(offers: DriverOffer[]): PrototypeState {
  return { ...createDefaultState(), driverOffers: offers, orders: [] };
}

function reviewOrder(over: Partial<Order> = {}): Order {
  return {
    id: "o-rev",
    publicNumber: "R-1",
    createdAt: T0,
    updatedAt: T0,
    status: "RESTAURANT_REVIEW",
    restaurant: { id: REST, name: "Р2", address: "адрес", zoneId: "zone-2" },
    history: [],
    items: [],
    etaAdjustments: [],
    ...over,
  } as unknown as Order;
}

function kitchenState(orders: Order[]): PrototypeState {
  return { ...createDefaultState(), orders };
}

// --- 1-6: capability -----------------------------------------------------------

test("1-6: capability resolution across the four inputs", () => {
  assert.equal(
    resolveDirectNotificationCapability({
      supported: false,
      permission: null,
      preferenceEnabled: true,
      workerReady: true,
    }).status,
    "UNSUPPORTED",
  );
  assert.equal(
    resolveDirectNotificationCapability({
      supported: true,
      permission: "default",
      preferenceEnabled: true,
      workerReady: true,
    }).status,
    "PERMISSION_REQUIRED",
  );
  assert.equal(
    resolveDirectNotificationCapability({
      supported: true,
      permission: "denied",
      preferenceEnabled: true,
      workerReady: true,
    }).status,
    "DENIED",
  );
  assert.equal(
    resolveDirectNotificationCapability({
      supported: true,
      permission: "granted",
      preferenceEnabled: false,
      workerReady: true,
    }).status,
    "DISABLED",
  );
  assert.equal(
    resolveDirectNotificationCapability({
      supported: true,
      permission: "granted",
      preferenceEnabled: true,
      workerReady: true,
    }).status,
    "ENABLED",
  );
  assert.equal(
    resolveDirectNotificationCapability({
      supported: true,
      permission: "granted",
      preferenceEnabled: true,
      workerReady: false,
    }).status,
    "DEGRADED",
  );
});

// --- 9-10: preference isolation ------------------------------------------------

test("9: driver and kitchen preferences are independent keys", () => {
  const driverKey = driverNotificationPreferenceKey(DRIVER);
  const otherDriverKey = driverNotificationPreferenceKey(OTHER_DRIVER);
  const kitchenKey = kitchenNotificationPreferenceKey(REST, "COMBINED");
  assert.notEqual(driverKey, otherDriverKey);
  assert.notEqual(driverKey, kitchenKey);
  // Never the sound preference key.
  assert.notEqual(driverKey, DRIVER_OFFER_SOUND_KEY);
});

test("10: kitchen preference scoped by restaurant AND role", () => {
  assert.notEqual(
    kitchenNotificationPreferenceKey(REST, "COMBINED"),
    kitchenNotificationPreferenceKey(REST, "OPERATOR"),
  );
  assert.notEqual(
    kitchenNotificationPreferenceKey(REST, "COMBINED"),
    kitchenNotificationPreferenceKey("restaurant-1", "COMBINED"),
  );
});

// --- 11-22: driver intents -----------------------------------------------------

test("11-12: one OPEN offer → one stable-key intent; repeat build is idempotent", () => {
  const state = offerState([offer()]);
  const a = buildDriverNotificationIntents(state, DRIVER, NOW);
  const b = buildDriverNotificationIntents(state, DRIVER, NOW);
  assert.equal(a.length, 1);
  assert.deepEqual(
    a.map((i) => i.key),
    b.map((i) => i.key),
  );
});

test("13: dedupe — an already-delivered key yields no new intent to show", () => {
  const state = offerState([offer()]);
  const intents = buildDriverNotificationIntents(state, DRIVER, NOW);
  const ledger = [intents[0].key];
  assert.deepEqual(selectUndeliveredIntents(intents, ledger), []);
});

test("14-17: expired/declined/accepted/other-driver offers create no intent", () => {
  assert.equal(
    buildDriverNotificationIntents(
      offerState([offer({ expiresAt: PAST })]),
      DRIVER,
      NOW,
    ).length,
    0,
  );
  for (const status of ["DECLINED", "ACCEPTED", "CANCELED", "EXPIRED"] as const) {
    assert.equal(
      buildDriverNotificationIntents(
        offerState([offer({ status })]),
        DRIVER,
        NOW,
      ).length,
      0,
      status,
    );
  }
  assert.equal(
    buildDriverNotificationIntents(
      offerState([offer({ driverId: OTHER_DRIVER })]),
      DRIVER,
      NOW,
    ).length,
    0,
  );
});

test("18-21: driver text is privacy-safe and the key is offer-id based", () => {
  const state = offerState([offer({ id: "offer-xyz" })]);
  const intent = buildDriverNotificationIntents(state, DRIVER, NOW)[0];
  const text = `${intent.title}\n${intent.body}`;
  // No full address, phone or comment before acceptance.
  assert.ok(!/\d{2,}/.test(text), "no house numbers / phone digits");
  assert.ok(!text.toLowerCase().includes("ул."));
  assert.ok(!text.includes("+"));
  assert.equal(intent.tag, driverOfferNotificationTag("offer-xyz"));
  assert.equal(intent.tag, "driver-offer:offer-xyz");
});

test("22: after resolution the delivered driver tag is reported stale", () => {
  const state = offerState([offer({ id: "offer-1" })]);
  const intents = buildDriverNotificationIntents(state, DRIVER, NOW);
  const ledger = [intents[0].key];
  // Offer accepted → no longer an active intent → stale.
  const resolved = offerState([offer({ id: "offer-1", status: "ACCEPTED" })]);
  const active = buildDriverNotificationIntents(resolved, DRIVER, NOW);
  assert.deepEqual(selectStaleNotificationTags(active, ledger), [intents[0].key]);
});

// --- 23-32: kitchen intents ----------------------------------------------------

test("23: kitchen intents mirror the canonical actionable selector", () => {
  const state = kitchenState([
    reviewOrder({ id: "o-a", publicNumber: "A-1" }),
    reviewOrder({ id: "o-b", publicNumber: "B-1" }),
  ]);
  const selectorIds = getAudibleKitchenReviewOrders(state, REST, NOW)
    .map((o) => o.id)
    .sort();
  const intentIds = buildKitchenNotificationIntents(state, REST, "COMBINED", NOW)
    .map((i) => i.entityId)
    .sort();
  assert.deepEqual(intentIds, selectorIds);
});

test("24-25: one actionable order → one stable key; dedupe blocks repeats", () => {
  const state = kitchenState([reviewOrder()]);
  const intents = buildKitchenNotificationIntents(state, REST, "COMBINED", NOW);
  assert.equal(intents.length, 1);
  assert.deepEqual(selectUndeliveredIntents(intents, [intents[0].key]), []);
});

test("26: order beyond the freshness window creates no intent", () => {
  const stale = kitchenState([
    reviewOrder({ createdAt: "2026-07-31T09:50:00.000Z" }),
  ]);
  assert.equal(
    buildKitchenNotificationIntents(stale, REST, "COMBINED", NOW).length,
    0,
  );
});

test("27-29: other restaurant / non-review status create no intent", () => {
  assert.equal(
    buildKitchenNotificationIntents(
      kitchenState([
        reviewOrder({
          restaurant: { id: "restaurant-1", name: "Р1", address: "a", zoneId: "zone-1" },
        }),
      ]),
      REST,
      "COMBINED",
      NOW,
    ).length,
    0,
  );
  for (const status of ["PREPARING", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELED"] as const) {
    assert.equal(
      buildKitchenNotificationIntents(
        kitchenState([reviewOrder({ status })]),
        REST,
        "COMBINED",
        NOW,
      ).length,
      0,
      status,
    );
  }
});

test("30: kitchen key uses structured evidence, not message text", () => {
  const withEvent = reviewOrder({
    id: "o-evt",
    history: [
      {
        id: "evt-review-1",
        occurredAt: T0,
        actor: "SYSTEM",
        type: "STATUS",
        fromStatus: null,
        toStatus: "RESTAURANT_REVIEW",
        message: "любой человекочитаемый текст",
      },
    ],
  } as unknown as Partial<Order>);
  assert.equal(kitchenActionableEvidenceId(withEvent), "evt-review-1");
  // Changing the message text does not change the evidence id.
  const renamed = {
    ...withEvent,
    history: [{ ...(withEvent.history[0] as object), message: "другое" }],
  } as unknown as Order;
  assert.equal(kitchenActionableEvidenceId(renamed), "evt-review-1");
  // No structured event → deterministic id/createdAt fallback (still not text).
  const fallback = reviewOrder({ id: "o-f", createdAt: T0, history: [] });
  assert.equal(kitchenActionableEvidenceId(fallback), `o-f:${T0}`);
});

test("31: after leaving the actionable queue the kitchen tag is stale", () => {
  const state = kitchenState([reviewOrder({ id: "o-x" })]);
  const intents = buildKitchenNotificationIntents(state, REST, "COMBINED", NOW);
  const ledger = [intents[0].key];
  // Order started → no longer RESTAURANT_REVIEW.
  const started = kitchenState([reviewOrder({ id: "o-x", status: "PREPARING" })]);
  const active = buildKitchenNotificationIntents(started, REST, "COMBINED", NOW);
  assert.deepEqual(selectStaleNotificationTags(active, ledger), ledger);
});

test("32: kitchen body carries only the public number, no phone/address", () => {
  const state = kitchenState([reviewOrder({ publicNumber: "R-42" })]);
  const intent = buildKitchenNotificationIntents(state, REST, "COMBINED", NOW)[0];
  assert.ok(intent.body.includes("R-42"));
  assert.ok(!intent.body.includes("+"));
  assert.ok(!intent.body.toLowerCase().includes("ул."));
  assert.equal(
    intent.tag,
    kitchenOrderNotificationTag(REST, kitchenActionableEvidenceId(reviewOrder({ publicNumber: "R-42" }))),
  );
});

// --- 33-37: dedupe ledger ------------------------------------------------------

test("33: two serialized tabs show one intent at most", () => {
  const state = offerState([offer({ id: "offer-1" })]);
  const intents = buildDriverNotificationIntents(state, DRIVER, NOW);
  // Tab A: nothing delivered yet → shows, records.
  let ledger: string[] = [];
  const aShow = selectUndeliveredIntents(intents, ledger);
  assert.equal(aShow.length, 1);
  ledger = ledgerAfterDeliveryAttempt(ledger, aShow[0].key, true);
  // Tab B reads the shared, updated ledger → nothing left to show.
  const bShow = selectUndeliveredIntents(intents, ledger);
  assert.equal(bShow.length, 0);
});

test("34-35: delivered key recorded only on success", () => {
  assert.deepEqual(ledgerAfterDeliveryAttempt([], "k", true), ["k"]);
  assert.deepEqual(ledgerAfterDeliveryAttempt([], "k", false), []);
});

test("36: ledger scope is audience-specific", () => {
  const driverScope = notificationAudienceScope({ type: "DRIVER", driverId: DRIVER });
  const kitchenScope = notificationAudienceScope({
    type: "KITCHEN",
    restaurantId: REST,
    workspaceRole: "COMBINED",
  });
  assert.notEqual(driverScope, kitchenScope);
  // Role does not split the kitchen ledger (COMBINED+OPERATOR dedupe together).
  assert.equal(
    kitchenScope,
    notificationAudienceScope({
      type: "KITCHEN",
      restaurantId: REST,
      workspaceRole: "OPERATOR",
    }),
  );
});

test("37: ledger is bounded with deterministic oldest-first pruning", () => {
  let ledger: string[] = [];
  for (let i = 0; i < NOTIFICATION_LEDGER_MAX + 5; i += 1) {
    ledger = recordDeliveredKey(ledger, `k${i}`);
  }
  assert.equal(ledger.length, NOTIFICATION_LEDGER_MAX);
  assert.equal(ledger[0], "k5"); // oldest five pruned deterministically
  assert.equal(ledger[ledger.length - 1], `k${NOTIFICATION_LEDGER_MAX + 4}`);
  assert.deepEqual(forgetDeliveredKeys(["a", "b", "c"], ["b"]), ["a", "c"]);
});

// --- 38-43: worker contract ----------------------------------------------------

test("38: worker validation rejects external / protocol-relative / traversal URLs", () => {
  for (const url of [
    "https://evil.example/x",
    "//evil.example",
    "/driver/../admin",
    "http://localhost/driver",
    "/unknown-route",
    "",
  ]) {
    assert.equal(isApprovedNotificationRoute(url), false, url);
  }
  for (const url of ["/driver", "/restaurant/kitchen", "/restaurant/operator", "/driver?x=1"]) {
    assert.equal(isApprovedNotificationRoute(url), true, url);
  }
  const show = {
    type: "SHOW_DIRECT_NOTIFICATION",
    notification: {
      tag: "driver-offer:1",
      title: "T",
      body: "B",
      url: "https://evil.example",
      entityKind: "DRIVER_OFFER",
      entityId: "1",
    },
  };
  assert.equal(validateWorkerNotificationMessage(show), null);
});

test("39: worker validation rejects unknown types and bad payloads", () => {
  assert.equal(validateWorkerNotificationMessage({ type: "NUKE" }), null);
  assert.equal(validateWorkerNotificationMessage(null), null);
  assert.equal(validateWorkerNotificationMessage("string"), null);
  assert.equal(
    validateWorkerNotificationMessage({
      type: "SHOW_DIRECT_NOTIFICATION",
      notification: {
        tag: "t",
        title: "",
        body: "b",
        url: "/driver",
        entityKind: "DRIVER_OFFER",
        entityId: "1",
      },
    }),
    null,
    "blank title rejected",
  );
  assert.equal(
    validateWorkerNotificationMessage({
      type: "SHOW_DIRECT_NOTIFICATION",
      notification: {
        tag: "t",
        title: "x",
        body: "b",
        url: "/driver",
        entityKind: "WHATEVER",
        entityId: "1",
      },
    }),
    null,
    "unknown entityKind rejected",
  );
});

test("42-43: valid show has no action buttons; close message validates", () => {
  const show = validateWorkerNotificationMessage({
    type: "SHOW_DIRECT_NOTIFICATION",
    notification: {
      tag: "driver-offer:1",
      title: "Новый заказ Direct",
      body: "Откройте Direct.",
      url: "/driver",
      entityKind: "DRIVER_OFFER",
      entityId: "1",
    },
  });
  assert.ok(show && show.type === "SHOW_DIRECT_NOTIFICATION");
  // Payload is a fixed shape — no `actions` field ever passes through.
  assert.deepEqual(
    Object.keys(show.notification).sort(),
    ["body", "entityId", "entityKind", "tag", "title", "url"],
  );
  const close = validateWorkerNotificationMessage({
    type: "CLOSE_DIRECT_NOTIFICATION",
    tag: "driver-offer:1",
  });
  assert.deepEqual(close, { type: "CLOSE_DIRECT_NOTIFICATION", tag: "driver-offer:1" });
});

// --- 48-57: purity / no persisted prefs / scope --------------------------------

test("48: PrototypeState carries no notification preferences", () => {
  const state = createDefaultState() as unknown as Record<string, unknown>;
  for (const key of Object.keys(state)) {
    assert.ok(!key.toLowerCase().includes("notification"), key);
  }
});

test("49-57: notification read-models do not mutate state", () => {
  const state: PrototypeState = {
    ...createDefaultState(),
    driverOffers: [offer({ id: "offer-1" })],
    orders: [reviewOrder({ id: "o-rev" })],
  };
  const before = JSON.stringify(state);
  const driverIntents = buildDriverNotificationIntents(state, DRIVER, NOW);
  const kitchenIntents = buildKitchenNotificationIntents(state, REST, "COMBINED", NOW);
  const ledger = recordDeliveredKey([], driverIntents[0]?.key ?? "x");
  selectUndeliveredIntents([...driverIntents, ...kitchenIntents], ledger);
  selectStaleNotificationTags(driverIntents, ledger);
  assert.equal(JSON.stringify(state), before);
});

test("intents are plain data (no functions leak into payloads)", () => {
  const state = offerState([offer()]);
  const intent: DirectSystemNotificationIntent = buildDriverNotificationIntents(
    state,
    DRIVER,
    NOW,
  )[0];
  for (const value of Object.values(intent)) {
    assert.notEqual(typeof value, "function");
  }
});
