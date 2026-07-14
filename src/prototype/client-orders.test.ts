import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  cancelOrderByClient,
  completePickupWithCode,
  createOrderFromCart,
  markOrderArriving,
  markOrderDelivered,
  markOrderOutForDelivery,
  markOrderReady,
  repeatOrderToCart,
  setCartItemComment,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import { calculateCartPricing } from "./selectors.ts";
import type { PrototypeState } from "./models.ts";

const ADDR = { street: "Тестовая улица 1", house: "1" };

/** Заказ доставки Ресторана 2 (DIRECT) в статусе RESTAURANT_REVIEW. */
function reviewDeliveryOrder(
  qty = 2,
  itemId = "restaurant-2-item-1",
  variantId: string | null = "size-standard",
): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = updateCartAddress(s, ADDR);
  for (let i = 0; i < qty; i += 1) {
    s = addCartItem(s, itemId, variantId).state;
  }
  const created = createOrderFromCart(s);
  return { state: created.state, orderId: created.result.orderId as string };
}

/** Тот же заказ, но переведённый клиентом в CANCELED (завершённый). */
function completedOrder(qty = 2): { state: PrototypeState; orderId: string } {
  const { state, orderId } = reviewDeliveryOrder(qty);
  const canceled = cancelOrderByClient(state, orderId, "завершаем для теста");
  return { state: canceled.state, orderId };
}

// --- §17: повторный заказ ---------------------------------------------------

test("завершённый заказ успешно повторяется в корзину", () => {
  const { state, orderId } = completedOrder(2);
  const res = repeatOrderToCart(state, orderId);
  assert.equal(res.result.ok, true);
  assert.equal(res.state.cart.restaurantId, "restaurant-2");
  assert.equal(res.state.cart.items.length, 1);
  assert.equal(res.state.cart.items[0].quantity, 2);
});

test("корзина повтора использует актуальные цены (не старый snapshot)", () => {
  const { state, orderId } = completedOrder(1);
  const res = repeatOrderToCart(state, orderId);
  const pricing = calculateCartPricing(res.state);
  // Актуальная база пиццы restaurant-2-item-1 = 800.
  assert.equal(pricing.foodSubtotalBeforeDiscountsCents, 800);
  // Элемент корзины не несёт финансовых полей снимка.
  assert.ok(!("unitPriceCents" in res.state.cart.items[0]));
  assert.ok(!("lineTotalCents" in res.state.cart.items[0]));
});

test("актуальная акция пересчитывается заново при повторе", () => {
  const { state, orderId } = completedOrder(4);
  const res = repeatOrderToCart(state, orderId);
  const pricing = calculateCartPricing(res.state);
  assert.equal(pricing.promotionFreeUnitCount, 1);
});

test("количество и комментарии позиций сохраняются", () => {
  let s = createDefaultState();
  s = updateCartAddress(s, ADDR);
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartItemComment(s, "restaurant-2-item-1", "size-standard", "без лука");
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  const completed = cancelOrderByClient(created.state, orderId, "тест").state;
  const res = repeatOrderToCart(completed, orderId);
  assert.equal(res.result.ok, true);
  assert.equal(res.state.cart.items[0].quantity, 3);
  assert.equal(res.state.cart.items[0].cookingComment, "без лука");
});

test("недоступное блюдо блокирует весь повтор и не меняет корзину", () => {
  const { state, orderId } = completedOrder(2);
  const withUnavailable: PrototypeState = {
    ...state,
    menuItems: state.menuItems.map((m) =>
      m.id === "restaurant-2-item-1" ? { ...m, available: false } : m,
    ),
  };
  const cartBefore = JSON.stringify(withUnavailable.cart);
  const res = repeatOrderToCart(withUnavailable, orderId);
  assert.equal(res.result.ok, false);
  assert.deepEqual(res.result.unavailableItems, ["Пицца Маргарита"]);
  assert.equal(JSON.stringify(res.state.cart), cartBefore);
});

test("удалённое блюдо блокирует весь повтор", () => {
  const { state, orderId } = completedOrder(2);
  const withDeleted: PrototypeState = {
    ...state,
    menuItems: state.menuItems.filter((m) => m.id !== "restaurant-2-item-1"),
  };
  const res = repeatOrderToCart(withDeleted, orderId);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.unavailableItems.length, 1);
});

test("недоступный размер блокирует повтор с сообщением о размере", () => {
  const { state, orderId } = reviewDeliveryOrder(1, "restaurant-2-item-1", "size-large");
  const canceled = cancelOrderByClient(state, orderId, "тест").state;
  const withBadSize: PrototypeState = {
    ...canceled,
    menuItems: canceled.menuItems.map((m) =>
      m.id === "restaurant-2-item-1"
        ? {
            ...m,
            variants: (m.variants ?? []).map((v) =>
              v.id === "size-large" ? { ...v, available: false } : v,
            ),
          }
        : m,
    ),
  };
  const res = repeatOrderToCart(withBadSize, orderId);
  assert.equal(res.result.ok, false);
  assert.ok(res.result.unavailableItems[0].includes("размер"));
  assert.ok(res.result.unavailableItems[0].includes("Большая"));
});

