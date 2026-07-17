import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOperatorPackageLabelData,
  canPrintOperatorPackageLabel,
  getPackagePaymentLabel,
  PACKAGE_DUE,
  PACKAGE_PAID,
} from "./operator-package-label-data.ts";
import { createDefaultState } from "../../prototype/default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "../../prototype/actions.ts";
import type {
  Order,
  OrderStatus,
  PrototypeState,
  RestaurantWorkspaceRole,
} from "../../prototype/models.ts";

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

test("label содержит номер, способ, ресторан, позиции, варианты, totals, payment", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
    status: "READY_FOR_PICKUP",
    items: [
      {
        ...base.order.items[0],
        name: "Бургер",
        quantity: 2,
        selectedVariantId: "size-double",
        selectedVariantName: "Двойной",
        cookingComment: "Без лука",
      },
    ],
  });
  const data = buildOperatorPackageLabelData(order);

  assert.equal(data.publicNumber, order.publicNumber);
  assert.match(data.publicNumber, /^DIR-\d+$/);
  assert.equal(data.deliveryLabel, "САМОВЫВОЗ");
  assert.equal(data.restaurantName, order.restaurant.name);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].quantity, 2);
  assert.equal(data.items[0].name, "Бургер");
  assert.equal(data.items[0].variantName, "Двойной");
  assert.equal(data.itemsTotal, 1);
  assert.equal(data.unitsTotal, 2);
  assert.equal(data.countsLine, "Позиций: 1 · Единиц: 2");
  assert.ok(data.paymentLabel === PACKAGE_PAID || data.paymentLabel === PACKAGE_DUE);
});

// 2 --------------------------------------------------------------------------

test("snapshot: позиции из order.items; изменение меню не меняет наклейку", () => {
  const { state, order } = acceptedOrder();
  const before = buildOperatorPackageLabelData(order);
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
  const after = buildOperatorPackageLabelData(orderAfter);

  assert.equal(after.items[0].name, originalName);
  assert.notEqual(after.items[0].name, "Новое название из меню");
  assert.deepEqual(after, before);
});

// 3 --------------------------------------------------------------------------

test("cooking comments не попадают в label даже если непустые", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
    items: [
      {
        ...base.order.items[0],
        cookingComment: "СЕКРЕТ_КОММ_без лука и соуса",
      },
    ],
  });
  const data = buildOperatorPackageLabelData(order);
  assert.ok(!("cookingComment" in data.items[0]));
  assert.ok(!JSON.stringify(data).includes("СЕКРЕТ_КОММ_без лука и соуса"));
});

// 4 --------------------------------------------------------------------------

test("privacy sentinel: ни одно приватное/финансовое значение не в label", () => {
  const base = acceptedOrder("DELIVERY");
  const { order } = withOrder(base.state, base.order, {
    status: "READY",
    customer: {
      ...base.order.customer,
      name: "СЕНТИНЕЛ_ИМЯ_Ольга",
      phone: "СЕНТИНЕЛ_ТЕЛ_0600123",
    },
    address: {
      ...base.order.address!,
      street: "СЕНТИНЕЛ_УЛИЦА_Абрикосовая",
      house: "СЕНТИНЕЛ_ДОМ_88",
      apartment: "СЕНТИНЕЛ_КВ_777",
      entrance: "СЕНТИНЕЛ_ПОДЪЕЗД_3",
      floor: "СЕНТИНЕЛ_ЭТАЖ_9",
      comment: "СЕНТИНЕЛ_КОММ_позвонить",
    },
    pickupCode: "СЕНТИНЕЛ_КОД_5910",
    assignedDriverId: "СЕНТИНЕЛ_ВОДИТЕЛЬ_driver-1",
    items: [
      { ...base.order.items[0], cookingComment: "СЕНТИНЕЛ_КОММ_кухни" },
    ],
    financials: {
      ...base.order.financials,
      customerTotalCents: 987654,
    },
  });

  const data = buildOperatorPackageLabelData(order);
  const serialized = JSON.stringify(data);

  const sentinels = [
    "СЕНТИНЕЛ_ИМЯ_Ольга",
    "СЕНТИНЕЛ_ТЕЛ_0600123",
    "СЕНТИНЕЛ_УЛИЦА_Абрикосовая",
    "СЕНТИНЕЛ_ДОМ_88",
    "СЕНТИНЕЛ_КВ_777",
    "СЕНТИНЕЛ_ПОДЪЕЗД_3",
    "СЕНТИНЕЛ_ЭТАЖ_9",
    "СЕНТИНЕЛ_КОММ_позвонить",
    "СЕНТИНЕЛ_КОД_5910",
    "СЕНТИНЕЛ_ВОДИТЕЛЬ_driver-1",
    "СЕНТИНЕЛ_КОММ_кухни",
    "987654",
    order.id,
  ];
  for (const sentinel of sentinels) {
    assert.ok(!serialized.includes(sentinel), `наклейка не должна содержать «${sentinel}»`);
  }
});

