import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  adminCancelOrder,
  createOrderFromCart,
  issuePickupWithoutCode,
  markOrderReady,
  markPickupNoShow,
  setCartFulfillmentChoice,
} from "./actions.ts";
import {
  clientHistoryEvent,
  getPickupNoShowEligibleAtIso,
} from "./selectors.ts";
import { upgradeToV6 } from "./prototype-store.ts";
import type {
  Order,
  OrderHistoryEvent,
  PrototypeState,
} from "./models.ts";

const NOW = "2026-07-14T12:00:00.000Z";

function makeReadyPickup(): {
  state: PrototypeState;
  orderId: string;
  code: string;
} {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  s = created.state;
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(s, orderId, 20);
  s = markOrderReady(s, orderId);
  const order = s.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return { state: s, orderId, code: order.pickupCode as string };
}

function getOrder(state: PrototypeState, orderId: string): Order {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
}

function patchOrder(
  state: PrototypeState,
  orderId: string,
  patch: Partial<Order>,
): PrototypeState {
  return {
    ...state,
    orders: state.orders.map((o) => (o.id === orderId ? { ...o, ...patch } : o)),
  };
}

function eligibleAt(state: PrototypeState, orderId: string): string {
  const iso = getPickupNoShowEligibleAtIso(getOrder(state, orderId));
  assert.ok(iso);
  return iso;
}

// --- §3: структурированный признак + legacy-нормализация ---------------------

test("создание PICKUP: pickupNoShowAt = null", () => {
  const { state, orderId } = makeReadyPickup();
  assert.equal(getOrder(state, orderId).pickupNoShowAt, null);
});

test("успешный невыкуп ставит pickupNoShowAt = nowIso", () => {
  const { state, orderId } = makeReadyPickup();
  const at = eligibleAt(state, orderId);
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", at);
  assert.equal(res.result.ok, true);
  assert.equal(getOrder(res.state, orderId).pickupNoShowAt, at);
});

test("обычная adminCancelOrder из READY_FOR_PICKUP не ставит pickupNoShowAt", () => {
  const { state, orderId } = makeReadyPickup();
  const res = adminCancelOrder(state, orderId, "Технический сбой");
  assert.equal(res.result.ok, true);
  const order = getOrder(res.state, orderId);
  assert.equal(order.status, "CANCELED");
  assert.equal(order.pickupNoShowAt, null);
});

test("нормализация legacy: битый pickupNoShowAt → null", () => {
  const base = createDefaultState();
  const legacy = {
    id: "order-950",
    publicNumber: "DIR-0950",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    customer: { id: "customer-1", name: "К", phone: "x" },
    restaurant: { id: "restaurant-1", name: "Р1", address: "a", zoneId: "zone-1" },
    address: null,
    deliveryMode: "PICKUP",
    paymentMethod: "PAY_AT_RESTAURANT",
    paymentStatus: "DUE_AT_PICKUP",
    paidAt: null,
    status: "CANCELED",
    preparationMinutes: 20,
    expectedReadyAt: null,
    cancellationReason: "Клиент не пришёл",
    pickupCode: "4321",
    pickupCodeUsed: false,
    pickupNoShowAt: "не-дата",
    items: [],
    financials: { foodSubtotalCents: 800, restaurantCommissionCents: 120 },
    history: [],
  };
  const migrated = upgradeToV6({ ...base, schemaVersion: 5, orders: [legacy] });
  assert.equal(migrated.orders[0].pickupNoShowAt, null);
});

test("нормализация legacy: корректный ISO pickupNoShowAt сохраняется", () => {
  const base = createDefaultState();
  const legacy = {
    id: "order-951",
    publicNumber: "DIR-0951",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    customer: { id: "customer-1", name: "К", phone: "x" },
    restaurant: { id: "restaurant-1", name: "Р1", address: "a", zoneId: "zone-1" },
    address: null,
    deliveryMode: "PICKUP",
    paymentMethod: "PAY_AT_RESTAURANT",
    paymentStatus: "DUE_AT_PICKUP",
    paidAt: null,
    status: "CANCELED",
    preparationMinutes: 20,
    expectedReadyAt: null,
    cancellationReason: "Клиент не пришёл",
    pickupCode: "4321",
    pickupCodeUsed: false,
    pickupNoShowAt: "2026-07-10T01:30:00.000Z",
    items: [],
    financials: { foodSubtotalCents: 800, restaurantCommissionCents: 120 },
    history: [],
  };
  const migrated = upgradeToV6({ ...base, schemaVersion: 5, orders: [legacy] });
  assert.equal(migrated.orders[0].pickupNoShowAt, "2026-07-10T01:30:00.000Z");
});

