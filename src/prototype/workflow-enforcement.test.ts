import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  adjustOrderEtaFromIntent,
  completePickupWithCode,
  createOrderFromCart,
  markOrderArriving,
  markOrderDelivered,
  markOrderOutForDelivery,
  markOrderReady,
  markPickupNoShow,
  pauseRestaurantOrders,
  rejectRestaurantOrder,
  reportRestaurantPreparationProblem,
  restoreMenuItemAvailability,
  setCartFulfillmentChoice,
  setMenuItemOperationallyUnavailable,
  setRestaurantWorkflowMode,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import {
  clientHistoryEvent,
  getRestaurantAvailabilityStateAt,
} from "./selectors.ts";
import type { Order, PrototypeState } from "./models.ts";

const NOW = "2026-07-14T12:00:00.000Z";

function splitPickupState(): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  // Ресторан-2 переводим в раздельный режим.
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === "restaurant-2"
        ? { ...r, orderWorkflowMode: "SPLIT_OPERATOR_KITCHEN" as const }
        : r,
    ),
  };
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  return { state: created.state, orderId: created.result.orderId as string };
}

function getOrder(state: PrototypeState, orderId: string): Order {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
}

// --- Приём заказа -----------------------------------------------------------

test("SPLIT: оператор не может принять заказ (state неизменён)", () => {
  const { state, orderId } = splitPickupState();
  const next = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  assert.equal(next, state);
  assert.equal(getOrder(next, orderId).status, "RESTAURANT_REVIEW");
});

test("SPLIT: кухня принимает заказ", () => {
  const { state, orderId } = splitPickupState();
  const next = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  assert.notEqual(next, state);
  assert.equal(getOrder(next, orderId).status, "PREPARING");
});

test("SPLIT: без роли приём заблокирован (fail-closed)", () => {
  const { state, orderId } = splitPickupState();
  const next = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT");
  assert.equal(next, state);
});

test("COMBINED (по умолчанию) принимает без роли", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  const next = acceptRestaurantOrder(created.state, created.result.orderId, 20);
  assert.equal(getOrder(next, created.result.orderId).status, "PREPARING");
});

test("SPLIT: событие приёма несёт роль KITCHEN", () => {
  const { state, orderId } = splitPickupState();
  const next = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  const ev = getOrder(next, orderId).history.at(-1);
  assert.equal(ev?.restaurantWorkspaceRole, "KITCHEN");
});

// --- Готовность и ETA -------------------------------------------------------

test("SPLIT: кухня отмечает готовность, оператор — нет", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  const byOperator = markOrderReady(prepared, orderId, "RESTAURANT", "OPERATOR");
  assert.equal(byOperator, prepared);
  const byKitchen = markOrderReady(prepared, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(getOrder(byKitchen, orderId).status, "READY_FOR_PICKUP");
});

test("SPLIT: оператор не меняет ETA, кухня меняет", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  // expectedReadyAt задан от реального now внутри приёмки — берём тот же базис.
  const now = new Date().toISOString();
  // Оператор блокируется правами до любых проверок времени.
  const opTry = adjustOrderEtaFromIntent(prepared, orderId, { kind: "DELAY", minutes: 10 }, "Задержка", "RESTAURANT", now, "OPERATOR");
  assert.equal(opTry.result.ok, false);
  const kitchenTry = adjustOrderEtaFromIntent(prepared, orderId, { kind: "DELAY", minutes: 10 }, "Задержка", "RESTAURANT", now, "KITCHEN");
  assert.equal(kitchenTry.result.ok, true);
});

// --- Выдача -----------------------------------------------------------------

test("SPLIT: кухня не выполняет выдачу, оператор выполняет", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  const ready = markOrderReady(prepared, orderId, "RESTAURANT", "KITCHEN");
  const code = getOrder(ready, orderId).pickupCode as string;
  const byKitchen = completePickupWithCode(ready, orderId, code, "CASH", "RESTAURANT", NOW, "KITCHEN");
  assert.equal(byKitchen.result.ok, false);
  const byOperator = completePickupWithCode(ready, orderId, code, "CASH", "RESTAURANT", NOW, "OPERATOR");
  assert.equal(byOperator.result.ok, true);
  assert.equal(getOrder(byOperator.state, orderId).status, "PICKED_UP");
});

