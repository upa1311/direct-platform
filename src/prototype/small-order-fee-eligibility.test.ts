import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import {
  calculateCartPricing,
  getCartDeliveryMode,
  getSmallOrderMissingAmountCents,
} from "./selectors.ts";
import {
  computeDirectFinancials,
  computePickupSettlement,
  computeRestaurantDeliveryFinancials,
  shouldApplySmallOrderFee,
} from "./pricing-engine.ts";
import type { FinancialSnapshot, PrototypeState } from "./models.ts";

/** Собирает корзину выбранного ресторана. restaurant-1 = DIRECT, restaurant-3 = RESTAURANT. */
function cart(
  restaurantId: string,
  fulfillment: "PICKUP" | "DELIVERY",
  itemId: string,
  units = 1,
): PrototypeState {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  }
  for (let i = 0; i < units; i += 1) {
    s = addCartItem(s, itemId).state;
  }
  return s;
}

const DIRECT_INPUT = {
  foodSubtotalCents: 400, // комиссия 15% = 60 < 100 → доплата применима
  commissionRateBps: 1500,
  minimumPlatformGrossRevenueCents: 100,
  deliveryFeeCents: 300,
} as const;

// 1 --------------------------------------------------------------------------

test("PLATFORM_DRIVER с маленькой суммой → smallOrderFee > 0", () => {
  const r = computeDirectFinancials({ ...DIRECT_INPUT, deliveryMode: "PLATFORM_DRIVER" });
  assert.equal(r.smallOrderFeeCents, 40); // 100 - 60
  assert.ok(r.smallOrderFeeCents > 0);
  assert.equal(r.customerTotalCents, 400 + 300 + 40);
});

// 2 --------------------------------------------------------------------------

test("PLATFORM_DRIVER при достаточной комиссии → smallOrderFee = 0", () => {
  const r = computeDirectFinancials({
    ...DIRECT_INPUT,
    foodSubtotalCents: 2000, // комиссия 300 > 100 → доплаты нет
    deliveryMode: "PLATFORM_DRIVER",
  });
  assert.equal(r.smallOrderFeeCents, 0);
});

// 3 --------------------------------------------------------------------------

test("PICKUP ресторана DIRECT с маленькой суммой → без доплаты", () => {
  const r = computeDirectFinancials({ ...DIRECT_INPUT, deliveryMode: "PICKUP" });
  assert.equal(r.smallOrderFeeCents, 0);
  assert.equal(r.customerTotalCents, 400, "итог = только еда");
  assert.equal(r.platformGrossRevenueCents, r.restaurantCommissionCents, "gross = комиссия");
});

// 4 --------------------------------------------------------------------------

test("PICKUP ресторана RESTAURANT → те же результаты без доплаты", () => {
  const r = computeRestaurantDeliveryFinancials({
    foodSubtotalCents: 400,
    commissionRateBps: 700,
    deliveryFeeCents: 0,
    isPickup: true,
  });
  assert.equal(r.smallOrderFeeCents, 0);
  assert.equal(r.customerTotalCents, 400);
  assert.equal(r.platformGrossRevenueCents, r.restaurantCommissionCents);
});

// 5 --------------------------------------------------------------------------

test("computePickupSettlement не начисляет small-order fee (задолженность = только комиссия)", () => {
  const s = computePickupSettlement({ foodSubtotalCents: 400, commissionRateBps: 1500 });
  assert.equal(s.customerTotalCents, 400);
  assert.equal(s.platformCommissionReceivableCents, s.restaurantCommissionCents);
  assert.equal(s.platformCommissionReceivableCents, 60);
});

// 6 --------------------------------------------------------------------------

test("RESTAURANT_DELIVERY → smallOrderFee = 0 и eligibility=false", () => {
  const r = computeRestaurantDeliveryFinancials({
    foodSubtotalCents: 400,
    commissionRateBps: 700,
    deliveryFeeCents: 350,
    isPickup: false,
  });
  assert.equal(r.smallOrderFeeCents, 0);
  assert.equal(shouldApplySmallOrderFee("RESTAURANT_DELIVERY"), false);
  assert.equal(shouldApplySmallOrderFee("PICKUP"), false);
  assert.equal(shouldApplySmallOrderFee("PLATFORM_DRIVER"), true);
  assert.equal(shouldApplySmallOrderFee(null), false);
});

