import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  adjustOrderEtaFromIntent,
  assignDriverToOrder,
  completePickupWithCode,
  createOrderFromCart,
  expireUnansweredRestaurantOrders,
  markOrderArrivingWithResult,
  markOrderDeliveredWithResult,
  markOrderOutForDeliveryWithResult,
  markOrderReadyWithResult,
  markPickupNoShow,
  reportRestaurantPreparationProblem,
  setCartFulfillmentChoice,
  simulateSuccessfulOnlinePaymentWithResult,
  updateCartAddress,
  RESTAURANT_RESPONSE_TIMEOUT_MS,
} from "./actions.ts";
import { getPickupNoShowEligibleAtIso } from "./selectors.ts";
import type { Order, PrototypeState, RestaurantOrderWorkflowMode } from "./models.ts";

/**
 * Сквозной regression кухонного lifecycle без React: каждая проверка проходит
 * ПОСЛЕДОВАТЕЛЬНОСТЬ состояний целиком и подтверждает ключевые инварианты
 * (финансы, settlement, история, роли, revision, идемпотентность). Отдельные
 * граничные случаи уже покрыты unit-тестами соседних файлов и здесь не
 * дублируются — тут проверяется именно связка шагов.
 */

/** Ресторан 2 — DIRECT-доставка, 3 — собственный курьер ресторана. */
function stateWithMode(
  restaurantId: string,
  mode: RestaurantOrderWorkflowMode,
): PrototypeState {
  const s = createDefaultState();
  return {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === restaurantId ? { ...r, orderWorkflowMode: mode } : r,
    ),
  };
}

function makeOrder(
  restaurantId: string,
  fulfillment: "PICKUP" | "DELIVERY",
  mode: RestaurantOrderWorkflowMode = "COMBINED",
): { state: PrototypeState; orderId: string } {
  let s = stateWithMode(restaurantId, mode);
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  }
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

function getOrder(state: PrototypeState, orderId: string): Order {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
}

/** Снимок инвариантов, которые кухня не имеет права менять. */
function snapshot(state: PrototypeState, orderId: string) {
  const o = getOrder(state, orderId);
  return {
    financials: JSON.stringify(o.financials),
    settlements: state.settlements.length,
    revision: state.revision,
    history: o.history.length,
    items: JSON.stringify(o.items),
  };
}

test("Regression 1: COMBINED PICKUP — приём → готовность → выдача по коду", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP");
  const base = snapshot(state, orderId);
  const created = getOrder(state, orderId);
  assert.equal(created.status, "RESTAURANT_REVIEW");
  assert.equal(created.paymentMethod, "PAY_AT_RESTAURANT");
  assert.equal(created.paymentStatus, "DUE_AT_PICKUP");
  assert.ok(created.pickupCode);
  assert.equal(created.pickupCodeUsed, false);

  // Приём: PICKUP сразу в PREPARING, время приготовления зафиксировано.
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "COMBINED");
  assert.equal(accepted.result.ok, true);
  const prep = getOrder(accepted.state, orderId);
  assert.equal(prep.status, "PREPARING");
  assert.equal(prep.preparationMinutes, 20);
  assert.ok(prep.expectedReadyAt);
  assert.equal(accepted.state.revision, base.revision + 1);

  // Готовность: PICKUP уходит в READY_FOR_PICKUP, код не тронут.
  const ready = markOrderReadyWithResult(accepted.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(ready.result.ok, true);
  const readyOrder = getOrder(ready.state, orderId);
  assert.equal(readyOrder.status, "READY_FOR_PICKUP");
  assert.equal(readyOrder.pickupCode, created.pickupCode);
  assert.equal(readyOrder.pickupCodeUsed, false);
  assert.equal(ready.state.settlements.length, 0);

  // Выдача по коду: оплата на точке и ровно одно начисление комиссии.
  const code = readyOrder.pickupCode as string;
  const done = completePickupWithCode(ready.state, orderId, code, "CARD", "RESTAURANT", "2026-07-14T12:00:00.000Z", "COMBINED");
  assert.equal(done.result.ok, true);
  const final = getOrder(done.state, orderId);
  assert.equal(final.status, "PICKED_UP");
  assert.equal(final.paymentStatus, "PAID_AT_RESTAURANT");
  assert.equal(final.pickupCodeUsed, true);
  assert.equal(final.pickupPaidWith, "CARD");
  assert.ok(final.paidAt);
  // Финансовый снимок неизменен на всём пути; комиссия взята из него.
  assert.equal(JSON.stringify(final.financials), base.financials);
  assert.equal(final.financials.deliveryFeeCents, 0);
  assert.equal(done.state.settlements.length, 1);
  assert.equal(done.state.settlements[0].type, "PICKUP_COMMISSION");
  assert.equal(
    done.state.settlements[0].amountCents,
    created.financials.platformCommissionReceivableCents,
  );
  // Ровно три шага ревизии на три мутации; один Order.
  assert.equal(done.state.revision, base.revision + 3);
  assert.equal(done.state.orders.filter((o) => o.id === orderId).length, 1);

  // Идемпотентность: повторная выдача не создаёт второе финальное состояние.
  const again = completePickupWithCode(done.state, orderId, code, "CARD", "RESTAURANT", "2026-07-14T12:05:00.000Z", "COMBINED");
  assert.equal(again.result.ok, false);
  assert.equal(again.state, done.state);
  assert.equal(again.state.settlements.length, 1);
});

