import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeDirectFinancials,
  computeFreeUnitCount,
  computePickupSettlement,
  computePromotionDiscountCents,
  computeRestaurantDeliveryFinancials,
  computeRestaurantDeliveryQuote,
  computeVariantUnitPriceCents,
  generatePickupCode,
  migrateFulfillmentChoice,
  resolveDeliveryMode,
  shouldAutoConfirmAddress,
  type PromotionConfig,
  type RestaurantDeliverySettings,
} from "./pricing-engine.ts";

const PROMO: PromotionConfig = {
  buyQuantity: 3,
  freeQuantity: 1,
  repeat: true,
};

const R3_SETTINGS: RestaurantDeliverySettings = {
  minimumOrderCents: 1000,
  freeDeliveryThresholdCents: 2500,
  servedZoneIds: ["zone-1", "zone-2", "zone-3", "zone-4"],
  zoneFeesCents: {
    "zone-1": 300,
    "zone-2": 350,
    "zone-3": 400,
    "zone-4": 450,
  },
};

test("resolveDeliveryMode: клиент не выбирает исполнителя", () => {
  assert.equal(resolveDeliveryMode("DIRECT", "DELIVERY"), "PLATFORM_DRIVER");
  assert.equal(
    resolveDeliveryMode("RESTAURANT", "DELIVERY"),
    "RESTAURANT_DELIVERY",
  );
  assert.equal(resolveDeliveryMode("DIRECT", "PICKUP"), "PICKUP");
  assert.equal(resolveDeliveryMode("RESTAURANT", "PICKUP"), "PICKUP");
});

test("computeVariantUnitPriceCents: доплата за размер", () => {
  assert.equal(computeVariantUnitPriceCents(800, 0), 800); // Стандартная
  assert.equal(computeVariantUnitPriceCents(800, 200), 1000); // Большая +$2
});

test("акция 3+1: количество бесплатных единиц", () => {
  assert.equal(computeFreeUnitCount(1, PROMO), 0);
  assert.equal(computeFreeUnitCount(3, PROMO), 0);
  assert.equal(computeFreeUnitCount(4, PROMO), 1);
  assert.equal(computeFreeUnitCount(7, PROMO), 1);
  assert.equal(computeFreeUnitCount(8, PROMO), 2);
  assert.equal(computeFreeUnitCount(11, PROMO), 2);
  assert.equal(computeFreeUnitCount(12, PROMO), 3);
});

test("акция 3+1: 3 пиццы — скидки нет", () => {
  assert.equal(computePromotionDiscountCents([800, 800, 900], PROMO), 0);
});

test("акция 3+1: 4 пиццы — бесплатна самая дешёвая базовая", () => {
  // базовые цены: 900, 800, 1000, 850 → бесплатна 800
  assert.equal(
    computePromotionDiscountCents([900, 800, 1000, 850], PROMO),
    800,
  );
});

test("акция 3+1: 8 пицц — две самые дешёвые базовые бесплатно", () => {
  // базовые: 800×4, 1000×4 → две по 800 → 1600
  const units = [800, 800, 800, 800, 1000, 1000, 1000, 1000];
  assert.equal(computePromotionDiscountCents(units, PROMO), 1600);
});

test("акция 3+1: surcharge большого размера не участвует", () => {
  // Массив содержит только базовые цены ($8 = 800). Большой размер (+$2)
  // передаётся отдельно и не попадает в расчёт скидки, поэтому при 4 пиццах
  // скидка равна ровно одной базовой цене 800, а не 1000.
  const baseOnly = [800, 800, 800, 800];
  assert.equal(computePromotionDiscountCents(baseOnly, PROMO), 800);
});

test("Ресторан 3: зона не обслуживается", () => {
  const noZone = computeRestaurantDeliveryQuote(1500, R3_SETTINGS, null);
  assert.equal(noZone.status, "ZONE_NOT_SERVED");
});