// 7 --------------------------------------------------------------------------

test("getSmallOrderMissingAmountCents: положителен только для PLATFORM_DRIVER", () => {
  // restaurant-1 DIRECT, малая еда (520 < порога 667), доставка → PLATFORM_DRIVER.
  const driver = cart("restaurant-1", "DELIVERY", "restaurant-1-item-1");
  assert.equal(getCartDeliveryMode(driver), "PLATFORM_DRIVER");
  assert.ok(getSmallOrderMissingAmountCents(driver) > 0);

  // Тот же ресторан, самовывоз → PICKUP → 0.
  const pickup = cart("restaurant-1", "PICKUP", "restaurant-1-item-1");
  assert.equal(getCartDeliveryMode(pickup), "PICKUP");
  assert.equal(getSmallOrderMissingAmountCents(pickup), 0);

  // restaurant-3 RESTAURANT, доставка → RESTAURANT_DELIVERY → 0.
  const restDelivery = cart("restaurant-3", "DELIVERY", "restaurant-3-item-1");
  assert.equal(getCartDeliveryMode(restDelivery), "RESTAURANT_DELIVERY");
  assert.equal(getSmallOrderMissingAmountCents(restDelivery), 0);
});

// 8 --------------------------------------------------------------------------

test("createOrderFromCart PICKUP: снимок без доплаты, итог = еда, задолженность = комиссия", () => {
  const s = cart("restaurant-1", "PICKUP", "restaurant-1-item-1");
  const pricing = calculateCartPricing(s);
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null, created.result.error ?? "");
  const order = created.state.orders.find((o) => o.id === created.result.orderId)!;
  const f = order.financials;
  assert.equal(f.smallOrderFeeCents, 0, "PICKUP snapshot без доплаты");
  assert.equal(f.customerTotalCents, pricing.foodSubtotalCents, "итог = только еда");
  assert.equal(
    f.platformCommissionReceivableCents,
    f.restaurantCommissionCents,
    "задолженность Direct = только комиссия",
  );
  // v13: самовывоз до фактической оплаты ещё не собран ни одной стороной.
  assert.equal(f.restaurantCollectedFromCustomerCents, 0);
  assert.equal(f.platformCollectedFromCustomerCents, 0);
});

// 9 --------------------------------------------------------------------------

test("createOrderFromCart PLATFORM_DRIVER: существующая доплата и итог сохранены", () => {
  const s = cart("restaurant-1", "DELIVERY", "restaurant-1-item-1");
  const pricing = calculateCartPricing(s);
  assert.ok(pricing.smallOrderFeeCents > 0, "малый заказ → доплата активна");
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null, created.result.error ?? "");
  const order = created.state.orders.find((o) => o.id === created.result.orderId)!;
  const f = order.financials;
  assert.equal(f.smallOrderFeeCents, pricing.smallOrderFeeCents, "доплата снимка = pricing");
  assert.equal(f.customerTotalCents, pricing.customerTotalCents, "итог снимка = pricing");
  assert.ok(
    f.customerTotalCents >= pricing.foodSubtotalCents + f.smallOrderFeeCents,
    "итог включает доплату",
  );
});

// 10 -------------------------------------------------------------------------

test("исторический снимок не пересчитывается при изменении меню/настроек", () => {
  const s = cart("restaurant-1", "PICKUP", "restaurant-1-item-1");
  const created = createOrderFromCart(s);
  const order = created.state.orders.find((o) => o.id === created.result.orderId)!;
  const before: FinancialSnapshot = structuredClone(order.financials);

  const mutated: PrototypeState = {
    ...created.state,
    menuItems: created.state.menuItems.map((m) => ({ ...m, priceCents: 999_99 })),
    platformSettings: {
      ...created.state.platformSettings,
      minimumPlatformGrossRevenueCents: 999_99,
    },
  };
  const same = mutated.orders.find((o) => o.id === order.id)!;
  assert.deepEqual(same.financials, before, "снимок неизменяем");
  assert.equal(same.financials.smallOrderFeeCents, 0);
});