test("SPLIT: невыкуп — действие оператора, кухня не может", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  const ready = markOrderReady(prepared, orderId, "RESTAURANT", "KITCHEN");
  const kitchenTry = markPickupNoShow(ready, orderId, "Не пришёл", "RESTAURANT", NOW, "KITCHEN");
  assert.equal(kitchenTry.result.ok, false);
});

// --- Проблема приготовления (Этап 6) ----------------------------------------

test("SPLIT: кухня сообщает о проблеме, статус не меняется", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  const before = getOrder(prepared, orderId);
  const res = reportRestaurantPreparationProblem(prepared, orderId, "Нет блюда", "RESTAURANT", NOW, "KITCHEN");
  assert.equal(res.result.ok, true);
  const after = getOrder(res.state, orderId);
  assert.equal(after.status, before.status);
  assert.equal(after.paymentStatus, before.paymentStatus);
  assert.deepEqual(after.financials, before.financials);
  const ev = after.history.at(-1);
  assert.equal(ev?.type, "PREPARATION_PROBLEM");
  assert.equal(ev?.restaurantWorkspaceRole, "KITCHEN");
});

test("SPLIT: оператор не сообщает о проблеме приготовления", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  const res = reportRestaurantPreparationProblem(prepared, orderId, "Нет блюда", "RESTAURANT", NOW, "OPERATOR");
  assert.equal(res.result.ok, false);
  assert.equal(res.state, prepared);
});

// --- ADMIN — отдельный actor, не проходит матрицу ресторана -----------------

// --- Смена режима сохраняет заказ и lifecycle (Этап 13 №24–28) --------------

test("смена режима меняет только orderWorkflowMode, заказ не тронут", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  const before = getOrder(prepared, orderId);
  const switched = setRestaurantWorkflowMode(prepared, "restaurant-2", "COMBINED");
  const after = getOrder(switched, orderId);
  assert.equal(
    switched.restaurants.find((r) => r.id === "restaurant-2")?.orderWorkflowMode,
    "COMBINED",
  );
  assert.equal(after.status, before.status);
  assert.equal(after.expectedReadyAt, before.expectedReadyAt);
  assert.equal(after.preparationMinutes, before.preparationMinutes);
  assert.deepEqual(after.financials, before.financials);
  assert.equal(after.assignedDriverId, before.assignedDriverId);
  assert.equal(switched.settlements.length, prepared.settlements.length);
});

test("смена режима на тот же режим не мутирует state", () => {
  const { state } = splitPickupState();
  const same = setRestaurantWorkflowMode(state, "restaurant-2", "SPLIT_OPERATOR_KITCHEN");
  assert.equal(same, state);
});

test("ADMIN принимает заказ в SPLIT без workspace-роли", () => {
  const { state, orderId } = splitPickupState();
  const next = acceptRestaurantOrder(state, orderId, 20, "ADMIN");
  assert.equal(getOrder(next, orderId).status, "PREPARING");
  // Событие ADMIN не несёт ресторанную workspace-роль.
  assert.equal(getOrder(next, orderId).history.at(-1)?.restaurantWorkspaceRole, undefined);
});

// --- Этап 4 (остаток): отклонение, курьер, пауза, доступность меню -----------

test("SPLIT: кухня не отклоняет заказ, оператор отклоняет", () => {
  const { state, orderId } = splitPickupState();
  const kitchen = rejectRestaurantOrder(state, orderId, "Нет блюда", "RESTAURANT", "KITCHEN");
  assert.equal(kitchen, state);
  const operator = rejectRestaurantOrder(state, orderId, "Нет блюда", "RESTAURANT", "OPERATOR");
  assert.equal(getOrder(operator, orderId).status, "CANCELED");
  const ev = getOrder(operator, orderId).history.at(-1);
  assert.equal(ev?.restaurantWorkspaceRole, "OPERATOR");
});

function splitCourierReadyState(): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === "restaurant-3"
        ? { ...r, orderWorkflowMode: "SPLIT_OPERATOR_KITCHEN" as const }
        : r,
    ),
  };
  s = setCartFulfillmentChoice(s, "DELIVERY");
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = created.state;
  s = acceptRestaurantOrder(s, orderId, 20, "RESTAURANT", "KITCHEN");
  s = simulateSuccessfulOnlinePayment(s, orderId);
  s = markOrderReady(s, orderId, "RESTAURANT", "KITCHEN");
  return { state: s, orderId };
}

