import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  acceptRestaurantOrder,
  addCartItem,
  assignDriverToOrder,
  createOrderFromCart,
  goDriverOnline,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { markDriverArrivedAtRestaurant } from "./driver-delivery.ts";
import { reportDriverOrderIncident } from "./driver-order-incidents.ts";
import type { Order, PrototypeState, ZoneId } from "./models.ts";
import {
  getRestaurantDelayAlerts,
  getRestaurantWaitingAnalyticsView,
  getRestaurantWaitingView,
} from "./restaurant-waiting-analytics.ts";

const DRIVER = "driver-1";
const OTHER_DRIVER = "driver-2";
const ZONE: ZoneId = "zone-2";
const T0 = "2026-01-01T10:00:00.000Z";
const T5 = "2026-01-01T10:05:00.000Z";
const T8 = "2026-01-01T10:08:00.000Z";
const T10 = "2026-01-01T10:10:00.000Z";
const T12 = "2026-01-01T10:12:00.000Z";
const T15 = "2026-01-01T10:15:00.000Z";
const T20 = "2026-01-01T10:20:00.000Z";

function preparingState(expectedReadyAt = T10): {
  state: PrototypeState;
  orderId: string;
} {
  let state = goDriverOnline(createDefaultState(), DRIVER, ZONE).state;
  state = goDriverOnline(state, OTHER_DRIVER, ZONE).state;
  state = updateCartAddress(state, { street: "Садовый переулок", house: "5" });
  state = addCartItem(state, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(state);
  assert.ok(created.result.orderId);
  const orderId = created.result.orderId;
  state = acceptRestaurantOrder(created.state, orderId, 20);
  state = simulateSuccessfulOnlinePayment(state, orderId);
  state = assignDriverToOrder(state, orderId, DRIVER).state;
  state = {
    ...state,
    orders: state.orders.map((order) =>
      order.id === orderId
        ? {
            ...order,
            createdAt: T0,
            kitchenStartedAt: T0,
            expectedReadyAt,
          }
        : order,
    ),
  };
  return { state, orderId };
}

function arrive(
  state: PrototypeState,
  orderId: string,
  occurredAt = T5,
): PrototypeState {
  const result = markDriverArrivedAtRestaurant(state, DRIVER, orderId, occurredAt);
  assert.equal(result.result.ok, true);
  return result.state;
}

function ready(
  state: PrototypeState,
  orderId: string,
  occurredAt: string,
): PrototypeState {
  return {
    ...state,
    orders: state.orders.map((order) =>
      order.id === orderId
        ? {
            ...order,
            status: "READY" as const,
            history: [
              ...order.history,
              {
                id: `${order.id}-ready-test-${occurredAt}`,
                occurredAt,
                actor: "RESTAURANT" as const,
                type: "STATUS" as const,
                fromStatus: "PREPARING" as const,
                toStatus: "READY" as const,
                message: "ignored human text",
              },
            ],
          }
        : order,
    ),
  };
}

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((item) => item.id === orderId);
  assert.ok(order);
  return order;
}

test("1-3: wait starts only at ARRIVED and lateness starts only after ETA", () => {
  const base = preparingState();
  assert.equal(
    getRestaurantWaitingView(base.state, base.orderId, T15).status,
    "NOT_ARRIVED",
  );
  const state = arrive(base.state, base.orderId);
  const beforeEta = getRestaurantWaitingView(state, base.orderId, T8);
  assert.equal(beforeEta.status, "WAITING");
  assert.equal(beforeEta.waitingDurationMs, 3 * 60_000);
  assert.equal(beforeEta.restaurantDelayMs, 0);
  const afterEta = getRestaurantWaitingView(state, base.orderId, T15);
  assert.equal(afterEta.waitingDurationMs, 10 * 60_000);
  assert.equal(afterEta.restaurantDelayMs, 5 * 60_000);
});

