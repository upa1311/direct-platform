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
  rejectRestaurantOrderWithResult,
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
  let s = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
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
  const accepted = acceptRestaurantOrder(state, orderId, 20, "RESTAURANT", "KITCHEN");
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

test("Исправление 4: обратная гонка — после отклонения кухня не может принять", () => {
  const { state, orderId } = splitPickupState();
  const rejected = rejectRestaurantOrderWithResult(
    state, orderId, "Ресторан не может выполнить заказ", "RESTAURANT", "OPERATOR",
  );
  assert.equal(rejected.result.ok, true);
  const historyAfterReject = getOrder(rejected.state, orderId).history.length;
  const tryAccept = acceptRestaurantOrder(rejected.state, orderId, 20, "RESTAURANT", "KITCHEN");
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
