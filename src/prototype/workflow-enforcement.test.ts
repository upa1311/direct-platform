import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  acceptRestaurantOrderWithResult,
  addCartItem,
  adjustOrderEtaFromIntent,
  completePickupWithCode,
  createOrderFromCart,
  markOrderArriving,
  markOrderDelivered,
  markOrderOutForDelivery,
  markOrderReady,
  markOrderReadyWithResult,
  markPickupNoShow,
  pauseRestaurantOrders,
  rejectRestaurantOrder,
  rejectRestaurantOrderWithResult,
  reportRestaurantPreparationProblem,
  restoreMenuItemAvailability,
  setCartFulfillmentChoice,
  setMenuItemOperationallyUnavailable,
  setRestaurantWorkflowMode,
  simulateSuccessfulOnlinePayment,
  startKitchenPreparation,
  updateCartAddress,
} from "./actions.ts";
import {
  clientHistoryEvent,
  deliveryModeLabels,
  getPickupNoShowEligibleAtIso,
  getRestaurantAvailabilityStateAt,
  getRestaurantTimeZoneLabel,
  restaurantTimeZoneLabels,
  workflowModeLabels,
} from "./selectors.ts";
import { normalizePrototypeState } from "./prototype-store.ts";
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

test("SPLIT: кухня не может принять заказ (state неизменён)", () => {
  const { state, orderId } = splitPickupState();
  const next = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
  assert.equal(next, state);
  assert.equal(getOrder(next, orderId).status, "RESTAURANT_REVIEW");
});

