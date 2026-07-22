import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  approveCancellationRequest,
  assignDriverToOrder,
  cancelOrderByClient,
  createOrderFromCart,
  goDriverOnline,
  expireUnansweredRestaurantOrders,
  markOrderArriving,
  markOrderOutForDelivery,
  markOrderReady,
  rejectCancellationRequest,
  rejectRestaurantOrder,
  requestOrderCancellationByClient,
  RESTAURANT_RESPONSE_TIMEOUT_MS,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import {
  getPendingCancellationRequests,
  getPendingCancellationRequestsForRestaurant,
  isKitchenBeepDue,
} from "./selectors.ts";
import type { Order, PrototypeState } from "./models.ts";

const ADDR = { street: "Тестовая улица 1", house: "1" };

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

function addPickupReview(
  state: PrototypeState,
  itemId = "restaurant-2-item-1",
): { state: PrototypeState; orderId: string } {
  const withItem = addCartItem(state, itemId).state;
  const created = createOrderFromCart({
    ...withItem,
    cart: { ...withItem.cart, fulfillmentChoice: "PICKUP" },
  });
  return { state: created.state, orderId: created.result.orderId as string };
}

function addDeliveryReview(
  state: PrototypeState,
  itemId = "restaurant-2-item-1",
  qty = 1,
): { state: PrototypeState; orderId: string } {
  let s = updateCartAddress(state, ADDR);
  for (let i = 0; i < qty; i += 1) s = addCartItem(s, itemId).state;
  const created = createOrderFromCart(s);
  return { state: created.state, orderId: created.result.orderId as string };
}

/** PICKUP-заказ, доведённый до PREPARING. */
function pickupPreparing(): { state: PrototypeState; orderId: string } {
  const { state, orderId } = addPickupReview(createDefaultState());
  return { state: acceptRestaurantOrder(state, orderId, 20), orderId };
}

function plusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

// =========================== §16: автоотмена ================================

test("автоотмена: 6:59 не отменяется", () => {
  const { state, orderId } = addPickupReview(createDefaultState());
  const created = orderOf(state, orderId).createdAt;
  const next = expireUnansweredRestaurantOrders(
    state,
    plusMs(created, RESTAURANT_RESPONSE_TIMEOUT_MS - 1000),
  );
  assert.equal(orderOf(next, orderId).status, "RESTAURANT_REVIEW");
});

test("автоотмена: 7:00 отменяется с причиной, actor SYSTEM, одно событие", () => {
  const { state, orderId } = addPickupReview(createDefaultState());
  const created = orderOf(state, orderId).createdAt;
  const before = orderOf(state, orderId).history.length;
  const next = expireUnansweredRestaurantOrders(
    state,
    plusMs(created, RESTAURANT_RESPONSE_TIMEOUT_MS),
  );
  const order = orderOf(next, orderId);
  assert.equal(order.status, "CANCELED");
  assert.equal(order.cancellationReason, "Ресторан не ответил в течение 7 минут");
  const last = order.history.at(-1);
  assert.equal(last?.actor, "SYSTEM");
  assert.equal(last?.fromStatus, "RESTAURANT_REVIEW");
  assert.equal(last?.toStatus, "CANCELED");
  assert.equal(order.history.length, before + 1);
});

test("автоотмена идемпотентна: повторный sweep не создаёт второе событие", () => {
  const { state, orderId } = addPickupReview(createDefaultState());
  const created = orderOf(state, orderId).createdAt;
  const nowIso = plusMs(created, RESTAURANT_RESPONSE_TIMEOUT_MS);
  const once = expireUnansweredRestaurantOrders(state, nowIso);
  const len = orderOf(once, orderId).history.length;
  const twice = expireUnansweredRestaurantOrders(once, nowIso);
  assert.equal(twice, once); // без изменений — та же ссылка
  assert.equal(orderOf(twice, orderId).history.length, len);
});

