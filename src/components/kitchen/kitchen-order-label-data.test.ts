import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildKitchenOrderLabelData,
  getLabelAddressLine,
  getLabelPaymentLine,
  LABEL_NO_CUSTOMER_NAME,
  LABEL_PAID,
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
import { formatMoney } from "../../prototype/selectors.ts";
import type { Order, PrototypeState } from "../../prototype/models.ts";

/** Один принятый заказ: самовывоз из ресторана-1, доставка из ресторана-2. */
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

test("самовывоз: САМОВЫВОЗ DIRECT, имя, ресторан, без адреса, оплата с суммой", () => {
  const { order } = acceptedOrder();
  const data = buildKitchenOrderLabelData(order);

  assert.equal(data.deliveryLabel, "САМОВЫВОЗ DIRECT");
  assert.equal(data.publicNumber, order.publicNumber);
  assert.match(data.publicNumber, /^DIR-\d+$/);
  assert.equal(data.customerName, order.customer.name);
  // Для самовывоза адресный блок отсутствует целиком.
  assert.equal(data.addressLine, null);
  assert.equal(data.restaurantName, order.restaurant.name);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].name, order.items[0].name);

  assert.equal(order.paymentStatus, "DUE_AT_PICKUP");
  assert.match(data.paymentLine, /^К ОПЛАТЕ В РЕСТОРАНЕ/);
  assert.ok(
    data.paymentLine.includes(
      formatMoney(order.financials.customerTotalCents, order.financials.currencyCode),
    ),
    data.paymentLine,
  );
});

test("Direct-доставка: ДОСТАВКА DIRECT, имя, полный адрес, позиции", () => {
  const { order } = acceptedOrder("DELIVERY");
  const data = buildKitchenOrderLabelData(order);

  assert.equal(data.deliveryLabel, "ДОСТАВКА DIRECT");
  assert.equal(order.deliveryMode, "PLATFORM_DRIVER");
  assert.equal(data.customerName, order.customer.name);
  assert.equal(data.addressLine, "Тестовая улица 1, дом 4, кв. 12");
  assert.equal(data.items.length, 1);
  assert.ok(data.items[0].quantity > 0);
});

test("доставка ресторана: ДОСТАВКА РЕСТОРАНА, адрес, оплата курьеру наличными", () => {
  const base = acceptedOrder("DELIVERY");
  const { order } = withOrder(base.state, base.order, {
    deliveryMode: "RESTAURANT_DELIVERY",
    paymentStatus: "DUE_TO_RESTAURANT_COURIER",
  });
  const data = buildKitchenOrderLabelData(order);

  assert.equal(data.deliveryLabel, "ДОСТАВКА РЕСТОРАНА");
  assert.equal(data.addressLine, "Тестовая улица 1, дом 4, кв. 12");
  assert.match(data.paymentLine, /^К ОПЛАТЕ КУРЬЕРУ НАЛИЧНЫМИ: /);
  assert.ok(
    data.paymentLine.includes(
      formatMoney(order.financials.customerTotalCents, order.financials.currencyCode),
    ),
    data.paymentLine,
  );
});

test("оплаченный заказ: только ОПЛАЧЕНО, без суммы", () => {
  const delivery = acceptedOrder("DELIVERY");
  const s = simulateSuccessfulOnlinePayment(delivery.state, delivery.order.id);
  const paid = s.orders.find((o) => o.id === delivery.order.id);
  assert.ok(paid);
  assert.equal(paid.paymentStatus, "PAID");

  const data = buildKitchenOrderLabelData(paid);
  assert.equal(data.paymentLine, LABEL_PAID);
  // В строке оплаты не должно быть ни суммы, ни валюты.
  assert.ok(!/\d/.test(data.paymentLine), data.paymentLine);
  assert.ok(!data.paymentLine.includes("$"), data.paymentLine);
  assert.ok(
    !data.paymentLine.includes(String(paid.financials.customerTotalCents)),
    data.paymentLine,
  );

  for (const status of ["PAID_AT_RESTAURANT", "PAID_TO_RESTAURANT_COURIER"] as const) {
    const probe = withOrder(s, paid, { paymentStatus: status });
    assert.equal(getLabelPaymentLine(probe.order), LABEL_PAID, status);
  }
});

test("оплата в ресторане зависит от снимка способов оплаты", () => {
  const base = acceptedOrder();
  const amount = formatMoney(
    base.order.financials.customerTotalCents,
    base.order.financials.currencyCode,
  );

  const cases: [readonly ("CASH" | "CARD")[], string][] = [
    [["CASH", "CARD"], `К ОПЛАТЕ В РЕСТОРАНЕ НАЛИЧНЫМИ ИЛИ КАРТОЙ: ${amount}`],
    [["CASH"], `К ОПЛАТЕ В РЕСТОРАНЕ НАЛИЧНЫМИ: ${amount}`],
    [["CARD"], `К ОПЛАТЕ В РЕСТОРАНЕ КАРТОЙ: ${amount}`],
    [[], `К ОПЛАТЕ В РЕСТОРАНЕ: ${amount}`],
  ];

  for (const [snapshot, expected] of cases) {
    const probe = withOrder(base.state, base.order, {
      paymentStatus: "DUE_AT_PICKUP",
      pickupPaymentMethodsSnapshot: [...snapshot],
    });
    assert.equal(getLabelPaymentLine(probe.order), expected, snapshot.join("+"));
  }
});