test("Regression 2: COMBINED PICKUP — невыкуп после 30 минут вместо выдачи", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP");
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "COMBINED").state;
  const ready = markOrderReadyWithResult(accepted, orderId, "RESTAURANT", "COMBINED").state;
  const before = snapshot(ready, orderId);
  const readyOrder = getOrder(ready, orderId);
  const eligibleAt = getPickupNoShowEligibleAtIso(readyOrder) as string;
  assert.ok(eligibleAt);

  const res = markPickupNoShow(ready, orderId, "Клиент не пришёл", "RESTAURANT", eligibleAt, "COMBINED");
  assert.equal(res.result.ok, true);
  const o = getOrder(res.state, orderId);
  assert.equal(o.status, "CANCELED");
  assert.ok(o.pickupNoShowAt);
  assert.equal(res.state.customer.noShowPickupCount, ready.customer.noShowPickupCount + 1);
  // Невыкуп не фиксирует оплату и не начисляет комиссию.
  assert.equal(o.paymentStatus, "DUE_AT_PICKUP");
  assert.equal(o.paidAt, null);
  assert.equal(o.pickupPaidWith, null);
  assert.equal(o.pickupCodeUsed, false);
  assert.equal(JSON.stringify(o.financials), before.financials);
  assert.equal(res.state.settlements.length, 0);
  assert.equal(o.history.length, before.history + 1);
  assert.equal(o.history.at(-1)?.restaurantWorkspaceRole, "COMBINED");
  assert.equal(res.state.revision, before.revision + 1);

  // Выдача после невыкупа невозможна.
  const handoff = completePickupWithCode(res.state, orderId, readyOrder.pickupCode as string, "CASH", "RESTAURANT", eligibleAt, "COMBINED");
  assert.equal(handoff.result.ok, false);
  assert.equal(handoff.state.settlements.length, 0);
});

test("Regression 3: SPLIT PICKUP — кухня готовит, выдаёт только оператор", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP", "SPLIT_OPERATOR_KITCHEN");

  // Оператор не принимает и не готовит — это зона кухни.
  assert.equal(acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "OPERATOR").result.ok, false);
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "KITCHEN");
  assert.equal(accepted.result.ok, true);
  assert.equal(accepted.state.orders.find((o) => o.id === orderId)?.history.at(-1)?.restaurantWorkspaceRole, "KITCHEN");

  assert.equal(markOrderReadyWithResult(accepted.state, orderId, "RESTAURANT", "OPERATOR").result.ok, false);
  const ready = markOrderReadyWithResult(accepted.state, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(ready.result.ok, true);
  assert.equal(getOrder(ready.state, orderId).history.at(-1)?.restaurantWorkspaceRole, "KITCHEN");

  const code = getOrder(ready.state, orderId).pickupCode as string;
  const at = "2026-07-14T12:00:00.000Z";
  // Кухня не выдаёт и не отмечает невыкуп: оба действия — зона оператора.
  assert.equal(completePickupWithCode(ready.state, orderId, code, "CASH", "RESTAURANT", at, "KITCHEN").result.ok, false);
  const eligibleAt = getPickupNoShowEligibleAtIso(getOrder(ready.state, orderId)) as string;
  assert.equal(markPickupNoShow(ready.state, orderId, "Не пришёл", "RESTAURANT", eligibleAt, "KITCHEN").result.ok, false);
  assert.equal(ready.state.settlements.length, 0);

  const done = completePickupWithCode(ready.state, orderId, code, "CASH", "RESTAURANT", at, "OPERATOR");
  assert.equal(done.result.ok, true);
  const final = getOrder(done.state, orderId);
  assert.equal(final.status, "PICKED_UP");
  // Роли шагов: приготовление — KITCHEN, выдача — OPERATOR.
  const added = final.history.slice(getOrder(ready.state, orderId).history.length);
  added.forEach((e) => assert.equal(e.restaurantWorkspaceRole, "OPERATOR"));
  assert.equal(done.state.settlements.length, 1);
});

