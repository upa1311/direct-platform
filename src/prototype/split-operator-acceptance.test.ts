import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  createOrderFromCart,
  expireUnansweredRestaurantOrders,
  markOrderReadyWithResult,
  rejectRestaurantOrderWithResult,
  setCartFulfillmentChoice,
  simulateSuccessfulOnlinePaymentWithResult,
  startKitchenPreparationWithResult,
  updateCartAddress,
  RESTAURANT_RESPONSE_TIMEOUT_MS,
} from "./actions.ts";
import { getKitchenNewOrders, getKitchenPreparingOrders } from "./selectors.ts";
import type { PrototypeState, RestaurantOrderWorkflowMode } from "./models.ts";

/**
 * Перераспределение обязанностей в SPLIT: решение по новому заказу принимает
 * оператор, кухня получает только уже принятый заказ. Проверяется домен и
 * правило видимости — не React.
 */

function orderState(
  mode: RestaurantOrderWorkflowMode,
  fulfillment: "PICKUP" | "DELIVERY" = "PICKUP",
  restaurantId = "restaurant-2",
): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === restaurantId ? { ...r, orderWorkflowMode: mode } : r,
    ),
  };
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  }
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

const getOrder = (state: PrototypeState, orderId: string) => {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
};

test("SPLIT: оператор принимает новый заказ — одно событие с ролью OPERATOR", () => {
  const { state, orderId } = orderState("SPLIT_OPERATOR_KITCHEN");
  const before = getOrder(state, orderId);
  assert.equal(before.status, "RESTAURANT_REVIEW");
  const acceptedAtMs = Date.now();

  const res = acceptRestaurantOrderWithResult(
    state,
    orderId,
    25,
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(res.result.ok, true);

  const order = getOrder(res.state, orderId);
  assert.equal(order.status, "PREPARING");
  assert.equal(order.preparationMinutes, 25);
  assert.ok(order.expectedReadyAt);
  const deltaMin =
    (Date.parse(order.expectedReadyAt as string) - acceptedAtMs) / 60_000;
  assert.ok(deltaMin > 24 && deltaMin < 26, `deltaMin=${deltaMin}`);

  // Ровно одно STATUS-событие приёма, actor RESTAURANT, роль OPERATOR.
  assert.equal(order.history.length, before.history.length + 1);
  const ev = order.history.at(-1);
  assert.equal(ev?.type, "STATUS");
  assert.equal(ev?.fromStatus, "RESTAURANT_REVIEW");
  assert.equal(ev?.toStatus, "PREPARING");
  assert.equal(ev?.actor, "RESTAURANT");
  assert.equal(ev?.restaurantWorkspaceRole, "OPERATOR");

  // Ревизия выросла ровно один раз, инварианты заказа не тронуты.
  assert.equal(res.state.revision, state.revision + 1);
  assert.deepEqual(order.items, before.items);
  assert.deepEqual(order.financials, before.financials);
  assert.equal(order.pickupCode, before.pickupCode);
  assert.equal(order.deliveryMode, before.deliveryMode);
  assert.equal(order.paymentMethod, before.paymentMethod);
  assert.deepEqual(order.customer, before.customer);
  assert.deepEqual(res.state.settlements, state.settlements);
});

test("SPLIT: прямой доменный приём кухней отклоняется без изменения state", () => {
  const { state, orderId } = orderState("SPLIT_OPERATOR_KITCHEN");
  const res = acceptRestaurantOrderWithResult(
    state,
    orderId,
    20,
    "RESTAURANT",
    "KITCHEN",
  );

  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Недостаточно прав для принятия заказа.");
  // Тот же объект state: ни ревизии, ни истории, ни финансов, ни settlement.
  assert.equal(res.state, state);
  assert.equal(res.state.revision, state.revision);
  assert.equal(getOrder(res.state, orderId).status, "RESTAURANT_REVIEW");
  assert.equal(
    getOrder(res.state, orderId).history.length,
    getOrder(state, orderId).history.length,
  );
  assert.deepEqual(res.state.settlements, state.settlements);
});

test("SPLIT: оператор отклоняет новый заказ — существующий flow, одно событие", () => {
  const { state, orderId } = orderState("SPLIT_OPERATOR_KITCHEN");
  const before = getOrder(state, orderId);

  const res = rejectRestaurantOrderWithResult(
    state,
    orderId,
    "Нет нужных позиций",
    "RESTAURANT",
    "OPERATOR",
  );

  assert.equal(res.result.ok, true);
  const order = getOrder(res.state, orderId);
  assert.equal(order.status, "CANCELED");
  assert.equal(order.history.length, before.history.length + 1);
  assert.equal(order.history.at(-1)?.restaurantWorkspaceRole, "OPERATOR");
  assert.equal(res.state.revision, state.revision + 1);
  // Отказ не начисляет settlement и не меняет финансовый снимок.
  assert.deepEqual(res.state.settlements, state.settlements);
  assert.deepEqual(order.financials, before.financials);
});

test("COMBINED: приём и отклонение общего экрана не сломаны", () => {
  const accept = orderState("COMBINED");
  const acceptedRes = acceptRestaurantOrderWithResult(
    accept.state,
    accept.orderId,
    20,
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(acceptedRes.result.ok, true);
  const accepted = getOrder(acceptedRes.state, accept.orderId);
  assert.equal(accepted.status, "PREPARING");
  assert.equal(accepted.history.at(-1)?.restaurantWorkspaceRole, "COMBINED");
  assert.equal(accepted.history.at(-1)?.actor, "RESTAURANT");

  // Старый вызов без роли в COMBINED продолжает работать.
  const legacy = orderState("COMBINED");
  const legacyRes = acceptRestaurantOrderWithResult(
    legacy.state,
    legacy.orderId,
    20,
  );
  assert.equal(legacyRes.result.ok, true);
  assert.equal(
    getOrder(legacyRes.state, legacy.orderId).history.at(-1)
      ?.restaurantWorkspaceRole,
    "COMBINED",
  );

  const reject = orderState("COMBINED");
  const rejectRes = rejectRestaurantOrderWithResult(
    reject.state,
    reject.orderId,
    "Кухня перегружена",
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(rejectRes.result.ok, true);
  assert.equal(getOrder(rejectRes.state, reject.orderId).status, "CANCELED");
});

test("видимость: новый заказ есть у кухни в COMBINED и отсутствует в SPLIT", () => {
  const combined = orderState("COMBINED");
  assert.equal(getKitchenNewOrders(combined.state, "restaurant-2").length, 1);

  const split = orderState("SPLIT_OPERATOR_KITCHEN");
  assert.equal(
    getKitchenNewOrders(split.state, "restaurant-2").length,
    0,
    "непринятый заказ до кухни в SPLIT не доходит",
  );
  // Сам заказ существует и ждёт решения — он просто не кухонный.
  assert.equal(getOrder(split.state, split.orderId).status, "RESTAURANT_REVIEW");

  // После приёма оператором заказ появляется у кухни как готовящийся.
  const accepted = acceptRestaurantOrderWithResult(
    split.state,
    split.orderId,
    20,
    "RESTAURANT",
    "OPERATOR",
  ).state;
  assert.equal(getKitchenNewOrders(accepted, "restaurant-2").length, 0);
  const preparing = getKitchenPreparingOrders(accepted, "restaurant-2");
  assert.equal(preparing.length, 1);
  assert.equal(preparing[0].id, split.orderId);
});

test("SPLIT: онлайн-оплата — приём даёт AWAITING_PAYMENT, кухня ждёт оплаты", () => {
  const { state, orderId } = orderState("SPLIT_OPERATOR_KITCHEN", "DELIVERY");

  const accepted = acceptRestaurantOrderWithResult(
    state,
    orderId,
    20,
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(accepted.result.ok, true);
  // Существующая модель оплаты сохранена: приготовление ещё не началось.
  assert.equal(getOrder(accepted.state, orderId).status, "AWAITING_PAYMENT");
  assert.equal(getKitchenPreparingOrders(accepted.state, "restaurant-2").length, 0);

  // Кухня не может отметить готовность раньше разрешённого перехода.
  const early = markOrderReadyWithResult(
    accepted.state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(early.result.ok, false);
  assert.equal(early.state, accepted.state);

  const paid = simulateSuccessfulOnlinePaymentWithResult(accepted.state, orderId);
  assert.equal(paid.result.ok, true);
  assert.equal(getOrder(paid.state, orderId).status, "PREPARING");
  const preparing = getKitchenPreparingOrders(paid.state, "restaurant-2");
  assert.equal(preparing.length, 1, "после оплаты заказ появляется у кухни");
});

test("SPLIT: кухня подтверждает начало, готовит и отмечает готовность", () => {
  const { state, orderId } = orderState("SPLIT_OPERATOR_KITCHEN");
  const acceptedRaw = acceptRestaurantOrderWithResult(
    state,
    orderId,
    20,
    "RESTAURANT",
    "OPERATOR",
  ).state;
  // SPLIT: до подтверждения начала готовность заблокирована (fail-closed).
  const early = markOrderReadyWithResult(
    acceptedRaw,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(early.result.ok, false);
  assert.equal(early.result.error, "Сначала подтвердите начало приготовления.");
  assert.equal(early.state, acceptedRaw);

  // Кухня подтверждает начало — событие KITCHEN_START, статус остаётся PREPARING.
  const started = startKitchenPreparationWithResult(
    acceptedRaw,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(started.result.ok, true);
  const startedOrder = getOrder(started.state, orderId);
  assert.equal(startedOrder.status, "PREPARING");
  assert.ok(startedOrder.kitchenStartedAt);
  assert.equal(startedOrder.history.at(-1)?.type, "KITCHEN_START");
  assert.equal(startedOrder.history.at(-1)?.restaurantWorkspaceRole, "KITCHEN");

  const ready = markOrderReadyWithResult(
    started.state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(ready.result.ok, true);
  const order = getOrder(ready.state, orderId);
  assert.equal(order.status, "READY_FOR_PICKUP");
  assert.equal(order.history.at(-1)?.restaurantWorkspaceRole, "KITCHEN");
  assert.equal(ready.state.revision, started.state.revision + 1);
});

test("SPLIT: автозакрытие не зависит от роли и не удваивается", () => {
  const { state, orderId } = orderState("SPLIT_OPERATOR_KITCHEN");
  const created = getOrder(state, orderId);
  const dueIso = new Date(
    Date.parse(created.createdAt) + RESTAURANT_RESPONSE_TIMEOUT_MS,
  ).toISOString();

  // Отсчёт от createdAt: sweep не привязан к тому, чей экран открыт.
  const swept = expireUnansweredRestaurantOrders(state, dueIso);
  const closed = getOrder(swept, orderId);
  assert.equal(closed.status, "CANCELED");
  assert.equal(closed.history.length, created.history.length + 1);
  assert.equal(closed.history.at(-1)?.actor, "SYSTEM");
  assert.equal(swept.revision, state.revision + 1);

  // Повторный sweep (вторая вкладка) не создаёт вторую мутацию.
  const again = expireUnansweredRestaurantOrders(swept, dueIso);
  assert.equal(again, swept, "повторный sweep возвращает тот же state");
  assert.equal(
    getOrder(again, orderId).history.length,
    closed.history.length,
    "второго события автозакрытия нет",
  );
});
