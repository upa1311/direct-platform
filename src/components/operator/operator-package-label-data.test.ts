import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildOperatorPackageLabelData,
  canPrintOperatorPackageLabel,
  formatPackageLabelItemLine,
  formatPickupMethodsLine,
  PACKAGE_LABEL_LOGO_ERROR,
  PACKAGE_LABEL_LOGO_SRC,
  PACKAGE_LABEL_PAYMENT_ERROR,
  resolvePackagePaymentBlock,
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

/**
 * Пакетная наклейка: строгий состав и порядок, адрес только для доставки,
 * платёжный блок из фактического состояния заказа, отсутствие приватных данных.
 * Проверяется чистая label-data; порядок DOM дополнительно защищён контрактными
 * проверками исходника компонента (JSX в node:test не исполняется).
 */

function acceptedOrder(
  fulfillment: "PICKUP" | "DELIVERY" = "PICKUP",
): { state: PrototypeState; order: Order } {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, {
      street: "Тестовая улица 1",
      house: "15",
      apartment: "24",
      entrance: "2",
      floor: "6",
      comment: "СЕНТИНЕЛ_КОММ_позвонить",
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

/** Гарантированно строимая наклейка (иначе тест бессмысленный). */
function buildOk(order: Order) {
  const data = buildOperatorPackageLabelData(order);
  assert.ok(data, "label-data должна строиться");
  return data;
}

const LABEL_TSX = readFileSync(
  new URL("./operator-package-label.tsx", import.meta.url),
  "utf8",
);

// 1 — точный путь логотипа ----------------------------------------------------

test("используется точный путь логотипа", () => {
  assert.equal(PACKAGE_LABEL_LOGO_SRC, "/print/direct-package-label-logo.png");
});

// 2/3 — логотип в наклейке, старые заголовки удалены --------------------------

test("наклейка рендерит логотип по устойчивому селектору", () => {
  assert.ok(LABEL_TSX.includes("data-package-label-logo"));
  assert.ok(LABEL_TSX.includes("PACKAGE_LABEL_LOGO_SRC"));
});

test("старые текстовые заголовки DIRECT и НАКЛЕЙКА НА ПАКЕТ удалены", () => {
  assert.ok(!LABEL_TSX.includes("НАКЛЕЙКА НА ПАКЕТ"));
  assert.ok(!LABEL_TSX.includes(">DIRECT<"));
  assert.ok(!LABEL_TSX.includes("styles.brand"));
  assert.ok(!LABEL_TSX.includes("styles.kind"));
});

// 19 — платёжный блок последний ----------------------------------------------

test("платёжный блок — последний элемент наклейки", () => {
  const paymentAt = LABEL_TSX.indexOf("styles.payment");
  assert.ok(paymentAt > 0);
  // Все содержательные строки идут ДО платёжного блока.
  for (const marker of ["data-package-label-logo", "Ресторан:", "styles.number", "styles.items", "Клиент:", "Адрес:"]) {
    assert.ok(
      LABEL_TSX.indexOf(marker) < paymentAt,
      `«${marker}» должен идти до платёжного блока`,
    );
  }
  // После платёжного блока других строк наклейки нет.
  const afterPayment = LABEL_TSX.slice(paymentAt);
  for (const marker of ["Ресторан:", "Клиент:", "Адрес:", "styles.items", "styles.number"]) {
    assert.ok(!afterPayment.includes(marker), `после блока оплаты нет «${marker}»`);
  }
});

// 4/5/6 — способ получения ----------------------------------------------------

test("способ получения: точные строки без enum", () => {
  const base = acceptedOrder("DELIVERY");
  const driver = buildOk(
    withOrder(base.state, base.order, {
      status: "READY",
      deliveryMode: "PLATFORM_DRIVER",
      paymentMethod: "ONLINE",
      paymentStatus: "PAID",
    }).order,
  );
  assert.equal(driver.deliveryLabel, "ДОСТАВКА DIRECT");

  const restaurant = buildOk(
    withOrder(base.state, base.order, {
      status: "READY",
      deliveryMode: "RESTAURANT_DELIVERY",
      paymentMethod: "CASH_TO_RESTAURANT_COURIER",
      paymentStatus: "DUE_TO_RESTAURANT_COURIER",
    }).order,
  );
  assert.equal(restaurant.deliveryLabel, "ДОСТАВКА РЕСТОРАНА");

  const pickup = acceptedOrder();
  assert.equal(buildOk(pickup.order).deliveryLabel, "САМОВЫВОЗ");

  for (const data of [driver, restaurant]) {
    assert.ok(!JSON.stringify(data).includes("PLATFORM_DRIVER"));
    assert.ok(!JSON.stringify(data).includes("RESTAURANT_DELIVERY"));
  }
});

// 7/8 — строки позиций --------------------------------------------------------

test("позиция с вариантом и без висячего разделителя", () => {
  assert.equal(
    formatPackageLabelItemLine({ quantity: 2, name: "Позиция", variantName: "Стандартная" }),
    "2 × Позиция · Стандартная",
  );
  const noVariant = formatPackageLabelItemLine({
    quantity: 1,
    name: "Лимонад",
    variantName: null,
  });
  assert.equal(noVariant, "1 × Лимонад");
  assert.ok(!noVariant.includes("·"), "нет висячего разделителя");
  // Пустой/пробельный вариант тоже не оставляет разделителя.
  assert.equal(
    formatPackageLabelItemLine({ quantity: 3, name: "Кофе", variantName: "   " }),
    "3 × Кофе",
  );
});

// 9 — имя клиента -------------------------------------------------------------

test("имя клиента присутствует в наклейке", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
    status: "READY_FOR_PICKUP",
    customer: { ...base.order.customer, name: "Дмитрий" },
  });
  assert.equal(buildOk(order).customerName, "Дмитрий");
});