test("SPLIT: курьерские шаги — оператор может, кухня нет", () => {
  const { state, orderId } = splitCourierReadyState();
  assert.equal(getOrder(state, orderId).status, "READY");
  const kitchen = markOrderOutForDelivery(state, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(kitchen, state);
  const out = markOrderOutForDelivery(state, orderId, "RESTAURANT", "OPERATOR");
  assert.equal(getOrder(out, orderId).status, "OUT_FOR_DELIVERY");
  const arriving = markOrderArriving(out, orderId, "RESTAURANT", "OPERATOR");
  assert.equal(getOrder(arriving, orderId).status, "ARRIVING");
  const kitchenDeliver = markOrderDelivered(arriving, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(kitchenDeliver, arriving);
  const delivered = markOrderDelivered(arriving, orderId, "RESTAURANT", "OPERATOR");
  assert.equal(getOrder(delivered, orderId).status, "DELIVERED");
  const ev = getOrder(delivered, orderId).history.at(-1);
  assert.equal(ev?.restaurantWorkspaceRole, "OPERATOR");
});

test("SPLIT: ONLINE lifecycle сохраняет AWAITING_PAYMENT (оплата не обходится)", () => {
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === "restaurant-2"
        ? { ...r, orderWorkflowMode: "SPLIT_OPERATOR_KITCHEN" as const }
        : r,
    ),
  };
  s = setCartFulfillmentChoice(s, "DELIVERY");
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20, "RESTAURANT", "KITCHEN");
  assert.equal(getOrder(s, orderId).status, "AWAITING_PAYMENT");
  s = simulateSuccessfulOnlinePayment(s, orderId);
  assert.equal(getOrder(s, orderId).status, "PREPARING");
});

test("SPLIT: пауза ресторана — кухня может, оператор нет", () => {
  const { state } = splitPickupState();
  const operator = pauseRestaurantOrders(
    state, "restaurant-2", "Перегружены", "UNTIL_MANUAL", null, "RESTAURANT", "OPERATOR",
  );
  assert.equal(operator.result.ok, false);
  assert.equal(operator.state, state);
  const kitchen = pauseRestaurantOrders(
    state, "restaurant-2", "Перегружены", "UNTIL_MANUAL", null, "RESTAURANT", "KITCHEN",
  );
  assert.equal(kitchen.result.ok, true);
  assert.equal(
    kitchen.state.restaurants.find((r) => r.id === "restaurant-2")?.isAcceptingOrders,
    false,
  );
});

test("SPLIT: доступность меню — кухня может, оператор нет", () => {
  const { state } = splitPickupState();
  const operator = setMenuItemOperationallyUnavailable(
    state, "restaurant-2", "restaurant-2-item-1", "Закончился", "UNTIL_MANUAL", null,
    "RESTAURANT", "OPERATOR",
  );
  assert.equal(operator.result.ok, false);
  const kitchen = setMenuItemOperationallyUnavailable(
    state, "restaurant-2", "restaurant-2-item-1", "Закончился", "UNTIL_MANUAL", null,
    "RESTAURANT", "KITCHEN",
  );
  assert.equal(kitchen.result.ok, true);
  const restore = restoreMenuItemAvailability(
    kitchen.state, "restaurant-2", "restaurant-2-item-1", "RESTAURANT", "", "OPERATOR",
  );
  assert.equal(restore.result.ok, false);
});

test("клиентская история не раскрывает workspace-роль", () => {
  const { state, orderId } = splitPickupState();
  const accepted = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  const order = getOrder(accepted, orderId);
  const ev = order.history.at(-1);
  assert.equal(ev?.restaurantWorkspaceRole, "KITCHEN");
  const view = clientHistoryEvent(ev!, order, true);
  assert.ok(!view.message.includes("KITCHEN"));
  assert.ok(!view.message.includes("Кухня"));
  assert.ok(!view.message.includes("OPERATOR"));
});

test("availability ресторана не зависит от workflow mode", () => {
  const base = createDefaultState();
  const combined = base.restaurants.find((r) => r.id === "restaurant-1")!;
  const split = { ...combined, orderWorkflowMode: "SPLIT_OPERATOR_KITCHEN" as const };
  const at = Date.parse("2026-07-14T12:00:00.000Z");
  assert.equal(
    getRestaurantAvailabilityStateAt(combined, at),
    getRestaurantAvailabilityStateAt(split, at),
  );
});