test("изменение цены устанавливает pricesChanged = true, повтор разрешён", () => {
  const { state, orderId } = completedOrder(1);
  const withNewPrice: PrototypeState = {
    ...state,
    menuItems: state.menuItems.map((m) =>
      m.id === "restaurant-2-item-1" ? { ...m, priceCents: 950 } : m,
    ),
  };
  const res = repeatOrderToCart(withNewPrice, orderId);
  assert.equal(res.result.ok, true);
  assert.equal(res.result.pricesChanged, true);
});

test("ресторан, который не принимает заказы, нельзя повторить", () => {
  const { state, orderId } = completedOrder(1);
  const closed: PrototypeState = {
    ...state,
    restaurants: state.restaurants.map((r) =>
      r.id === "restaurant-2" ? { ...r, isAcceptingOrders: false } : r,
    ),
  };
  const res = repeatOrderToCart(closed, orderId);
  assert.equal(res.result.ok, false);
  assert.match(res.result.error ?? "", /недоступен для повторного/);
});

test("прежний способ получения (PICKUP) сохраняется, если доступен", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart({
    ...s,
    cart: { ...s.cart, fulfillmentChoice: "PICKUP" },
  });
  const orderId = created.result.orderId as string;
  const completed = cancelOrderByClient(created.state, orderId, "тест").state;
  const res = repeatOrderToCart(completed, orderId);
  assert.equal(res.result.ok, true);
  assert.equal(res.state.cart.fulfillmentChoice, "PICKUP");
  assert.equal(res.result.fulfillmentChanged, false);
});

test("недоступный способ получения заменяется безопасным вариантом", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart({
    ...s,
    cart: { ...s.cart, fulfillmentChoice: "PICKUP" },
  });
  const orderId = created.result.orderId as string;
  const completed = cancelOrderByClient(created.state, orderId, "тест").state;
  // Ресторан 2 больше не поддерживает PICKUP — только доставка.
  const noPickup: PrototypeState = {
    ...completed,
    restaurants: completed.restaurants.map((r) =>
      r.id === "restaurant-2" ? { ...r, deliveryModes: ["PLATFORM_DRIVER"] } : r,
    ),
  };
  const res = repeatOrderToCart(noPickup, orderId);
  assert.equal(res.result.ok, true);
  assert.equal(res.state.cart.fulfillmentChoice, "DELIVERY");
  assert.equal(res.result.fulfillmentChanged, true);
});

test("оплата выводится по актуальному deliveryMode после повтора", () => {
  // Ресторан 3 — собственный курьер: доставка → CASH_TO_RESTAURANT_COURIER.
  let s = createDefaultState();
  s = updateCartAddress(s, ADDR);
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  const completed = cancelOrderByClient(created.state, orderId, "тест").state;
  const res = repeatOrderToCart(completed, orderId);
  assert.equal(res.result.ok, true);
  const newOrder = createOrderFromCart(res.state);
  const order = newOrder.state.orders.find(
    (o) => o.id === newOrder.result.orderId,
  );
  assert.equal(order?.paymentMethod, "CASH_TO_RESTAURANT_COURIER");
});

// --- §18: клиентская отмена -------------------------------------------------

test("клиент может отменить заказ в RESTAURANT_REVIEW", () => {
  const { state, orderId } = reviewDeliveryOrder(1);
  const res = cancelOrderByClient(state, orderId, "Заказал по ошибке");
  assert.equal(res.result.ok, true);
  const order = res.state.orders.find((o) => o.id === orderId);
  assert.equal(order?.status, "CANCELED");
});

test("причина отмены обязательна", () => {
  const { state, orderId } = reviewDeliveryOrder(1);
  const res = cancelOrderByClient(state, orderId, "   ");
  assert.equal(res.result.ok, false);
  assert.equal(res.state.orders.find((o) => o.id === orderId)?.status, "RESTAURANT_REVIEW");
});

test("клиентская отмена: actor CLIENT, причина и текст в истории", () => {
  const { state, orderId } = reviewDeliveryOrder(1);
  const res = cancelOrderByClient(state, orderId, "Хочу изменить заказ");
  const order = res.state.orders.find((o) => o.id === orderId);
  assert.equal(order?.cancellationReason, "Хочу изменить заказ");
  const last = order?.history.at(-1);
  assert.equal(last?.actor, "CLIENT");
  assert.ok(last?.message.includes("Клиент отменил заказ"));
  assert.ok(last?.message.includes("Хочу изменить заказ"));
});

