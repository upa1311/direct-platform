import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildKitchenOrderLabelData,
  findOrderAcceptedAtIso,
  getLabelPaymentLabel,
  LABEL_DUE_ON_RECEIPT,
  LABEL_PAID,
  LABEL_READY_UNKNOWN,
} from "./kitchen-order-label-data.ts";
import { createDefaultState } from "../../prototype/default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
  setRestaurantWorkflowMode,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "../../prototype/actions.ts";
import type { Order, PaymentStatus, PrototypeState } from "../../prototype/models.ts";

/** Один принятый заказ: самовывоз из ресторана-1, доставка из ресторана-2. */
function acceptedOrder(
  fulfillment: "PICKUP" | "DELIVERY" = "PICKUP",
): { state: PrototypeState; order: Order } {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, {
      street: "Тестовая улица 1",
      house: "1",
      apartment: "кв. 42",
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

test("наклейка печатает публичные поля заказа", () => {
  const { state, order } = acceptedOrder();
  const data = buildKitchenOrderLabelData(state, order);

  assert.equal(data.brand, "DIRECT");
  assert.equal(data.publicNumber, order.publicNumber);
  assert.match(data.publicNumber, /^DIR-\d+$/);
  assert.equal(data.restaurantName, order.restaurant.name);
  assert.equal(data.deliveryLabel, "САМОВЫВОЗ");
  assert.match(data.readyLine, /^Готово к \d{2}:\d{2}$/);
  assert.match(data.acceptedLine ?? "", /^Принят: \d{2}:\d{2}$/);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].name, order.items[0].name);
  assert.equal(data.items[0].quantity, order.items[0].quantity);
  assert.equal(data.paymentLabel, LABEL_DUE_ON_RECEIPT);
});

test("способ получения печатается словами, без внутреннего enum", () => {
  const pickup = acceptedOrder();
  assert.equal(
    buildKitchenOrderLabelData(pickup.state, pickup.order).deliveryLabel,
    "САМОВЫВОЗ",
  );

  const platform = withOrder(pickup.state, pickup.order, {
    deliveryMode: "PLATFORM_DRIVER",
  });
  assert.equal(
    buildKitchenOrderLabelData(platform.state, platform.order).deliveryLabel,
    "ДОСТАВКА DIRECT",
  );

  const restaurantDelivery = withOrder(pickup.state, pickup.order, {
    deliveryMode: "RESTAURANT_DELIVERY",
  });
  assert.equal(
    buildKitchenOrderLabelData(restaurantDelivery.state, restaurantDelivery.order)
      .deliveryLabel,
    "ДОСТАВКА РЕСТОРАНА",
  );

  for (const mode of ["PICKUP", "PLATFORM_DRIVER", "RESTAURANT_DELIVERY"] as const) {
    const probe = withOrder(pickup.state, pickup.order, { deliveryMode: mode });
    const label = buildKitchenOrderLabelData(probe.state, probe.order)
      .deliveryLabel;
    assert.ok(!label.includes("_"), label);
    assert.ok(!/PICKUP|PLATFORM|RESTAURANT_/.test(label), label);
  }
});

test("вариант и комментарий приготовления попадают на наклейку, пустой — нет", () => {
  const base = acceptedOrder();
  const { state, order } = withOrder(base.state, base.order, {
    items: [
      {
        ...base.order.items[0],
        name: "Бургер",
        quantity: 2,
        selectedVariantId: "size-double",
        selectedVariantName: "Двойной",
        cookingComment: "  Без лука, соус отдельно  ",
      },
      {
        ...base.order.items[0],
        menuItemId: "restaurant-1-item-2",
        name: "Картофель фри",
        quantity: 1,
        selectedVariantId: null,
        selectedVariantName: null,
        cookingComment: "   ",
      },
    ],
  });

  const data = buildKitchenOrderLabelData(state, order);

  assert.equal(data.items[0].variantName, "Двойной");
  // Комментарий печатается обрезанным по краям, содержимое не меняется.
  assert.equal(data.items[0].comment, "Без лука, соус отдельно");
  assert.equal(data.items[1].variantName, null);
  assert.equal(data.items[1].comment, null, "пустой комментарий не печатается");
});

