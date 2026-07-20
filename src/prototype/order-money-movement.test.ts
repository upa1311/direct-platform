import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  computeOrderMoneyMovement,
  type OrderMoneyMovementInput,
} from "./order-money-movement.ts";

/**
 * Канонический расчёт движения денег по одному заказу: детерминированные
 * проверки четырёх утверждённых сценариев, инвариантов и fail-closed границ.
 */

function okMovement(input: OrderMoneyMovementInput) {
  const result = computeOrderMoneyMovement(input);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) throw new Error("unreachable");
  const m = result.movement;
  // Сквозные инварианты каждого успешного расчёта.
  assert.equal(
    m.restaurantBankFeeCents + m.directBankFeeCents,
    m.totalBankFeeCents,
  );
  assert.ok(!(m.restaurantOwesDirectCents > 0 && m.directOwesRestaurantCents > 0));
  for (const value of [
    m.totalBankFeeCents,
    m.restaurantBankFeeCents,
    m.directBankFeeCents,
    m.restaurantOwesDirectCents,
    m.directOwesRestaurantCents,
    m.restaurantNetCents,
    m.directNetRevenueCents,
  ]) {
    assert.ok(Number.isInteger(value) && value >= 0);
  }
  return m;
}

const pickupCard = (): OrderMoneyMovementInput => ({
  deliveryMode: "PICKUP",
  paymentChannel: "CARD_AT_RESTAURANT",
  foodSubtotalCents: 10_000,
  deliveryFeeCents: 0,
  smallOrderFeeCents: 0,
  customerTotalCents: 10_000,
  restaurantCommissionCents: 1_500,
});

const platformOnline = (): OrderMoneyMovementInput => ({
  deliveryMode: "PLATFORM_DRIVER",
  paymentChannel: "ONLINE_CARD",
  foodSubtotalCents: 10_000,
  deliveryFeeCents: 500,
  smallOrderFeeCents: 0,
  customerTotalCents: 10_500,
  restaurantCommissionCents: 1_500,
  driverPayoutCents: 500,
});

// 1 — самовывоз картой ---------------------------------------------------------

test("самовывоз картой: банк $1 ресторану, долг Direct $15, чисто $84", () => {
  const m = okMovement(pickupCard());
  assert.equal(m.customerMoneyRecipient, "RESTAURANT");
  assert.equal(m.totalBankFeeCents, 100);
  assert.equal(m.restaurantBankFeeCents, 100);
  assert.equal(m.directBankFeeCents, 0);
  assert.equal(m.restaurantOwesDirectCents, 1_500);
  assert.equal(m.directOwesRestaurantCents, 0);
  assert.equal(m.restaurantNetCents, 8_400);
  assert.equal(m.directNetRevenueCents, 1_500);
});

// 2 — самовывоз наличными ------------------------------------------------------

test("самовывоз наличными: банковская комиссия 0", () => {
  const m = okMovement({
    ...pickupCard(),
    paymentChannel: "CASH_AT_RESTAURANT",
  });
  assert.equal(m.totalBankFeeCents, 0);
  assert.equal(m.restaurantBankFeeCents, 0);
  assert.equal(m.restaurantOwesDirectCents, 1_500);
  assert.equal(m.restaurantNetCents, 8_500);
  assert.equal(m.directNetRevenueCents, 1_500);
});

// 3 — курьер ресторана наличными -----------------------------------------------

test("курьер ресторана наличными: 7%, доставка остаётся ресторану", () => {
  const m = okMovement({
    deliveryMode: "RESTAURANT_DELIVERY",
    paymentChannel: "CASH_TO_RESTAURANT_COURIER",
    foodSubtotalCents: 10_000,
    deliveryFeeCents: 350,
    smallOrderFeeCents: 0,
    customerTotalCents: 10_350,
    restaurantCommissionCents: 700,
  });
  assert.equal(m.customerMoneyRecipient, "RESTAURANT");
  assert.equal(m.totalBankFeeCents, 0);
  assert.equal(m.restaurantOwesDirectCents, 700);
  assert.equal(m.directOwesRestaurantCents, 0);
  // Стоимость собственной доставки внутри customerTotal остаётся ресторану.
  assert.equal(m.restaurantNetCents, 10_350 - 700);
  assert.equal(m.directNetRevenueCents, 700);
});

