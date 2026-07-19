import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildKitchenProductionTicketData,
  getTicketReadyLine,
  TICKET_READY,
} from "./kitchen-production-ticket-data.ts";
import { createDefaultState } from "../../prototype/default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "../../prototype/actions.ts";
import { formatClock24 } from "../../prototype/selectors.ts";
import type { Order, PrototypeState } from "../../prototype/models.ts";

const TZ = "Europe/Chisinau";

function acceptedOrder(
  fulfillment: "PICKUP" | "DELIVERY" = "PICKUP",
): { state: PrototypeState; order: Order } {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, {
      street: "Тестовая улица 1",
      house: "4",
      apartment: "12",
    });
  }
  const restaurantId = fulfillment === "DELIVERY" ? "restaurant-2" : "restaurant-1";
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  const created = createOrderFromCart(s);
  assert.ok(created.result.orderId, created.result.error ?? "заказ не создан");
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 25);
  const order = s.orders.find((o) => o.id === orderId);
  assert.ok(order, "заказ должен существовать");
  return { state: s, order };
}

function withOrder(
  state: PrototypeState,
  order: Order,
  patch: Partial<Order>,
): { state: PrototypeState; order: Order } {
  const next = { ...order, ...patch };
  return {
    state: {
      ...state,
      orders: state.orders.map((o) => (o.id === order.id ? next : o)),
    },
    order: next,
  };
}

// 1 --------------------------------------------------------------------------

test("тикет содержит номер, способ, ресторан, готовность, оценку, позиции, totals", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
    status: "PREPARING",
    items: [
      {
        ...base.order.items[0],
        name: "Бургер",
        quantity: 2,
        selectedVariantId: "size-double",
        selectedVariantName: "Двойной",
        cookingComment: "  Без лука  ",
      },
    ],
  });
  const data = buildKitchenProductionTicketData(order, TZ);

  assert.equal(data.publicNumber, order.publicNumber);
  assert.match(data.publicNumber, /^DIR-\d+$/);
  assert.equal(data.deliveryLabel, "САМОВЫВОЗ DIRECT");
  assert.equal(data.restaurantName, order.restaurant.name);
  assert.match(data.readyLine, /^ОЖИДАЕМАЯ ГОТОВНОСТЬ: К /);
  assert.equal(data.preparationMinutes, 25);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].quantity, 2);
  assert.equal(data.items[0].name, "Бургер");
  assert.equal(data.items[0].variantName, "Двойной");
  assert.equal(data.items[0].cookingComment, "Без лука");
  assert.equal(data.itemsTotal, 1);
  assert.equal(data.unitsTotal, 2);
  assert.equal(data.countsLine, "Позиций: 1 · Единиц: 2");
});

// 2 --------------------------------------------------------------------------

test("snapshot: позиции из order.items; изменение меню не меняет старый тикет", () => {
  const { state, order } = acceptedOrder();
  const before = buildKitchenProductionTicketData(order, TZ);
  const originalName = order.items[0].name;

  const renamed: PrototypeState = {
    ...state,
    menuItems: state.menuItems.map((item) =>
      item.id === order.items[0].menuItemId
        ? { ...item, name: "Новое название из меню" }
        : item,
    ),
  };
  const orderAfter = renamed.orders.find((o) => o.id === order.id);
  assert.ok(orderAfter);
  const after = buildKitchenProductionTicketData(orderAfter, TZ);

  assert.equal(after.items[0].name, originalName);
  assert.notEqual(after.items[0].name, "Новое название из меню");
  assert.deepEqual(after, before);
});

// 3 --------------------------------------------------------------------------

test("privacy sentinel: ни одно приватное/финансовое значение не попадает в тикет", () => {
  const base = acceptedOrder("DELIVERY");
  const { order } = withOrder(base.state, base.order, {
    status: "PREPARING",
    customer: {
      ...base.order.customer,
      name: "СЕНТИНЕЛ_ИМЯ_Ольга",
      phone: "СЕНТИНЕЛ_ТЕЛ_0600123",
    },
    address: {
      ...base.order.address!,
      street: "СЕНТИНЕЛ_УЛИЦА_Абрикосовая",
      apartment: "СЕНТИНЕЛ_КВ_777",
      comment: "СЕНТИНЕЛ_КОММ_позвонить",
    },
    pickupCode: "СЕНТИНЕЛ_КОД_5910",
    assignedDriverId: "СЕНТИНЕЛ_ВОДИТЕЛЬ_driver-1",
    financials: {
      ...base.order.financials,
      customerTotalCents: 987654,
    },
  });

  const data = buildKitchenProductionTicketData(order, TZ);
  const serialized = JSON.stringify(data);

  const sentinels = [
    "СЕНТИНЕЛ_ИМЯ_Ольга",
    "СЕНТИНЕЛ_ТЕЛ_0600123",
    "СЕНТИНЕЛ_УЛИЦА_Абрикосовая",
    "СЕНТИНЕЛ_КВ_777",
    "СЕНТИНЕЛ_КОММ_позвонить",
    "СЕНТИНЕЛ_КОД_5910",
    "СЕНТИНЕЛ_ВОДИТЕЛЬ_driver-1",
    "987654",
    order.id,
  ];
  for (const sentinel of sentinels) {
    assert.ok(
      !serialized.includes(sentinel),
      `тикет не должен содержать «${sentinel}»`,
    );
  }
});

