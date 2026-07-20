import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  createOrderFromCart,
  markOrderReadyWithResult,
  setCartFulfillmentChoice,
  simulateSuccessfulOnlinePaymentWithResult,
  startKitchenPreparationWithResult,
  updateCartAddress,
} from "./actions.ts";
import {
  getKitchenPendingStartOrders,
  getKitchenPreparingOrders,
  isAwaitingKitchenStart,
} from "./selectors.ts";
import { getTicketReadyLine } from "../components/kitchen/kitchen-production-ticket-data.ts";
import type { PrototypeState, RestaurantOrderWorkflowMode } from "./models.ts";

/**
 * SPLIT: принятый и оплаченный заказ сначала «новый» для кухни и только после
 * «Начать готовить» переходит в «Готовятся» с запущенным отсчётом. COMBINED
 * сохраняет прежнее поведение — начало и время фиксируются сразу.
 */

const RID = "restaurant-2";

function orderState(
  mode: RestaurantOrderWorkflowMode,
  fulfillment: "PICKUP" | "DELIVERY" = "PICKUP",
): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === RID ? { ...r, orderWorkflowMode: mode } : r,
    ),
  };
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  }
  s = addCartItem(s, `${RID}-item-1`).state;
  const created = createOrderFromCart(s);
  return { state: created.state, orderId: created.result.orderId as string };
}

const getOrder = (state: PrototypeState, orderId: string) => {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
};

function acceptedSplit(
  fulfillment: "PICKUP" | "DELIVERY" = "PICKUP",
): { state: PrototypeState; orderId: string } {
  const { state, orderId } = orderState("SPLIT_OPERATOR_KITCHEN", fulfillment);
  const accepted = acceptRestaurantOrderWithResult(
    state,
    orderId,
    20,
    "RESTAURANT",
    "OPERATOR",
  ).state;
  return { state: accepted, orderId };
}

// 1/2 — принятие в SPLIT не запускает таймер --------------------------------------

test("SPLIT + оплата в ресторане: после принятия нет начала и нет времени", () => {
  const { state, orderId } = acceptedSplit();
  const order = getOrder(state, orderId);
  assert.equal(order.status, "PREPARING");
  assert.equal(order.paymentMethod, "PAY_AT_RESTAURANT");
  assert.equal(order.preparationMinutes, 20);
  assert.equal(order.kitchenStartedAt, null);
  assert.equal(order.expectedReadyAt, null);
  assert.equal(isAwaitingKitchenStart(order), true);
});

// 3/4 — онлайн ---------------------------------------------------------------------

test("SPLIT + ONLINE: до оплаты кухня заказ не видит", () => {
  const { state, orderId } = acceptedSplit("DELIVERY");
  const order = getOrder(state, orderId);
  assert.equal(order.status, "AWAITING_PAYMENT");
  assert.equal(order.kitchenStartedAt, null);
  assert.equal(order.expectedReadyAt, null);
  assert.equal(getKitchenPendingStartOrders(state, RID).length, 0);
  assert.equal(getKitchenPreparingOrders(state, RID).length, 0);
});

test("SPLIT + ONLINE: после оплаты заказ новый для кухни, без таймера", () => {
  const accepted = acceptedSplit("DELIVERY");
  const paid = simulateSuccessfulOnlinePaymentWithResult(
    accepted.state,
    accepted.orderId,
  );
  assert.equal(paid.result.ok, true);
  const order = getOrder(paid.state, accepted.orderId);
  assert.equal(order.status, "PREPARING");
  assert.equal(order.paymentStatus, "PAID");
  assert.equal(order.kitchenStartedAt, null);
  assert.equal(order.expectedReadyAt, null);
  assert.equal(getKitchenPendingStartOrders(paid.state, RID).length, 1);
  assert.equal(getKitchenPreparingOrders(paid.state, RID).length, 0);
});

// 5 — COMBINED не изменился ---------------------------------------------------------

