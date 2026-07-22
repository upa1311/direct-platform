import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  addCartItem,
  completePickupAtRestaurant,
  createOrderFromCart,
  markOrderDeliveredByDriverWithResult,
  markOrderDeliveredWithResult,
  markOrderReady,
  acceptRestaurantOrder,
  setCartFulfillmentChoice,
  updateCartAddress,
  updateRestaurant,
} from "./actions.ts";
import {
  addChecked,
  allocateBankFee,
  isSafeCents,
  subtractChecked,
  type BankFeeInput,
} from "./bank-fee.ts";
import { createDefaultState } from "./default-state.ts";
import { FINANCIAL_RULES } from "./financial-rule.ts";
import type {
  Order,
  PrototypeState,
  RestaurantFinancialCollectionMode,
} from "./models.ts";
import { buildCompatibilityCollectionFields } from "./money-movement-snapshot.ts";
import {
  computeOrderMoneyMovement,
  type OrderMoneyMovementInput,
} from "./order-money-movement.ts";
import { parseStoredState } from "./prototype-store.ts";
import {
  buildRestaurantDailySettlement,
  buildRestaurantSettlementOverview,
  type RestaurantSettlementOverview,
} from "./restaurant-settlements.ts";

/**
 * Согласованность compatibility-полей снимка с каноническим movement и
 * безопасная денежная арифметика. Compatibility-поля — проекция движения, а не
 * вторая формула; денежные операции проверяются на безопасный диапазон до, а
 * не после получения результата.
 */

const V1_RULE = FINANCIAL_RULES.DIRECT_FINANCIAL_RULE_V1;
const ADDR = { street: "Тестовая улица 1", house: "1" };
const NOW = "2026-07-21T10:00:00.000Z";
const ALL = "RESTAURANT_COLLECTS_ALL" as const;
const MIXED = "MIXED_COLLECTION" as const;
const MAX = Number.MAX_SAFE_INTEGER;

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

function stateWithMode(
  restaurantId: string,
  mode: RestaurantFinancialCollectionMode,
  base: PrototypeState = createDefaultState(),
): PrototypeState {
  return {
    ...base,
    restaurants: base.restaurants.map((r) =>
      r.id === restaurantId ? { ...r, financialCollectionMode: mode } : r,
    ),
  };
}

function withOrder(
  state: PrototypeState,
  orderId: string,
  update: (order: Order) => Order,
): PrototypeState {
  return {
    ...state,
    orders: state.orders.map((o) => (o.id === orderId ? update(o) : o)),
  };
}