// 4 --------------------------------------------------------------------------

test("в модели тикета нет запрещённых ключей", () => {
  const { order } = acceptedOrder();
  const data = buildKitchenProductionTicketData(order, TZ);
  for (const key of [
    "customerName",
    "customer",
    "addressLine",
    "address",
    "paymentLine",
    "paymentStatus",
    "paymentMethod",
    "financials",
    "pickupCode",
    "assignedDriverId",
    "id",
  ]) {
    assert.ok(!(key in data), `в ticket-data не должно быть ключа «${key}»`);
  }
});

// 5 --------------------------------------------------------------------------

test("PREPARING: нижняя рамка «ОЖИДАЕМАЯ ГОТОВНОСТЬ: К HH:MM» в поясе ресторана", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
    status: "PREPARING",
    expectedReadyAt: "2026-07-17T15:40:00.000Z",
    preparationMinutes: 25,
  });

  const data = buildKitchenProductionTicketData(order, TZ);
  assert.equal(
    data.readyLine,
    `ОЖИДАЕМАЯ ГОТОВНОСТЬ: К ${formatClock24("2026-07-17T15:40:00.000Z", TZ)}`,
  );
  assert.equal(data.preparationMinutes, 25);
  // Другой часовой пояс даёт другое отображаемое время.
  assert.notEqual(
    getTicketReadyLine(order, "America/New_York"),
    getTicketReadyLine(order, TZ),
  );
});

// 5b -------------------------------------------------------------------------

test("AWAITING_PAYMENT без expectedReadyAt: рамка «ПРИГОТОВЛЕНИЕ ПОСЛЕ ОПЛАТЫ · N МИН»", () => {
  const base = acceptedOrder("DELIVERY");
  const { order } = withOrder(base.state, base.order, {
    status: "AWAITING_PAYMENT",
    expectedReadyAt: null,
    preparationMinutes: 25,
  });
  const data = buildKitchenProductionTicketData(order, TZ);
  assert.equal(data.readyLine, "ПРИГОТОВЛЕНИЕ ПОСЛЕ ОПЛАТЫ · 25 МИН");
  // Никогда не выводим «не задана».
  assert.ok(!data.readyLine.includes("не задана"));
});

// 6 --------------------------------------------------------------------------

test("READY / READY_FOR_PICKUP: readyLine === ЗАКАЗ ГОТОВ", () => {
  const base = acceptedOrder();
  for (const status of ["READY", "READY_FOR_PICKUP"] as const) {
    const { order } = withOrder(base.state, base.order, {
      status,
      expectedReadyAt: "2026-07-17T15:40:00.000Z",
    });
    const data = buildKitchenProductionTicketData(order, TZ);
    assert.equal(data.readyLine, TICKET_READY);
    assert.equal(data.readyLine, "ЗАКАЗ ГОТОВ");
  }
});

// 7 --------------------------------------------------------------------------

test("пустой вариант/комментарий не создаёт пустых печатных строк", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
    items: [
      {
        ...base.order.items[0],
        name: "Картофель фри",
        quantity: 3,
        selectedVariantId: null,
        selectedVariantName: null,
        cookingComment: "   ",
      },
    ],
  });
  const data = buildKitchenProductionTicketData(order, TZ);
  assert.equal(data.items[0].variantName, null);
  assert.equal(data.items[0].cookingComment, null);
});

// 8 --------------------------------------------------------------------------

test("read-only: построение тикета не меняет state/order", () => {
  const { state, order } = acceptedOrder();
  const stateBefore = JSON.stringify(state);
  const orderBefore = JSON.stringify(order);

  buildKitchenProductionTicketData(order, TZ);
  buildKitchenProductionTicketData(order, TZ);

  assert.equal(JSON.stringify(state), stateBefore, "state не изменился");
  assert.equal(JSON.stringify(order), orderBefore, "заказ не изменился");
  assert.equal(state.revision, JSON.parse(stateBefore).revision);
  assert.equal(order.history.length, JSON.parse(orderBefore).history.length);
  assert.equal(order.status, JSON.parse(orderBefore).status);
  assert.equal(order.paymentStatus, JSON.parse(orderBefore).paymentStatus);
  assert.equal(order.pickupCode, JSON.parse(orderBefore).pickupCode);
  assert.deepEqual(state.settlements, createDefaultState().settlements);
});
