import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  createOrderFromCart,
  markOrderArriving,
  markOrderDelivered,
  markOrderOutForDelivery,
  markOrderReady,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import {
  calculateCartPricing,
  canPlacePrototypeOrder,
  getRestaurant,
  getSettlementForOrder,
  isAddressReady,
} from "./selectors.ts";
import { upgradeToV6 } from "./prototype-store.ts";
import type { PrototypeState } from "./models.ts";

/** RESTAURANT_DELIVERY-заказ Ресторана 3 (собственный курьер), зона-1. */
function makeRestaurantDeliveryOrder(): {
  state: PrototypeState;
  orderId: string;
} {
  let s = createDefaultState();
  // Валидный адрес доставки в обслуживаемой зоне.
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  // Две позиции по 710 = 1420 ≥ минимум 1000.
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  assert.ok(created.result.orderId);
  return { state: created.state, orderId: created.result.orderId as string };
}

function deliverFully(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  let s = acceptRestaurantOrder(state, orderId, 20); // → PREPARING
  s = markOrderReady(s, orderId); // → READY
  s = markOrderOutForDelivery(s, orderId); // → OUT_FOR_DELIVERY
  s = markOrderArriving(s, orderId); // → ARRIVING
  return s;
}

// --- Flow адреса (§2, §3, §15.1–5) -----------------------------------------

test("без адреса клиент может открыть ресторан и добавить блюда", () => {
  const s = createDefaultState();
  assert.equal(isAddressReady(s.cart.address, s), false);
  const restaurant = getRestaurant(s, "restaurant-3");
  assert.ok(restaurant);
  assert.equal(canPlacePrototypeOrder(restaurant), true);
  const added = addCartItem(s, "restaurant-3-item-1", "size-standard");
  assert.equal(added.result, "ADDED");
});

test("оформление доставки без адреса возвращает ошибку, а не редирект", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.orderId, null);
  assert.equal(created.result.error, "Введите адрес доставки");
});

test("после заполнения адреса заказ создаётся без отдельного подтверждения", () => {
  let s = createDefaultState();
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  assert.ok(created.result.orderId);
});

test("прогресс акции исчезает после первого бесплатного товара", () => {
  let s = createDefaultState();
  for (let i = 0; i < 3; i += 1) {
    s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  }
  let pricing = calculateCartPricing(s);
  // 3 пиццы — акция не применена, прогресс показывается (условие UI: === 0).
  assert.equal(pricing.promotionFreeUnitCount, 0);
  assert.equal(pricing.promotionUnitsToNextFree, 1);
  // 4-я пицца — акция применилась, прогресс скрывается.
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  pricing = calculateCartPricing(s);
  assert.equal(pricing.promotionFreeUnitCount, 1);
});

// --- Модель оплаты и создание заказа (§6–10, §15.10–14) ---------------------

test("RESTAURANT_DELIVERY: способ оплаты — наличные курьеру, не ONLINE", () => {
  const { state, orderId } = makeRestaurantDeliveryOrder();
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  assert.equal(order.deliveryMode, "RESTAURANT_DELIVERY");
  assert.equal(order.paymentMethod, "CASH_TO_RESTAURANT_COURIER");
  assert.equal(order.paymentStatus, "DUE_TO_RESTAURANT_COURIER");
  assert.notEqual(order.paymentMethod, "ONLINE");
});

test("RESTAURANT_DELIVERY: деньги Direct не собирает, комиссия 7% только с еды", () => {
  const { state, orderId } = makeRestaurantDeliveryOrder();
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  const f = order.financials;
  const foodSubtotal = 1420;
  const deliveryFee = 300;
  const expectedCommission = Math.round((foodSubtotal * 700) / 10_000); // 99
  // Комиссия 7% считается только от еды после скидок.
  assert.equal(f.foodSubtotalCents, foodSubtotal);
  assert.equal(f.restaurantCommissionCents, expectedCommission);
  // Доставка НЕ входит в комиссионную базу (иначе было бы 120).
  assert.notEqual(
    f.restaurantCommissionCents,
    Math.round(((foodSubtotal + deliveryFee) * 700) / 10_000),
  );
  // Клиентский платёж Direct не удерживает; всё получает ресторан.
  assert.equal(f.platformCollectedFromCustomerCents, 0);
  assert.equal(f.restaurantCollectedFromCustomerCents, f.customerTotalCents);
  assert.equal(f.customerTotalCents, foodSubtotal + deliveryFee);
  // Расчётная комиссия хранится как задолженность; small-order fee и выплата
  // водителю отсутствуют.
  assert.equal(f.platformCommissionReceivableCents, expectedCommission);
  assert.equal(f.smallOrderFeeCents, 0);
  assert.equal(f.driverPayoutCents, 0);
  assert.equal(
    f.restaurantNetAfterPlatformCommissionCents,
    f.customerTotalCents - expectedCommission,
  );
});

