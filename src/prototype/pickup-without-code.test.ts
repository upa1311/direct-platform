import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  completePickupAtRestaurant,
  createOrderFromCart,
  markOrderReady,
  setCartFulfillmentChoice,
} from "./actions.ts";
import {
  getClientPickupPaymentLabel,
  getPickupPaymentChoices,
} from "./selectors.ts";
import type { Order, PrototypeState } from "./models.ts";

/**
 * Неоплаченный самовывоз без четырёхзначного кода: клиент платит на месте,
 * сотрудник фиксирует фактический способ оплаты и выдаёт заказ.
 *
 * Разметка проверяется контрактно по исходникам экранов (JSX в node:test не
 * исполняется): важно, что полей кода и подсказок «назовите код» больше нет.
 */

const KITCHEN_PAGE = readFileSync(
  new URL("../app/restaurant/kitchen/page.tsx", import.meta.url),
  "utf8",
);
const OPERATOR_PAGE = readFileSync(
  new URL("../app/restaurant/operator/page.tsx", import.meta.url),
  "utf8",
);
const CLIENT_ORDER_PAGE = readFileSync(
  new URL("../app/client/orders/[orderId]/page.tsx", import.meta.url),
  "utf8",
);

function pickupOrder(): { state: PrototypeState; order: Order } {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const order = created.state.orders.at(-1);
  assert.ok(order);
  return { state: created.state, order };
}

// 1 — новый PICKUP без кода ---------------------------------------------------

test("новый PICKUP-заказ создаётся без кода выдачи", () => {
  const { order } = pickupOrder();
  assert.equal(order.deliveryMode, "PICKUP");
  assert.equal(order.paymentMethod, "PAY_AT_RESTAURANT");
  assert.equal(order.paymentStatus, "DUE_AT_PICKUP");
  assert.equal(order.pickupCode, null, "код больше не выдаётся");
  assert.equal(order.pickupCodeUsed, false);
});

// 6 — способы оплаты при выдаче ------------------------------------------------

test("способы оплаты берутся из снимка, а пустой снимок даёт CASH и CARD", () => {
  const { order } = pickupOrder();
  // Оба способа из снимка ресторана.
  assert.deepEqual(
    getPickupPaymentChoices({
      ...order,
      pickupPaymentMethodsSnapshot: ["CASH", "CARD"],
    }),
    ["CASH", "CARD"],
  );
  // Единственный способ — он и подставляется.
  assert.deepEqual(
    getPickupPaymentChoices({ ...order, pickupPaymentMethodsSnapshot: ["CARD"] }),
    ["CARD"],
  );
  // Пустой снимок НЕ блокирует выдачу: безопасный набор из обоих способов.
  assert.deepEqual(
    getPickupPaymentChoices({ ...order, pickupPaymentMethodsSnapshot: [] }),
    ["CASH", "CARD"],
  );
  // Повреждённые значения отбрасываются, набор остаётся рабочим.
  assert.deepEqual(
    getPickupPaymentChoices({
      ...order,
      pickupPaymentMethodsSnapshot: ["BONUS"] as unknown as Order["pickupPaymentMethodsSnapshot"],
    }),
    ["CASH", "CARD"],
  );
});

// 3/4 — экраны выдачи без поля кода -------------------------------------------

test("COMBINED-выдача не содержит поля кода и подсказок про код", () => {
  // Проверяется разметка, а не комментарии: поля ввода кода нет.
  assert.ok(!KITCHEN_PAGE.includes(">Код клиента<"));
  assert.ok(!KITCHEN_PAGE.includes("четырёхзначный код"));
  assert.ok(!KITCHEN_PAGE.includes("Нет кода клиента"));
  assert.ok(!KITCHEN_PAGE.includes("one-time-code"));
  assert.ok(!/setCode|codeValid/.test(KITCHEN_PAGE));
});

test("SPLIT-выдача оператора не содержит поля кода и подсказок про код", () => {
  assert.ok(!OPERATOR_PAGE.includes(">Код клиента<"));
  assert.ok(!OPERATOR_PAGE.includes("четырёхзначный код"));
  assert.ok(!OPERATOR_PAGE.includes("one-time-code"));
  assert.ok(!/setCode|codeValid/.test(OPERATOR_PAGE));
});

// 2 — клиенту код не показывается ---------------------------------------------

test("клиентский экран заказа не показывает код самовывоза", () => {
  assert.ok(!CLIENT_ORDER_PAGE.includes("четырёхзначный"));
  assert.ok(!CLIENT_ORDER_PAGE.includes("Назовите этот"));
  assert.ok(!CLIENT_ORDER_PAGE.includes("flowStyles.pickupCode"));
  assert.ok(!CLIENT_ORDER_PAGE.includes("{order.pickupCode}"));
});

// 5 — кнопка зависит только от способа оплаты и pending ------------------------

test("кнопка выдачи: точный текст и зависимость только от paidWith и pending", () => {
  for (const page of [KITCHEN_PAGE, OPERATOR_PAGE]) {
    assert.ok(
      page.includes("Оплата получена — выдать заказ"),
      "точный текст кнопки",
    );
    assert.ok(
      page.includes("const canConfirm = paidWith !== null;"),
      "готовность кнопки определяется только выбранным способом оплаты",
    );
  }
  // Кухня и оператор блокируют кнопку только на время операции.
  assert.ok(KITCHEN_PAGE.includes("disabled={!canConfirm || pickupActionPending}"));
  assert.ok(OPERATOR_PAGE.includes("disabled={!canConfirm || handoffPending}"));
});