test("количество: единицы суммируются, счётчики нейтральной формы", () => {
  const base = acceptedOrder();
  const { state, order } = withOrder(base.state, base.order, {
    items: [
      { ...base.order.items[0], name: "Бургер", quantity: 2 },
      { ...base.order.items[0], name: "Картофель фри", quantity: 3 },
    ],
  });

  const data = buildKitchenOrderLabelData(state, order);

  assert.equal(data.itemsTotal, 2);
  assert.equal(data.unitsTotal, 5);
  assert.equal(data.countsLine, "Позиций: 2 · Единиц: 5");
});

test("оплата: оплаченные статусы → ОПЛАЧЕНО, ожидающие → ОПЛАТА ПРИ ПОЛУЧЕНИИ", () => {
  assert.equal(getLabelPaymentLabel("PAID"), LABEL_PAID);
  assert.equal(getLabelPaymentLabel("PAID_AT_RESTAURANT"), LABEL_PAID);
  assert.equal(getLabelPaymentLabel("PAID_TO_RESTAURANT_COURIER"), LABEL_PAID);

  const dueStatuses: PaymentStatus[] = [
    "DUE_AT_PICKUP",
    "CASH_ON_DELIVERY",
    "DUE_TO_RESTAURANT_COURIER",
    "NOT_STARTED",
    "AWAITING_PAYMENT",
  ];
  for (const status of dueStatuses) {
    assert.equal(getLabelPaymentLabel(status), LABEL_DUE_ON_RECEIPT, status);
  }

  // Реальный онлайн-оплаченный заказ печатается как ОПЛАЧЕНО.
  const delivery = acceptedOrder("DELIVERY");
  const s = simulateSuccessfulOnlinePayment(delivery.state, delivery.order.id);
  const paidOrder = s.orders.find((o) => o.id === delivery.order.id);
  assert.ok(paidOrder);
  assert.equal(paidOrder.paymentStatus, "PAID");
  assert.equal(buildKitchenOrderLabelData(s, paidOrder).paymentLabel, LABEL_PAID);
});

test("время принятия берётся из реального перехода в PREPARING", () => {
  const { state, order } = acceptedOrder();
  const acceptedAt = findOrderAcceptedAtIso(order);
  const event = order.history.find(
    (e) => e.type === "STATUS" && e.toStatus === "PREPARING",
  );

  assert.ok(event);
  assert.equal(acceptedAt, event.occurredAt);

  // Без перехода в PREPARING время принятия не выдумывается.
  const noHistory = withOrder(state, order, { history: [] });
  assert.equal(findOrderAcceptedAtIso(noHistory.order), null);
  assert.equal(buildKitchenOrderLabelData(noHistory.state, noHistory.order).acceptedLine, null);
});

test("без expectedReadyAt печатается «Время готовности не задано»", () => {
  const base = acceptedOrder();
  const { state, order } = withOrder(base.state, base.order, {
    expectedReadyAt: null,
  });
  assert.equal(
    buildKitchenOrderLabelData(state, order).readyLine,
    LABEL_READY_UNKNOWN,
  );
});