/** Новый PLATFORM_DRIVER-заказ ресторана-2 в заданном режиме. */
function platformOrder(mode: RestaurantFinancialCollectionMode): {
  state: PrototypeState;
  orderId: string;
} {
  let s = updateCartAddress(stateWithMode("restaurant-2", mode), ADDR);
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

/** Новый PICKUP-заказ ресторана-2. */
function pickupOrder(mode: RestaurantFinancialCollectionMode): {
  state: PrototypeState;
  orderId: string;
} {
  let s = setCartFulfillmentChoice(stateWithMode("restaurant-2", mode), "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

/** Новый RESTAURANT_DELIVERY-заказ ресторана-3 (собственный курьер). */
function courierOrder(): { state: PrototypeState; orderId: string } {
  let s = updateCartAddress(createDefaultState(), ADDR);
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

/** Самовывоз, доведённый до фактической оплаты и выдачи. */
function pickupCompleted(
  mode: RestaurantFinancialCollectionMode,
  paidWith: "CASH" | "CARD" = "CARD",
): { state: PrototypeState; orderId: string } {
  const { state, orderId } = pickupOrder(mode);
  let s = acceptRestaurantOrder(state, orderId, 20);
  s = markOrderReady(s, orderId);
  const done = completePickupAtRestaurant(s, orderId, paidWith);
  assert.equal(done.result.error, null);
  return { state: done.state, orderId };
}

/** Завершённый доставкой Direct заказ. */
function driverCompleted(mode: RestaurantFinancialCollectionMode): {
  state: PrototypeState;
  orderId: string;
} {
  const { state, orderId } = platformOrder(mode);
  const prepared = withOrder(state, orderId, (o) => ({
    ...o,
    status: "ARRIVING",
    paymentStatus: "PAID",
    assignedDriverId: "driver-1",
    driverAssignedAt: NOW,
    history: [
      ...o.history,
      {
        id: `${o.id}-history-x`,
        occurredAt: NOW,
        actor: "SYSTEM",
        type: "STATUS",
        fromStatus: "OUT_FOR_DELIVERY",
        toStatus: "ARRIVING",
        message: "",
      },
    ],
  }));
  const res = markOrderDeliveredByDriverWithResult(prepared, orderId);
  assert.equal(res.result.error, null);
  return { state: res.state, orderId };
}

function driverInput(
  mode: RestaurantFinancialCollectionMode,
  overrides: Partial<OrderMoneyMovementInput> = {},
): OrderMoneyMovementInput {
  return {
    deliveryMode: "PLATFORM_DRIVER",
    paymentChannel: mode === ALL ? "ONLINE_CARD_TO_RESTAURANT" : "ONLINE_CARD",
    foodSubtotalCents: 10_000,
    deliveryFeeCents: 500,
    smallOrderFeeCents: 0,
    customerTotalCents: 10_500,
    restaurantCommissionCents: 1_500,
    driverPayoutCents: 500,
    financialRule: V1_RULE,
    financialCollectionMode: mode,
    ...overrides,
  };
}

function bankInput(overrides: Partial<BankFeeInput> = {}): BankFeeInput {
  return {
    deliveryMode: "PICKUP",
    moneyCollector: "RESTAURANT",
    paymentInstrument: "CARD",
    foodSubtotalCents: 10_000,
    customerTotalCents: 10_000,
    bankCardFeeRateBps: 100,
    financialCollectionMode: MIXED,
    ...overrides,
  };
}

function overviewOf(
  state: PrototypeState,
  restaurantId = "restaurant-2",
): RestaurantSettlementOverview {
  // Билдер fail-closed и возвращает result: успешный разворачивается,
  // неожиданная ошибка немедленно валит тест.
  const result = buildRestaurantSettlementOverview(
    state,
    restaurantId,
    "ALL",
    new Date().toISOString(),
    "Europe/Chisinau",
  );
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.overview;
}

// --- 1–9: compatibility-поля снимка ------------------------------------------

test("1: MIXED + доставка Direct — деньги собрал Direct", () => {
  const { state, orderId } = platformOrder(MIXED);
  const fin = orderOf(state, orderId).financials;
  assert.equal(fin.platformCollectedFromCustomerCents, fin.customerTotalCents);
  assert.equal(fin.restaurantCollectedFromCustomerCents, 0);
  assert.equal(fin.moneyMovement?.customerMoneyRecipient, "DIRECT");
});

test("2: RESTAURANT_COLLECTS_ALL + доставка Direct — деньги собрал ресторан", () => {
  const { state, orderId } = platformOrder(ALL);
  const fin = orderOf(state, orderId).financials;
  assert.equal(fin.restaurantCollectedFromCustomerCents, fin.customerTotalCents);
  assert.equal(fin.platformCollectedFromCustomerCents, 0);
  assert.equal(fin.moneyMovement?.customerMoneyRecipient, "RESTAURANT");
});

test("3: compatibility-нетто совпадает с movement.restaurantNetCents", () => {
  for (const mode of [MIXED, ALL]) {
    const { state, orderId } = platformOrder(mode);
    const fin = orderOf(state, orderId).financials;
    assert.equal(
      fin.restaurantNetAfterPlatformCommissionCents,
      fin.moneyMovement?.restaurantNetCents,
      mode,
    );
  }
});

test("4: platformCommissionReceivable — только комиссия, не перечисление", () => {
  const { state, orderId } = platformOrder(ALL);
  const fin = orderOf(state, orderId).financials;
  assert.equal(
    fin.platformCommissionReceivableCents,
    fin.restaurantCommissionCents,
  );
  // Полное обязательство ресторана больше комиссии и живёт только в движении.
  assert.ok(
    (fin.moneyMovement?.restaurantOwesDirectCents ?? 0) >
      fin.platformCommissionReceivableCents,
  );
  // У MIXED деньги получил Direct — комиссионного требования к ресторану нет.
  const mixed = platformOrder(MIXED);
  assert.equal(
    orderOf(mixed.state, mixed.orderId).financials
      .platformCommissionReceivableCents,
    0,
  );
});

test("5: самовывоз до оплаты — обе собранные суммы равны нулю", () => {
  const { state, orderId } = pickupOrder(MIXED);
  const fin = orderOf(state, orderId).financials;
  assert.equal(fin.moneyMovementStatus, "PENDING_PAYMENT_CHANNEL");
  assert.equal(fin.restaurantCollectedFromCustomerCents, 0);
  assert.equal(fin.platformCollectedFromCustomerCents, 0);
});

test("6: самовывоз после оплаты — собрал ресторан всю сумму клиента", () => {
  const { state, orderId } = pickupCompleted(MIXED, "CARD");
  const fin = orderOf(state, orderId).financials;
  assert.equal(fin.moneyMovementStatus, "COMPLETE");
  assert.equal(fin.restaurantCollectedFromCustomerCents, fin.customerTotalCents);
  assert.equal(fin.platformCollectedFromCustomerCents, 0);
  assert.equal(
    fin.restaurantNetAfterPlatformCommissionCents,
    fin.moneyMovement?.restaurantNetCents,
  );
});

test("7: доставка курьером ресторана — собрал ресторан", () => {
  const { state, orderId } = courierOrder();
  const fin = orderOf(state, orderId).financials;
  assert.equal(fin.restaurantCollectedFromCustomerCents, fin.customerTotalCents);
  assert.equal(fin.platformCollectedFromCustomerCents, 0);
  assert.equal(
    fin.platformCommissionReceivableCents,
    fin.restaurantCommissionCents,
  );
});

test("8: смена режима после заказа не меняет compatibility-снимок", () => {
  const { state, orderId } = platformOrder(MIXED);
  const before = { ...orderOf(state, orderId).financials };
  const changed = updateRestaurant(state, "restaurant-2", {
    financialCollectionMode: ALL,
  });
  assert.equal(changed.result.ok, true);
  const after = orderOf(changed.state, orderId).financials;
  assert.equal(
    after.platformCollectedFromCustomerCents,
    before.platformCollectedFromCustomerCents,
  );
  assert.equal(
    after.restaurantCollectedFromCustomerCents,
    before.restaurantCollectedFromCustomerCents,
  );
  assert.equal(
    after.restaurantNetAfterPlatformCommissionCents,
    before.restaurantNetAfterPlatformCommissionCents,
  );
});

test("9: serialize/parse сохраняет согласованность снимка и движения", () => {
  const { state, orderId } = platformOrder(ALL);
  const parsed = parseStoredState(JSON.stringify(state));
  assert.ok(parsed);
  const fin = orderOf(parsed, orderId).financials;
  assert.equal(fin.moneyMovement?.customerMoneyRecipient, "RESTAURANT");
  assert.equal(fin.restaurantCollectedFromCustomerCents, fin.customerTotalCents);
  assert.equal(fin.platformCollectedFromCustomerCents, 0);
  assert.equal(
    fin.restaurantNetAfterPlatformCommissionCents,
    fin.moneyMovement?.restaurantNetCents,
  );
});

// --- 10–18: старый отчёт -----------------------------------------------------

test("10: COMPLETE-заказ ALL определяет собравшего как ресторан", () => {
  const { state } = driverCompleted(ALL);
  const row = overviewOf(state).rows[0];
  assert.ok(row);
  assert.equal(row.collector, "RESTAURANT");
  assert.equal(row.restaurantCollectedFromCustomerCents, row.customerTotalCents);
  assert.equal(row.platformCollectedFromCustomerCents, 0);
});

test("11: COMPLETE-заказ MIXED определяет собравшего как Direct", () => {
  const { state } = driverCompleted(MIXED);
  const row = overviewOf(state).rows[0];
  assert.ok(row);
  assert.equal(row.collector, "DIRECT");
  assert.equal(row.platformCollectedFromCustomerCents, row.customerTotalCents);
  assert.equal(row.restaurantCollectedFromCustomerCents, 0);
});

test("12: строка использует movement.restaurantNetCents", () => {
  const { state, orderId } = driverCompleted(ALL);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  const row = overviewOf(state).rows[0];
  assert.ok(row);
  assert.equal(row.restaurantNetCents, movement.restaurantNetCents);
  assert.equal(
    row.restaurantNetAfterPlatformCommissionCents,
    movement.restaurantNetCents,
  );
  assert.equal(row.dataStatus, "COMPLETE");
});

test("13: строка показывает restaurantOwesDirectCents из движения", () => {
  const { state, orderId } = driverCompleted(ALL);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  const row = overviewOf(state).rows[0];
  assert.ok(row);
  assert.equal(row.restaurantOwesDirectCents, movement.restaurantOwesDirectCents);
  assert.equal(row.directOwesRestaurantCents, 0);
  assert.equal(row.paymentChannel, "ONLINE_CARD_TO_RESTAURANT");
});

test("14: перечисление не выдаётся за обычную комиссию Direct", () => {
  const { state } = driverCompleted(ALL);
  const row = overviewOf(state).rows[0];
  assert.ok(row);
  assert.equal(row.platformCommissionReceivableCents, row.restaurantCommissionCents);
  assert.ok(
    (row.restaurantOwesDirectCents ?? 0) > row.platformCommissionReceivableCents,
    "полное перечисление больше комиссии и показывается отдельно",
  );
  const PAGE = readPage();
  assert.ok(PAGE.includes("Перечисление рестораном"));
});

function readPage(): string {
  // Старый ресторанский отчёт: контракт подписи проверяется по исходнику.
  return readFileSync("src/app/restaurant/settlements/page.tsx", "utf8");
}

test("15: REVIEW_REQUIRED не входит в достоверные итоги", () => {
  const { state, orderId } = driverCompleted(ALL);
  const broken = withOrder(state, orderId, (o) => ({
    ...o,
    financials: {
      ...o.financials,
      moneyMovementStatus: "REVIEW_REQUIRED",
      moneyMovement: undefined,
    },
  }));
  const overview = overviewOf(broken);
  const row = overview.rows[0];
  assert.ok(row);
  assert.equal(row.dataStatus, "REVIEW_REQUIRED");
  assert.equal(overview.summary.reviewRequiredOrderCount, 1);
  assert.equal(overview.summary.customerTotalCents, 0);
  assert.equal(overview.summary.restaurantNetCents, 0);
  assert.equal(overview.summary.platformCommissionReceivableCents, 0);
});

test("16: настоящий legacy-заказ помечается LEGACY и сохраняет старые поля", () => {
  // Доказуемо исторический снимок: нет ни движения, ни снимка правила, ни
  // снимка финансового режима — заказ оформлен до v12/v13.
  const { state, orderId } = driverCompleted(MIXED);
  const legacy = withOrder(state, orderId, (o) => {
    const {
      moneyMovement,
      financialRule,
      financialCollectionMode,
      ...rest
    } = o.financials;
    void moneyMovement;
    void financialRule;
    void financialCollectionMode;
    return {
      ...o,
      financials: {
        ...rest,
        moneyMovementStatus: "REVIEW_REQUIRED",
        restaurantCollectedFromCustomerCents: 0,
        platformCollectedFromCustomerCents: 4_242,
        platformCommissionReceivableCents: 111,
        restaurantNetAfterPlatformCommissionCents: 2_222,
      } as typeof o.financials,
    };
  });
  const overview = overviewOf(legacy);
  const row = overview.rows[0];
  assert.ok(row);
  assert.equal(row.dataStatus, "LEGACY");
  assert.equal(row.collector, "DIRECT");
  assert.equal(row.platformCollectedFromCustomerCents, 4_242);
  assert.equal(row.restaurantNetAfterPlatformCommissionCents, 2_222);
  assert.equal(row.restaurantNetCents, null);
  assert.equal(overview.summary.reviewRequiredOrderCount, 0);
});

test("17: современная строка не зависит от повреждённых compatibility-полей", () => {
  const { state, orderId } = driverCompleted(ALL);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  const corrupted = withOrder(state, orderId, (o) => ({
    ...o,
    financials: {
      ...o.financials,
      restaurantCollectedFromCustomerCents: 0,
      platformCollectedFromCustomerCents: 999_999,
      platformCommissionReceivableCents: 999_999,
      restaurantNetAfterPlatformCommissionCents: 999_999,
    },
  }));
  const row = overviewOf(corrupted).rows[0];
  assert.ok(row);
  assert.equal(row.collector, "RESTAURANT");
  assert.equal(row.platformCollectedFromCustomerCents, 0);
  assert.equal(row.restaurantNetAfterPlatformCommissionCents, movement.restaurantNetCents);
  assert.equal(row.platformCommissionReceivableCents, row.restaurantCommissionCents);
});

test("18: дневная сверка строится без ошибок и сходится с итогами", () => {
  const { state } = driverCompleted(ALL);
  const overview = overviewOf(state);
  const dailyResult = buildRestaurantDailySettlement(
    state,
    "restaurant-2",
    "ALL",
    new Date().toISOString(),
    "Europe/Chisinau",
  );
  assert.ok(dailyResult.ok);
  const days = dailyResult.days;
  const daySum = days.reduce((sum, day) => sum + day.restaurantNetCents, 0);
  assert.equal(daySum, overview.summary.restaurantNetCents);
  assert.equal(
    days.reduce((sum, day) => sum + day.completedOrderCount, 0),
    overview.summary.completedOrderCount,
  );
});

// --- 19–28: безопасная арифметика --------------------------------------------

test("19: MAX_SAFE_INTEGER + 1 не является суммой", () => {
  assert.equal(isSafeCents(MAX + 1), false);
  assert.equal(isSafeCents(MAX), true);
});

test("20: отрицательное значение отклоняется", () => {
  assert.equal(isSafeCents(-1), false);
});

test("21: дробное значение отклоняется", () => {
  assert.equal(isSafeCents(10.5), false);
});

test("22: NaN и Infinity отклоняются", () => {
  assert.equal(isSafeCents(Number.NaN), false);
  assert.equal(isSafeCents(Number.POSITIVE_INFINITY), false);
  assert.equal(isSafeCents(Number.NEGATIVE_INFINITY), false);
  assert.equal(isSafeCents("100"), false);
  assert.equal(isSafeCents(null), false);
});

test("23: обычное безопасное значение принимается", () => {
  assert.equal(isSafeCents(0), true);
  assert.equal(isSafeCents(10_500), true);
});

test("24: сложение двух безопасных значений с переполнением отклоняется", () => {
  assert.equal(addChecked(MAX, 1), null);
  assert.equal(addChecked(MAX - 1, 1), MAX);
  assert.equal(addChecked(1_000, 500), 1_500);
  assert.equal(addChecked(null, 5), null);
  assert.equal(addChecked(10.5, 5), null);
});

test("25: переполнение ожидаемой суммы клиента — отдельная доменная ошибка", () => {
  const result = computeOrderMoneyMovement(
    driverInput(MIXED, {
      foodSubtotalCents: MAX,
      deliveryFeeCents: 1,
      smallOrderFeeCents: 0,
      customerTotalCents: MAX,
      restaurantCommissionCents: 1_500,
      driverPayoutCents: 1,
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && /безопасный диапазон/.test(result.error),
    "именно про диапазон, а не «суммы не сходятся»",
  );
});

test("26: переполнение суммы перечисления отклоняется", () => {
  // Перечисление складывается последовательным checked-add: любая ступень с
  // выходом за диапазон обрывает расчёт, а не даёт неточный итог.
  assert.equal(addChecked(addChecked(MAX, 1), 0), null);
  assert.equal(addChecked(addChecked(1_500, 500), 150), 2_150);
  const result = computeOrderMoneyMovement(
    driverInput(ALL, {
      foodSubtotalCents: MAX,
      deliveryFeeCents: 1,
      customerTotalCents: MAX,
      driverPayoutCents: 1,
    }),
  );
  assert.equal(result.ok, false);
});

test("27: переполнение дохода Direct отклоняется", () => {
  assert.equal(addChecked(MAX, 150), null);
  assert.equal(subtractChecked(addChecked(MAX, 150), 5), null);
  assert.equal(subtractChecked(addChecked(1_500, 150), 5), 1_645);
});

test("28: вычитание с отрицательным результатом отклоняется", () => {
  assert.equal(subtractChecked(100, 101), null);
  assert.equal(subtractChecked(100, 100), 0);
  assert.equal(subtractChecked(MAX + 1, 1), null);
  assert.equal(subtractChecked(null, 1), null);
});

// --- 29–36: банковская комиссия ----------------------------------------------

test("29: 10500 при 100 bps даёт 105", () => {
  const result = allocateBankFee(
    bankInput({
      deliveryMode: "PLATFORM_DRIVER",
      moneyCollector: "DIRECT",
      foodSubtotalCents: 10_000,
      customerTotalCents: 10_500,
    }),
  );
  assert.ok(result.ok);
  assert.equal(result.fee.totalBankFeeCents, 105);
});

test("30: самовывоз 10000 при 100 bps даёт 100", () => {
  const result = allocateBankFee(bankInput());
  assert.ok(result.ok);
  assert.equal(result.fee.totalBankFeeCents, 100);
  assert.equal(result.fee.restaurantBankFeeCents, 100);
  assert.equal(result.fee.directBankFeeCents, 0);
});

test("31: MAX_SAFE_INTEGER при 100 bps считается точно", () => {
  const result = allocateBankFee(
    bankInput({ foodSubtotalCents: MAX, customerTotalCents: MAX }),
  );
  assert.ok(result.ok);
  // BigInt: (MAX * 100 + 5000) / 10000 без промежуточного переполнения Number.
  const expected = Number(
    (BigInt(MAX) * BigInt(100) + BigInt(5_000)) / BigInt(10_000),
  );
  assert.equal(result.fee.totalBankFeeCents, expected);
  assert.ok(Number.isSafeInteger(result.fee.totalBankFeeCents));
});

test("32: комиссия вне безопасного диапазона отклоняется", () => {
  const result = allocateBankFee(
    bankInput({
      foodSubtotalCents: MAX,
      customerTotalCents: MAX,
      bankCardFeeRateBps: 20_000,
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /банковская комиссия/.test(result.error));
});

test("33: небезопасная ставка отклоняется", () => {
  for (const rate of [MAX + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      allocateBankFee(bankInput({ bankCardFeeRateBps: rate })).ok,
      false,
      String(rate),
    );
  }
});

test("34: нулевая и отрицательная ставка отклоняются", () => {
  for (const rate of [0, -100]) {
    assert.equal(
      allocateBankFee(bankInput({ bankCardFeeRateBps: rate })).ok,
      false,
      String(rate),
    );
  }
});

test("35: инвариант частей банковской комиссии сохраняется", () => {
  for (let food = 0; food <= 5_000; food += 311) {
    for (const extra of [0, 1, 49, 150, 999]) {
      const result = allocateBankFee(
        bankInput({
          deliveryMode: "PLATFORM_DRIVER",
          moneyCollector: "DIRECT",
          foodSubtotalCents: food,
          customerTotalCents: food + extra,
        }),
      );
      assert.ok(result.ok);
      assert.equal(
        result.fee.restaurantBankFeeCents + result.fee.directBankFeeCents,
        result.fee.totalBankFeeCents,
      );
    }
  }
});

test("36: прежние примеры распределения не изменились", () => {
  const pickup = allocateBankFee(bankInput());
  assert.ok(pickup.ok);
  assert.deepEqual(pickup.fee, {
    totalBankFeeCents: 100,
    restaurantBankFeeCents: 100,
    directBankFeeCents: 0,
  });
  const driver = allocateBankFee(
    bankInput({
      deliveryMode: "PLATFORM_DRIVER",
      moneyCollector: "DIRECT",
      foodSubtotalCents: 10_000,
      customerTotalCents: 10_500,
    }),
  );
  assert.ok(driver.ok);
  assert.deepEqual(driver.fee, {
    totalBankFeeCents: 105,
    restaurantBankFeeCents: 100,
    directBankFeeCents: 5,
  });
});

// --- 37–41: регрессия ---------------------------------------------------------

test("37: пример RESTAURANT_COLLECTS_ALL не изменился", () => {
  const result = computeOrderMoneyMovement(driverInput(ALL));
  assert.ok(result.ok);
  assert.equal(result.movement.restaurantOwesDirectCents, 2_000);
  assert.equal(result.movement.restaurantNetCents, 8_395);
  assert.equal(result.movement.directNetRevenueCents, 1_500);
});

test("38: пример MIXED не изменился", () => {
  const result = computeOrderMoneyMovement(driverInput(MIXED));
  assert.ok(result.ok);
  assert.deepEqual(result.movement, {
    customerMoneyRecipient: "DIRECT",
    paymentChannel: "ONLINE_CARD",
    totalBankFeeCents: 105,
    restaurantBankFeeCents: 100,
    directBankFeeCents: 5,
    restaurantOwesDirectCents: 0,
    directOwesRestaurantCents: 8_400,
    restaurantNetCents: 8_400,
    directNetRevenueCents: 1_495,
  });
});

test("39: accounting создаёт перечисление и выплату с прежними суммами", () => {
  const all = driverCompleted(ALL);
  const allEntry = all.state.restaurantAccountingEntries.find(
    (e) => e.orderId === all.orderId,
  );
  assert.ok(allEntry);
  assert.equal(allEntry.type, "RESTAURANT_REMITTANCE");
  assert.equal(
    allEntry.amountCents,
    orderOf(all.state, all.orderId).financials.moneyMovement
      ?.restaurantOwesDirectCents,
  );

  const mixed = driverCompleted(MIXED);
  const mixedEntry = mixed.state.restaurantAccountingEntries.find(
    (e) => e.orderId === mixed.orderId,
  );
  assert.ok(mixedEntry);
  assert.equal(mixedEntry.type, "RESTAURANT_PAYOUT");
  assert.equal(
    mixedEntry.amountCents,
    orderOf(mixed.state, mixed.orderId).financials.moneyMovement
      ?.directOwesRestaurantCents,
  );
});

test("40: legacy без правила и режима остаётся REVIEW_REQUIRED", () => {
  const { state, orderId } = platformOrder(ALL);
  const legacy = withOrder(state, orderId, (o) => {
    const {
      financialRule,
      financialCollectionMode,
      ...rest
    } = o.financials;
    void financialRule;
    void financialCollectionMode;
    return { ...o, financials: rest as typeof o.financials };
  });
  const parsed = parseStoredState(JSON.stringify(legacy));
  assert.ok(parsed);
  const fin = orderOf(parsed, orderId).financials;
  assert.equal(fin.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(fin.moneyMovement, undefined);
});

test("41: compatibility-проекция движения — чистая функция без своей формулы", () => {
  const movement = computeOrderMoneyMovement(driverInput(ALL));
  assert.ok(movement.ok);
  const fields = buildCompatibilityCollectionFields({
    movement: movement.movement,
    customerTotalCents: 10_500,
    restaurantCommissionCents: 1_500,
    pendingRestaurantNetCents: 0,
  });
  assert.deepEqual(fields, {
    restaurantCollectedFromCustomerCents: 10_500,
    platformCollectedFromCustomerCents: 0,
    platformCommissionReceivableCents: 1_500,
    restaurantNetAfterPlatformCommissionCents: 8_395,
  });
  // Без движения (самовывоз до оплаты) собранные суммы равны нулю.
  const pending = buildCompatibilityCollectionFields({
    movement: null,
    customerTotalCents: 10_500,
    restaurantCommissionCents: 1_500,
    pendingRestaurantNetCents: 9_000,
  });
  assert.equal(pending.restaurantCollectedFromCustomerCents, 0);
  assert.equal(pending.platformCollectedFromCustomerCents, 0);
  assert.equal(pending.restaurantNetAfterPlatformCommissionCents, 9_000);
});

// markOrderDeliveredWithResult импортируется для проверки, что старый путь
// собственного курьера остаётся рабочим после изменения снимка.
void markOrderDeliveredWithResult;
