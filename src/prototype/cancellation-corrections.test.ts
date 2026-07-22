import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  adminCancelOrder,
  assignDriverToOrder,
  createOrderFromCart,
  goDriverOnline,
  requestOrderCancellationByClient,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import {
  getAudibleKitchenReviewOrders,
  getKitchenReadyOrders,
  getOrderStatusSince,
  isKitchenBeepDue,
  KITCHEN_REVIEW_TIMEOUT_MS,
} from "./selectors.ts";
import type { Order, OrderHistoryEvent, OrderStatus, PrototypeState } from "./models.ts";

const ADDR = { street: "Тестовая улица 1", house: "1" };

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

/** Реальный заказ-шаблон для клонирования с искусственной историей. */
function templateOrder(): Order {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart({
    ...s,
    cart: { ...s.cart, fulfillmentChoice: "PICKUP" },
  });
  return orderOf(created.state, created.result.orderId as string);
}

function ev(
  fromStatus: OrderStatus,
  toStatus: OrderStatus,
  occurredAt: string,
): OrderHistoryEvent {
  return {
    id: `ev-${occurredAt}`,
    occurredAt,
    actor: "SYSTEM",
    type: "STATUS",
    fromStatus,
    toStatus,
    message: `${fromStatus}->${toStatus}`,
  };
}

// =========================== §1: same-status история ========================

test("§1: запрос на отмену (PREPARING→PREPARING) не сбрасывает точку входа PREPARING", () => {
  const order: Order = {
    ...templateOrder(),
    status: "PREPARING",
    updatedAt: "2026-07-14T10:07:00.000Z",
    history: [
      ev("RESTAURANT_REVIEW", "PREPARING", "2026-07-14T10:00:00.000Z"),
      // клиент создал запрос (same-status)
      ev("PREPARING", "PREPARING", "2026-07-14T10:05:00.000Z"),
      // администратор отклонил запрос (same-status)
      ev("PREPARING", "PREPARING", "2026-07-14T10:07:00.000Z"),
    ],
  };
  assert.equal(
    getOrderStatusSince(order, "PREPARING"),
    "2026-07-14T10:00:00.000Z",
  );
});

test("§1: назначение водителя (PREPARING→PREPARING) не сбрасывает время", () => {
  const order: Order = {
    ...templateOrder(),
    status: "PREPARING",
    updatedAt: "2026-07-14T10:06:00.000Z",
    history: [
      ev("RESTAURANT_REVIEW", "PREPARING", "2026-07-14T10:00:00.000Z"),
      ev("PREPARING", "PREPARING", "2026-07-14T10:06:00.000Z"), // назначен водитель
    ],
  };
  assert.equal(
    getOrderStatusSince(order, "PREPARING"),
    "2026-07-14T10:00:00.000Z",
  );
});

test("§1: READY-заказ после запроса сохраняет исходное время READY", () => {
  const order: Order = {
    ...templateOrder(),
    status: "READY",
    updatedAt: "2026-07-14T10:40:00.000Z",
    history: [
      ev("PREPARING", "READY", "2026-07-14T10:30:00.000Z"),
      ev("READY", "READY", "2026-07-14T10:40:00.000Z"), // запрос на отмену
    ],
  };
  assert.equal(getOrderStatusSince(order, "READY"), "2026-07-14T10:30:00.000Z");
});

test("§1: fallback updatedAt, если настоящего перехода нет", () => {
  const order: Order = {
    ...templateOrder(),
    status: "PREPARING",
    updatedAt: "2026-07-14T12:00:00.000Z",
    history: [ev("PREPARING", "PREPARING", "2026-07-14T11:00:00.000Z")],
  };
  assert.equal(
    getOrderStatusSince(order, "PREPARING"),
    "2026-07-14T12:00:00.000Z",
  );
});

test("§1: сортировка getKitchenReadyOrders не меняется после same-status событий", () => {
  const base = templateOrder();
  const early: Order = {
    ...base,
    id: "early",
    status: "READY",
    history: [ev("PREPARING", "READY", "2026-07-14T10:00:00.000Z")],
  };
  const lateWithRequest: Order = {
    ...base,
    id: "late",
    status: "READY",
    history: [
      ev("PREPARING", "READY", "2026-07-14T10:20:00.000Z"),
      // more-recent same-status событие НЕ должно поднять его выше early
      ev("READY", "READY", "2026-07-14T10:59:00.000Z"),
    ],
  };
  const state: PrototypeState = {
    ...createDefaultState(),
    orders: [lateWithRequest, early],
  };
  assert.deepEqual(
    getKitchenReadyOrders(state, "restaurant-2").map((o) => o.id),
    ["early", "late"],
  );
});

// =========================== §2: запрет звука на 7:00 =======================

function reviewOrderAt(id: string, createdAt: string): Order {
  return { ...templateOrder(), id, status: "RESTAURANT_REVIEW", createdAt };
}

function stateWithReview(orders: Order[]): PrototypeState {
  return { ...createDefaultState(), orders };
}

test("§2: 6:59 — заказ звучит, 7:00 и 7:05 — нет", () => {
  const created = "2026-07-14T10:00:00.000Z";
  const state = stateWithReview([reviewOrderAt("o1", created)]);
  const at = (offset: number) => Date.parse(created) + offset;
  assert.equal(
    getAudibleKitchenReviewOrders(state, "restaurant-2", at(KITCHEN_REVIEW_TIMEOUT_MS - 1000)).length,
    1,
  );
  assert.equal(
    getAudibleKitchenReviewOrders(state, "restaurant-2", at(KITCHEN_REVIEW_TIMEOUT_MS)).length,
    0,
  );
  assert.equal(
    getAudibleKitchenReviewOrders(state, "restaurant-2", at(KITCHEN_REVIEW_TIMEOUT_MS + 5 * 60_000)).length,
    0,
  );
});

