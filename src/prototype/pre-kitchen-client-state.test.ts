import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  cancelOrderByClient,
  completePickupAtRestaurant,
  createOrderFromCart,
  markOrderArriving,
  markOrderDelivered,
  markOrderOutForDelivery,
  markOrderReady,
  PRE_KITCHEN_PREPARING_HISTORY_MESSAGE,
  requestOrderCancellationByClient,
  setCartFulfillmentChoice,
  simulateSuccessfulOnlinePaymentWithResult,
  startKitchenPreparationWithResult,
  updateCartAddress,
} from "./actions.ts";
import {
  canClientCancelDirectly,
  canClientRequestCancellation,
  CLIENT_PAID_AWAITING_KITCHEN_CANCEL_TEXT,
  getClientCancellationMode,
  getClientOrderStatusLabel,
  getPostPreparationWarning,
  hasActiveEtaUpdate,
  isAwaitingKitchenStart,
  orderStatusLabels,
} from "./selectors.ts";
import type {
  Order,
  PrototypeState,
  RestaurantOrderWorkflowMode,
} from "./models.ts";

/**
 * До клика кухни (SPLIT: PREPARING + kitchenStartedAt null) клиент видит
 * «Принят рестораном», неоплаченные заказы отменяются напрямую, оплаченный
 * ONLINE — только запросом, и ни один текст не утверждает, что приготовление
 * уже началось. COMBINED сохраняет прежнее поведение.
 */

const ADDR = { street: "Тестовая улица 1", house: "1" };

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

function withMode(
  state: PrototypeState,
  restaurantId: string,
  mode: RestaurantOrderWorkflowMode,
): PrototypeState {
  return {
    ...state,
    restaurants: state.restaurants.map((r) =>
      r.id === restaurantId ? { ...r, orderWorkflowMode: mode } : r,
    ),
  };
}

