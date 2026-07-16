import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  createOrderFromCart,
  markOrderReady,
  rejectRestaurantOrder,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import {
  formatExpectedReady,
  formatKitchenCountdown,
  formatKitchenDuration,
  getKitchenAwaitingPaymentOrders,
  getKitchenNewOrders,
  getKitchenPreparingOrders,
  getKitchenReadyOrders,
  getOrderStatusSince,
} from "./selectors.ts";
import type {
  Order,
  OrderHistoryEvent,
  OrderStatus,
  PrototypeState,
} from "./models.ts";

const ADDR = { street: "Тестовая улица 1", house: "1" };

/** Добавляет к состоянию новый PICKUP-заказ (RESTAURANT_REVIEW). */
function addPickupOrder(
  state: PrototypeState,
  itemId: string,
): { state: PrototypeState; orderId: string } {
  const withItem = addCartItem(state, itemId).state;
  const created = createOrderFromCart({
    ...withItem,
    cart: { ...withItem.cart, fulfillmentChoice: "PICKUP" },
  });
  return { state: created.state, orderId: created.result.orderId as string };
}

/** Добавляет к состоянию новый DELIVERY-заказ (RESTAURANT_REVIEW). */
function addDeliveryOrder(
  state: PrototypeState,
  itemId: string,
  qty = 1,
): { state: PrototypeState; orderId: string } {
  let s = updateCartAddress(state, ADDR);
  for (let i = 0; i < qty; i += 1) {
    s = addCartItem(s, itemId).state;
  }
  const created = createOrderFromCart(s);
  return { state: created.state, orderId: created.result.orderId as string };
}

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

function ids(orders: Order[]): string[] {
  return orders.map((o) => o.id);
}

// --- Изоляция ресторанов ----------------------------------------------------

test("кухня restaurant-1 видит только заказы restaurant-1", () => {
  const r1 = addPickupOrder(createDefaultState(), "restaurant-1-item-1");
  const r2 = addPickupOrder(r1.state, "restaurant-2-item-1");
  const state = r2.state;

  const kitchen1 = getKitchenNewOrders(state, "restaurant-1");
  assert.deepEqual(ids(kitchen1), [r1.orderId]);
  // Заказ restaurant-2 не попал в кухню restaurant-1.
  assert.ok(!ids(kitchen1).includes(r2.orderId));

  const kitchen2 = getKitchenNewOrders(state, "restaurant-2");
  assert.deepEqual(ids(kitchen2), [r2.orderId]);
});

// --- Распределение по секциям ----------------------------------------------

test("RESTAURANT_REVIEW только в «Новые»", () => {
  const { state, orderId } = addPickupOrder(
    createDefaultState(),
    "restaurant-2-item-1",
  );
  assert.deepEqual(ids(getKitchenNewOrders(state, "restaurant-2")), [orderId]);
  assert.equal(getKitchenPreparingOrders(state, "restaurant-2").length, 0);
  assert.equal(getKitchenReadyOrders(state, "restaurant-2").length, 0);
});

test("AWAITING_PAYMENT не попадает в «Готовятся», а в отдельную полосу", () => {
  const { state, orderId } = addDeliveryOrder(
    createDefaultState(),
    "restaurant-2-item-1",
  );
  const accepted = acceptRestaurantOrder(state, orderId, 20); // ONLINE → AWAITING_PAYMENT
  assert.equal(orderOf(accepted, orderId).status, "AWAITING_PAYMENT");
  assert.equal(getKitchenPreparingOrders(accepted, "restaurant-2").length, 0);
  assert.deepEqual(
    ids(getKitchenAwaitingPaymentOrders(accepted, "restaurant-2")),
    [orderId],
  );
});

test("PREPARING только в «Готовятся»", () => {
  const { state, orderId } = addPickupOrder(
    createDefaultState(),
    "restaurant-2-item-1",
  );
  const prep = acceptRestaurantOrder(state, orderId, 20); // PICKUP → PREPARING
  assert.deepEqual(ids(getKitchenPreparingOrders(prep, "restaurant-2")), [
    orderId,
  ]);
  assert.equal(getKitchenNewOrders(prep, "restaurant-2").length, 0);
  assert.equal(getKitchenReadyOrders(prep, "restaurant-2").length, 0);
});