// 4 — доставка Direct онлайн ---------------------------------------------------

test("доставка Direct онлайн: $100 + $5 → Direct должен ресторану $84", () => {
  const m = okMovement(platformOnline());
  assert.equal(m.customerMoneyRecipient, "DIRECT");
  assert.equal(m.totalBankFeeCents, 105);
  assert.equal(m.restaurantBankFeeCents, 100);
  assert.equal(m.directBankFeeCents, 5);
  assert.equal(m.restaurantOwesDirectCents, 0);
  assert.equal(m.directOwesRestaurantCents, 8_400);
  assert.equal(m.restaurantNetCents, 8_400);
  assert.equal(m.directNetRevenueCents, 1_495);
});

// 5 — доставка Direct со small-order fee ---------------------------------------

test("доставка Direct со small-order fee: доплата в чистом доходе Direct", () => {
  const m = okMovement({
    deliveryMode: "PLATFORM_DRIVER",
    paymentChannel: "ONLINE_CARD",
    foodSubtotalCents: 800,
    deliveryFeeCents: 500,
    smallOrderFeeCents: 150,
    customerTotalCents: 1_450,
    restaurantCommissionCents: 120,
  });
  assert.equal(m.totalBankFeeCents, 15); // round(14.5)
  assert.equal(m.restaurantBankFeeCents, 8);
  assert.equal(m.directBankFeeCents, 7);
  assert.equal(m.directOwesRestaurantCents, 800 - 120 - 8);
  assert.equal(m.directNetRevenueCents, 120 + 150 - 7);
});

// 6 — доставка не является доходом Direct --------------------------------------

test("стоимость доставки не попадает в чистый доход Direct", () => {
  const base = okMovement(platformOnline());
  // Тот же заказ с двойной доставкой: чистый доход Direct не меняется.
  const doubled = okMovement({
    ...platformOnline(),
    deliveryFeeCents: 1_000,
    customerTotalCents: 11_000,
    driverPayoutCents: 1_000,
  });
  // Банковская часть Direct растёт вместе с транзакцией (110 - 100 = 10),
  // но сама доставка в доход не входит: доход меняется только на дельту банка.
  assert.equal(doubled.directNetRevenueCents, 1_500 - 10);
  assert.equal(base.directNetRevenueCents, 1_500 - 5);
  assert.ok(doubled.directNetRevenueCents < base.directNetRevenueCents);
});

// 7 — банковская математика только через allocateBankFee -----------------------