// 7 — единая клиентская строка «Оплата при получении» --------------------------

test("подпись оплаты до оплаты: снимок способов с безопасным fallback", () => {
  const { order } = pickupOrder();
  assert.equal(order.pickupPaidWith, null);
  // Оба способа доступны.
  assert.equal(
    getClientPickupPaymentLabel({
      ...order,
      pickupPaymentMethodsSnapshot: ["CASH", "CARD"],
    }),
    "Картой или наличными",
  );
  // Только карта.
  assert.equal(
    getClientPickupPaymentLabel({
      ...order,
      pickupPaymentMethodsSnapshot: ["CARD"],
    }),
    "Картой",
  );
  // Только наличные.
  assert.equal(
    getClientPickupPaymentLabel({
      ...order,
      pickupPaymentMethodsSnapshot: ["CASH"],
    }),
    "Наличными",
  );
  // Пустой снимок — безопасный fallback, как при выдаче.
  assert.equal(
    getClientPickupPaymentLabel({ ...order, pickupPaymentMethodsSnapshot: [] }),
    "Картой или наличными",
  );
  // Повреждённый снимок — тот же fallback.
  assert.equal(
    getClientPickupPaymentLabel({
      ...order,
      pickupPaymentMethodsSnapshot: [
        "BONUS",
      ] as unknown as Order["pickupPaymentMethodsSnapshot"],
    }),
    "Картой или наличными",
  );
});

test("подпись оплаты после выдачи: зафиксированный способ важнее снимка", () => {
  const { order } = pickupOrder();
  assert.equal(
    getClientPickupPaymentLabel({ ...order, pickupPaidWith: "CARD" }),
    "Картой",
  );
  assert.equal(
    getClientPickupPaymentLabel({ ...order, pickupPaidWith: "CASH" }),
    "Наличными",
  );
});

test("домен выдачи не изменён: handoff фиксирует способ, label его отражает", () => {
  const { state, order } = pickupOrder();
  let s = acceptRestaurantOrder(state, order.id, 20); // PREPARING (COMBINED)
  s = markOrderReady(s, order.id); // READY_FOR_PICKUP
  const done = completePickupAtRestaurant(s, order.id, "CASH");
  assert.equal(done.result.ok, true, done.result.error ?? "");
  const picked = done.state.orders.find((o) => o.id === order.id);
  assert.ok(picked);
  assert.equal(picked.status, "PICKED_UP");
  assert.equal(picked.paymentStatus, "PAID_AT_RESTAURANT");
  assert.equal(picked.pickupPaidWith, "CASH");
  assert.equal(getClientPickupPaymentLabel(picked), "Наличными");
});

// 8/9 — клиентская страница без кода, статуса оплаты и дублей ------------------

test("клиентская страница: нет кода получения, статуса оплаты и дублей способов", () => {
  assert.ok(!CLIENT_ORDER_PAGE.includes("Код получения появится"));
  assert.ok(!CLIENT_ORDER_PAGE.includes("Код получения"));
  assert.ok(!CLIENT_ORDER_PAGE.includes("Статус оплаты"));
  assert.ok(!CLIENT_ORDER_PAGE.includes("Способы оплаты на точке"));
  assert.ok(!CLIENT_ORDER_PAGE.includes("четырёхзначн"));
  assert.ok(!CLIENT_ORDER_PAGE.includes("paymentStatusLabels"));
  assert.ok(!CLIENT_ORDER_PAGE.includes("pickupPaymentMethodLabels"));
  // Единая строка самовывоза ровно одна: dt + helper значения.
  assert.equal(
    CLIENT_ORDER_PAGE.split("Оплата при получении").length - 1,
    1,
    "одна строка «Оплата при получении»",
  );
  assert.ok(CLIENT_ORDER_PAGE.includes("getClientPickupPaymentLabel(order)"));
});

test("карточка READY_FOR_PICKUP: сумма и подсказка без кода и перечня способов", () => {
  assert.ok(CLIENT_ORDER_PAGE.includes("Заказ готов к выдаче"));
  assert.ok(
    CLIENT_ORDER_PAGE.includes(
      "К оплате: {formatMoney(order.financials.customerTotalCents)}",
    ),
  );
  assert.ok(
    CLIENT_ORDER_PAGE.includes("Оплатите заказ при получении в ресторане."),
  );
});

test("после выдачи остаётся «Заказ получен.», не-PICKUP сохраняет строку «Оплата»", () => {
  assert.ok(CLIENT_ORDER_PAGE.includes("Заказ получен."));
  assert.ok(CLIENT_ORDER_PAGE.includes("<dt>Оплата</dt>"));
  assert.ok(
    CLIENT_ORDER_PAGE.includes("paymentMethodLabels[order.paymentMethod]"),
  );
});

// 12 — логотип наклейки --------------------------------------------------------

test("логотип пакетной наклейки уменьшен вдвое, PNG не менялся", () => {
  const css = readFileSync(
    new URL("../components/operator/operator-package-label.module.css", import.meta.url),
    "utf8",
  );
  assert.ok(css.includes("max-width: 23mm"));
  assert.ok(!css.includes("max-width: 46mm"));
});