test("Regression 4: RESTAURANT_DELIVERY — полная цепочка до DELIVERED", () => {
  const { state, orderId } = makeOrder("restaurant-3", "DELIVERY");
  const base = snapshot(state, orderId);
  assert.equal(getOrder(state, orderId).deliveryMode, "RESTAURANT_DELIVERY");

  const accepted = acceptRestaurantOrderWithResult(state, orderId, 30, "RESTAURANT", "COMBINED").state;
  const prepOrder = getOrder(accepted, orderId);
  assert.equal(prepOrder.status, "PREPARING");
  assert.ok(prepOrder.expectedReadyAt);

  // Готовность курьерского заказа — READY (не READY_FOR_PICKUP).
  const ready = markOrderReadyWithResult(accepted, orderId, "RESTAURANT", "COMBINED");
  assert.equal(ready.result.ok, true);
  assert.equal(getOrder(ready.state, orderId).status, "READY");
  assert.equal(ready.state.settlements.length, 0);

  const out = markOrderOutForDeliveryWithResult(ready.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(out.result.ok, true);
  assert.equal(getOrder(out.state, orderId).status, "OUT_FOR_DELIVERY");
  const arriving = markOrderArrivingWithResult(out.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(arriving.result.ok, true);
  const delivered = markOrderDeliveredWithResult(arriving.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(delivered.result.ok, true);

  const final = getOrder(delivered.state, orderId);
  assert.equal(final.status, "DELIVERED");
  // Ровно одно начисление комиссии за доставку, снимок не пересчитан.
  const settlements = delivered.state.settlements.filter((s) => s.orderId === orderId);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].type, "RESTAURANT_DELIVERY_COMMISSION");
  assert.equal(JSON.stringify(final.financials), base.financials);

  // Повторная доставка не создаёт второй settlement.
  const again = markOrderDeliveredWithResult(delivered.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(again.result.ok, false);
  assert.equal(again.state, delivered.state);
  assert.equal(again.state.settlements.filter((s) => s.orderId === orderId).length, 1);
});

test("Regression 5: PLATFORM_DRIVER — оплата, приготовление, READY без водителя", () => {
  const { state, orderId } = makeOrder("restaurant-2", "DELIVERY");
  const base = snapshot(state, orderId);
  assert.equal(getOrder(state, orderId).deliveryMode, "PLATFORM_DRIVER");

  // После приёма онлайн-заказ ждёт оплату; кухня сама её не подтверждает.
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 25, "RESTAURANT", "COMBINED").state;
  const awaiting = getOrder(accepted, orderId);
  assert.equal(awaiting.status, "AWAITING_PAYMENT");
  assert.equal(awaiting.paymentStatus, "AWAITING_PAYMENT");
  // Готовность до оплаты недопустима.
  assert.equal(markOrderReadyWithResult(accepted, orderId, "RESTAURANT", "COMBINED").result.ok, false);

  const paid = simulateSuccessfulOnlinePaymentWithResult(accepted, orderId);
  assert.equal(paid.result.ok, true);
  const prep = getOrder(paid.state, orderId);
  assert.equal(prep.status, "PREPARING");
  assert.equal(prep.paymentStatus, "PAID");
  assert.ok(prep.expectedReadyAt);

  const ready = markOrderReadyWithResult(paid.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(ready.result.ok, true);
  const readyOrder = getOrder(ready.state, orderId);
  assert.equal(readyOrder.status, "READY");
  // Кухня не назначает водителя и не отправляет заказ в путь.
  assert.equal(readyOrder.assignedDriverId, null);
  assert.equal(
    markOrderOutForDeliveryWithResult(ready.state, orderId, "RESTAURANT", "COMBINED").result.ok,
    false,
  );
  // Водителя назначает администратор — только после этого возможен выезд.
  const assigned = assignDriverToOrder(ready.state, orderId, "driver-1");
  assert.equal(assigned.result.ok, true);
  assert.equal(
    markOrderOutForDeliveryWithResult(assigned.state, orderId, "RESTAURANT", "COMBINED").result.ok,
    true,
  );
  assert.equal(JSON.stringify(getOrder(ready.state, orderId).financials), base.financials);
  assert.equal(ready.state.settlements.length, 0);
});

test("Regression 6: ETA — корректировка не трогает статус, финансы и оплату", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP", "SPLIT_OPERATOR_KITCHEN");
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "KITCHEN").state;
  const before = snapshot(accepted, orderId);
  const prep = getOrder(accepted, orderId);
  const now = new Date().toISOString();

  const res = adjustOrderEtaFromIntent(accepted, orderId, { kind: "DELAY", minutes: 10 }, "Кухня перегружена", "RESTAURANT", now, "KITCHEN");
  assert.equal(res.result.ok, true);
  const o = getOrder(res.state, orderId);
  assert.equal(o.status, "PREPARING");
  assert.equal(o.preparationMinutes, prep.preparationMinutes);
  assert.notEqual(o.expectedReadyAt, prep.expectedReadyAt);
  assert.equal(o.etaAdjustments.length, prep.etaAdjustments.length + 1);
  assert.equal(o.history.length, before.history + 1);
  assert.equal(o.history.at(-1)?.type, "ETA");
  assert.equal(o.history.at(-1)?.restaurantWorkspaceRole, "KITCHEN");
  assert.equal(res.state.revision, before.revision + 1);
  assert.equal(JSON.stringify(o.financials), before.financials);
  assert.equal(res.state.settlements.length, before.settlements);
  assert.equal(o.assignedDriverId, null);
  assert.equal(o.paymentStatus, prep.paymentStatus);
});