test("ожидание оплаты и оплата курьеру при доставке", () => {
  const base = acceptedOrder("DELIVERY");
  const amount = formatMoney(
    base.order.financials.customerTotalCents,
    base.order.financials.currencyCode,
  );

  for (const status of ["NOT_STARTED", "AWAITING_PAYMENT"] as const) {
    const probe = withOrder(base.state, base.order, { paymentStatus: status });
    assert.equal(getLabelPaymentLine(probe.order), `ОПЛАТА ОЖИДАЕТСЯ: ${amount}`);
  }

  const cash = withOrder(base.state, base.order, {
    paymentStatus: "CASH_ON_DELIVERY",
  });
  assert.equal(
    getLabelPaymentLine(cash.order),
    `К ОПЛАТЕ КУРЬЕРУ НАЛИЧНЫМИ: ${amount}`,
  );
});

test("адрес: без квартиры короче, самовывоз без адреса совсем", () => {
  const base = acceptedOrder("DELIVERY");

  const noApartment = withOrder(base.state, base.order, {
    address: { ...base.order.address!, apartment: "" },
  });
  assert.equal(getLabelAddressLine(noApartment.order), "Тестовая улица 1, дом 4");

  // Самовывоз: адреса нет, даже если поле в заказе заполнено.
  const pickup = withOrder(base.state, base.order, { deliveryMode: "PICKUP" });
  assert.equal(getLabelAddressLine(pickup.order), null);
});

test("пустое имя клиента заменяется явной подписью", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
    customer: { ...base.order.customer, name: "   " },
  });
  assert.equal(buildKitchenOrderLabelData(order).customerName, LABEL_NO_CUSTOMER_NAME);
});

test("вариант и комментарий приготовления печатаются, пустой комментарий — нет", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
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
        quantity: 3,
        selectedVariantId: null,
        selectedVariantName: null,
        cookingComment: "   ",
      },
    ],
  });

  const data = buildKitchenOrderLabelData(order);

  assert.equal(data.items[0].variantName, "Двойной");
  assert.equal(data.items[0].comment, "Без лука, соус отдельно");
  assert.equal(data.items[1].variantName, null);
  assert.equal(data.items[1].comment, null, "пустой комментарий не печатается");
  assert.equal(data.itemsTotal, 2);
  assert.equal(data.unitsTotal, 5);
  assert.equal(data.countsLine, "Позиций: 2 · Единиц: 5");
});

test("privacy: наклейка не содержит телефон, код выдачи, id, водителя и комиссии", () => {
  const base = acceptedOrder("DELIVERY");
  const { order } = withOrder(base.state, base.order, {
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

  const data = buildKitchenOrderLabelData(order);
  const serialized = JSON.stringify(data);

  const forbiddenStrings = [
    order.customer.phone,
    "5910",
    "driver-1",
    order.id,
    "внутренняя причина отмены",
    "внутренняя причина ETA",
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  // Защита от пустого теста: сверяемся с реальными непустыми значениями.
  assert.equal(forbiddenStrings.length, 6);

  for (const value of forbiddenStrings) {
    assert.ok(!serialized.includes(value), `наклейка не должна содержать «${value}»`);
  }

  // Комиссии и settlement: сверяем только многозначные суммы, «0» встречался бы
  // в тексте случайно. Клиентский итог на наклейке разрешён — это цена к оплате.
  const money = [
    order.financials.restaurantCommissionCents,
    order.financials.platformCommissionReceivableCents,
    order.financials.platformGrossRevenueCents,
  ].filter((cents) => cents >= 100);
  assert.ok(money.length >= 1, "проверяем реальную комиссию");
  for (const cents of money) {
    assert.ok(!serialized.includes(String(cents)), `комиссия ${cents} не печатается`);
  }

  // Запрещённых ключей нет даже структурно.
  for (const key of [
    "customerPhone",
    "phone",
    "pickupCode",
    "financials",
    "settlements",
    "assignedDriverId",
    "id",
    "brand",
    "readyLine",
    "acceptedLine",
  ]) {
    assert.ok(!(key in data), `в label-data не должно быть ключа «${key}»`);
  }
});

test("privacy одинакова в COMBINED и SPLIT", () => {
  const base = acceptedOrder();
  const combined = buildKitchenOrderLabelData(base.order);

  const splitState = setRestaurantWorkflowMode(
    base.state,
    "restaurant-1",
    "SPLIT_OPERATOR_KITCHEN",
  );
  const splitOrder = splitState.orders.find((o) => o.id === base.order.id);
  assert.ok(splitOrder);
  const split = buildKitchenOrderLabelData(splitOrder);

  // Состав наклейки не зависит от режима работы ресторана.
  assert.deepEqual(split, combined);
  assert.ok(!JSON.stringify(split).includes(base.order.customer.phone));
});

test("snapshot: изменение меню не меняет наклейку старого заказа", () => {
  const { state, order } = acceptedOrder();
  const before = buildKitchenOrderLabelData(order);
  const originalName = order.items[0].name;

  // Меню переименовано уже ПОСЛЕ создания заказа.
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

  const after = buildKitchenOrderLabelData(orderAfter);
  assert.equal(after.items[0].name, originalName);
  assert.notEqual(after.items[0].name, "Новое название из меню");
  assert.deepEqual(after, before);
});

test("построение наклейки — чистая операция без мутаций", () => {
  const { state, order } = acceptedOrder();
  const stateBefore = JSON.stringify(state);
  const orderBefore = JSON.stringify(order);

  buildKitchenOrderLabelData(order);
  buildKitchenOrderLabelData(order);

  assert.equal(JSON.stringify(state), stateBefore, "state не изменился");
  assert.equal(JSON.stringify(order), orderBefore, "заказ не изменился");
  assert.equal(state.revision, JSON.parse(stateBefore).revision);
  assert.equal(order.history.length, JSON.parse(orderBefore).history.length);
  assert.equal(order.paymentStatus, JSON.parse(orderBefore).paymentStatus);
  assert.deepEqual(state.settlements, createDefaultState().settlements);
});