test("Ресторан 3: порог минимального заказа $9.99 / $10", () => {
  const below = computeRestaurantDeliveryQuote(999, R3_SETTINGS, "zone-1");
  assert.equal(below.status, "BELOW_MINIMUM");
  assert.equal(
    below.status === "BELOW_MINIMUM" ? below.missingCents : -1,
    1,
  );

  const atMin = computeRestaurantDeliveryQuote(1000, R3_SETTINGS, "zone-1");
  assert.equal(atMin.status, "OK");
  assert.equal(atMin.status === "OK" ? atMin.deliveryFeeCents : -1, 300);
});

test("Ресторан 3: зональные тарифы", () => {
  const fee = (zone: "zone-1" | "zone-2" | "zone-3" | "zone-4") => {
    const q = computeRestaurantDeliveryQuote(1500, R3_SETTINGS, zone);
    return q.status === "OK" ? q.deliveryFeeCents : -1;
  };
  assert.equal(fee("zone-1"), 300);
  assert.equal(fee("zone-2"), 350);
  assert.equal(fee("zone-3"), 400);
  assert.equal(fee("zone-4"), 450);
});

test("Ресторан 3: бесплатная доставка $24.99 / $25", () => {
  const paid = computeRestaurantDeliveryQuote(2499, R3_SETTINGS, "zone-2");
  assert.equal(paid.status === "OK" ? paid.deliveryFeeCents : -1, 350);
  assert.equal(paid.status === "OK" ? paid.freeDelivery : true, false);

  const free = computeRestaurantDeliveryQuote(2500, R3_SETTINGS, "zone-2");
  assert.equal(free.status === "OK" ? free.deliveryFeeCents : -1, 0);
  assert.equal(free.status === "OK" ? free.freeDelivery : false, true);
});

test("DIRECT финансы: комиссия 15% и доплата за небольшой заказ", () => {
  // Еда $5.20 (520), комиссия 15% = 78, min gross 100 → small fee 22.
  const r = computeDirectFinancials({
    foodSubtotalCents: 520,
    commissionRateBps: 1500,
    minimumPlatformGrossRevenueCents: 100,
    deliveryFeeCents: 300,
    isPickup: false,
  });
  assert.equal(r.restaurantCommissionCents, 78);
  assert.equal(r.smallOrderFeeCents, 22);
  assert.equal(r.platformGrossRevenueCents, 100);
  assert.equal(r.driverPayoutCents, 300);
  assert.equal(r.deliveryFeeCents, 300);
  assert.equal(r.customerTotalCents, 520 + 300 + 22);
});

test("DIRECT финансы: PICKUP обнуляет доставку и выплату", () => {
  const r = computeDirectFinancials({
    foodSubtotalCents: 800,
    commissionRateBps: 1500,
    minimumPlatformGrossRevenueCents: 100,
    deliveryFeeCents: 300,
    isPickup: true,
  });
  assert.equal(r.deliveryFeeCents, 0);
  assert.equal(r.driverPayoutCents, 0);
});

test("RESTAURANT финансы: 7%, без small-order fee, payout с доставкой", () => {
  // Еда $15.00 (1500), комиссия 7% = 105, доставка 350.
  const r = computeRestaurantDeliveryFinancials({
    foodSubtotalCents: 1500,
    commissionRateBps: 700,
    deliveryFeeCents: 350,
    isPickup: false,
  });
  assert.equal(r.restaurantCommissionCents, 105);
  assert.equal(r.smallOrderFeeCents, 0);
  assert.equal(r.platformGrossRevenueCents, 105);
  assert.equal(r.driverPayoutCents, 0);
  assert.equal(r.deliveryFeeCents, 350);
  assert.equal(r.restaurantPayoutBeforeBankFeeCents, 1500 - 105 + 350);
  assert.equal(r.customerTotalCents, 1500 + 350);
});

test("RESTAURANT финансы: бесплатная доставка не даёт payout по доставке", () => {
  const r = computeRestaurantDeliveryFinancials({
    foodSubtotalCents: 2600,
    commissionRateBps: 700,
    deliveryFeeCents: 0,
    isPickup: false,
  });
  assert.equal(r.deliveryFeeCents, 0);
  assert.equal(r.restaurantPayoutBeforeBankFeeCents, 2600 - 182);
});