test("SPLIT: оператор принимает заказ", () => {
  const { state, orderId } = splitPickupState();
  const next = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
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

test("SPLIT: событие приёма несёт роль OPERATOR", () => {
  const { state, orderId } = splitPickupState();
  const next = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const ev = getOrder(next, orderId).history.at(-1);
  assert.equal(ev?.restaurantWorkspaceRole, "OPERATOR");
});

test("Приём pickup: prep/expectedReadyAt/оплата/финансы выставлены корректно", () => {
  const { state, orderId } = splitPickupState();
  const before = getOrder(state, orderId);
  const finBefore = JSON.stringify(before.financials);
  const acceptedAtMs = Date.now();
  const res = acceptRestaurantOrderWithResult(
    state, orderId, 20, "RESTAURANT", "OPERATOR",
  );
  assert.equal(res.result.ok, true);
  const order = getOrder(res.state, orderId);
  assert.equal(order.status, "PREPARING");
  // Выбранное время сохранено, ожидаемая готовность ≈ now + 20 минут.
  assert.equal(order.preparationMinutes, 20);
  assert.ok(order.expectedReadyAt);
  const deltaMin =
    (Date.parse(order.expectedReadyAt as string) - acceptedAtMs) / 60_000;
  assert.ok(deltaMin > 19 && deltaMin < 21, `deltaMin=${deltaMin}`);
  // Оплата при получении сохраняется, финансовый снимок не пересчитан.
  assert.equal(order.paymentStatus, "DUE_AT_PICKUP");
  assert.equal(order.financials.deliveryFeeCents, 0);
  assert.equal(JSON.stringify(order.financials), finBefore);
  assert.equal(res.state.settlements.length, 0);
  assert.equal(order.pickupCodeUsed, false);
  assert.equal(order.assignedDriverId, null);
  // Один Order, ревизия выросла ровно на один, одно новое событие.
  assert.equal(res.state.orders.filter((o) => o.id === orderId).length, 1);
  assert.equal(res.state.revision, state.revision + 1);
  assert.equal(order.history.length, before.history.length + 1);
});

test("Повторное принятие уже принятого заказа — ошибка без события и ревизии", () => {
  const { state, orderId } = splitPickupState();
  const first = acceptRestaurantOrderWithResult(
    state, orderId, 20, "RESTAURANT", "OPERATOR",
  );
  assert.equal(first.result.ok, true);
  const historyAfterFirst = getOrder(first.state, orderId).history.length;

  const second = acceptRestaurantOrderWithResult(
    first.state, orderId, 25, "RESTAURANT", "OPERATOR",
  );
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Заказ уже обработан. Обновите данные.");
  // Исходный state тем же объектом: ни события, ни роста revision,
  // preparationMinutes не перезаписан вторым значением.
  assert.equal(second.state, first.state);
  const order = getOrder(second.state, orderId);
  assert.equal(order.history.length, historyAfterFirst);
  assert.equal(order.preparationMinutes, 20);
  assert.equal(second.state.revision, first.state.revision);
});

test("COMBINED: событие приёма несёт роль COMBINED", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  const next = acceptRestaurantOrder(created.state, created.result.orderId, 20);
  const ev = getOrder(next, created.result.orderId).history.at(-1);
  assert.equal(ev?.restaurantWorkspaceRole, "COMBINED");
  assert.equal(ev?.actor, "RESTAURANT");
  assert.equal(ev?.type, "STATUS");
  assert.equal(ev?.fromStatus, "RESTAURANT_REVIEW");
  assert.equal(ev?.toStatus, "PREPARING");
});

// --- Готовность и ETA -------------------------------------------------------

test("SPLIT: кухня отмечает готовность, оператор — нет", () => {
  const { state, orderId } = splitPickupState();
  const accepted = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const prepared = startKitchenPreparation(accepted, orderId, "RESTAURANT", "KITCHEN");
  const byOperator = markOrderReady(prepared, orderId, "RESTAURANT", "OPERATOR");
  assert.equal(byOperator, prepared);
  const byKitchen = markOrderReady(prepared, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(getOrder(byKitchen, orderId).status, "READY_FOR_PICKUP");
});

test("Готовность pickup: инварианты кода, оплаты, финансов и события (SPLIT)", () => {
  const { state, orderId } = splitPickupState();
  const accepted = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const prepared = startKitchenPreparation(accepted, orderId, "RESTAURANT", "KITCHEN");
  const before = getOrder(prepared, orderId);
  const finBefore = JSON.stringify(before.financials);

  const res = markOrderReadyWithResult(prepared, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(res.result.ok, true);
  const order = getOrder(res.state, orderId);
  // Переход и неизменность полей вокруг него.
  assert.equal(order.status, "READY_FOR_PICKUP");
  assert.equal(order.paymentMethod, "PAY_AT_RESTAURANT");
  assert.equal(order.paymentStatus, "DUE_AT_PICKUP");
  assert.equal(order.preparationMinutes, before.preparationMinutes);
  assert.equal(order.expectedReadyAt, before.expectedReadyAt);
  // Pickup code существует, не изменился и не использован.
  assert.ok(before.pickupCode);
  assert.equal(order.pickupCode, before.pickupCode);
  assert.equal(order.pickupCodeUsed, false);
  assert.equal(order.pickupPaidWith, null);
  // Финансы и связанные сущности не тронуты.
  assert.equal(JSON.stringify(order.financials), finBefore);
  assert.equal(order.financials.deliveryFeeCents, 0);
  assert.equal(res.state.settlements.length, 0);
  assert.equal(order.assignedDriverId, null);
  // Один Order, ревизия +1, ровно одно новое событие с ролью KITCHEN.
  assert.equal(res.state.orders.filter((o) => o.id === orderId).length, 1);
  assert.equal(res.state.revision, prepared.revision + 1);
  assert.equal(order.history.length, before.history.length + 1);
  const ev = order.history.at(-1);
  assert.equal(ev?.actor, "RESTAURANT");
  assert.equal(ev?.type, "STATUS");
  assert.equal(ev?.fromStatus, "PREPARING");
  assert.equal(ev?.toStatus, "READY_FOR_PICKUP");
  assert.equal(ev?.restaurantWorkspaceRole, "KITCHEN");
});

test("COMBINED: событие готовности несёт роль COMBINED", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  const prepared = acceptRestaurantOrder(created.state, orderId, 20);
  const ready = markOrderReady(prepared, orderId);
  const ev = getOrder(ready, orderId).history.at(-1);
  assert.equal(getOrder(ready, orderId).status, "READY_FOR_PICKUP");
  assert.equal(ev?.restaurantWorkspaceRole, "COMBINED");
});

test("Повторная готовность pickup: ошибка без события, ревизии и изменений кода", () => {
  const { state, orderId } = splitPickupState();
  const accepted = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const prepared = startKitchenPreparation(accepted, orderId, "RESTAURANT", "KITCHEN");
  const first = markOrderReadyWithResult(prepared, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(first.result.ok, true);
  const afterFirst = getOrder(first.state, orderId);

  const second = markOrderReadyWithResult(first.state, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Заказ уже обработан. Обновите данные.");
  // Тот же объект state: без события, без ревизии, без изменений pickup-полей.
  assert.equal(second.state, first.state);
  const order = getOrder(second.state, orderId);
  assert.equal(order.history.length, afterFirst.history.length);
  assert.equal(second.state.revision, first.state.revision);
  assert.equal(order.pickupCode, afterFirst.pickupCode);
  assert.equal(order.pickupCodeUsed, false);
  assert.equal(second.state.settlements.length, 0);
});

test("SPLIT: оператор не меняет ETA, кухня меняет", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  // expectedReadyAt задан от реального now внутри приёмки — берём тот же базис.
  const now = new Date().toISOString();
  // Оператор блокируется правами до любых проверок времени.
  const opTry = adjustOrderEtaFromIntent(prepared, orderId, { kind: "DELAY", minutes: 10 }, "Задержка", "RESTAURANT", now, "OPERATOR");
  assert.equal(opTry.result.ok, false);
  const kitchenTry = adjustOrderEtaFromIntent(prepared, orderId, { kind: "DELAY", minutes: 10 }, "Задержка", "RESTAURANT", now, "KITCHEN");
  assert.equal(kitchenTry.result.ok, true);
});

test("SPLIT: кухня меняет ETA — событие с ролью KITCHEN, ревизия +1, инварианты", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const before = getOrder(prepared, orderId);
  const finBefore = JSON.stringify(before.financials);
  const now = new Date().toISOString();

  const res = adjustOrderEtaFromIntent(
    prepared, orderId, { kind: "DELAY", minutes: 10 }, "Кухня перегружена", "RESTAURANT", now, "KITCHEN",
  );
  assert.equal(res.result.ok, true);
  const after = getOrder(res.state, orderId);
  // Статус, время приготовления и связанные сущности не тронуты.
  assert.equal(after.status, "PREPARING");
  assert.equal(after.preparationMinutes, before.preparationMinutes);
  assert.notEqual(after.expectedReadyAt, before.expectedReadyAt);
  assert.equal(JSON.stringify(after.financials), finBefore);
  assert.equal(res.state.settlements.length, prepared.settlements.length);
  assert.equal(after.pickupCode, before.pickupCode);
  assert.equal(after.pickupCodeUsed, false);
  // Ровно одна корректировка и одно ETA-событие; ревизия выросла на один.
  assert.equal(after.etaAdjustments.length, before.etaAdjustments.length + 1);
  assert.equal(after.history.length, before.history.length + 1);
  const ev = after.history.at(-1);
  assert.equal(ev?.type, "ETA");
  assert.equal(ev?.actor, "RESTAURANT");
  assert.equal(ev?.fromStatus, "PREPARING");
  assert.equal(ev?.toStatus, "PREPARING");
  assert.equal(ev?.restaurantWorkspaceRole, "KITCHEN");
  assert.ok(ev?.message.includes("Кухня перегружена"));
  assert.equal(res.state.revision, prepared.revision + 1);
});

// --- Выдача -----------------------------------------------------------------

test("SPLIT: кухня не выполняет выдачу, оператор выполняет", () => {
  const { state, orderId } = splitPickupState();
  const accepted = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const prepared = startKitchenPreparation(accepted, orderId, "RESTAURANT", "KITCHEN");
  const ready = markOrderReady(prepared, orderId, "RESTAURANT", "KITCHEN");
  const code = getOrder(ready, orderId).pickupCode as string;
  const byKitchen = completePickupWithCode(ready, orderId, code, "CASH", "RESTAURANT", NOW, "KITCHEN");
  assert.equal(byKitchen.result.ok, false);
  const byOperator = completePickupWithCode(ready, orderId, code, "CASH", "RESTAURANT", NOW, "OPERATOR");
  assert.equal(byOperator.result.ok, true);
  assert.equal(getOrder(byOperator.state, orderId).status, "PICKED_UP");
});

test("SPLIT: выдача оператором — оплата, один settlement, роль OPERATOR, ревизия +1", () => {
  const { state, orderId } = splitPickupState();
  const accepted = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const prepared = startKitchenPreparation(accepted, orderId, "RESTAURANT", "KITCHEN");
  const ready = markOrderReady(prepared, orderId, "RESTAURANT", "KITCHEN");
  const before = getOrder(ready, orderId);
  const finBefore = JSON.stringify(before.financials);
  const code = before.pickupCode as string;
  assert.equal(before.pickupCodeUsed, false);
  assert.equal(before.paymentStatus, "DUE_AT_PICKUP");
  assert.equal(ready.settlements.length, 0);

  // Неправильный код не меняет состояние (тот же объект state).
  const wrong = completePickupWithCode(ready, orderId, "0000", "CASH", "RESTAURANT", NOW, "OPERATOR");
  assert.equal(wrong.result.ok, false);
  assert.equal(wrong.result.error, "Неверный код клиента.");
  assert.equal(wrong.state, ready);
  assert.equal(getOrder(wrong.state, orderId).pickupCodeUsed, false);
  assert.equal(wrong.state.settlements.length, 0);
  assert.equal(wrong.state.revision, ready.revision);

  // Правильный код: заказ выдан, оплата зафиксирована.
  const res = completePickupWithCode(ready, orderId, code, "CARD", "RESTAURANT", NOW, "OPERATOR");
  assert.equal(res.result.ok, true);
  const order = getOrder(res.state, orderId);
  assert.equal(order.status, "PICKED_UP");
  assert.equal(order.paymentStatus, "PAID_AT_RESTAURANT");
  assert.equal(order.paidAt, NOW);
  assert.equal(order.pickupCodeUsed, true);
  assert.equal(order.pickupPaidWith, "CARD");
  // Финансы не пересчитываются, самовывоз без платы за доставку.
  assert.equal(JSON.stringify(order.financials), finBefore);
  assert.equal(order.financials.deliveryFeeCents, 0);
  // Ровно один settlement PICKUP_COMMISSION из исторического снимка.
  assert.equal(res.state.settlements.length, 1);
  const settlement = res.state.settlements[0];
  assert.equal(settlement.id, `settlement-${orderId}`);
  assert.equal(settlement.orderId, orderId);
  assert.equal(settlement.type, "PICKUP_COMMISSION");
  assert.equal(
    settlement.amountCents,
    before.financials.platformCommissionReceivableCents,
  );
  // По одному PAYMENT и STATUS-событию перехода, оба с ролью OPERATOR.
  const added = order.history.slice(before.history.length);
  assert.equal(added.length, 2);
  const payments = added.filter((e) => e.type === "PAYMENT");
  const pickedUp = added.filter(
    (e) => e.type === "STATUS" && e.toStatus === "PICKED_UP",
  );
  assert.equal(payments.length, 1);
  assert.equal(pickedUp.length, 1);
  added.forEach((e) => assert.equal(e.restaurantWorkspaceRole, "OPERATOR"));
  // Ревизия выросла ровно на один; заказ по-прежнему один.
  assert.equal(res.state.revision, ready.revision + 1);
  assert.equal(res.state.orders.filter((o) => o.id === orderId).length, 1);

  // Повторная выдача отклоняется и не создаёт второй settlement.
  const again = completePickupWithCode(res.state, orderId, code, "CARD", "RESTAURANT", NOW, "OPERATOR");
  assert.equal(again.result.ok, false);
  assert.equal(again.state, res.state);
  assert.equal(again.state.settlements.length, 1);
});

test("SPLIT: невыкуп — действие оператора, кухня не может", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const ready = markOrderReady(prepared, orderId, "RESTAURANT", "KITCHEN");
  const kitchenTry = markPickupNoShow(ready, orderId, "Не пришёл", "RESTAURANT", NOW, "KITCHEN");
  assert.equal(kitchenTry.result.ok, false);
});

// --- Проблема приготовления (Этап 6) ----------------------------------------

test("SPLIT: кухня сообщает о проблеме, статус не меняется", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
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

test("SPLIT: проблема приготовления — ревизия +1, одно событие, settlement и ETA не тронуты", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const before = getOrder(prepared, orderId);
  const historyBefore = before.history.length;

  const res = reportRestaurantPreparationProblem(
    prepared, orderId, "Закончился ингредиент", "RESTAURANT", NOW, "KITCHEN",
  );
  assert.equal(res.result.ok, true);
  const after = getOrder(res.state, orderId);
  // Ровно одно новое событие проблемы; статус и время готовности не меняются.
  assert.equal(after.history.length, historyBefore + 1);
  assert.equal(
    after.history.filter((e) => e.type === "PREPARATION_PROBLEM").length,
    1,
  );
  assert.equal(after.status, "PREPARING");
  assert.equal(after.preparationMinutes, before.preparationMinutes);
  assert.equal(after.expectedReadyAt, before.expectedReadyAt);
  assert.equal(after.paidAt, before.paidAt);
  assert.equal(after.pickupCode, before.pickupCode);
  // Ревизия выросла ровно на один; settlements не создавались.
  assert.equal(res.state.revision, prepared.revision + 1);
  assert.equal(res.state.settlements.length, prepared.settlements.length);
  assert.equal(res.state.settlements.length, 0);
});

test("SPLIT: оператор не сообщает о проблеме приготовления", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const res = reportRestaurantPreparationProblem(prepared, orderId, "Нет блюда", "RESTAURANT", NOW, "OPERATOR");
  assert.equal(res.result.ok, false);
  assert.equal(res.state, prepared);
});