// 10/11/12 — адрес только для доставки ----------------------------------------

test("адрес присутствует для доставки водителем Direct", () => {
  const base = acceptedOrder("DELIVERY");
  const { order } = withOrder(base.state, base.order, {
    status: "READY",
    deliveryMode: "PLATFORM_DRIVER",
    paymentStatus: "PAID",
  });
  const data = buildOk(order);
  assert.equal(data.addressMain, "Тестовая улица 1, дом 15, кв. 24");
  assert.equal(data.addressAccess, "Подъезд 2 · этаж 6");
});

test("адрес присутствует для доставки ресторана", () => {
  const base = acceptedOrder("DELIVERY");
  const { order } = withOrder(base.state, base.order, {
    status: "READY",
    deliveryMode: "RESTAURANT_DELIVERY",
    paymentMethod: "CASH_TO_RESTAURANT_COURIER",
    paymentStatus: "DUE_TO_RESTAURANT_COURIER",
  });
  const data = buildOk(order);
  assert.equal(data.addressMain, "Тестовая улица 1, дом 15, кв. 24");
});

test("для самовывоза адреса нет совсем", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
    status: "READY_FOR_PICKUP",
  });
  const data = buildOk(order);
  assert.equal(data.addressMain, null);
  assert.equal(data.addressAccess, null);
  // Ни адреса ресторана, ни пустой строки-заглушки.
  assert.ok(!JSON.stringify(data).includes(order.restaurant.address));
});

// 13/14/15 — приватные данные не попадают на наклейку -------------------------

test("телефон, комментарии и внутренние данные отсутствуют в label-data", () => {
  const base = acceptedOrder("DELIVERY");
  const { order } = withOrder(base.state, base.order, {
    status: "READY",
    deliveryMode: "PLATFORM_DRIVER",
    paymentStatus: "PAID",
    customer: {
      ...base.order.customer,
      name: "Ольга",
      phone: "СЕНТИНЕЛ_ТЕЛ_0600123",
    },
    pickupCode: "СЕНТИНЕЛ_КОД_5910",
    assignedDriverId: "СЕНТИНЕЛ_ВОДИТЕЛЬ_driver-1",
    items: [{ ...base.order.items[0], cookingComment: "СЕНТИНЕЛ_КОММ_кухни" }],
  });

  const serialized = JSON.stringify(buildOk(order));
  for (const sentinel of [
    "СЕНТИНЕЛ_ТЕЛ_0600123",
    "СЕНТИНЕЛ_КОД_5910",
    "СЕНТИНЕЛ_ВОДИТЕЛЬ_driver-1",
    "СЕНТИНЕЛ_КОММ_кухни",
    "СЕНТИНЕЛ_КОММ_позвонить", // комментарий к адресу
    order.id,
  ]) {
    assert.ok(!serialized.includes(sentinel), `наклейка не должна содержать «${sentinel}»`);
  }
});