// 5 --------------------------------------------------------------------------

test("в модели наклейки нет запрещённых ключей", () => {
  const { order } = acceptedOrder();
  const data = buildOperatorPackageLabelData(order);
  for (const key of [
    "customer",
    "customerName",
    "address",
    "addressLine",
    "phone",
    "pickupCode",
    "paymentStatus",
    "paymentMethod",
    "financials",
    "amount",
    "assignedDriverId",
    "cookingComment",
    "id",
  ]) {
    assert.ok(!(key in data), `в label-data не должно быть ключа «${key}»`);
  }
  for (const item of data.items) {
    assert.ok(!("cookingComment" in item), "у позиции нет cookingComment");
  }
});

// 6 --------------------------------------------------------------------------

test("payment marker: оплачено → ОПЛАЧЕНО, остальное → ОПЛАТА ПРИ ПОЛУЧЕНИИ", () => {
  const base = acceptedOrder();
  const paidStatuses = ["PAID", "PAID_AT_RESTAURANT", "PAID_TO_RESTAURANT_COURIER"] as const;
  const dueStatuses = [
    "NOT_STARTED",
    "AWAITING_PAYMENT",
    "DUE_AT_PICKUP",
    "CASH_ON_DELIVERY",
    "DUE_TO_RESTAURANT_COURIER",
  ] as const;

  for (const status of paidStatuses) {
    const { order } = withOrder(base.state, base.order, { paymentStatus: status });
    const label = getPackagePaymentLabel(order);
    assert.equal(label, PACKAGE_PAID, status);
    assert.equal(label, "ОПЛАЧЕНО");
    assert.ok(!/\d/.test(label), "нет цифр");
    assert.ok(!label.includes("$"), "нет валюты");
  }
  for (const status of dueStatuses) {
    const { order } = withOrder(base.state, base.order, { paymentStatus: status });
    const label = getPackagePaymentLabel(order);
    assert.equal(label, PACKAGE_DUE, status);
    assert.equal(label, "ОПЛАТА ПРИ ПОЛУЧЕНИИ");
    assert.ok(!/\d/.test(label), "нет цифр");
    assert.ok(!label.includes("$"), "нет валюты");
  }
});

// 7 --------------------------------------------------------------------------

test("visibility helper: только OPERATOR/COMBINED и только готовый заказ", () => {
  const base = acceptedOrder();
  const at = (status: OrderStatus, role: RestaurantWorkspaceRole) =>
    canPrintOperatorPackageLabel(
      withOrder(base.state, base.order, { status }).order,
      role,
    );

  assert.equal(at("READY", "OPERATOR"), true);
  assert.equal(at("READY_FOR_PICKUP", "OPERATOR"), true);
  assert.equal(at("READY", "COMBINED"), true);
  assert.equal(at("READY_FOR_PICKUP", "COMBINED"), true);

  // Кухня — никогда, при любом статусе.
  for (const status of ["READY", "READY_FOR_PICKUP", "PREPARING"] as const) {
    assert.equal(at(status, "KITCHEN"), false, `KITCHEN ${status}`);
  }

  // До готовности и после выдачи/в доставке — нет.
  for (const status of [
    "RESTAURANT_REVIEW",
    "AWAITING_PAYMENT",
    "PREPARING",
    "OUT_FOR_DELIVERY",
    "ARRIVING",
    "DELIVERED",
    "PICKED_UP",
    "CANCELED",
  ] as const) {
    assert.equal(at(status, "OPERATOR"), false, `OPERATOR ${status}`);
    assert.equal(at(status, "COMBINED"), false, `COMBINED ${status}`);
  }
});

// 8 --------------------------------------------------------------------------

test("read-only: построение наклейки не меняет state/order", () => {
  const { state, order } = acceptedOrder();
  const stateBefore = JSON.stringify(state);
  const orderBefore = JSON.stringify(order);

  buildOperatorPackageLabelData(order);
  buildOperatorPackageLabelData(order);

  assert.equal(JSON.stringify(state), stateBefore, "state не изменился");
  assert.equal(JSON.stringify(order), orderBefore, "заказ не изменился");
  assert.equal(state.revision, JSON.parse(stateBefore).revision);
  assert.equal(order.history.length, JSON.parse(orderBefore).history.length);
  assert.equal(order.status, JSON.parse(orderBefore).status);
  assert.equal(order.paymentStatus, JSON.parse(orderBefore).paymentStatus);
  assert.equal(order.pickupCode, JSON.parse(orderBefore).pickupCode);
  assert.equal(order.assignedDriverId, JSON.parse(orderBefore).assignedDriverId);
  assert.deepEqual(state.settlements, createDefaultState().settlements);
});