test("клиентская отмена не создаёт settlement и не меняет snapshot", () => {
  const { state, orderId } = reviewDeliveryOrder(2);
  const before = state.orders.find((o) => o.id === orderId);
  const financialsBefore = JSON.stringify(before?.financials);
  const res = cancelOrderByClient(state, orderId, "Слишком долго ждать");
  const after = res.state.orders.find((o) => o.id === orderId);
  assert.equal(res.state.settlements.length, 0);
  assert.equal(JSON.stringify(after?.financials), financialsBefore);
});

test("после принятия рестораном клиентская отмена невозможна", () => {
  const { state, orderId } = reviewDeliveryOrder(1);
  const accepted = acceptRestaurantOrder(state, orderId, 20); // AWAITING_PAYMENT
  const res = cancelOrderByClient(accepted, orderId, "передумал");
  assert.equal(res.result.ok, false);
  assert.match(res.result.error ?? "", /Ресторан уже принял/);
  assert.equal(res.state.orders.find((o) => o.id === orderId)?.status, "AWAITING_PAYMENT");
});

test("PREPARING и READY нельзя отменить клиентским action", () => {
  const { state, orderId } = reviewDeliveryOrder(1);
  let s = acceptRestaurantOrder(state, orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, orderId); // PREPARING
  assert.equal(cancelOrderByClient(s, orderId, "x").result.ok, false);
  s = markOrderReady(s, orderId); // READY
  assert.equal(cancelOrderByClient(s, orderId, "x").result.ok, false);
});

test("завершённый заказ нельзя отменить повторно; второе событие не создаётся", () => {
  const { state, orderId } = reviewDeliveryOrder(1);
  const first = cancelOrderByClient(state, orderId, "ошибка");
  const historyLen = first.state.orders.find((o) => o.id === orderId)?.history
    .length;
  const second = cancelOrderByClient(first.state, orderId, "ещё раз");
  assert.equal(second.result.ok, false);
  const afterLen = second.state.orders.find((o) => o.id === orderId)?.history
    .length;
  assert.equal(afterLen, historyLen);
});

// --- Повтор разрешён только для завершённых статусов ------------------------

/** Самовывоз Ресторана 2, доведённый до PICKED_UP. */
function pickedUpOrder(): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart({
    ...s,
    cart: { ...s.cart, fulfillmentChoice: "PICKUP" },
  });
  let st = created.state;
  const orderId = created.result.orderId as string;
  st = acceptRestaurantOrder(st, orderId, 20); // PREPARING
  st = markOrderReady(st, orderId); // READY_FOR_PICKUP
  const code = st.orders.find((o) => o.id === orderId)?.pickupCode as string;
  st = completePickupWithCode(st, orderId, code).state; // PICKED_UP
  return { state: st, orderId };
}

/** Доставка Ресторана 3 (свой курьер), доведённая до DELIVERED. */
function deliveredOrder(): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = updateCartAddress(s, ADDR);
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  let st = created.state;
  const orderId = created.result.orderId as string;
  st = acceptRestaurantOrder(st, orderId, 20); // PREPARING
  st = markOrderReady(st, orderId); // READY
  st = markOrderOutForDelivery(st, orderId); // OUT_FOR_DELIVERY
  st = markOrderArriving(st, orderId); // ARRIVING
  st = markOrderDelivered(st, orderId); // DELIVERED
  return { state: st, orderId };
}

test("повтор разрешён: CANCELED", () => {
  const { state, orderId } = completedOrder(1);
  assert.equal(
    state.orders.find((o) => o.id === orderId)?.status,
    "CANCELED",
  );
  assert.equal(repeatOrderToCart(state, orderId).result.ok, true);
});

test("повтор разрешён: DELIVERED", () => {
  const { state, orderId } = deliveredOrder();
  assert.equal(
    state.orders.find((o) => o.id === orderId)?.status,
    "DELIVERED",
  );
  assert.equal(repeatOrderToCart(state, orderId).result.ok, true);
});

test("повтор разрешён: PICKED_UP", () => {
  const { state, orderId } = pickedUpOrder();
  assert.equal(
    state.orders.find((o) => o.id === orderId)?.status,
    "PICKED_UP",
  );
  assert.equal(repeatOrderToCart(state, orderId).result.ok, true);
});

test("повтор запрещён для активного RESTAURANT_REVIEW; корзина не меняется", () => {
  const { state, orderId } = reviewDeliveryOrder(2);
  const cartBefore = JSON.stringify(state.cart);
  const res = repeatOrderToCart(state, orderId);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Повторить можно только завершённый заказ.");
  assert.equal(JSON.stringify(res.state.cart), cartBefore);
});

test("повтор запрещён для активного PREPARING", () => {
  const { state, orderId } = reviewDeliveryOrder(1);
  let s = acceptRestaurantOrder(state, orderId, 20); // AWAITING_PAYMENT
  s = simulateSuccessfulOnlinePayment(s, orderId); // PREPARING
  const res = repeatOrderToCart(s, orderId);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Повторить можно только завершённый заказ.");
});