test("4-5: structured READY freezes completed waiting across later reads", () => {
  const base = preparingState();
  const state = ready(arrive(base.state, base.orderId), base.orderId, T12);
  const first = getRestaurantWaitingView(state, base.orderId, T15);
  const later = getRestaurantWaitingView(state, base.orderId, T20);
  assert.equal(first.status, "READY");
  assert.equal(first.waitingDurationMs, 7 * 60_000);
  assert.equal(first.restaurantDelayMs, 2 * 60_000);
  assert.equal(later.waitingDurationMs, first.waitingDurationMs);
  assert.equal(later.restaurantDelayMs, first.restaurantDelayMs);
});

test("6-7: READY before arrival gives zero wait and a late driver creates no false delay", () => {
  const base = preparingState();
  const readyState = ready(base.state, base.orderId, T8);
  const state = arrive(readyState, base.orderId, T15);
  const view = getRestaurantWaitingView(state, base.orderId, T20);
  assert.equal(view.status, "READY");
  assert.equal(view.readyAtArrival, true);
  assert.equal(view.waitingDurationMs, 0);
  assert.equal(view.restaurantDelayMs, 0);
  assert.equal(view.lostDriverTimeMs, 0);
});

test("8-10: duplicate/corrupt arrival and contradictory READY evidence fail closed", () => {
  const base = preparingState();
  const state = arrive(base.state, base.orderId);
  const event = state.driverDeliveryEvents.at(-1)!;
  const duplicate = {
    ...state,
    driverDeliveryEvents: [
      ...state.driverDeliveryEvents,
      { ...event, id: `${event.id}-duplicate` },
    ],
  };
  assert.equal(
    getRestaurantWaitingView(duplicate, base.orderId, T15).status,
    "REVIEW_REQUIRED",
  );
  const corrupt = {
    ...state,
    driverDeliveryEvents: state.driverDeliveryEvents.map((item) =>
      item.id === event.id ? { ...item, occurredAt: "not-an-iso-date" } : item,
    ),
  };
  assert.equal(
    getRestaurantWaitingView(corrupt, base.orderId, T15).status,
    "REVIEW_REQUIRED",
  );
  const oneReady = ready(state, base.orderId, T12);
  const order = orderOf(oneReady, base.orderId);
  const contradictory = {
    ...oneReady,
    orders: oneReady.orders.map((item) =>
      item.id === base.orderId
        ? {
            ...item,
            history: [
              ...item.history,
              { ...order.history.at(-1)!, id: "contradictory-ready", occurredAt: T15 },
            ],
          }
        : item,
    ),
  };
  assert.equal(
    getRestaurantWaitingView(contradictory, base.orderId, T20).status,
    "REVIEW_REQUIRED",
  );
});

test("11-14: PREPARING permits only proven late ORDER_DELAYED and keeps one open incident", () => {
  const base = preparingState();
  const late = arrive(base.state, base.orderId, T5);
  const allowed = reportDriverOrderIncident(late, {
    driverId: DRIVER,
    orderId: base.orderId,
    reason: "ORDER_DELAYED",
    details: "",
  });
  assert.equal(allowed.result.ok, true);
  const duplicate = reportDriverOrderIncident(allowed.state, {
    driverId: DRIVER,
    orderId: base.orderId,
    reason: "ORDER_DELAYED",
    details: "",
  });
  assert.equal(duplicate.result.ok, false);
  assert.equal(duplicate.state, allowed.state);

  const beforeEtaBase = preparingState("2099-01-01T10:10:00.000Z");
  const beforeEta = arrive(beforeEtaBase.state, beforeEtaBase.orderId, T5);
  for (const result of [
    reportDriverOrderIncident(beforeEta, {
      driverId: DRIVER,
      orderId: beforeEtaBase.orderId,
      reason: "ORDER_DELAYED",
      details: "",
    }),
    reportDriverOrderIncident(late, {
      driverId: OTHER_DRIVER,
      orderId: base.orderId,
      reason: "ORDER_DELAYED",
      details: "",
    }),
    reportDriverOrderIncident(late, {
      driverId: DRIVER,
      orderId: base.orderId,
      reason: "WRONG_ADDRESS",
      details: "",
    }),
  ]) {
    assert.equal(result.result.ok, false);
  }
});