test("в модели наклейки нет запрещённых ключей", () => {
  const { order } = acceptedOrder();
  const data = buildOk(order);
  for (const key of [
    "phone",
    "pickupCode",
    "paymentStatus",
    "paymentMethod",
    "financials",
    "assignedDriverId",
    "id",
    "history",
    "addressComment",
    "countsLine",
  ]) {
    assert.ok(!(key in data), `в label-data не должно быть ключа «${key}»`);
  }
  for (const item of data.items) {
    assert.ok(!("cookingComment" in item), "у позиции нет cookingComment");
  }
});

// 16 — оплаченный заказ -------------------------------------------------------

test("оплаченный заказ печатает только ОПЛАЧЕНО без суммы", () => {
  const base = acceptedOrder();
  for (const status of ["PAID", "PAID_AT_RESTAURANT", "PAID_TO_RESTAURANT_COURIER"] as const) {
    const { order } = withOrder(base.state, base.order, {
      status: "READY_FOR_PICKUP",
      paymentStatus: status,
    });
    const block = buildOk(order).paymentBlock;
    assert.equal(block.kind, "PAID", status);
    assert.equal(block.title, "ОПЛАЧЕНО");
    assert.ok(!("amount" in block), "в оплаченной ветке суммы нет");
    assert.ok(!JSON.stringify(block).includes("$"));
  }
});

// 17 — доставка с оплатой наличными -------------------------------------------

test("доставка ресторана наличными: К ОПЛАТЕ НАЛИЧНЫМИ и полный итог", () => {
  const base = acceptedOrder("DELIVERY");
  const { order } = withOrder(base.state, base.order, {
    status: "READY",
    deliveryMode: "RESTAURANT_DELIVERY",
    paymentMethod: "CASH_TO_RESTAURANT_COURIER",
    paymentStatus: "DUE_TO_RESTAURANT_COURIER",
    financials: { ...base.order.financials, customerTotalCents: 1000 },
  });
  const block = buildOk(order).paymentBlock;
  assert.equal(block.kind, "CASH_DUE");
  assert.equal(block.title, "К ОПЛАТЕ НАЛИЧНЫМИ");
  assert.equal(block.kind === "CASH_DUE" && block.amount, "$10.00");
});

test("будущая комбинация «водитель Direct + наличные» даёт тот же блок", () => {
  const base = acceptedOrder("DELIVERY");
  const { order } = withOrder(base.state, base.order, {
    status: "READY",
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    paymentStatus: "CASH_ON_DELIVERY",
    financials: { ...base.order.financials, customerTotalCents: 1000 },
  });
  const block = buildOk(order).paymentBlock;
  assert.equal(block.kind, "CASH_DUE");
  assert.equal(block.title, "К ОПЛАТЕ НАЛИЧНЫМИ");
  assert.equal(block.kind === "CASH_DUE" && block.amount, "$10.00");
});

// 18 — самовывоз с оплатой в ресторане ----------------------------------------

test("самовывоз: К ОПЛАТЕ В РЕСТОРАНЕ, полный итог и способы оплаты", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
    status: "READY_FOR_PICKUP",
    paymentStatus: "DUE_AT_PICKUP",
    financials: { ...base.order.financials, customerTotalCents: 1000 },
    pickupPaymentMethodsSnapshot: ["CASH", "CARD"],
  });
  const block = buildOk(order).paymentBlock;
  assert.equal(block.kind, "PICKUP_DUE");
  assert.equal(block.title, "К ОПЛАТЕ В РЕСТОРАНЕ");
  assert.equal(block.kind === "PICKUP_DUE" && block.amount, "$10.00");
  assert.equal(block.kind === "PICKUP_DUE" && block.methodsLine, "НАЛИЧНЫМИ ИЛИ КАРТОЙ");
});