test("READY и READY_FOR_PICKUP только в «Готовы»", () => {
  // READY_FOR_PICKUP (самовывоз).
  const pickup = addPickupOrder(createDefaultState(), "restaurant-2-item-1");
  let s = acceptRestaurantOrder(pickup.state, pickup.orderId, 20);
  s = markOrderReady(s, pickup.orderId);
  assert.equal(orderOf(s, pickup.orderId).status, "READY_FOR_PICKUP");

  // READY (доставка).
  const delivery = addDeliveryOrder(s, "restaurant-2-item-1");
  s = delivery.state;
  s = acceptRestaurantOrder(s, delivery.orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, delivery.orderId);
  s = markOrderReady(s, delivery.orderId);
  assert.equal(orderOf(s, delivery.orderId).status, "READY");

  const ready = ids(getKitchenReadyOrders(s, "restaurant-2"));
  assert.ok(ready.includes(pickup.orderId));
  assert.ok(ready.includes(delivery.orderId));
  assert.equal(getKitchenPreparingOrders(s, "restaurant-2").length, 0);
});

// --- Сортировка (на искусственных таймстампах) ------------------------------

function cloneOrder(base: Order, overrides: Partial<Order>): Order {
  return { ...base, ...overrides };
}

function stateWith(orders: Order[]): PrototypeState {
  return { ...createDefaultState(), orders };
}

test("«Новые» сортируются от самых старых", () => {
  const base = orderOf(
    addPickupOrder(createDefaultState(), "restaurant-2-item-1").state,
    "order-1001",
  );
  const older = cloneOrder(base, {
    id: "o-old",
    status: "RESTAURANT_REVIEW",
    createdAt: "2026-07-13T10:00:00.000Z",
  });
  const newer = cloneOrder(base, {
    id: "o-new",
    status: "RESTAURANT_REVIEW",
    createdAt: "2026-07-13T12:00:00.000Z",
  });
  const state = stateWith([newer, older]);
  assert.deepEqual(ids(getKitchenNewOrders(state, "restaurant-2")), [
    "o-old",
    "o-new",
  ]);
});

test("«Готовятся»: просроченные первыми, затем по expectedReadyAt, без времени — в конце", () => {
  const base = orderOf(
    addPickupOrder(createDefaultState(), "restaurant-2-item-1").state,
    "order-1001",
  );
  const mk = (id: string, expectedReadyAt: string | null) =>
    cloneOrder(base, { id, status: "PREPARING" as OrderStatus, expectedReadyAt });
  const soon = mk("soon", "2026-07-13T10:10:00.000Z");
  const overdue = mk("overdue", "2026-07-13T09:00:00.000Z");
  const later = mk("later", "2026-07-13T11:00:00.000Z");
  const noTime = mk("notime", null);
  const state = stateWith([later, noTime, soon, overdue]);
  assert.deepEqual(ids(getKitchenPreparingOrders(state, "restaurant-2")), [
    "overdue",
    "soon",
    "later",
    "notime",
  ]);
});

test("«Готовы» сортируются по времени готовности (давние сверху)", () => {
  const base = orderOf(
    addPickupOrder(createDefaultState(), "restaurant-2-item-1").state,
    "order-1001",
  );
  const readyEvent = (at: string) => ({
    id: "ev",
    occurredAt: at,
    actor: "RESTAURANT" as const,
    type: "STATUS" as const,
    fromStatus: "PREPARING" as OrderStatus,
    toStatus: "READY" as OrderStatus,
    message: "готов",
  });
  const early = cloneOrder(base, {
    id: "early",
    status: "READY",
    history: [readyEvent("2026-07-13T10:00:00.000Z")],
  });
  const late = cloneOrder(base, {
    id: "late",
    status: "READY",
    history: [readyEvent("2026-07-13T11:00:00.000Z")],
  });
  const state = stateWith([late, early]);
  assert.deepEqual(ids(getKitchenReadyOrders(state, "restaurant-2")), [
    "early",
    "late",
  ]);
});

// --- Действия кухни используют существующие переходы ------------------------

test("принятие ONLINE-заказа → AWAITING_PAYMENT", () => {
  const { state, orderId } = addDeliveryOrder(
    createDefaultState(),
    "restaurant-2-item-1",
  );
  const next = acceptRestaurantOrder(state, orderId, 20);
  assert.equal(orderOf(next, orderId).status, "AWAITING_PAYMENT");
});

test("принятие PICKUP → PREPARING", () => {
  const { state, orderId } = addPickupOrder(
    createDefaultState(),
    "restaurant-2-item-1",
  );
  const next = acceptRestaurantOrder(state, orderId, 20);
  assert.equal(orderOf(next, orderId).status, "PREPARING");
});