test("Regression 7: проблема приготовления не меняет заказ и не отменяет его", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP", "SPLIT_OPERATOR_KITCHEN");
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "KITCHEN").state;
  const before = snapshot(accepted, orderId);
  const prep = getOrder(accepted, orderId);
  const now = new Date().toISOString();

  const res = reportRestaurantPreparationProblem(accepted, orderId, "Закончился ингредиент", "RESTAURANT", now, "KITCHEN");
  assert.equal(res.result.ok, true);
  const o = getOrder(res.state, orderId);
  // Заказ продолжает готовиться: статус, время и оплата не тронуты.
  assert.equal(o.status, "PREPARING");
  assert.equal(o.expectedReadyAt, prep.expectedReadyAt);
  assert.equal(o.paymentStatus, prep.paymentStatus);
  assert.equal(JSON.stringify(o.financials), before.financials);
  assert.equal(res.state.settlements.length, before.settlements);
  assert.equal(o.history.length, before.history + 1);
  assert.equal(o.history.at(-1)?.type, "PREPARATION_PROBLEM");
  assert.equal(o.history.at(-1)?.restaurantWorkspaceRole, "KITCHEN");
  assert.equal(res.state.revision, before.revision + 1);
});

test("Regression 8: авто-закрытие нового заказа через 7 минут и его идемпотентность", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP");
  const created = getOrder(state, orderId);
  const base = snapshot(state, orderId);
  const justBefore = new Date(Date.parse(created.createdAt) + RESTAURANT_RESPONSE_TIMEOUT_MS - 1000).toISOString();
  const past = new Date(Date.parse(created.createdAt) + RESTAURANT_RESPONSE_TIMEOUT_MS + 1000).toISOString();

  // До порога заказ не трогается (тот же объект state).
  assert.equal(expireUnansweredRestaurantOrders(state, justBefore), state);

  const expired = expireUnansweredRestaurantOrders(state, past);
  const o = getOrder(expired, orderId);
  assert.equal(o.status, "CANCELED");
  assert.equal(expired.revision, base.revision + 1);
  assert.equal(o.history.length, base.history + 1);
  assert.equal(expired.settlements.length, 0);
  assert.equal(JSON.stringify(o.financials), base.financials);

  // Повторный sweep не создаёт вторую отмену.
  const second = expireUnansweredRestaurantOrders(expired, past);
  assert.equal(second, expired);
  assert.equal(getOrder(second, orderId).history.length, base.history + 1);

  // Принять автозакрытый заказ нельзя.
  assert.equal(acceptRestaurantOrderWithResult(expired, orderId, 20, "RESTAURANT", "COMBINED").result.ok, false);
});