test("privacy: наклейка не содержит клиента, адрес, код выдачи, id и финансы", () => {
  const base = acceptedOrder("DELIVERY");
  const { state, order } = withOrder(base.state, base.order, {
    pickupCode: "5910",
    assignedDriverId: "driver-1",
    cancellationReason: "внутренняя причина отмены",
    etaAdjustments: [
      {
        ...(base.order.etaAdjustments[0] ?? {}),
        reason: "внутренняя причина ETA",
      } as Order["etaAdjustments"][number],
    ],
  });

  const data = buildKitchenOrderLabelData(state, order);
  const serialized = JSON.stringify(data);

  // Персональные и внутренние строки, реально присутствующие в заказе.
  const forbiddenStrings = [
    order.customer.name,
    order.customer.phone,
    order.address?.street,
    order.address?.apartment,
    "5910",
    "driver-1",
    order.id,
    "внутренняя причина отмены",
    "внутренняя причина ETA",
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  // Защита от пустого теста: сверяться нужно с реальными непустыми значениями,
  // иначе «не содержит» выполнялось бы само собой.
  assert.equal(forbiddenStrings.length, 9);

  for (const value of forbiddenStrings) {
    assert.ok(
      !serialized.includes(value),
      `наклейка не должна содержать «${value}»`,
    );
  }

  // Суммы: сверяем только многозначные величины — «0» встречался бы в тексте
  // случайно (например, во времени) и проверка ничего не доказывала бы.
  const money = [
    order.financials.customerTotalCents,
    order.financials.foodSubtotalCents,
    order.financials.restaurantCommissionCents,
    order.financials.platformCommissionReceivableCents,
  ].filter((cents) => cents >= 100);

  assert.ok(order.financials.customerTotalCents >= 100, "сумма должна быть реальной");
  assert.ok(money.length >= 2, "проверяем несколько реальных сумм");

  for (const cents of money) {
    assert.ok(
      !serialized.includes(String(cents)),
      `наклейка не должна содержать сумму ${cents}`,
    );
  }

  // Запрещённых ключей нет даже структурно.
  const forbiddenKeys = [
    "customer",
    "phone",
    "address",
    "apartment",
    "pickupCode",
    "financials",
    "settlements",
    "assignedDriverId",
    "id",
  ];
  for (const key of forbiddenKeys) {
    assert.ok(!(key in data), `в label-data не должно быть ключа «${key}»`);
  }
  assert.ok(!("customer" in data.items[0]));
});

test("privacy одинакова в COMBINED и SPLIT", () => {
  const base = acceptedOrder();
  const combined = buildKitchenOrderLabelData(base.state, base.order);

  const splitState = setRestaurantWorkflowMode(
    base.state,
    "restaurant-1",
    "SPLIT_OPERATOR_KITCHEN",
  );
  const splitOrder = splitState.orders.find((o) => o.id === base.order.id);
  assert.ok(splitOrder);
  const split = buildKitchenOrderLabelData(splitState, splitOrder);

  // Состав безопасных данных не зависит от режима работы ресторана.
  assert.deepEqual(split, combined);
  const serialized = JSON.stringify(split);
  assert.ok(!serialized.includes(base.order.customer.name));
  assert.ok(!serialized.includes(base.order.customer.phone));
});

test("snapshot: изменение меню не меняет наклейку старого заказа", () => {
  const { state, order } = acceptedOrder();
  const before = buildKitchenOrderLabelData(state, order);
  const originalName = order.items[0].name;

  // Меню переименовано и передобавлено уже ПОСЛЕ создания заказа.
  const renamedMenu: PrototypeState = {
    ...state,
    menuItems: state.menuItems.map((item) =>
      item.id === order.items[0].menuItemId
        ? { ...item, name: "Новое название из меню" }
        : item,
    ),
  };

  const after = buildKitchenOrderLabelData(renamedMenu, order);

  assert.equal(after.items[0].name, originalName);
  assert.notEqual(after.items[0].name, "Новое название из меню");
  assert.deepEqual(after, before);
});

test("построение наклейки — чистая операция без мутаций", () => {
  const { state, order } = acceptedOrder();
  const stateBefore = JSON.stringify(state);
  const orderBefore = JSON.stringify(order);
  const revisionBefore = state.revision;
  const historyBefore = order.history.length;

  buildKitchenOrderLabelData(state, order);
  buildKitchenOrderLabelData(state, order);

  assert.equal(JSON.stringify(state), stateBefore, "state не изменился");
  assert.equal(JSON.stringify(order), orderBefore, "заказ не изменился");
  assert.equal(state.revision, revisionBefore);
  assert.equal(order.history.length, historyBefore);
  assert.deepEqual(state.settlements, createDefaultState().settlements);
});