test("банковская математика получена через allocateBankFee, без дублей", () => {
  const source = readFileSync(
    new URL("./order-money-movement.ts", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("allocateBankFee("));
  // Собственного округления/ставки в модуле нет — формула 1% не дублируется.
  assert.ok(!source.includes("Math.round"));
  assert.ok(!source.includes("BANK_CARD_FEE_RATE_BPS"));
  assert.ok(!source.includes("0.01"));
});

// 8/14 — чистота функции -------------------------------------------------------

test("клиентская сумма и входные данные не изменяются", () => {
  const input = Object.freeze(platformOnline());
  const before = { ...input };
  const result = computeOrderMoneyMovement(input); // frozen: мутация бросила бы
  assert.equal(result.ok, true);
  assert.deepEqual({ ...input }, before);
  assert.equal(input.customerTotalCents, 10_500);
});

// 9 — целые неотрицательные центы (охвачено okMovement для всех сценариев) ------

test("все результаты — целые неотрицательные центы (нечётные суммы)", () => {
  const m = okMovement({
    deliveryMode: "PLATFORM_DRIVER",
    paymentChannel: "ONLINE_CARD",
    foodSubtotalCents: 9_999,
    deliveryFeeCents: 501,
    smallOrderFeeCents: 1,
    customerTotalCents: 10_501,
    restaurantCommissionCents: 1_499,
  });
  assert.equal(m.totalBankFeeCents, 105);
  assert.equal(m.restaurantBankFeeCents, 100);
  assert.equal(m.directOwesRestaurantCents, 9_999 - 1_499 - 100);
});

// 10 — неизвестные enum --------------------------------------------------------

test("неизвестные delivery mode и канал оплаты отклоняются", () => {
  const badMode = computeOrderMoneyMovement({
    ...pickupCard(),
    deliveryMode: "TELEPORT" as unknown as OrderMoneyMovementInput["deliveryMode"],
  });
  assert.equal(badMode.ok, false);
  const badChannel = computeOrderMoneyMovement({
    ...pickupCard(),
    paymentChannel: "BONUS" as unknown as OrderMoneyMovementInput["paymentChannel"],
  });
  assert.equal(badChannel.ok, false);
});

// 11 — онлайн для курьера ресторана --------------------------------------------

test("онлайн и карта для собственного курьера ресторана отклоняются", () => {
  for (const paymentChannel of ["ONLINE_CARD", "CARD_AT_RESTAURANT"] as const) {
    const result = computeOrderMoneyMovement({
      deliveryMode: "RESTAURANT_DELIVERY",
      paymentChannel,
      foodSubtotalCents: 10_000,
      deliveryFeeCents: 350,
      smallOrderFeeCents: 0,
      customerTotalCents: 10_350,
      restaurantCommissionCents: 700,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && /курьера ресторана/.test(result.error));
  }
});

// 12 — small-order fee вне доставки Direct -------------------------------------

test("small-order fee для PICKUP и RESTAURANT_DELIVERY отклоняется", () => {
  const pickup = computeOrderMoneyMovement({
    ...pickupCard(),
    smallOrderFeeCents: 150,
  });
  assert.equal(pickup.ok, false);
  const courier = computeOrderMoneyMovement({
    deliveryMode: "RESTAURANT_DELIVERY",
    paymentChannel: "CASH_TO_RESTAURANT_COURIER",
    foodSubtotalCents: 10_000,
    deliveryFeeCents: 350,
    smallOrderFeeCents: 150,
    customerTotalCents: 10_500,
    restaurantCommissionCents: 700,
  });
  assert.equal(courier.ok, false);
});

// 13 — повреждённые суммы -------------------------------------------------------

test("комиссия больше еды и повреждённые суммы отклоняются", () => {
  assert.equal(
    computeOrderMoneyMovement({
      ...pickupCard(),
      restaurantCommissionCents: 10_001,
    }).ok,
    false,
  );
  assert.equal(
    computeOrderMoneyMovement({ ...pickupCard(), foodSubtotalCents: -1 }).ok,
    false,
  );
  assert.equal(
    computeOrderMoneyMovement({ ...pickupCard(), customerTotalCents: 10.5 }).ok,
    false,
  );
  assert.equal(
    computeOrderMoneyMovement({
      ...pickupCard(),
      foodSubtotalCents: Number.NaN,
    }).ok,
    false,
  );
  // Суммы, не сходящиеся с суммой клиента, — повреждённые данные.
  assert.equal(
    computeOrderMoneyMovement({ ...pickupCard(), customerTotalCents: 10_001 }).ok,
    false,
  );
  // Невозможный отрицательный чистый результат: комиссия равна еде, а карта
  // ещё удерживает банковский 1% — net ресторана ушёл бы в минус.
  const negativeNet = computeOrderMoneyMovement({
    ...pickupCard(),
    restaurantCommissionCents: 10_000,
  });
  assert.equal(negativeNet.ok, false);
});

// 15 — денежное равенство примеров ---------------------------------------------

test("денежное равенство сходится до цента", () => {
  // Доставка Direct: транзакция клиента распределяется без остатка.
  const platform = okMovement(platformOnline());
  assert.equal(
    platform.directOwesRestaurantCents + // ресторану
      500 + // водителю (стоимость доставки)
      platform.directNetRevenueCents + // Direct
      platform.totalBankFeeCents, // банку
    10_500,
  );
  // Самовывоз картой: платёж на точке распределяется без остатка.
  const pickup = okMovement(pickupCard());
  assert.equal(
    pickup.restaurantNetCents +
      pickup.restaurantOwesDirectCents +
      pickup.totalBankFeeCents,
    10_000,
  );
});