test("COMBINED: начало и время готовности создаются сразу", () => {
  const { state, orderId } = orderState("COMBINED");
  const accepted = acceptRestaurantOrderWithResult(
    state,
    orderId,
    20,
    "RESTAURANT",
    "COMBINED",
  ).state;
  const order = getOrder(accepted, orderId);
  assert.equal(order.status, "PREPARING");
  assert.ok(order.kitchenStartedAt);
  assert.ok(order.expectedReadyAt);
  const deltaMin =
    (Date.parse(order.expectedReadyAt as string) -
      Date.parse(order.kitchenStartedAt as string)) /
    60_000;
  assert.equal(deltaMin, 20);
  // Подэтапа ожидания в COMBINED нет.
  assert.equal(getKitchenPendingStartOrders(accepted, RID).length, 0);
  assert.equal(getKitchenPreparingOrders(accepted, RID).length, 1);
});

// 6/7/8 — селекторы -----------------------------------------------------------------

test("селекторы не пересекаются: заказ либо новый, либо готовится", () => {
  const { state, orderId } = acceptedSplit();
  const pendingIds = getKitchenPendingStartOrders(state, RID).map((o) => o.id);
  const preparingIds = getKitchenPreparingOrders(state, RID).map((o) => o.id);
  assert.deepEqual(pendingIds, [orderId]);
  assert.deepEqual(preparingIds, []);

  const started = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  ).state;
  assert.deepEqual(
    getKitchenPendingStartOrders(started, RID).map((o) => o.id),
    [],
  );
  assert.deepEqual(
    getKitchenPreparingOrders(started, RID).map((o) => o.id),
    [orderId],
  );
});

test("pending-селектор пуст для не-PREPARING статусов", () => {
  const { state, orderId } = acceptedSplit();
  const started = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  ).state;
  const ready = markOrderReadyWithResult(
    started,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  ).state;
  assert.equal(getKitchenPendingStartOrders(ready, RID).length, 0);
  assert.equal(getKitchenPreparingOrders(ready, RID).length, 0);
});

// 9 — старт задаёт время ------------------------------------------------------------

test("«Начать готовить» задаёт начало и время готовности от клика", () => {
  const { state, orderId } = acceptedSplit();
  const res = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(res.result.ok, true);
  const order = getOrder(res.state, orderId);
  assert.equal(order.status, "PREPARING");
  assert.ok(order.kitchenStartedAt);
  assert.ok(order.expectedReadyAt);
  assert.equal(isAwaitingKitchenStart(order), false);
  const deltaMin =
    (Date.parse(order.expectedReadyAt as string) -
      Date.parse(order.kitchenStartedAt as string)) /
    60_000;
  assert.equal(deltaMin, 20);
});

// 17 — производственный лист ---------------------------------------------------------

test("лист до старта: честная строка без выдуманного времени", () => {
  const { state, orderId } = acceptedSplit();
  const line = getTicketReadyLine(getOrder(state, orderId), "Europe/Chisinau");
  assert.equal(line, "КУХНЯ ЕЩЁ НЕ НАЧАЛА · ВРЕМЯ ПРИГОТОВЛЕНИЯ: 20 МИН");
  assert.ok(!/\d\d:\d\d/.test(line), "нет фиктивного HH:MM");
  assert.ok(!line.includes("ПОСЛЕ ОПЛАТЫ"), "оплата уже пройдена");
  assert.ok(!line.includes("не задана"));
});

test("лист после старта: обычная ожидаемая готовность", () => {
  const { state, orderId } = acceptedSplit();
  const started = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  ).state;
  const line = getTicketReadyLine(
    getOrder(started, orderId),
    "Europe/Chisinau",
  );
  assert.ok(line.startsWith("ОЖИДАЕМАЯ ГОТОВНОСТЬ: К "));
  assert.ok(/\d\d:\d\d/.test(line));
});

// 16 — готовность --------------------------------------------------------------------

test("markReady: до старта запрещён, после старта успешен", () => {
  const { state, orderId } = acceptedSplit();
  const early = markOrderReadyWithResult(state, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(early.result.ok, false);
  assert.equal(early.result.error, "Сначала подтвердите начало приготовления.");
  assert.equal(early.state, state);

  const started = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  ).state;
  const ready = markOrderReadyWithResult(
    started,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(ready.result.ok, true);
});