// --- §5: fail-closed проверки невыкупа ---------------------------------------

test("§5: PAID_AT_RESTAURANT + READY_FOR_PICKUP → невыкуп запрещён", () => {
  const { state, orderId } = makeReadyPickup();
  const corrupt = patchOrder(state, orderId, {
    paymentStatus: "PAID_AT_RESTAURANT",
  });
  const res = markPickupNoShow(
    corrupt,
    orderId,
    "Не пришёл",
    "RESTAURANT",
    eligibleAt(corrupt, orderId),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, corrupt);
});

test("§5: установленный paidAt → невыкуп запрещён", () => {
  const { state, orderId } = makeReadyPickup();
  const corrupt = patchOrder(state, orderId, { paidAt: NOW });
  const res = markPickupNoShow(
    corrupt,
    orderId,
    "Не пришёл",
    "RESTAURANT",
    eligibleAt(corrupt, orderId),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, corrupt);
});

test("§5: установленный pickupPaidWith → невыкуп запрещён", () => {
  const { state, orderId } = makeReadyPickup();
  const corrupt = patchOrder(state, orderId, { pickupPaidWith: "CASH" });
  const res = markPickupNoShow(
    corrupt,
    orderId,
    "Не пришёл",
    "RESTAURANT",
    eligibleAt(corrupt, orderId),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, corrupt);
});

test("§5: pickupCodeUsed=true → невыкуп запрещён", () => {
  const { state, orderId } = makeReadyPickup();
  const corrupt = patchOrder(state, orderId, { pickupCodeUsed: true });
  const res = markPickupNoShow(
    corrupt,
    orderId,
    "Не пришёл",
    "RESTAURANT",
    eligibleAt(corrupt, orderId),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, corrupt);
});

test("§5: существующая settlement → невыкуп запрещён", () => {
  const { state, orderId } = makeReadyPickup();
  const corrupt: PrototypeState = {
    ...state,
    settlements: [
      {
        id: `settlement-${orderId}`,
        orderId,
        restaurantId: "restaurant-2",
        type: "PICKUP_COMMISSION",
        amountCents: 100,
        status: "PENDING",
        createdAt: NOW,
      },
    ],
  };
  const res = markPickupNoShow(
    corrupt,
    orderId,
    "Не пришёл",
    "RESTAURANT",
    eligibleAt(corrupt, orderId),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, corrupt);
});

test("§5: все повреждённые состояния не меняют счётчик невыкупов", () => {
  const { state, orderId } = makeReadyPickup();
  const before = state.customer.noShowPickupCount;
  const corrupt = patchOrder(state, orderId, {
    paymentStatus: "PAID_AT_RESTAURANT",
    paidAt: NOW,
    pickupPaidWith: "CARD",
    pickupCodeUsed: true,
  });
  const res = markPickupNoShow(
    corrupt,
    orderId,
    "Не пришёл",
    "RESTAURANT",
    eligibleAt(corrupt, orderId),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state.customer.noShowPickupCount, before);
});

test("§5: успех явно сохраняет безопасное состояние", () => {
  const { state, orderId } = makeReadyPickup();
  const res = markPickupNoShow(
    state,
    orderId,
    "Не пришёл",
    "RESTAURANT",
    eligibleAt(state, orderId),
  );
  const order = getOrder(res.state, orderId);
  assert.equal(order.paymentStatus, "DUE_AT_PICKUP");
  assert.equal(order.paidAt, null);
  assert.equal(order.pickupPaidWith, null);
  assert.equal(order.pickupCodeUsed, false);
  assert.equal(res.state.settlements.length, 0);
});