test("автоотмена не трогает AWAITING_PAYMENT и PREPARING", () => {
  const awaiting = addDeliveryReview(createDefaultState());
  const s1 = acceptRestaurantOrder(awaiting.state, awaiting.orderId, 20);
  assert.equal(orderOf(s1, awaiting.orderId).status, "AWAITING_PAYMENT");
  const created1 = orderOf(s1, awaiting.orderId).createdAt;
  const after1 = expireUnansweredRestaurantOrders(
    s1,
    plusMs(created1, RESTAURANT_RESPONSE_TIMEOUT_MS + 60_000),
  );
  assert.equal(orderOf(after1, awaiting.orderId).status, "AWAITING_PAYMENT");

  const prep = pickupPreparing();
  const created2 = orderOf(prep.state, prep.orderId).createdAt;
  const after2 = expireUnansweredRestaurantOrders(
    prep.state,
    plusMs(created2, RESTAURANT_RESPONSE_TIMEOUT_MS + 60_000),
  );
  assert.equal(orderOf(after2, prep.orderId).status, "PREPARING");
});

test("автоотмена не меняет уже отклонённый заказ", () => {
  const { state, orderId } = addPickupReview(createDefaultState());
  const rejected = rejectRestaurantOrder(state, orderId, "нет позиций");
  const created = orderOf(rejected, orderId).createdAt;
  const after = expireUnansweredRestaurantOrders(
    rejected,
    plusMs(created, RESTAURANT_RESPONSE_TIMEOUT_MS + 60_000),
  );
  assert.equal(after, rejected);
});

test("автоотмена не меняет financial snapshot и не создаёт settlement", () => {
  const { state, orderId } = addPickupReview(createDefaultState());
  const created = orderOf(state, orderId).createdAt;
  const financialsBefore = JSON.stringify(orderOf(state, orderId).financials);
  const after = expireUnansweredRestaurantOrders(
    state,
    plusMs(created, RESTAURANT_RESPONSE_TIMEOUT_MS),
  );
  assert.equal(JSON.stringify(orderOf(after, orderId).financials), financialsBefore);
  assert.equal(after.settlements.length, 0);
});

test("автоотмена проверяет заказы всех ресторанов", () => {
  const r1 = addPickupReview(createDefaultState(), "restaurant-1-item-1");
  const r2 = addPickupReview(r1.state, "restaurant-2-item-1");
  const created = orderOf(r2.state, r2.orderId).createdAt;
  const after = expireUnansweredRestaurantOrders(
    r2.state,
    plusMs(created, RESTAURANT_RESPONSE_TIMEOUT_MS + 60_000),
  );
  assert.equal(orderOf(after, r1.orderId).status, "CANCELED");
  assert.equal(orderOf(after, r2.orderId).status, "CANCELED");
});

// =========================== §17: клиентская отмена =========================

test("клиент может отменить RESTAURANT_REVIEW и AWAITING_PAYMENT", () => {
  const review = addPickupReview(createDefaultState());
  assert.equal(
    cancelOrderByClient(review.state, review.orderId, "передумал").result.ok,
    true,
  );
  const awaiting = addDeliveryReview(createDefaultState());
  const s1 = acceptRestaurantOrder(awaiting.state, awaiting.orderId, 20);
  assert.equal(orderOf(s1, awaiting.orderId).status, "AWAITING_PAYMENT");
  const res = cancelOrderByClient(s1, awaiting.orderId, "передумал");
  assert.equal(res.result.ok, true);
  assert.equal(orderOf(res.state, awaiting.orderId).status, "CANCELED");
});

test("клиент не может напрямую отменить PREPARING (гонка)", () => {
  const { state, orderId } = pickupPreparing();
  const res = cancelOrderByClient(state, orderId, "поздно");
  assert.equal(res.result.ok, false);
  assert.match(res.result.error ?? "", /начал готовить/);
  assert.equal(orderOf(res.state, orderId).status, "PREPARING");
});

test("клиентская отмена не меняет финансы и не создаёт settlement", () => {
  const { state, orderId } = addDeliveryReview(createDefaultState());
  const financialsBefore = JSON.stringify(orderOf(state, orderId).financials);
  const res = cancelOrderByClient(state, orderId, "передумал");
  assert.equal(
    JSON.stringify(orderOf(res.state, orderId).financials),
    financialsBefore,
  );
  assert.equal(res.state.settlements.length, 0);
});

// =========================== §18: запрос на отмену ==========================