test("принятие RESTAURANT_DELIVERY (наличные курьеру) → PREPARING", () => {
  const { state, orderId } = addDeliveryOrder(
    createDefaultState(),
    "restaurant-3-item-1",
    2,
  );
  assert.equal(orderOf(state, orderId).paymentMethod, "CASH_TO_RESTAURANT_COURIER");
  const next = acceptRestaurantOrder(state, orderId, 20);
  assert.equal(orderOf(next, orderId).status, "PREPARING");
});

test("отклонение требует причину и пишет actor RESTAURANT", () => {
  const { state, orderId } = addPickupOrder(
    createDefaultState(),
    "restaurant-2-item-1",
  );
  // Пустая причина не отклоняет.
  const noReason = rejectRestaurantOrder(state, orderId, "   ");
  assert.equal(orderOf(noReason, orderId).status, "RESTAURANT_REVIEW");
  // С причиной — CANCELED, actor RESTAURANT.
  const rejected = rejectRestaurantOrder(state, orderId, "Кухня перегружена");
  const order = orderOf(rejected, orderId);
  assert.equal(order.status, "CANCELED");
  assert.equal(order.history.at(-1)?.actor, "RESTAURANT");
  assert.ok(order.history.at(-1)?.message.includes("Кухня перегружена"));
});

test("«Готово» переводит PICKUP в READY_FOR_PICKUP, доставку — в READY", () => {
  const pickup = addPickupOrder(createDefaultState(), "restaurant-2-item-1");
  let s = acceptRestaurantOrder(pickup.state, pickup.orderId, 20);
  s = markOrderReady(s, pickup.orderId);
  assert.equal(orderOf(s, pickup.orderId).status, "READY_FOR_PICKUP");

  const delivery = addDeliveryOrder(s, "restaurant-2-item-1");
  s = delivery.state;
  s = acceptRestaurantOrder(s, delivery.orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, delivery.orderId);
  s = markOrderReady(s, delivery.orderId);
  assert.equal(orderOf(s, delivery.orderId).status, "READY");
});

// --- Ничего финансового не меняется -----------------------------------------

test("действия кухни не меняют financial snapshot и не создают settlement", () => {
  const { state, orderId } = addPickupOrder(
    createDefaultState(),
    "restaurant-2-item-1",
  );
  const financialsBefore = JSON.stringify(orderOf(state, orderId).financials);
  let s = acceptRestaurantOrder(state, orderId, 20);
  s = markOrderReady(s, orderId);
  assert.equal(
    JSON.stringify(orderOf(s, orderId).financials),
    financialsBefore,
  );
  assert.equal(s.settlements.length, 0);
});

test("вызов kitchen-селекторов не мутирует данные заказов", () => {
  const { state } = addPickupOrder(createDefaultState(), "restaurant-2-item-1");
  const before = JSON.stringify(state.orders);
  getKitchenNewOrders(state, "restaurant-1");
  getKitchenNewOrders(state, "restaurant-2");
  getKitchenPreparingOrders(state, "restaurant-3");
  getKitchenReadyOrders(state, "restaurant-2");
  assert.equal(JSON.stringify(state.orders), before);
});

// --- §8: точки отсчёта статусов и форматирование времени --------------------

function statusEvent(
  toStatus: OrderStatus,
  occurredAt: string,
): OrderHistoryEvent {
  return {
    id: `ev-${toStatus}`,
    occurredAt,
    actor: "RESTAURANT",
    type: "STATUS",
    fromStatus: null,
    toStatus,
    message: toStatus,
  };
}

/** Реальный заказ-шаблон для клонирования с искусственной историей. */
function templateOrder(): Order {
  const { state, orderId } = addPickupOrder(
    createDefaultState(),
    "restaurant-2-item-1",
  );
  return orderOf(state, orderId);
}

test("getOrderStatusSince: RESTAURANT_REVIEW считается от createdAt", () => {
  const order: Order = {
    ...templateOrder(),
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T10:30:00.000Z",
    history: [statusEvent("RESTAURANT_REVIEW", "2026-07-13T10:05:00.000Z")],
  };
  assert.equal(
    getOrderStatusSince(order, "RESTAURANT_REVIEW"),
    "2026-07-13T10:00:00.000Z",
  );
});

test("getOrderStatusSince: PREPARING считается от перехода, не от createdAt", () => {
  const order: Order = {
    ...templateOrder(),
    createdAt: "2026-07-13T10:00:00.000Z",
    updatedAt: "2026-07-13T11:00:00.000Z",
    status: "PREPARING",
    history: [
      statusEvent("RESTAURANT_REVIEW", "2026-07-13T10:00:00.000Z"),
      statusEvent("PREPARING", "2026-07-13T10:20:00.000Z"),
    ],
  };
  assert.equal(
    getOrderStatusSince(order, "PREPARING"),
    "2026-07-13T10:20:00.000Z",
  );
});