// --- §6: аварийная выдача — admin-only в домене ------------------------------

test("§6: issuePickupWithoutCode всегда фиксирует actor ADMIN", () => {
  const { state, orderId } = makeReadyPickup();
  const res = issuePickupWithoutCode(state, orderId, "Забыл код", "CASH", NOW);
  assert.equal(res.result.ok, true);
  const events = getOrder(res.state, orderId).history.filter(
    (e) => e.occurredAt === NOW,
  );
  assert.ok(events.length >= 2);
  // Публичная сигнатура не принимает actor — RESTAURANT вызвать невозможно;
  // домен всегда фиксирует ADMIN на всех записанных событиях.
  for (const e of events) assert.equal(e.actor, "ADMIN");
});

// --- §4: клиентски-безопасная история ----------------------------------------

function ev(partial: Partial<OrderHistoryEvent>): OrderHistoryEvent {
  return {
    id: "e1",
    occurredAt: NOW,
    actor: "ADMIN",
    type: "STATUS",
    fromStatus: null,
    toStatus: "READY_FOR_PICKUP",
    message: "",
    ...partial,
  } as OrderHistoryEvent;
}

const pickupOrder = (noShowAt: string | null): Order =>
  ({ deliveryMode: "PICKUP", pickupNoShowAt: noShowAt }) as Order;

test("§4: внутренняя причина невыкупа не показывается клиенту", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "READY_FOR_PICKUP",
    toStatus: "CANCELED",
    message: "Клиент не пришёл за заказом. Причина: он передумал",
  });
  const out = clientHistoryEvent(event, pickupOrder(NOW), true);
  assert.equal(out.message, "Заказ был закрыт как невыкупленный.");
  assert.ok(!out.message.includes("передумал"));
});

test("§4: причина аварийной выдачи не показывается клиенту", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "READY_FOR_PICKUP",
    toStatus: "PICKED_UP",
    message: "Аварийная выдача без кода администратором Direct. Причина: паспорт",
  });
  const out = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(out.message, "Заказ получен.");
  assert.ok(!out.message.includes("паспорт"));
});

test("§4: «Администратор Direct» не показывается у аварийной выдачи", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "READY_FOR_PICKUP",
    toStatus: "PICKED_UP",
    actor: "ADMIN",
    message: "Аварийная выдача без кода администратором Direct. Причина: x",
  });
  const out = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(out.hideActor, true);
  assert.ok(!out.message.includes("Администратор"));
});

test("§4: обычная отмена из READY_FOR_PICKUP не считается невыкупом", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "READY_FOR_PICKUP",
    toStatus: "CANCELED",
    message: "Администратор Direct отменил заказ. Причина: дубликат",
  });
  const out = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(out.message, "Заказ отменён.");
  assert.ok(!out.message.includes("невыкуп"));
  assert.ok(!out.message.includes("дубликат"));
});

test("§4: настоящий невыкуп определяется по pickupNoShowAt", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "READY_FOR_PICKUP",
    toStatus: "CANCELED",
    message: "Клиент не пришёл за заказом. Причина: y",
  });
  const withFlag = clientHistoryEvent(event, pickupOrder(NOW), true);
  const withoutFlag = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(withFlag.message, "Заказ был закрыт как невыкупленный.");
  assert.equal(withoutFlag.message, "Заказ отменён.");
});

test("§4: ETA-нейтрализация продолжает работать", () => {
  const event = ev({ type: "ETA", message: "Смена времени: внутренняя причина" });
  const out = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(out.message, "Ресторан обновил ожидаемое время готовности заказа.");
  assert.equal(out.hideActor, true);
});

test("§4: обычные безопасные STATUS-события не ломаются", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: null,
    toStatus: "RESTAURANT_REVIEW",
    actor: "CLIENT",
    message: "Заказ на самовывоз отправлен ресторану на проверку.",
  });
  const out = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(out.message, "Заказ на самовывоз отправлен ресторану на проверку.");
  assert.equal(out.hideActor, false);
});