test("автоподтверждение адреса: только для валидной доставки", () => {
  // валидный адрес, доставка, не подтверждён → подтверждаем
  assert.equal(
    shouldAutoConfirmAddress({
      fulfillmentChoice: "DELIVERY",
      isAddressConfirmed: false,
      hasValidAddress: true,
    }),
    true,
  );
});

test("автоподтверждение адреса: невалидный адрес не подтверждается", () => {
  assert.equal(
    shouldAutoConfirmAddress({
      fulfillmentChoice: "DELIVERY",
      isAddressConfirmed: false,
      hasValidAddress: false,
    }),
    false,
  );
});

test("автоподтверждение адреса: PICKUP не требует подтверждения", () => {
  assert.equal(
    shouldAutoConfirmAddress({
      fulfillmentChoice: "PICKUP",
      isAddressConfirmed: false,
      hasValidAddress: true,
    }),
    false,
  );
  // уже подтверждён — повторно не трогаем
  assert.equal(
    shouldAutoConfirmAddress({
      fulfillmentChoice: "DELIVERY",
      isAddressConfirmed: true,
      hasValidAddress: true,
    }),
    false,
  );
});

test("самовывоз: клиент платит ресторану, Direct получает 15% комиссии", () => {
  // Еда $8.00, small-order fee 0 (еда выше порога).
  const s = computePickupSettlement({
    foodSubtotalCents: 800,
    commissionRateBps: 1500,
    smallOrderFeeCents: 0,
  });
  assert.equal(s.restaurantCommissionCents, 120); // 15% от 800
  assert.equal(s.customerTotalCents, 800);
  assert.equal(s.restaurantCollectedFromCustomerCents, 800); // ресторан собирает
  assert.equal(s.platformCollectedFromCustomerCents, 0); // Direct не удерживает
  assert.equal(s.platformCommissionReceivableCents, 120); // ресторан должен Direct
  assert.equal(s.restaurantNetAfterPlatformCommissionCents, 680);
});

test("самовывоз: скидка уменьшает базу комиссии", () => {
  // Еда после скидки $6.00 → комиссия 15% = 90.
  const s = computePickupSettlement({
    foodSubtotalCents: 600,
    commissionRateBps: 1500,
    smallOrderFeeCents: 0,
  });
  assert.equal(s.restaurantCommissionCents, 90);
});

test("самовывоз: small-order fee включается в задолженность", () => {
  // Еда $4.00, комиссия 15% = 60, min gross 100 → small fee 40.
  const s = computePickupSettlement({
    foodSubtotalCents: 400,
    commissionRateBps: 1500,
    smallOrderFeeCents: 40,
  });
  assert.equal(s.restaurantCommissionCents, 60);
  assert.equal(s.customerTotalCents, 440); // еда + small fee, без доставки
  assert.equal(s.platformCommissionReceivableCents, 100); // 60 + 40
  assert.equal(s.restaurantNetAfterPlatformCommissionCents, 340);
});

test("код выдачи самовывоза: детерминированный, 4 знака", () => {
  const a = generatePickupCode(1001);
  const b = generatePickupCode(1001);
  const c = generatePickupCode(1002);
  assert.equal(a, b);
  assert.equal(a.length, 4);
  assert.notEqual(a, c);
});

test("migrateFulfillmentChoice: v4 → v5", () => {
  assert.equal(migrateFulfillmentChoice("PICKUP"), "PICKUP");
  assert.equal(migrateFulfillmentChoice("PLATFORM_DRIVER"), "DELIVERY");
  assert.equal(migrateFulfillmentChoice(null), "DELIVERY");
  assert.equal(migrateFulfillmentChoice(undefined), "DELIVERY");
  assert.equal(migrateFulfillmentChoice("SOMETHING_ELSE"), "DELIVERY");
});