/** Достигает нужного активного статуса запросимого заказа. */
function orderInStatus(status: Order["status"]): {
  state: PrototypeState;
  orderId: string;
} {
  if (status === "PREPARING") return pickupPreparing();
  if (status === "READY_FOR_PICKUP") {
    const p = pickupPreparing();
    return { state: markOrderReady(p.state, p.orderId), orderId: p.orderId };
  }
  // Доставка Ресторана 3 (свой курьер) для READY/OUT_FOR_DELIVERY/ARRIVING.
  const d = addDeliveryReview(createDefaultState(), "restaurant-3-item-1", 2);
  let s = acceptRestaurantOrder(d.state, d.orderId, 20); // PREPARING
  s = markOrderReady(s, d.orderId); // READY
  if (status === "READY") return { state: s, orderId: d.orderId };
  s = markOrderOutForDelivery(s, d.orderId); // OUT_FOR_DELIVERY
  if (status === "OUT_FOR_DELIVERY") return { state: s, orderId: d.orderId };
  s = markOrderArriving(s, d.orderId); // ARRIVING
  return { state: s, orderId: d.orderId };
}

for (const status of [
  "PREPARING",
  "READY",
  "READY_FOR_PICKUP",
  "OUT_FOR_DELIVERY",
  "ARRIVING",
] as const) {
  test(`запрос на отмену разрешён в статусе ${status}`, () => {
    const { state, orderId } = orderInStatus(status);
    const res = requestOrderCancellationByClient(state, orderId, "причина");
    assert.equal(res.result.ok, true);
    // Статус заказа не меняется.
    assert.equal(orderOf(res.state, orderId).status, status);
    const req = res.state.cancellationRequests.find((r) => r.orderId === orderId);
    assert.equal(req?.status, "PENDING");
  });
}

test("запрос на отмену запрещён до приготовления и в терминальном статусе", () => {
  const review = addPickupReview(createDefaultState());
  assert.equal(
    requestOrderCancellationByClient(review.state, review.orderId, "x").result.ok,
    false,
  );
  const awaiting = addDeliveryReview(createDefaultState());
  const s1 = acceptRestaurantOrder(awaiting.state, awaiting.orderId, 20);
  assert.equal(
    requestOrderCancellationByClient(s1, awaiting.orderId, "x").result.ok,
    false,
  );
  const canceled = rejectRestaurantOrder(
    review.state,
    review.orderId,
    "нет",
  );
  assert.equal(
    requestOrderCancellationByClient(canceled, review.orderId, "x").result.ok,
    false,
  );
});

test("запрос: причина обязательна и не создаёт дубликат", () => {
  const { state, orderId } = pickupPreparing();
  assert.equal(
    requestOrderCancellationByClient(state, orderId, "   ").result.ok,
    false,
  );
  const first = requestOrderCancellationByClient(state, orderId, "причина");
  assert.equal(first.result.ok, true);
  const second = requestOrderCancellationByClient(first.state, orderId, "ещё");
  assert.equal(second.result.ok, false);
  assert.equal(second.state.cancellationRequests.length, 1);
});

test("создание запроса не меняет paymentStatus, financials и не создаёт settlement", () => {
  const { state, orderId } = pickupPreparing();
  const before = orderOf(state, orderId);
  const paymentBefore = before.paymentStatus;
  const financialsBefore = JSON.stringify(before.financials);
  const res = requestOrderCancellationByClient(state, orderId, "причина");
  const after = orderOf(res.state, orderId);
  assert.equal(after.paymentStatus, paymentBefore);
  assert.equal(JSON.stringify(after.financials), financialsBefore);
  assert.equal(res.state.settlements.length, 0);
});

test("ресторан видит только свои запросы; админ видит все", () => {
  const p2 = pickupPreparing(); // restaurant-2
  let s = requestOrderCancellationByClient(p2.state, p2.orderId, "r2").state;
  const p3 = orderInStatus("READY"); // restaurant-3 в состоянии p3.state (отдельное)
  // Переносим заказ restaurant-3 в общее состояние s, запросив там отмену.
  const d = addDeliveryReview(s, "restaurant-3-item-1", 2);
  s = d.state;
  s = acceptRestaurantOrder(s, d.orderId, 20);
  s = markOrderReady(s, d.orderId);
  s = requestOrderCancellationByClient(s, d.orderId, "r3").state;
  void p3;

  assert.equal(getPendingCancellationRequests(s).length, 2);
  assert.equal(
    getPendingCancellationRequestsForRestaurant(s, "restaurant-2").length,
    1,
  );
  assert.equal(
    getPendingCancellationRequestsForRestaurant(s, "restaurant-3").length,
    1,
  );
});