// --- ADMIN — отдельный actor, не проходит матрицу ресторана -----------------

// --- Смена режима сохраняет заказ и lifecycle (Этап 13 №24–28) --------------

test("смена режима меняет только orderWorkflowMode, заказ не тронут", () => {
  const { state, orderId } = splitPickupState();
  const prepared = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
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
  s = acceptRestaurantOrder(s, orderId, 20, "RESTAURANT", "OPERATOR");
  s = simulateSuccessfulOnlinePayment(s, orderId);
  s = startKitchenPreparation(s, orderId, "RESTAURANT", "KITCHEN");
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
  s = acceptRestaurantOrder(created.state, orderId, 20, "RESTAURANT", "OPERATOR");
  assert.equal(getOrder(s, orderId).status, "AWAITING_PAYMENT");
  s = simulateSuccessfulOnlinePayment(s, orderId);
  assert.equal(getOrder(s, orderId).status, "PREPARING");
});

test("SPLIT: пауза ресторана — кухня может, оператор нет", () => {
  const { state } = splitPickupState();
  const operator = pauseRestaurantOrders(
    state, "restaurant-2", "Перегружены", "MANUAL", null, "RESTAURANT", "OPERATOR",
  );
  assert.equal(operator.result.ok, false);
  assert.equal(operator.state, state);
  const kitchen = pauseRestaurantOrders(
    state, "restaurant-2", "Перегружены", "MANUAL", null, "RESTAURANT", "KITCHEN",
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
    state, "restaurant-2", "restaurant-2-item-1", "Закончился", "MANUAL", null,
    "RESTAURANT", "OPERATOR",
  );
  assert.equal(operator.result.ok, false);
  const kitchen = setMenuItemOperationallyUnavailable(
    state, "restaurant-2", "restaurant-2-item-1", "Закончился", "MANUAL", null,
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
  const accepted = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const order = getOrder(accepted, orderId);
  const ev = order.history.at(-1);
  // Роль в событии есть (внутренний аудит), но клиенту её не показывают.
  assert.equal(ev?.restaurantWorkspaceRole, "OPERATOR");
  const view = clientHistoryEvent(ev!, order, true);
  assert.ok(!view.message.includes("KITCHEN"));
  assert.ok(!view.message.includes("Кухня"));
  assert.ok(!view.message.includes("OPERATOR"));
  assert.ok(!view.message.includes("Оператор"));
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


// --- Исправительный проход (аудит): отклонение оператором ---------------------

test("Исправление 1: оператор отклоняет новый заказ, событие с ролью OPERATOR", () => {
  const { state, orderId } = splitPickupState();
  const before = getOrder(state, orderId).history.length;
  const next = rejectRestaurantOrder(state, orderId, "Нет нужных позиций", "RESTAURANT", "OPERATOR");
  const order = getOrder(next, orderId);
  assert.equal(order.status, "CANCELED");
  // Ровно одно новое событие.
  assert.equal(order.history.length, before + 1);
  assert.equal(order.history.at(-1)?.restaurantWorkspaceRole, "OPERATOR");
  // Повторное отклонение не создаёт второе событие.
  const again = rejectRestaurantOrder(next, orderId, "Ещё раз", "RESTAURANT", "OPERATOR");
  assert.equal(getOrder(again, orderId).history.length, before + 1);
});

test("Исправление 1: кухня в SPLIT не может отклонить", () => {
  const { state, orderId } = splitPickupState();
  const next = rejectRestaurantOrder(state, orderId, "Нет блюда", "RESTAURANT", "KITCHEN");
  assert.equal(next, state);
  assert.equal(getOrder(next, orderId).status, "RESTAURANT_REVIEW");
});

// --- Исправление 2: клиентская нейтрализация PREPARATION_PROBLEM -------------

test("Исправление 2: клиент видит нейтральный текст, оператор — исходный", () => {
  const { state, orderId } = splitPickupState();
  const reported = reportRestaurantPreparationProblem(
    state, orderId, "Закончился ингредиент", "RESTAURANT", NOW, "KITCHEN",
  );
  const order = getOrder(reported.state, orderId);
  const ev = order.history.find((e) => e.type === "PREPARATION_PROBLEM")!;
  // Исходное событие сохраняет внутренний текст (для оператора/администратора).
  assert.ok(ev.message.includes("Кухня сообщила о проблеме: Закончился ингредиент"));
  assert.equal(ev.restaurantWorkspaceRole, "KITCHEN");
  // Клиентское представление нейтрально.
  const view = clientHistoryEvent(ev, order, true);
  assert.equal(view.message, "Ресторан сообщил о проблеме с выполнением заказа.");
  assert.equal(view.hideActor, true);
  assert.ok(!view.message.includes("Кухня"));
  assert.ok(!view.message.includes("Закончился"));
  assert.ok(!view.message.includes("KITCHEN"));
  // Событие не мутировано.
  assert.ok(ev.message.includes("Закончился ингредиент"));
});

// --- Исправление 3: роль в событии невыкупа -----------------------------------

function readyForNoShow(): { state: PrototypeState; orderId: string; at: string } {
  const { state, orderId } = splitPickupState();
  let s = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  s = startKitchenPreparation(s, orderId, "RESTAURANT", "KITCHEN");
  s = markOrderReady(s, orderId, "RESTAURANT", "KITCHEN");
  const at = getPickupNoShowEligibleAtIso(getOrder(s, orderId))!;
  return { state: s, orderId, at };
}

test("Исправление 3: невыкуп оператором — событие с ролью OPERATOR", () => {
  const { state, orderId, at } = readyForNoShow();
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", at, "OPERATOR");
  assert.equal(res.result.ok, true);
  const ev = getOrder(res.state, orderId).history.at(-1);
  assert.equal(ev?.restaurantWorkspaceRole, "OPERATOR");
  // Повторный вызов не создаёт дубликат.
  const len = getOrder(res.state, orderId).history.length;
  const again = markPickupNoShow(res.state, orderId, "Ещё", "RESTAURANT", at, "OPERATOR");
  assert.equal(again.result.ok, false);
  assert.equal(getOrder(again.state, orderId).history.length, len);
});

test("Исправление 3: COMBINED-невыкуп получает роль COMBINED", () => {
  // Ресторан-2 остаётся COMBINED (без перевода в split).
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20);
  s = markOrderReady(s, orderId);
  const at = getPickupNoShowEligibleAtIso(getOrder(s, orderId))!;
  const res = markPickupNoShow(s, orderId, "Не пришёл", "RESTAURANT", at);
  assert.equal(res.result.ok, true);
  assert.equal(getOrder(res.state, orderId).history.at(-1)?.restaurantWorkspaceRole, "COMBINED");
});

test("Исправление 3: ADMIN-невыкуп не получает ресторанную роль", () => {
  const { state, orderId, at } = readyForNoShow();
  const res = markPickupNoShow(state, orderId, "Не пришёл", "ADMIN", at);
  assert.equal(res.result.ok, true);
  assert.equal(getOrder(res.state, orderId).history.at(-1)?.restaurantWorkspaceRole, undefined);
});

// --- Исправление 6: MANUAL и неизвестный режим паузы ---------------------------

test("Исправление 6: MANUAL создаёт паузу без resumeAt, проходит normalizer", () => {
  const { state } = splitPickupState();
  const res = pauseRestaurantOrders(
    state, "restaurant-2", "Перегружены", "MANUAL", null, "RESTAURANT", "KITCHEN",
  );
  assert.equal(res.result.ok, true);
  const r = res.state.restaurants.find((x) => x.id === "restaurant-2")!;
  assert.equal(r.orderPause?.mode, "MANUAL");
  assert.equal(r.orderPause?.resumeAt, null);
  const normalized = normalizePrototypeState(res.state);
  assert.equal(
    normalized.restaurants.find((x) => x.id === "restaurant-2")?.orderPause?.mode,
    "MANUAL",
  );
});

test("Исправление 6: неизвестный режим паузы блокируется без мутации", () => {
  const { state } = splitPickupState();
  const res = pauseRestaurantOrders(
    state, "restaurant-2", "Перегружены",
    "UNTIL_MAGIC" as unknown as Parameters<typeof pauseRestaurantOrders>[3],
    null, "RESTAURANT", "KITCHEN",
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Неизвестный режим паузы.");
  assert.equal(res.state, state);
});

// --- Исправление 8: ETA в COMBINED + эффективная роль -------------------------

test("Исправление 8: COMBINED меняет ETA, роль в audit — COMBINED", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20);
  // Вызов «как с кухни»: в COMBINED резолвится в COMBINED.
  const res = adjustOrderEtaFromIntent(
    s, orderId, { kind: "DELAY", minutes: 10 }, "Загружены",
    "RESTAURANT", new Date().toISOString(), "KITCHEN",
  );
  assert.equal(res.result.ok, true);
  const order = getOrder(res.state, orderId);
  assert.equal(order.etaAdjustments.at(-1)?.restaurantWorkspaceRole, "COMBINED");
  assert.equal(order.history.at(-1)?.restaurantWorkspaceRole, "COMBINED");
});

// --- Исправление 5/9: русские подписи ------------------------------------------

test("Исправление 5: русские подписи часовых поясов без IANA ID", () => {
  assert.equal(getRestaurantTimeZoneLabel("Europe/Chisinau"), "Кишинёв");
  assert.equal(getRestaurantTimeZoneLabel("America/New_York"), "Нью-Йорк");
  assert.equal(
    getRestaurantTimeZoneLabel("UTC"),
    "Всемирное координированное время",
  );
  // Неизвестный ID — безопасный русский fallback, не сырой ID.
  assert.equal(getRestaurantTimeZoneLabel("Asia/Tokyo"), "Другой часовой пояс");
  for (const label of Object.values(restaurantTimeZoneLabels)) {
    assert.ok(!label.includes("/"), label);
    assert.ok(!/[A-Za-z]/.test(label), label);
  }
});

test("Исправление 9: подписи режимов работы на русском без enum", () => {
  for (const label of Object.values(workflowModeLabels)) {
    assert.ok(/[А-Яа-яЁё]/.test(label), label);
    assert.ok(!label.includes("COMBINED"));
    assert.ok(!label.includes("SPLIT"));
  }
});


// --- Исправление 3/4: result-based отклонение + гонка кухни и оператора -------

test("Исправление 3: успешное отклонение оператором возвращает ok, одно событие, роль OPERATOR", () => {
  const { state, orderId } = splitPickupState();
  const before = getOrder(state, orderId).history.length;
  const res = rejectRestaurantOrderWithResult(
    state, orderId, "Нет нужных позиций", "RESTAURANT", "OPERATOR",
  );
  assert.equal(res.result.ok, true);
  assert.equal(res.result.error, null);
  const order = getOrder(res.state, orderId);
  assert.equal(order.status, "CANCELED");
  assert.equal(order.history.length, before + 1);
  assert.equal(order.history.at(-1)?.restaurantWorkspaceRole, "OPERATOR");
});

test("Исправление 3: кухня в SPLIT получает ok:false без мутации", () => {
  const { state, orderId } = splitPickupState();
  const res = rejectRestaurantOrderWithResult(
    state, orderId, "Нет блюда", "RESTAURANT", "KITCHEN",
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Недостаточно прав для отклонения заказа.");
  assert.equal(res.state, state);
});

test("Исправление 3: пустая причина — ошибка без мутации", () => {
  const { state, orderId } = splitPickupState();
  const res = rejectRestaurantOrderWithResult(state, orderId, "   ", "RESTAURANT", "OPERATOR");
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Укажите причину отклонения.");
  assert.equal(res.state, state);
});

test("Исправление 3: неизвестный заказ — ошибка без мутации", () => {
  const { state } = splitPickupState();
  const res = rejectRestaurantOrderWithResult(state, "order-nope", "Причина", "RESTAURANT", "OPERATOR");
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Заказ не найден.");
  assert.equal(res.state, state);
});

test("Исправление 4: гонка — кухня приняла, оператор получает race-ошибку", () => {
  const { state, orderId } = splitPickupState();
  // Кухня принимает на исходном состоянии.
  const accepted = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "OPERATOR");
  const statusAfterAccept = getOrder(accepted, orderId).status;
  const historyAfterAccept = getOrder(accepted, orderId).history.length;
  // «Устаревший» оператор пытается отклонить уже принятый заказ.
  const res = rejectRestaurantOrderWithResult(
    accepted, orderId, "Нет нужных позиций", "RESTAURANT", "OPERATOR",
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Заказ уже обработан. Обновите данные.");
  // State — тот же объект, что после принятия; ничего не мутировано.
  assert.equal(res.state, accepted);
  const order = getOrder(res.state, orderId);
  assert.equal(order.status, statusAfterAccept);
  // PICKUP (оплата на точке) после принятия готовится, не отменён.
  assert.equal(order.status, "PREPARING");
  assert.equal(order.history.length, historyAfterAccept);
});

test("Исправление 4: обратная гонка — после отклонения устаревший оператор не примет", () => {
  const { state, orderId } = splitPickupState();
  const rejected = rejectRestaurantOrderWithResult(
    state, orderId, "Ресторан не может выполнить заказ", "RESTAURANT", "OPERATOR",
  );
  assert.equal(rejected.result.ok, true);
  const historyAfterReject = getOrder(rejected.state, orderId).history.length;
  const tryAccept = acceptRestaurantOrder(rejected.state, orderId, 20, "RESTAURANT", "OPERATOR");
  // Отменённый заказ не принимается: state не изменился, событий не добавилось.
  assert.equal(tryAccept, rejected.state);
  const order = getOrder(tryAccept, orderId);
  assert.equal(order.status, "CANCELED");
  assert.equal(order.history.length, historyAfterReject);
});

test("Исправление 3: повторное отклонение — ошибка, второе событие не создаётся", () => {
  const { state, orderId } = splitPickupState();
  const first = rejectRestaurantOrderWithResult(state, orderId, "Причина", "RESTAURANT", "OPERATOR");
  const len = getOrder(first.state, orderId).history.length;
  const second = rejectRestaurantOrderWithResult(first.state, orderId, "Ещё раз", "RESTAURANT", "OPERATOR");
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Заказ уже обработан. Обновите данные.");
  assert.equal(second.state, first.state);
  assert.equal(getOrder(second.state, orderId).history.length, len);
});

test("Исправление 3: compatibility-wrapper возвращает PrototypeState", () => {
  const { state, orderId } = splitPickupState();
  const next = rejectRestaurantOrder(state, orderId, "Причина", "RESTAURANT", "OPERATOR");
  // Это state, а не ActionResult.
  assert.ok(Array.isArray((next as PrototypeState).orders));
  assert.equal(getOrder(next as PrototypeState, orderId).status, "CANCELED");
  // Ошибочный путь: тот же state.
  const noop = rejectRestaurantOrder(next as PrototypeState, orderId, "Ещё", "RESTAURANT", "OPERATOR");
  assert.equal(noop, next);
});

test("Исправление 3: отклонение не меняет финансовый снимок и оплату", () => {
  const { state, orderId } = splitPickupState();
  const before = getOrder(state, orderId);
  const res = rejectRestaurantOrderWithResult(state, orderId, "Причина", "RESTAURANT", "OPERATOR");
  const after = getOrder(res.state, orderId);
  assert.deepEqual(after.financials, before.financials);
  assert.equal(after.paymentStatus, before.paymentStatus);
  assert.equal(after.paidAt, before.paidAt);
  assert.equal(res.state.settlements.length, state.settlements.length);
  // Один заказ, без дублирования.
  assert.equal(
    res.state.orders.filter((o) => o.id === orderId).length,
    1,
  );
});

test("Исправление 5: русские подписи режимов доставки без enum", () => {
  for (const label of Object.values(deliveryModeLabels)) {
    assert.ok(/[А-Яа-яЁё]/.test(label), label);
    assert.ok(!label.includes("PLATFORM_DRIVER"));
    assert.ok(!label.includes("RESTAURANT_DELIVERY"));
    assert.ok(!label.includes("PICKUP"));
  }
});