test("15-16: derived Direct alert exists without incident and disappears after READY", () => {
  const base = preparingState();
  const waiting = arrive(base.state, base.orderId);
  const alerts = getRestaurantDelayAlerts(waiting, T15);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].driverIncidentExists, false);
  assert.equal(alerts[0].restaurantDelayMs, 5 * 60_000);
  assert.deepEqual(getRestaurantDelayAlerts(ready(waiting, base.orderId, T12), T15), []);
});

test("17-20: restaurant analytics separates completed/active and counts only actual lost time", () => {
  const completedBase = preparingState();
  const completed = ready(
    arrive(completedBase.state, completedBase.orderId, T5),
    completedBase.orderId,
    T12,
  );
  const activeBase = preparingState();
  const activeOrder = orderOf(activeBase.state, activeBase.orderId);
  const activeId = `${activeBase.orderId}-active`;
  const combined: PrototypeState = {
    ...completed,
    orders: [
      ...completed.orders,
      { ...activeOrder, id: activeId, publicNumber: "ACTIVE-1" },
    ],
    driverDeliveryEvents: [
      ...completed.driverDeliveryEvents,
      {
        id: "active-arrival",
        orderId: activeId,
        driverId: DRIVER,
        type: "ARRIVED_AT_RESTAURANT",
        occurredAt: T12,
        orderStatusBefore: "PREPARING",
        orderStatusAfter: "PREPARING",
      },
    ],
  };
  const analytics = getRestaurantWaitingAnalyticsView(
    combined,
    activeOrder.restaurant.id,
    T15,
  );
  assert.equal(analytics.provenArrivalCount, 2);
  assert.equal(analytics.readyAtArrivalCount, 0);
  assert.equal(analytics.completedWaitingSampleCount, 1);
  assert.equal(analytics.activeWaitingSampleCount, 1);
  assert.equal(analytics.averageCompletedWaitingMs, 7 * 60_000);
  assert.equal(analytics.restaurantDelayCaseCount, 1);
  assert.equal(analytics.activeDelayCount, 1);
  assert.equal(analytics.totalLostDriverTimeMs, 5 * 60_000);
});

test("21-22: read models do not mutate domain, finance, zones, payouts or dispatch waves", () => {
  const base = preparingState();
  const state = arrive(base.state, base.orderId);
  const before = JSON.stringify(state);
  const protectedBefore = JSON.stringify({
    zones: state.zones,
    tariffs: state.tariffs,
    settlements: state.settlements,
    earnings: state.driverEarningEntries,
    payouts: state.driverPayoutBatches,
    waves: state.driverDispatchWaves,
  });
  getRestaurantWaitingView(state, base.orderId, T15);
  getRestaurantDelayAlerts(state, T15);
  getRestaurantWaitingAnalyticsView(state, orderOf(state, base.orderId).restaurant.id, T15);
  assert.equal(JSON.stringify(state), before);
  assert.equal(
    JSON.stringify({
      zones: state.zones,
      tariffs: state.tariffs,
      settlements: state.settlements,
      earnings: state.driverEarningEntries,
      payouts: state.driverPayoutBatches,
      waves: state.driverDispatchWaves,
    }),
    protectedBefore,
  );
});

test("presentation: live wait, delay action and admin derived warning use canonical view", () => {
  const workspace = readFileSync("src/components/driver/driver-workspace.tsx", "utf8");
  const admin = readFileSync("src/app/admin/driver-incidents/page.tsx", "utf8");
  for (const text of [
    "Ждёте",
    "Ресторан готовит заказ",
    "Ожидаемая готовность",
    "Ресторан опаздывает",
    "Сообщить о задержке",
    'openIncidentSheet("ORDER_DELAYED")',
  ]) assert.ok(workspace.includes(text), text);
  assert.ok(workspace.includes("getRestaurantWaitingView"));
  assert.ok(!workspace.includes("Заказ ещё готовится"));
  assert.ok(admin.includes("getRestaurantDelayAlerts"));
  assert.ok(admin.includes("Автоматические задержки ресторанов"));
  assert.ok(admin.includes("Incident водителя"));
});