test("отклонение запроса оставляет заказ активным", () => {
  const { state, orderId } = pickupPreparing();
  const req = requestOrderCancellationByClient(state, orderId, "причина").state;
  const requestId = `cancellation-request-${orderId}`;
  const res = rejectCancellationRequest(req, requestId, "продолжаем");
  assert.equal(res.result.ok, true);
  assert.equal(orderOf(res.state, orderId).status, "PREPARING");
  const request = res.state.cancellationRequests.find((r) => r.id === requestId);
  assert.equal(request?.status, "REJECTED");
  assert.equal(request?.resolvedBy, "ADMIN");
  // Повторное решение идемпотентно.
  const again = rejectCancellationRequest(res.state, requestId, "ещё");
  assert.equal(again.result.ok, false);
});

test("одобрение отмены: заказ CANCELED, онлайн-оплата PAID, без refund/settlement, водитель освобождён", () => {
  // PLATFORM_DRIVER, оплачен, с назначенным водителем.
  // v16: назначить можно только онлайн-водителя с подтверждённой зоной.
  const online = goDriverOnline(createDefaultState(), "driver-1", "zone-1").state;
  const d = addDeliveryReview(online, "restaurant-2-item-1");
  let s = acceptRestaurantOrder(d.state, d.orderId, 20); // AWAITING_PAYMENT
  s = simulateSuccessfulOnlinePayment(s, d.orderId); // PREPARING, PAID
  s = assignDriverToOrder(s, d.orderId, "driver-1").state;
  assert.equal(getDriverStatus(s, "driver-1"), "BUSY_DIRECT");
  s = requestOrderCancellationByClient(s, d.orderId, "причина").state;
  const settlementsBefore = JSON.stringify(s.settlements);
  const financialsBefore = JSON.stringify(orderOf(s, d.orderId).financials);

  const requestId = `cancellation-request-${d.orderId}`;
  const res = approveCancellationRequest(s, requestId, "одобряем");
  assert.equal(res.result.ok, true);
  const order = orderOf(res.state, d.orderId);
  assert.equal(order.status, "CANCELED");
  // Онлайн-оплата остаётся PAID, paidAt не очищен.
  assert.equal(order.paymentStatus, "PAID");
  assert.ok(order.paidAt);
  // Никакого автоматического refund/settlement и изменения snapshot.
  assert.equal(JSON.stringify(res.state.settlements), settlementsBefore);
  assert.equal(JSON.stringify(order.financials), financialsBefore);
  // Водитель освобождён.
  assert.equal(getDriverStatus(res.state, "driver-1"), "ZONE_CONFIRMATION_REQUIRED");
  // Запрос APPROVED; повторное решение идемпотентно.
  const request = res.state.cancellationRequests.find((r) => r.id === requestId);
  assert.equal(request?.status, "APPROVED");
  assert.equal(approveCancellationRequest(res.state, requestId, "x").result.ok, false);
});

function getDriverStatus(state: PrototypeState, driverId: string): string {
  return state.drivers.find((d) => d.id === driverId)?.status ?? "";
}

// =========================== §19: расписание звука ==========================

test("сигнал кухни: новый заказ — сразу", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["o1"],
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: 1000,
    }),
    true,
  );
});

test("сигнал кухни: следующий через 20с, между интервалами — нет", () => {
  const base = {
    reviewOrderIds: ["o1"],
    announcedOrderIds: ["o1"],
    lastBeepAtMs: 100_000,
  };
  assert.equal(isKitchenBeepDue({ ...base, nowMs: 105_000 }), false); // +5с
  assert.equal(isKitchenBeepDue({ ...base, nowMs: 120_000 }), true); // +20с
});

test("сигнал кухни: несколько заказов — один сигнал; после обработки — нет", () => {
  // Два новых заказа → сигнал нужен (один булев true).
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["o1", "o2"],
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: 0,
    }),
    true,
  );
  // Все приняты/отклонены/автозакрыты → список пуст → сигнала нет.
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: [],
      announcedOrderIds: ["o1", "o2"],
      lastBeepAtMs: 100_000,
      nowMs: 200_000,
    }),
    false,
  );
});

test("сигнал кухни: заказ другого ресторана не звучит", () => {
  // Вызывающий фильтрует по выбранному ресторану — сюда попадает пустой список.
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: [],
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: 5000,
    }),
    false,
  );
});