/** SPLIT restaurant-2, самовывоз → PAY_AT_RESTAURANT, принят оператором. */
function splitPayAtRestaurantPreparing(): {
  state: PrototypeState;
  orderId: string;
} {
  let s = withMode(createDefaultState(), "restaurant-2", "SPLIT_OPERATOR_KITCHEN");
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  const accepted = acceptRestaurantOrderWithResult(
    created.state,
    orderId,
    20,
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(accepted.result.ok, true);
  return { state: accepted.state, orderId };
}

/** SPLIT restaurant-3, доставка ресторана → CASH_TO_RESTAURANT_COURIER. */
function splitCourierCashPreparing(): {
  state: PrototypeState;
  orderId: string;
} {
  let s = withMode(createDefaultState(), "restaurant-3", "SPLIT_OPERATOR_KITCHEN");
  s = updateCartAddress(s, ADDR);
  // Две позиции по 710 = 1420 ≥ минимум 1000 собственной доставки.
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  const accepted = acceptRestaurantOrderWithResult(
    created.state,
    orderId,
    20,
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(accepted.result.ok, true);
  return { state: accepted.state, orderId };
}

/** SPLIT restaurant-2, доставка → ONLINE, принят и оплачен. */
function splitOnlinePaidPreparing(): {
  state: PrototypeState;
  orderId: string;
} {
  let s = withMode(createDefaultState(), "restaurant-2", "SPLIT_OPERATOR_KITCHEN");
  s = updateCartAddress(s, ADDR);
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  const accepted = acceptRestaurantOrderWithResult(
    created.state,
    orderId,
    20,
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(accepted.result.ok, true);
  const paid = simulateSuccessfulOnlinePaymentWithResult(
    accepted.state,
    orderId,
  );
  assert.equal(paid.result.ok, true);
  return { state: paid.state, orderId };
}

/** COMBINED restaurant-2, самовывоз, принят (kitchenStartedAt ставится сразу). */
function combinedPreparing(): { state: PrototypeState; orderId: string } {
  let s = setCartFulfillmentChoice(createDefaultState(), "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  const accepted = acceptRestaurantOrderWithResult(
    created.state,
    orderId,
    20,
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(accepted.result.ok, true);
  return { state: accepted.state, orderId };
}

function startKitchen(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  const started = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(started.result.ok, true);
  return started.state;
}

// 1 — клиентская подпись до старта -------------------------------------------

test("до старта кухни клиент видит «Принят рестораном», а не «Готовится»", () => {
  const { state, orderId } = splitPayAtRestaurantPreparing();
  const order = orderOf(state, orderId);
  assert.equal(order.status, "PREPARING");
  assert.equal(order.kitchenStartedAt, null);
  assert.equal(getClientOrderStatusLabel(order), "Принят рестораном");
  assert.notEqual(getClientOrderStatusLabel(order), "Готовится");
  // Глобальная подпись PREPARING для кухни/оператора/админки не изменилась.
  assert.equal(orderStatusLabels.PREPARING, "Готовится");
});

// 2 — после старта подпись обычная -------------------------------------------

test("после подтверждения кухни клиентская подпись снова «Готовится»", () => {
  const { state, orderId } = splitPayAtRestaurantPreparing();
  const started = startKitchen(state, orderId);
  const order = orderOf(started, orderId);
  assert.ok(order.kitchenStartedAt);
  assert.equal(getClientOrderStatusLabel(order), "Готовится");
});

// 3 — прямая отмена неоплаченного самовывоза ----------------------------------

test("SPLIT PAY_AT_RESTAURANT до старта: прямая отмена разрешена и чиста", () => {
  const { state, orderId } = splitPayAtRestaurantPreparing();
  const order = orderOf(state, orderId);
  assert.equal(order.paymentMethod, "PAY_AT_RESTAURANT");
  assert.equal(order.paidAt, null);
  assert.equal(getClientCancellationMode(order), "DIRECT_CANCEL");
  assert.equal(canClientCancelDirectly(order), true);
  assert.equal(canClientRequestCancellation(order), false);

  const historyBefore = order.history.length;
  const res = cancelOrderByClient(state, orderId, "Передумал");
  assert.equal(res.result.ok, true);
  const canceled = orderOf(res.state, orderId);
  assert.equal(canceled.status, "CANCELED");
  assert.equal(canceled.cancellationReason, "Передумал");
  const last = canceled.history.at(-1);
  assert.equal(last?.actor, "CLIENT");
  assert.equal(last?.fromStatus, "PREPARING");
  assert.equal(last?.toStatus, "CANCELED");
  assert.equal(canceled.history.length, historyBefore + 1);
  // Ни settlement, ни accounting, ни изменения финансового снимка.
  assert.equal(res.state.settlements.length, 0);
  assert.equal(res.state.restaurantAccountingEntries.length, 0);
  assert.deepEqual(canceled.financials, order.financials);
});

// 4 — прямая отмена неоплаченных наличных курьеру ------------------------------

test("SPLIT CASH_TO_RESTAURANT_COURIER до старта: прямая отмена разрешена", () => {
  const { state, orderId } = splitCourierCashPreparing();
  const order = orderOf(state, orderId);
  assert.equal(order.paymentMethod, "CASH_TO_RESTAURANT_COURIER");
  assert.equal(order.paymentStatus, "DUE_TO_RESTAURANT_COURIER");
  assert.equal(order.kitchenStartedAt, null);
  assert.equal(getClientCancellationMode(order), "DIRECT_CANCEL");

  const res = cancelOrderByClient(state, orderId, "Изменились планы");
  assert.equal(res.result.ok, true);
  assert.equal(orderOf(res.state, orderId).status, "CANCELED");
  assert.equal(res.state.settlements.length, 0);
  assert.equal(res.state.restaurantAccountingEntries.length, 0);
});

// 5 — оплаченный ONLINE до старта ---------------------------------------------

test("ONLINE PAID до старта: только запрос, тексты не утверждают начала", () => {
  const { state, orderId } = splitOnlinePaidPreparing();
  const order = orderOf(state, orderId);
  assert.equal(order.paymentStatus, "PAID");
  assert.equal(order.kitchenStartedAt, null);
  assert.equal(getClientCancellationMode(order), "REQUEST_CANCEL");
  assert.equal(canClientCancelDirectly(order), false);
  assert.equal(canClientRequestCancellation(order), true);

  const direct = cancelOrderByClient(state, orderId, "Передумал");
  assert.equal(direct.result.ok, false);
  assert.equal(direct.result.error, CLIENT_PAID_AWAITING_KITCHEN_CANCEL_TEXT);
  assert.ok(!/уже начал/.test(direct.result.error ?? ""));
  assert.equal(direct.state, state);

  const warning = getPostPreparationWarning(order);
  assert.equal(warning, CLIENT_PAID_AWAITING_KITCHEN_CANCEL_TEXT);
  assert.ok(!/уже начал/.test(warning));
  assert.ok(warning.includes("кухня ещё не начала"));

  const request = requestOrderCancellationByClient(state, orderId, "Передумал");
  assert.equal(request.result.ok, true);
});

// 6 — после фактического старта -----------------------------------------------

test("после старта кухни: прямой отмены нет, запрос работает как раньше", () => {
  const { state, orderId } = splitPayAtRestaurantPreparing();
  const started = startKitchen(state, orderId);
  const order = orderOf(started, orderId);
  assert.equal(getClientCancellationMode(order), "REQUEST_CANCEL");

  const direct = cancelOrderByClient(started, orderId, "Поздно");
  assert.equal(direct.result.ok, false);
  assert.match(direct.result.error ?? "", /начал готовить/);
  assert.equal(direct.state, started);

  assert.match(getPostPreparationWarning(order), /уже начал готовить/);

  const request = requestOrderCancellationByClient(started, orderId, "Поздно");
  assert.equal(request.result.ok, true);
});

// 7 — гонка кухни и клиента ---------------------------------------------------

test("гонка: кухня начала перед submit — прямая отмена fail-closed", () => {
  const { state, orderId } = splitPayAtRestaurantPreparing();
  // Клиент открыл форму, пока отмена ещё была доступна.
  assert.equal(canClientCancelDirectly(orderOf(state, orderId)), true);
  // Кухня успела нажать «Начать готовить».
  const started = startKitchen(state, orderId);
  // Submit формы: action проверяет АКТУАЛЬНЫЙ Order, а не старую кнопку.
  const res = cancelOrderByClient(started, orderId, "Передумал");
  assert.equal(res.result.ok, false);
  assert.equal(res.state, started); // исходный state тем же объектом
  assert.equal(orderOf(started, orderId).status, "PREPARING");
});

// 8 — COMBINED не расширился --------------------------------------------------

test("COMBINED PREPARING: kitchenStartedAt не null, прямой отмены нет", () => {
  const { state, orderId } = combinedPreparing();
  const order = orderOf(state, orderId);
  assert.ok(order.kitchenStartedAt);
  assert.equal(isAwaitingKitchenStart(order), false);
  assert.equal(getClientCancellationMode(order), "REQUEST_CANCEL");
  const res = cancelOrderByClient(state, orderId, "Передумал");
  assert.equal(res.result.ok, false);
  assert.match(res.result.error ?? "", /начал готовить/);
});

// 9 — история SPLIT до старта -------------------------------------------------

test("история SPLIT: точный текст про передачу кухне, без «в приготовление»", () => {
  const accepted = splitPayAtRestaurantPreparing();
  const acceptEvent = orderOf(accepted.state, accepted.orderId).history.at(-1);
  assert.equal(acceptEvent?.type, "STATUS");
  assert.equal(acceptEvent?.toStatus, "PREPARING");
  assert.equal(
    acceptEvent?.message,
    "Заказ принят рестораном и передан кухне. Ожидается начало приготовления.",
  );
  assert.equal(acceptEvent?.message, PRE_KITCHEN_PREPARING_HISTORY_MESSAGE);
  assert.ok(!acceptEvent?.message.includes("в приготовление"));

  const online = splitOnlinePaidPreparing();
  const paidEvent = orderOf(online.state, online.orderId).history.at(-1);
  assert.equal(paidEvent?.type, "STATUS");
  assert.equal(paidEvent?.toStatus, "PREPARING");
  assert.equal(paidEvent?.message, PRE_KITCHEN_PREPARING_HISTORY_MESSAGE);
  assert.ok(!paidEvent?.message.includes("в приготовление"));

  const courier = splitCourierCashPreparing();
  const courierEvent = orderOf(courier.state, courier.orderId).history.at(-1);
  assert.equal(courierEvent?.message, PRE_KITCHEN_PREPARING_HISTORY_MESSAGE);
});

// 10 — история COMBINED прежняя -----------------------------------------------

test("история COMBINED: прежние тексты перехода сохранены", () => {
  const { state, orderId } = combinedPreparing();
  const acceptEvent = orderOf(state, orderId).history.at(-1);
  assert.equal(
    acceptEvent?.message,
    "Ресторан принял заказ. Время приготовления — 20 минут. Оплата в ресторане при получении.",
  );

  // COMBINED + ONLINE: оплата по-прежнему пишет «в приготовление».
  let s = updateCartAddress(createDefaultState(), ADDR);
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart(s);
  const onlineId = created.result.orderId as string;
  const accepted = acceptRestaurantOrderWithResult(
    created.state,
    onlineId,
    20,
    "RESTAURANT",
    "COMBINED",
  );
  const paid = simulateSuccessfulOnlinePaymentWithResult(
    accepted.state,
    onlineId,
  );
  assert.equal(paid.result.ok, true);
  const paidEvent = orderOf(paid.state, onlineId).history.at(-1);
  assert.equal(paidEvent?.message, "Заказ передан ресторану в приготовление.");
});

// 11 — до старта нет ложного ETA ----------------------------------------------

test("до старта нет ETA/отсчёта: expectedReadyAt null, ETA-плашка скрыта", () => {
  const { state, orderId } = splitOnlinePaidPreparing();
  const order = orderOf(state, orderId);
  assert.equal(isAwaitingKitchenStart(order), true);
  assert.equal(order.expectedReadyAt, null);
  assert.equal(hasActiveEtaUpdate(order), false);
});

// 12 — терминальные статусы ---------------------------------------------------

test("терминальные статусы: отмена и запрос недоступны", () => {
  // CANCELED.
  const { state, orderId } = splitPayAtRestaurantPreparing();
  const canceled = cancelOrderByClient(state, orderId, "Передумал").state;
  const canceledOrder = orderOf(canceled, orderId);
  assert.equal(getClientCancellationMode(canceledOrder), "UNAVAILABLE");
  const again = cancelOrderByClient(canceled, orderId, "Ещё раз");
  assert.equal(again.result.ok, false);
  assert.ok(!/начал готовить/.test(again.result.error ?? ""));
  assert.equal(
    requestOrderCancellationByClient(canceled, orderId, "Ещё раз").result.ok,
    false,
  );

  // DELIVERED (COMBINED restaurant-3, полный цикл доставки ресторана).
  let s = updateCartAddress(createDefaultState(), ADDR);
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const deliveredId = created.result.orderId as string;
  s = acceptRestaurantOrderWithResult(created.state, deliveredId, 20).state;
  s = markOrderReady(s, deliveredId);
  s = markOrderOutForDelivery(s, deliveredId);
  s = markOrderArriving(s, deliveredId);
  s = markOrderDelivered(s, deliveredId);
  const delivered = orderOf(s, deliveredId);
  assert.equal(delivered.status, "DELIVERED");
  assert.equal(getClientCancellationMode(delivered), "UNAVAILABLE");
  assert.equal(cancelOrderByClient(s, deliveredId, "Поздно").result.ok, false);
});

// 13 — доменный запрет запроса для DIRECT_CANCEL -------------------------------

test("запрос запрещён для неоплаченного самовывоза до старта: атомарная ошибка", () => {
  const { state, orderId } = splitPayAtRestaurantPreparing();
  const order = orderOf(state, orderId);
  assert.equal(getClientCancellationMode(order), "DIRECT_CANCEL");

  const res = requestOrderCancellationByClient(state, orderId, "Передумал");
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Этот заказ можно отменить сразу без запроса.");
  // Атомарность: исходный state тем же объектом, ничего не мутировано.
  assert.equal(res.state, state);
  assert.equal(res.state.revision, state.revision);
  assert.equal(res.state.cancellationRequests.length, 0);
  assert.equal(orderOf(res.state, orderId), order);
});

test("запрос запрещён для неоплаченных наличных курьеру до старта", () => {
  const { state, orderId } = splitCourierCashPreparing();
  const order = orderOf(state, orderId);
  assert.equal(getClientCancellationMode(order), "DIRECT_CANCEL");

  const res = requestOrderCancellationByClient(state, orderId, "Передумал");
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Этот заказ можно отменить сразу без запроса.");
  assert.equal(res.state, state);
  assert.equal(res.state.cancellationRequests.length, 0);
  assert.equal(orderOf(res.state, orderId), order);
});

// 14 — запрос после старта для всех способов оплаты ----------------------------

test("после старта кухни запрос создаётся для всех способов оплаты", () => {
  const flows = [
    splitPayAtRestaurantPreparing,
    splitCourierCashPreparing,
    splitOnlinePaidPreparing,
  ];
  for (const make of flows) {
    const { state, orderId } = make();
    const started = startKitchen(state, orderId);
    const res = requestOrderCancellationByClient(started, orderId, "Передумал");
    assert.equal(res.result.ok, true, res.result.error ?? "");
    const request = res.state.cancellationRequests.find(
      (r) => r.orderId === orderId,
    );
    assert.equal(request?.status, "PENDING");
  }
});

// 15 — READY_FOR_PICKUP в SPLIT (READY/OUT_FOR_DELIVERY/ARRIVING покрывает
// cancellation.test.ts) --------------------------------------------------------

test("READY_FOR_PICKUP: запрос по-прежнему создаётся", () => {
  const { state, orderId } = splitPayAtRestaurantPreparing();
  let s = startKitchen(state, orderId);
  s = markOrderReady(s, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(orderOf(s, orderId).status, "READY_FOR_PICKUP");
  const res = requestOrderCancellationByClient(s, orderId, "Передумал");
  assert.equal(res.result.ok, true, res.result.error ?? "");
});

// 16 — до принятия/оплаты используется прямая отмена ---------------------------

test("RESTAURANT_REVIEW и AWAITING_PAYMENT: точная ошибка про прямую отмену", () => {
  // RESTAURANT_REVIEW.
  let s = setCartFulfillmentChoice(createDefaultState(), "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart(s);
  const reviewId = created.result.orderId as string;
  const reviewRes = requestOrderCancellationByClient(created.state, reviewId, "x");
  assert.equal(reviewRes.result.ok, false);
  assert.equal(
    reviewRes.result.error,
    "Этот заказ можно отменить сразу без запроса.",
  );
  assert.equal(reviewRes.state, created.state);

  // AWAITING_PAYMENT (доставка ONLINE, принят, не оплачен).
  let d = updateCartAddress(createDefaultState(), ADDR);
  d = addCartItem(d, "restaurant-2-item-1").state;
  const dCreated = createOrderFromCart(d);
  const awaitingId = dCreated.result.orderId as string;
  const accepted = acceptRestaurantOrderWithResult(
    dCreated.state,
    awaitingId,
    20,
    "RESTAURANT",
    "COMBINED",
  ).state;
  assert.equal(orderOf(accepted, awaitingId).status, "AWAITING_PAYMENT");
  const awaitingRes = requestOrderCancellationByClient(accepted, awaitingId, "x");
  assert.equal(awaitingRes.result.ok, false);
  assert.equal(
    awaitingRes.result.error,
    "Этот заказ можно отменить сразу без запроса.",
  );
  assert.equal(awaitingRes.state, accepted);
});

// 17 — терминальный PICKED_UP и защита от дубля --------------------------------

test("PICKED_UP: запрос недоступен", () => {
  const { state, orderId } = combinedPreparing();
  const ready = markOrderReady(state, orderId);
  const done = completePickupAtRestaurant(ready, orderId, "CASH");
  assert.equal(done.result.ok, true, done.result.error ?? "");
  assert.equal(orderOf(done.state, orderId).status, "PICKED_UP");
  const res = requestOrderCancellationByClient(done.state, orderId, "x");
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Для этого заказа запрос на отмену недоступен.");
  assert.equal(res.state, done.state);
});

test("повторный запрос: защита от дубля сохранена", () => {
  const { state, orderId } = splitOnlinePaidPreparing();
  const first = requestOrderCancellationByClient(state, orderId, "Передумал");
  assert.equal(first.result.ok, true);
  const second = requestOrderCancellationByClient(first.state, orderId, "Ещё");
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Запрос на отмену уже отправлен.");
  assert.equal(second.state.cancellationRequests.length, 1);
});