test("RESTAURANT_DELIVERY: после принятия нет AWAITING_PAYMENT", () => {
  const { state, orderId } = makeRestaurantDeliveryOrder();
  const accepted = acceptRestaurantOrder(state, orderId, 20);
  const order = accepted.orders.find((o) => o.id === orderId);
  assert.ok(order);
  assert.equal(order.status, "PREPARING");
  assert.equal(order.paymentStatus, "DUE_TO_RESTAURANT_COURIER");
  // Ни один статус в истории не проходит через AWAITING_PAYMENT.
  assert.equal(
    order.history.some(
      (e) => e.toStatus === "AWAITING_PAYMENT" || e.fromStatus === "AWAITING_PAYMENT",
    ),
    false,
  );
});

// --- Завершение доставки и settlement (§11, §15.16–19) ----------------------

test("RESTAURANT_DELIVERY: до доставки settlement отсутствует", () => {
  const { state, orderId } = makeRestaurantDeliveryOrder();
  const s = deliverFully(state, orderId); // до ARRIVING включительно
  assert.equal(s.settlements.length, 0);
  assert.equal(getSettlementForOrder(s, orderId), null);
});

test("RESTAURANT_DELIVERY: завершение фиксирует наличные и создаёт одну settlement", () => {
  const { state, orderId } = makeRestaurantDeliveryOrder();
  let s = deliverFully(state, orderId);
  s = markOrderDelivered(s, orderId);

  const order = s.orders.find((o) => o.id === orderId);
  assert.ok(order);
  assert.equal(order.status, "DELIVERED");
  assert.equal(order.paymentStatus, "PAID_TO_RESTAURANT_COURIER");
  assert.ok(order.paidAt);
  // Событие получения наличных и событие доставки в истории.
  assert.equal(
    order.history.some(
      (e) => e.type === "PAYMENT" && e.message.includes("наличными"),
    ),
    true,
  );
  assert.equal(
    order.history.some((e) => e.toStatus === "DELIVERED"),
    true,
  );

  // Ровно одна immutable settlement-запись нужного типа и суммы.
  assert.equal(s.settlements.length, 1);
  const entry = s.settlements[0];
  assert.equal(entry.orderId, orderId);
  assert.equal(entry.type, "RESTAURANT_DELIVERY_COMMISSION");
  assert.equal(entry.amountCents, order.financials.platformCommissionReceivableCents);
  assert.equal(entry.status, "PENDING");
});

test("RESTAURANT_DELIVERY: повторное завершение не создаёт вторую settlement", () => {
  const { state, orderId } = makeRestaurantDeliveryOrder();
  let s = deliverFully(state, orderId);
  s = markOrderDelivered(s, orderId);
  const afterFirst = s.settlements.length;
  s = markOrderDelivered(s, orderId); // повторное нажатие
  assert.equal(afterFirst, 1);
  assert.equal(s.settlements.length, 1);
});

// --- Инварианты других режимов (§14, §15.20–22) -----------------------------

test("PICKUP остаётся с комиссией Direct 15%", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const order = created.state.orders.find(
    (o) => o.id === created.result.orderId,
  );
  assert.ok(order);
  assert.equal(order.deliveryMode, "PICKUP");
  assert.equal(order.paymentMethod, "PAY_AT_RESTAURANT");
  assert.equal(order.financials.restaurantCommissionRateBps, 1500);
});

test("PLATFORM_DRIVER остаётся с оплатой ONLINE", () => {
  let s = createDefaultState();
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const order = created.state.orders.find(
    (o) => o.id === created.result.orderId,
  );
  assert.ok(order);
  assert.equal(order.deliveryMode, "PLATFORM_DRIVER");
  assert.equal(order.paymentMethod, "ONLINE");
  assert.equal(order.paymentStatus, "NOT_STARTED");
  assert.equal(order.financials.platformCollectedFromCustomerCents, order.financials.customerTotalCents);
});

test("миграция: старым RESTAURANT_DELIVERY-заказам settlement не создаётся", () => {
  const legacyState = {
    schemaVersion: 6,
    revision: 5,
    nextOrderNumber: 60,
    restaurants: [],
    orders: [
      {
        id: "legacy-rd-1",
        publicNumber: "DIR-0050",
        deliveryMode: "RESTAURANT_DELIVERY",
        // Историческая онлайн-оплата: не должна меняться и не создавать settlement.
        paymentMethod: "ONLINE",
        paymentStatus: "PAID",
        status: "DELIVERED",
        restaurant: {
          id: "restaurant-3",
          name: "Ресторан 3",
          address: "Бендеры",
          zoneId: "zone-3",
        },
        items: [],
      },
    ],
  };
  const migrated = upgradeToV6(legacyState);
  // Settlement задним числом не начисляется.
  assert.equal(migrated.settlements.length, 0);
  const order = migrated.orders.find((o) => o.id === "legacy-rd-1");
  assert.ok(order);
  // Историческая оплата сохранена без изменений.
  assert.equal(order.paymentMethod, "ONLINE");
  assert.equal(order.paymentStatus, "PAID");
  assert.equal(order.status, "DELIVERED");
});