test("§2: один просроченный и один свежий — звучит только свежий", () => {
  const now = Date.parse("2026-07-14T10:10:00.000Z");
  const stale = reviewOrderAt("stale", "2026-07-14T10:00:00.000Z"); // 10 мин
  const fresh = reviewOrderAt("fresh", "2026-07-14T10:08:00.000Z"); // 2 мин
  const state = stateWithReview([stale, fresh]);
  const audible = getAudibleKitchenReviewOrders(state, "restaurant-2", now);
  assert.deepEqual(audible.map((o) => o.id), ["fresh"]);
});

test("§2: все просрочены — сигнала нет", () => {
  const now = Date.parse("2026-07-14T11:00:00.000Z");
  const state = stateWithReview([
    reviewOrderAt("a", "2026-07-14T10:00:00.000Z"),
    reviewOrderAt("b", "2026-07-14T10:30:00.000Z"),
  ]);
  const audible = getAudibleKitchenReviewOrders(state, "restaurant-2", now);
  assert.equal(audible.length, 0);
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: audible.map((o) => o.id),
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: now,
    }),
    false,
  );
});

test("§2: заказ другого ресторана не попадает в звучащие", () => {
  const now = Date.parse("2026-07-14T10:02:00.000Z");
  const other = { ...reviewOrderAt("x", "2026-07-14T10:01:00.000Z") };
  other.restaurant = { ...other.restaurant, id: "restaurant-1" };
  const state = stateWithReview([other]);
  assert.equal(
    getAudibleKitchenReviewOrders(state, "restaurant-2", now).length,
    0,
  );
});

test("§2: несколько свежих заказов дают один общий сигнал", () => {
  const now = Date.parse("2026-07-14T10:01:00.000Z");
  const state = stateWithReview([
    reviewOrderAt("a", "2026-07-14T10:00:00.000Z"),
    reviewOrderAt("b", "2026-07-14T10:00:30.000Z"),
  ]);
  const audible = getAudibleKitchenReviewOrders(state, "restaurant-2", now);
  assert.equal(audible.length, 2);
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: audible.map((o) => o.id),
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: now,
    }),
    true,
  );
});

// =========================== §3: adminCancel + PENDING =======================

function paidPlatformPreparingWithDriver(): {
  state: PrototypeState;
  orderId: string;
} {
  // v16: назначить можно только онлайн-водителя с подтверждённой зоной.
  let s = goDriverOnline(createDefaultState(), "driver-1", "zone-1").state;
  s = updateCartAddress(s, ADDR);
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20); // AWAITING_PAYMENT
  s = simulateSuccessfulOnlinePayment(s, orderId); // PREPARING, PAID
  s = assignDriverToOrder(s, orderId, "driver-1").state;
  return { state: s, orderId };
}

test("§3: adminCancelOrder с PENDING-запросом — атомарно APPROVED, PAID, без refund/settlement, водитель освобождён", () => {
  const { state, orderId } = paidPlatformPreparingWithDriver();
  const withReq = requestOrderCancellationByClient(state, orderId, "причина").state;
  const settlementsBefore = JSON.stringify(withReq.settlements);
  const financialsBefore = JSON.stringify(orderOf(withReq, orderId).financials);
  assert.equal(
    withReq.drivers.find((d) => d.id === "driver-1")?.status,
    "BUSY_DIRECT",
  );

  const res = adminCancelOrder(withReq, orderId, "решение админа");
  assert.equal(res.result.ok, true);
  const order = orderOf(res.state, orderId);
  assert.equal(order.status, "CANCELED");
  assert.equal(order.paymentStatus, "PAID");
  assert.ok(order.paidAt);
  assert.equal(JSON.stringify(res.state.settlements), settlementsBefore);
  assert.equal(JSON.stringify(order.financials), financialsBefore);
  assert.equal(
    res.state.drivers.find((d) => d.id === "driver-1")?.status,
    "ZONE_CONFIRMATION_REQUIRED",
  );

  const request = res.state.cancellationRequests.find((r) => r.orderId === orderId);
  assert.equal(request?.status, "APPROVED");
  assert.equal(request?.resolvedBy, "ADMIN");
  assert.ok(request?.resolvedAt);
  // История содержит формулировку про отсутствие автоматического возврата.
  assert.ok(
    order.history.some((e) => e.message.includes("Автоматический возврат не выполнялся")),
  );
});

test("§3: повторный adminCancelOrder идемпотентен (нет второго одобрения)", () => {
  const { state, orderId } = paidPlatformPreparingWithDriver();
  const withReq = requestOrderCancellationByClient(state, orderId, "причина").state;
  const once = adminCancelOrder(withReq, orderId, "решение");
  const second = adminCancelOrder(once.state, orderId, "снова");
  assert.equal(second.result.ok, false);
  // Запрос остаётся APPROVED, не меняется повторно.
  const request = second.state.cancellationRequests.find((r) => r.orderId === orderId);
  assert.equal(request?.status, "APPROVED");
});

test("§3: заказ без запроса отменяется как раньше", () => {
  const { state, orderId } = paidPlatformPreparingWithDriver();
  const res = adminCancelOrder(state, orderId, "обычная отмена");
  assert.equal(res.result.ok, true);
  assert.equal(orderOf(res.state, orderId).status, "CANCELED");
  assert.equal(res.state.cancellationRequests.length, 0);
});
