import assert from "node:assert/strict";
import { test } from "node:test";

import { buildKitchenProductionTicketData } from "../components/kitchen/kitchen-production-ticket-data.ts";
import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
} from "./actions.ts";
import {
  getKitchenNewOrders,
  HIGH_VALUE_CASH_ORDER_THRESHOLD_CENTS,
  isHighValueCashOrder,
} from "./selectors.ts";
import type {
  DeliveryMode,
  Order,
  PaymentMethod,
  PrototypeState,
  RestaurantOrderWorkflowMode,
} from "./models.ts";

/**
 * Информационное предупреждение о крупном заказе с оплатой при получении.
 * Проверяется чистое правило показа (порог + режим оплаты), место показа
 * (общий экран / оператор, но не кухня в SPLIT) и то, что подсказка ничего не
 * блокирует и не попадает в производственную распечатку.
 */

const RID = "restaurant-2";

/** Минимальный заказ для чистой проверки правила показа. */
function order(
  deliveryMode: DeliveryMode,
  paymentMethod: PaymentMethod,
  customerTotalCents: number,
): Order {
  return {
    id: "o1",
    deliveryMode,
    paymentMethod,
    customer: { id: "c1", name: "Клиент", phone: "+373 000 00 100" },
    financials: { customerTotalCents },
  } as unknown as Order;
}

// 1 --------------------------------------------------------------------------

test("PICKUP $49.99 — предупреждения нет", () => {
  assert.equal(
    isHighValueCashOrder(order("PICKUP", "PAY_AT_RESTAURANT", 4_999)),
    false,
  );
});

// 2 --------------------------------------------------------------------------

test("PICKUP $50.00 — предупреждение есть (порог нестрогий)", () => {
  assert.equal(HIGH_VALUE_CASH_ORDER_THRESHOLD_CENTS, 5_000);
  assert.equal(
    isHighValueCashOrder(order("PICKUP", "PAY_AT_RESTAURANT", 5_000)),
    true,
  );
});

// 3 --------------------------------------------------------------------------

test("RESTAURANT_DELIVERY $50.00 наличными курьеру — предупреждение есть", () => {
  assert.equal(
    isHighValueCashOrder(
      order("RESTAURANT_DELIVERY", "CASH_TO_RESTAURANT_COURIER", 5_000),
    ),
    true,
  );
});

// 4 --------------------------------------------------------------------------

test("ONLINE $100 — предупреждения нет", () => {
  assert.equal(
    isHighValueCashOrder(order("PLATFORM_DRIVER", "ONLINE", 10_000)),
    false,
  );
  // Доставка водителем Direct не попадает под правило даже при крупной сумме.
  assert.equal(
    isHighValueCashOrder(order("PLATFORM_DRIVER", "CASH", 10_000)),
    false,
  );
});

test("порог считается по полному итогу заказа, а не по стоимости еды", () => {
  // Сумма чуть выше порога проходит, чуть ниже — нет; иных условий по цене нет.
  assert.equal(
    isHighValueCashOrder(order("PICKUP", "PAY_AT_RESTAURANT", 5_001)),
    true,
  );
  assert.equal(
    isHighValueCashOrder(order("PICKUP", "PAY_AT_RESTAURANT", 4_999)),
    false,
  );
});

// Место показа ---------------------------------------------------------------

/** Крупный PICKUP-заказ с оплатой в ресторане в нужном режиме работы. */
function highValuePickupOrder(mode: RestaurantOrderWorkflowMode): {
  state: PrototypeState;
  orderId: string;
} {
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === RID ? { ...r, orderWorkflowMode: mode } : r,
    ),
  };
  s = setCartFulfillmentChoice(s, "PICKUP");
  // Набираем позиций заведомо больше, чем на $50 полного итога.
  for (let i = 0; i < 20; i += 1) {
    s = addCartItem(s, `${RID}-item-1`, "size-standard").state;
  }
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  const placed = created.state.orders.find((o) => o.id === orderId);
  assert.ok(placed);
  assert.ok(
    placed.financials.customerTotalCents >=
      HIGH_VALUE_CASH_ORDER_THRESHOLD_CENTS,
    `итог ${placed.financials.customerTotalCents} должен быть не меньше порога`,
  );
  assert.equal(isHighValueCashOrder(placed), true);
  return { state: created.state, orderId };
}

// 5 --------------------------------------------------------------------------

test("SPLIT: кухня не получает карточку нового заказа, значит и предупреждения", () => {
  const { state } = highValuePickupOrder("SPLIT_OPERATOR_KITCHEN");
  // Непринятый заказ до кухни в SPLIT не доходит — предупреждение видит только
  // оператор, у которого карточка нового заказа и есть.
  assert.equal(getKitchenNewOrders(state, RID).length, 0);
});

// 6 --------------------------------------------------------------------------

test("COMBINED: общий экран получает карточку нового заказа с предупреждением", () => {
  const { state, orderId } = highValuePickupOrder("COMBINED");
  const newOrders = getKitchenNewOrders(state, RID);
  assert.equal(newOrders.length, 1);
  assert.equal(newOrders[0].id, orderId);
  assert.equal(isHighValueCashOrder(newOrders[0]), true);
});

// 7 --------------------------------------------------------------------------

test("предупреждение не блокирует приём заказа", () => {
  const { state, orderId } = highValuePickupOrder("COMBINED");
  const res = acceptRestaurantOrderWithResult(
    state,
    orderId,
    20,
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(res.result.ok, true);
  const accepted = res.state.orders.find((o) => o.id === orderId);
  assert.ok(accepted);
  assert.equal(accepted.status, "PREPARING");
  // Подсказка не меняет оплату и финансовый снимок.
  assert.equal(accepted.paymentStatus, "DUE_AT_PICKUP");
  assert.deepEqual(
    accepted.financials,
    state.orders.find((o) => o.id === orderId)?.financials,
  );
  // Карточка нового заказа ушла — вместе с ней и предупреждение.
  assert.equal(getKitchenNewOrders(res.state, RID).length, 0);
});

test("телефон клиента не попадает в производственную распечатку", () => {
  const { state, orderId } = highValuePickupOrder("COMBINED");
  const accepted = acceptRestaurantOrderWithResult(
    state,
    orderId,
    20,
    "RESTAURANT",
    "COMBINED",
  ).state;
  const placed = accepted.orders.find((o) => o.id === orderId);
  assert.ok(placed);
  const ticket = buildKitchenProductionTicketData(placed, "Europe/Chisinau");
  const serialized = JSON.stringify(ticket);
  // Ни телефона, ни имени клиента в кухонных данных печати нет.
  assert.ok(!serialized.includes(placed.customer.phone));
  assert.ok(!/\+373/.test(serialized));
  assert.ok(!serialized.includes(placed.customer.name));
});