test("§4: оплата на точке нейтрализуется до «Оплата получена в ресторане.»", () => {
  const event = ev({
    type: "PAYMENT",
    fromStatus: "READY_FOR_PICKUP",
    toStatus: "READY_FOR_PICKUP",
    message: "Оплата получена в ресторане картой.",
  });
  const out = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(out.message, "Оплата получена в ресторане.");
  assert.equal(out.hideActor, true);
});

test("§4: не-PICKUP история в clientSafe не трогается (кроме ETA)", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "READY_FOR_PICKUP",
    toStatus: "CANCELED",
    message: "Внутренняя причина",
  });
  const deliveryOrder = { deliveryMode: "PLATFORM_DRIVER", pickupNoShowAt: null } as Order;
  const out = clientHistoryEvent(event, deliveryOrder, true);
  assert.equal(out.message, "Внутренняя причина");
});

// --- §2: нейтрализация ЛЮБОЙ отмены самовывоза (не только из готовности) ------

test("§2: PICKUP PREPARING → CANCELED скрывает причину", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "PREPARING",
    toStatus: "CANCELED",
    actor: "ADMIN",
    message: "Заказ отменён администратором Direct. Причина: нет продуктов",
  });
  const out = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(out.message, "Заказ отменён.");
  assert.equal(out.hideActor, true);
  assert.ok(!out.message.includes("нет продуктов"));
});

test("§2: PICKUP RESTAURANT_REVIEW → CANCELED скрывает причину", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "RESTAURANT_REVIEW",
    toStatus: "CANCELED",
    actor: "ADMIN",
    message: "Заказ отклонён. Причина: ресторан закрыт",
  });
  const out = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(out.message, "Заказ отменён.");
  assert.equal(out.hideActor, true);
  assert.ok(!out.message.includes("закрыт"));
});

test("§2: PICKUP READY_FOR_PICKUP → CANCELED c pickupNoShowAt → невыкуп", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "READY_FOR_PICKUP",
    toStatus: "CANCELED",
    message: "Клиент не пришёл. Причина: x",
  });
  const out = clientHistoryEvent(event, pickupOrder(NOW), true);
  assert.equal(out.message, "Заказ был закрыт как невыкупленный.");
});

test("§2: PICKUP отмена без pickupNoShowAt → обычная отмена", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "AWAITING_PAYMENT",
    toStatus: "CANCELED",
    message: "Не оплачено вовремя",
  });
  const out = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(out.message, "Заказ отменён.");
});

test("§2: actor ADMIN не показывается ни при какой PICKUP-отмене", () => {
  for (const from of [
    "RESTAURANT_REVIEW",
    "AWAITING_PAYMENT",
    "PREPARING",
    "READY_FOR_PICKUP",
  ] as const) {
    const event = ev({
      type: "STATUS",
      fromStatus: from,
      toStatus: "CANCELED",
      actor: "ADMIN",
      message: "Администратор Direct отменил заказ. Причина: тест",
    });
    const out = clientHistoryEvent(event, pickupOrder(null), true);
    assert.equal(out.hideActor, true);
    assert.ok(!out.message.includes("Администратор"));
    assert.ok(!out.message.includes("тест"));
  }
});

test("§2: история доставки (не-PICKUP) при отмене не меняется", () => {
  const event = ev({
    type: "STATUS",
    fromStatus: "PREPARING",
    toStatus: "CANCELED",
    actor: "ADMIN",
    message: "Заказ отменён администратором Direct. Причина: сбой",
  });
  const deliveryOrder = {
    deliveryMode: "PLATFORM_DRIVER",
    pickupNoShowAt: null,
  } as Order;
  const out = clientHistoryEvent(event, deliveryOrder, true);
  assert.equal(out.message, "Заказ отменён администратором Direct. Причина: сбой");
  assert.equal(out.hideActor, false);
});

test("§2: ETA-нейтрализация продолжает работать при новой логике отмен", () => {
  const event = ev({ type: "ETA", message: "внутренняя причина ETA" });
  const out = clientHistoryEvent(event, pickupOrder(null), true);
  assert.equal(
    out.message,
    "Ресторан обновил ожидаемое время готовности заказа.",
  );
  assert.equal(out.hideActor, true);
});