test("getOrderStatusSince: READY и READY_FOR_PICKUP от своих переходов", () => {
  const base = templateOrder();
  const ready: Order = {
    ...base,
    status: "READY",
    history: [statusEvent("READY", "2026-07-13T10:40:00.000Z")],
  };
  assert.equal(getOrderStatusSince(ready, "READY"), "2026-07-13T10:40:00.000Z");
  const pickup: Order = {
    ...base,
    status: "READY_FOR_PICKUP",
    history: [statusEvent("READY_FOR_PICKUP", "2026-07-13T10:45:00.000Z")],
  };
  assert.equal(
    getOrderStatusSince(pickup, "READY_FOR_PICKUP"),
    "2026-07-13T10:45:00.000Z",
  );
});

test("getOrderStatusSince: без history-события — fallback updatedAt", () => {
  const order: Order = {
    ...templateOrder(),
    updatedAt: "2026-07-13T12:00:00.000Z",
    history: [],
  };
  assert.equal(
    getOrderStatusSince(order, "PREPARING"),
    "2026-07-13T12:00:00.000Z",
  );
});

test("getOrderStatusSince не мутирует order.history", () => {
  const order = {
    ...templateOrder(),
    status: "PREPARING" as OrderStatus,
    history: [statusEvent("PREPARING", "2026-07-13T10:20:00.000Z")],
  };
  const before = JSON.stringify(order.history);
  getOrderStatusSince(order, "PREPARING");
  assert.equal(JSON.stringify(order.history), before);
});

test("formatExpectedReady использует часовой пояс ресторана", () => {
  // 2026-07-13T11:35:00Z: Кишинёв (UTC+3 летом) → 14:35.
  const iso = "2026-07-13T11:35:00.000Z";
  assert.equal(
    formatExpectedReady(iso, "Europe/Chisinau"),
    "Ожидаемая готовность: 14:35",
  );
  // Тот же момент в UTC → 11:35 (не время компьютера).
  assert.equal(formatExpectedReady(iso, "UTC"), "Ожидаемая готовность: 11:35");
  // Без времени.
  assert.equal(
    formatExpectedReady(null, "Europe/Chisinau"),
    "Ожидаемая готовность: не задана",
  );
});

test("formatKitchenCountdown: просрочка увеличивается после 0:00", () => {
  const expected = "2026-07-13T10:00:00.000Z";
  const t = (iso: string) => Date.parse(iso);
  // До срока.
  assert.equal(
    formatKitchenCountdown(expected, t("2026-07-13T09:48:00.000Z")).overdue,
    false,
  );
  // На 3 минуты позже срока.
  const late3 = formatKitchenCountdown(expected, t("2026-07-13T10:03:00.000Z"));
  assert.equal(late3.overdue, true);
  assert.equal(late3.text, "Просрочено на 3 мин");
  // На 7 минут позже — просрочка растёт.
  const late7 = formatKitchenCountdown(expected, t("2026-07-13T10:07:00.000Z"));
  assert.equal(late7.text, "Просрочено на 7 мин");
});

test("formatKitchenDuration: минуты и часы в человекочитаемом виде", () => {
  assert.equal(formatKitchenDuration(1), "1 мин");
  assert.equal(formatKitchenDuration(32), "32 мин");
  assert.equal(formatKitchenDuration(59), "59 мин");
  // Ровно час — без «0 мин».
  assert.equal(formatKitchenDuration(60), "1 ч");
  assert.equal(formatKitchenDuration(77), "1 ч 17 мин");
  assert.equal(formatKitchenDuration(120), "2 ч");
  assert.equal(formatKitchenDuration(125), "2 ч 5 мин");
  // Защитные случаи: не время из будущего и не дробные минуты.
  assert.equal(formatKitchenDuration(0), "0 мин");
  assert.equal(formatKitchenDuration(-5), "0 мин");
  assert.equal(formatKitchenDuration(65.9), "1 ч 5 мин");
});

test("formatKitchenCountdown: просрочка больше часа — «1 ч 17 мин»", () => {
  const expected = "2026-07-13T10:00:00.000Z";
  const t = (iso: string) => Date.parse(iso);
  const late77 = formatKitchenCountdown(expected, t("2026-07-13T11:17:00.000Z"));
  assert.equal(late77.overdue, true);
  assert.equal(late77.text, "Просрочено на 1 ч 17 мин");
  const late60 = formatKitchenCountdown(expected, t("2026-07-13T11:00:00.000Z"));
  assert.equal(late60.text, "Просрочено на 1 ч");
});
