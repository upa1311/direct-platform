import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
} from "./actions.ts";
import { getPickupPaymentChoices } from "./selectors.ts";
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

// 12 — логотип наклейки --------------------------------------------------------

test("логотип пакетной наклейки уменьшен вдвое, PNG не менялся", () => {
  const css = readFileSync(
    new URL("../components/operator/operator-package-label.module.css", import.meta.url),
    "utf8",
  );
  assert.ok(css.includes("max-width: 23mm"));
  assert.ok(!css.includes("max-width: 46mm"));
});