test("строка способов оплаты строится только из снимка заказа", () => {
  assert.equal(formatPickupMethodsLine(["CASH", "CARD"]), "НАЛИЧНЫМИ ИЛИ КАРТОЙ");
  assert.equal(formatPickupMethodsLine(["CARD", "CASH"]), "НАЛИЧНЫМИ ИЛИ КАРТОЙ");
  assert.equal(formatPickupMethodsLine(["CASH"]), "НАЛИЧНЫМИ");
  assert.equal(formatPickupMethodsLine(["CARD"]), "КАРТОЙ");
  // Пустой снимок: способы не выдумываем, третьей строки нет.
  assert.equal(formatPickupMethodsLine([]), null);
});

test("самовывоз с пустым снимком способов не печатает третью строку", () => {
  const base = acceptedOrder();
  const { order } = withOrder(base.state, base.order, {
    status: "READY_FOR_PICKUP",
    paymentStatus: "DUE_AT_PICKUP",
    pickupPaymentMethodsSnapshot: [],
  });
  const block = buildOk(order).paymentBlock;
  assert.equal(block.kind === "PICKUP_DUE" && block.methodsLine, null);
});

// 24 — неизвестная комбинация -------------------------------------------------

test("неизвестная комбинация оплаты: блок не строится, наклейка не печатается", () => {
  const base = acceptedOrder("DELIVERY");
  // Доставка водителем Direct без оплаты онлайн — комбинация не распознаётся.
  const { order } = withOrder(base.state, base.order, {
    status: "READY",
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "ONLINE",
    paymentStatus: "AWAITING_PAYMENT",
  });
  assert.equal(resolvePackagePaymentBlock(order), null);
  assert.equal(buildOperatorPackageLabelData(order), null);
});

test("неоплаченный заказ никогда не помечается как ОПЛАЧЕНО", () => {
  const base = acceptedOrder("DELIVERY");
  for (const status of ["NOT_STARTED", "AWAITING_PAYMENT"] as const) {
    const { order } = withOrder(base.state, base.order, {
      status: "READY",
      deliveryMode: "PLATFORM_DRIVER",
      paymentMethod: "ONLINE",
      paymentStatus: status,
    });
    assert.equal(buildOperatorPackageLabelData(order), null, status);
  }
});

test("русские тексты ошибок печати заданы точно", () => {
  assert.equal(PACKAGE_LABEL_LOGO_ERROR, "Не удалось загрузить логотип для печати.");
  assert.equal(
    PACKAGE_LABEL_PAYMENT_ERROR,
    "Не удалось определить способ оплаты для наклейки.",
  );
});

// 20/21 — видимость кнопки ----------------------------------------------------

test("visibility helper: OPERATOR/COMBINED/KITCHEN и только готовый заказ", () => {
  const base = acceptedOrder();
  const at = (status: OrderStatus, role: RestaurantWorkspaceRole) =>
    canPrintOperatorPackageLabel(
      withOrder(base.state, base.order, { status }).order,
      role,
    );

  for (const role of ["OPERATOR", "COMBINED", "KITCHEN"] as const) {
    assert.equal(at("READY", role), true, `READY ${role}`);
    assert.equal(at("READY_FOR_PICKUP", role), true, `READY_FOR_PICKUP ${role}`);
  }

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
    for (const role of ["OPERATOR", "COMBINED", "KITCHEN"] as const) {
      assert.equal(at(status, role), false, `${role} ${status}`);
    }
  }
});

// Снимок и чистота ------------------------------------------------------------

test("snapshot: позиции из order.items; изменение меню не меняет наклейку", () => {
  const { state, order } = acceptedOrder();
  const before = buildOk(order);
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
  const after = buildOk(orderAfter);

  assert.equal(after.items[0].name, originalName);
  assert.deepEqual(after, before);
});

test("read-only: построение наклейки не меняет state/order", () => {
  const { state, order } = acceptedOrder();
  const stateBefore = JSON.stringify(state);
  const orderBefore = JSON.stringify(order);

  buildOperatorPackageLabelData(order);
  buildOperatorPackageLabelData(order);

  assert.equal(JSON.stringify(state), stateBefore, "state не изменился");
  assert.equal(JSON.stringify(order), orderBefore, "заказ не изменился");
  assert.deepEqual(state.settlements, createDefaultState().settlements);
});
