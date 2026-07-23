import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  addCartItem,
  createOrderFromCart,
  createRestaurant,
  markOrderDeliveredByDriverWithResult,
  setCartFulfillmentChoice,
  updateCartAddress,
  updateRestaurant,
  type RestaurantFormInput,
} from "./actions.ts";
import { allocateBankFee, type BankFeeInput } from "./bank-fee.ts";
import { createDefaultState } from "./default-state.ts";
import { FINANCIAL_RULES } from "./financial-rule.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type {
  FinancialSnapshot,
  Order,
  PrototypeState,
  RestaurantAccountingEntry,
  RestaurantFinancialCollectionMode,
} from "./models.ts";
import {
  buildCreationMoneyMovement,
  finalizePickupMoneyMovement,
  normalizeStoredMoneyMovement,
} from "./money-movement-snapshot.ts";
import {
  computeOrderMoneyMovement,
  type OrderMoneyMovementInput,
} from "./order-money-movement.ts";
import { normalizePrototypeState, parseStoredState } from "./prototype-store.ts";
import {
  ACCOUNTING_TYPE_LABELS,
  buildAdminAccountingView,
  computeCompletedOrderAccounting,
  resolveRestaurantAccountingEntry,
} from "./restaurant-accounting.ts";
import { buildRestaurantFinanceReadModel } from "./restaurant-finance-read-model.ts";
import { isAllowedDirectionTypePair } from "./restaurant-settlement-integrity.ts";
import { confirmRestaurantSettlement } from "./restaurant-settlement-records.ts";
import { financialCollectionModeLabels } from "./selectors.ts";
import { FINANCE_CHANNEL_LABELS } from "../app/restaurant/settlements/overview-presentation.ts";

/**
 * v13: два канонических финансовых режима ресторана. Проверяется весь контур:
 * тип и миграция, матрица режим/доставка/канал, банковская комиссия,
 * экономика перечисления, fail-closed поведение legacy-заказов, accounting
 * type RESTAURANT_REMITTANCE и подписи UI.
 */

const V1_RULE = FINANCIAL_RULES.DIRECT_FINANCIAL_RULE_V1;
const ADDR = { street: "Тестовая улица 1", house: "1" };
const NOW = "2026-07-21T10:00:00.000Z";

const ALL = "RESTAURANT_COLLECTS_ALL" as const;
const MIXED = "MIXED_COLLECTION" as const;

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

/** Состояние, в котором у ресторана задан конкретный финансовый режим. */
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

/** Новый PICKUP-заказ ресторана-2 в заданном режиме. */
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

/** Канонический вход движения денег: доставка Direct, 10000/500/1500. */
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
    deliveryMode: "PLATFORM_DRIVER",
    moneyCollector: "DIRECT",
    paymentInstrument: "CARD",
    foodSubtotalCents: 10_000,
    customerTotalCents: 10_500,
    bankCardFeeRateBps: V1_RULE.bankCardFeeRateBps,
    financialCollectionMode: MIXED,
    ...overrides,
  };
}

/** Финснимок без v13-поля — имитация заказа, созданного до режима. */
function stripMode(financials: FinancialSnapshot): Record<string, unknown> {
  const { financialCollectionMode, ...legacy } = financials;
  void financialCollectionMode;
  return legacy;
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

// --- 1–8: тип, миграция, форма ресторана -------------------------------------

test("1: оба финансовых режима — валидные значения ресторана", () => {
  for (const mode of [ALL, MIXED]) {
    const s = stateWithMode("restaurant-2", mode);
    const normalized = normalizePrototypeState(s);
    const restaurant = normalized.restaurants.find((r) => r.id === "restaurant-2");
    assert.ok(restaurant);
    assert.equal(restaurant.financialCollectionMode, mode);
  }
});

test("2: неизвестный финансовый режим ресторана отклоняется", () => {
  const s = createDefaultState();
  const input = {
    ...baseRestaurantInput(),
    financialCollectionMode: "RESTAURANT_KEEPS_EVERYTHING",
  } as unknown as RestaurantFormInput;
  const res = createRestaurant(s, input);
  assert.equal(res.result.restaurantId, null);
  assert.ok(res.result.error);
  // Ошибка не создаёт ресторан и не двигает ревизию.
  assert.equal(res.state, s);
  assert.equal(res.state.restaurants.length, s.restaurants.length);
});

function baseRestaurantInput(): RestaurantFormInput {
  return {
    name: "Новый",
    description: "",
    address: "",
    zoneId: "zone-1",
    deliveryProvider: "DIRECT",
    financialCollectionMode: MIXED,
    commissionRateBps: 1_500,
    defaultPreparationMinutes: 25,
    pickupEnabled: true,
    status: "DRAFT",
    isAcceptingOrders: false,
    restaurantDeliverySettings: null,
    pickupPaymentMethods: ["CASH", "CARD"],
  };
}

test("3: legacy-ресторан без поля получает MIXED_COLLECTION", () => {
  const s = createDefaultState() as unknown as Record<string, unknown>;
  const restaurants = (s.restaurants as Record<string, unknown>[]).map(
    (r) => {
      const copy = { ...r };
      delete copy.financialCollectionMode;
      return copy;
    },
  );
  const legacy = { ...s, schemaVersion: 12, restaurants };
  const parsed = parseStoredState(JSON.stringify(legacy));
  assert.ok(parsed);
  for (const restaurant of parsed.restaurants) {
    assert.equal(restaurant.financialCollectionMode, MIXED);
  }
});

test("4: схема мигрирует 12 → текущую", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 19);
  const legacy = createDefaultState() as unknown as Record<string, unknown>;
  legacy.schemaVersion = 12;
  const parsed = parseStoredState(JSON.stringify(legacy));
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, PROTOTYPE_SCHEMA_VERSION);
});

test("5: шаблон «с водителями Direct» по умолчанию MIXED_COLLECTION", () => {
  const FORM = readFileSync(
    "src/components/admin/restaurant-form.tsx",
    "utf8",
  );
  assert.match(
    FORM,
    /template === "RESTAURANT" \? "RESTAURANT_COLLECTS_ALL" : "MIXED_COLLECTION"/,
  );
  // Доменная сторона: явный MIXED действительно сохраняется как есть.
  const res = createRestaurant(createDefaultState(), baseRestaurantInput());
  const created = res.state.restaurants.find(
    (r) => r.id === res.result.restaurantId,
  );
  assert.ok(created);
  assert.equal(created.financialCollectionMode, MIXED);
});

test("6: шаблон «со своим курьером» по умолчанию RESTAURANT_COLLECTS_ALL", () => {
  const res = createRestaurant(createDefaultState(), {
    ...baseRestaurantInput(),
    deliveryProvider: "RESTAURANT",
    financialCollectionMode: ALL,
  });
  const created = res.state.restaurants.find(
    (r) => r.id === res.result.restaurantId,
  );
  assert.ok(created);
  assert.equal(created.financialCollectionMode, ALL);
});

test("7: admin update сохраняет новый финансовый режим", () => {
  const s = createDefaultState();
  const res = updateRestaurant(s, "restaurant-2", {
    financialCollectionMode: ALL,
  });
  assert.equal(res.result.ok, true);
  const updated = res.state.restaurants.find((r) => r.id === "restaurant-2");
  assert.ok(updated);
  assert.equal(updated.financialCollectionMode, ALL);
  // Патч без поля режим не сбрасывает.
  const kept = updateRestaurant(res.state, "restaurant-2", { name: "Другое" });
  assert.equal(kept.result.ok, true);
  assert.equal(
    kept.state.restaurants.find((r) => r.id === "restaurant-2")
      ?.financialCollectionMode,
    ALL,
  );
});

test("8: ошибка update не мутирует state и не растит revision", () => {
  const s = createDefaultState();
  const res = updateRestaurant(s, "restaurant-2", {
    financialCollectionMode: "NOPE" as unknown as RestaurantFinancialCollectionMode,
  });
  assert.equal(res.result.ok, false);
  assert.equal(res.state, s);
  assert.equal(res.state.revision, s.revision);
});

// --- 9–16: снимок заказа и матрица каналов -----------------------------------

test("9: новый заказ сохраняет финансовый режим в снимке", () => {
  for (const mode of [MIXED, ALL]) {
    const { state, orderId } = platformOrder(mode);
    assert.equal(orderOf(state, orderId).financials.financialCollectionMode, mode);
  }
});

test("10: смена режима ресторана после заказа не меняет снимок", () => {
  const { state, orderId } = platformOrder(MIXED);
  const changed = updateRestaurant(state, "restaurant-2", {
    financialCollectionMode: ALL,
  });
  assert.equal(changed.result.ok, true);
  const fin = orderOf(changed.state, orderId).financials;
  assert.equal(fin.financialCollectionMode, MIXED);
  assert.equal(fin.moneyMovement?.paymentChannel, "ONLINE_CARD");
  // И после serialize/parse снимок остаётся прежним.
  const parsed = parseStoredState(JSON.stringify(changed.state));
  assert.ok(parsed);
  assert.equal(
    orderOf(parsed, orderId).financials.financialCollectionMode,
    MIXED,
  );
});

test("11: MIXED + доставка Direct выбирает ONLINE_CARD", () => {
  const { state, orderId } = platformOrder(MIXED);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  assert.equal(movement.paymentChannel, "ONLINE_CARD");
  assert.equal(movement.customerMoneyRecipient, "DIRECT");
});

test("12: RESTAURANT_COLLECTS_ALL + доставка Direct выбирает ONLINE_CARD_TO_RESTAURANT", () => {
  const { state, orderId } = platformOrder(ALL);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  assert.equal(movement.paymentChannel, "ONLINE_CARD_TO_RESTAURANT");
  assert.equal(movement.customerMoneyRecipient, "RESTAURANT");
});

test("13: MIXED + ONLINE_CARD_TO_RESTAURANT отклоняется", () => {
  const result = computeOrderMoneyMovement(
    driverInput(MIXED, { paymentChannel: "ONLINE_CARD_TO_RESTAURANT" }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.length > 0);
});

test("14: RESTAURANT_COLLECTS_ALL + ONLINE_CARD отклоняется", () => {
  const result = computeOrderMoneyMovement(
    driverInput(ALL, { paymentChannel: "ONLINE_CARD" }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.length > 0);
});

test("15: каналы самовывоза допустимы в обоих режимах", () => {
  for (const mode of [MIXED, ALL]) {
    for (const channel of ["CARD_AT_RESTAURANT", "CASH_AT_RESTAURANT"] as const) {
      const result = computeOrderMoneyMovement({
        deliveryMode: "PICKUP",
        paymentChannel: channel,
        foodSubtotalCents: 10_000,
        deliveryFeeCents: 0,
        smallOrderFeeCents: 0,
        customerTotalCents: 10_000,
        restaurantCommissionCents: 1_500,
        financialRule: V1_RULE,
        financialCollectionMode: mode,
      });
      assert.equal(result.ok, true, `${mode}/${channel}`);
      assert.ok(result.ok && result.movement.customerMoneyRecipient === "RESTAURANT");
    }
  }
});

test("16: наличные курьеру ресторана допустимы в обоих режимах", () => {
  for (const mode of [MIXED, ALL]) {
    const result = computeOrderMoneyMovement({
      deliveryMode: "RESTAURANT_DELIVERY",
      paymentChannel: "CASH_TO_RESTAURANT_COURIER",
      foodSubtotalCents: 1_420,
      deliveryFeeCents: 350,
      smallOrderFeeCents: 0,
      customerTotalCents: 1_770,
      restaurantCommissionCents: 99,
      financialRule: V1_RULE,
      financialCollectionMode: mode,
    });
    assert.equal(result.ok, true, mode);
    assert.ok(result.ok && result.movement.totalBankFeeCents === 0);
  }
});

// --- 17–25: банковская комиссия и экономика ----------------------------------

test("17: доставка Direct с платежом ресторану — весь банк на ресторане", () => {
  const result = allocateBankFee(
    bankInput({ moneyCollector: "RESTAURANT", financialCollectionMode: ALL }),
  );
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.fee.totalBankFeeCents, 105);
  assert.equal(result.fee.restaurantBankFeeCents, 105);
  assert.equal(result.fee.directBankFeeCents, 0);
  // Тот же режим с получателем Direct — невозможная комбинация.
  const wrongCollector = allocateBankFee(
    bankInput({ moneyCollector: "DIRECT", financialCollectionMode: ALL }),
  );
  assert.equal(wrongCollector.ok, false);
});

test("18: доставка Direct в MIXED сохраняет прежнее распределение банка", () => {
  const result = allocateBankFee(bankInput());
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.fee.totalBankFeeCents, 105);
  assert.equal(result.fee.restaurantBankFeeCents, 100);
  assert.equal(result.fee.directBankFeeCents, 5);
  // Ресторан-получатель в MIXED невозможен.
  assert.equal(
    allocateBankFee(bankInput({ moneyCollector: "RESTAURANT" })).ok,
    false,
  );
});

test("19: пример 10000/500/1500 даёт долг ресторана 2000", () => {
  const result = computeOrderMoneyMovement(driverInput(ALL));
  assert.ok(result.ok);
  assert.equal(result.movement.restaurantOwesDirectCents, 2_000);
  assert.equal(result.movement.directOwesRestaurantCents, 0);
});

test("20: в том же примере чистый доход ресторана 8395", () => {
  const result = computeOrderMoneyMovement(driverInput(ALL));
  assert.ok(result.ok);
  assert.equal(result.movement.totalBankFeeCents, 105);
  assert.equal(result.movement.restaurantBankFeeCents, 105);
  assert.equal(result.movement.restaurantNetCents, 8_395);
  // Денежное равенство сходится до цента.
  assert.equal(
    result.movement.restaurantNetCents +
      result.movement.restaurantOwesDirectCents +
      result.movement.restaurantBankFeeCents,
    10_500,
  );
});

test("21: чистый доход Direct в этом примере 1500", () => {
  const result = computeOrderMoneyMovement(driverInput(ALL));
  assert.ok(result.ok);
  assert.equal(result.movement.directNetRevenueCents, 1_500);
  assert.equal(result.movement.directBankFeeCents, 0);
});

test("22: small-order fee входит и в перечисление, и в доход Direct", () => {
  const result = computeOrderMoneyMovement(
    driverInput(ALL, {
      foodSubtotalCents: 800,
      deliveryFeeCents: 500,
      smallOrderFeeCents: 150,
      customerTotalCents: 1_450,
      restaurantCommissionCents: 120,
      driverPayoutCents: 500,
    }),
  );
  assert.ok(result.ok);
  assert.equal(result.movement.restaurantOwesDirectCents, 120 + 500 + 150);
  assert.equal(result.movement.directNetRevenueCents, 120 + 150);
});

test("23: стоимость доставки не входит в чистый доход Direct", () => {
  const withFee = computeOrderMoneyMovement(driverInput(ALL));
  const biggerFee = computeOrderMoneyMovement(
    driverInput(ALL, {
      deliveryFeeCents: 900,
      customerTotalCents: 10_900,
      driverPayoutCents: 900,
    }),
  );
  assert.ok(withFee.ok && biggerFee.ok);
  // Доставка выросла на 400: перечисление выросло, доход Direct — нет.
  assert.equal(
    biggerFee.movement.restaurantOwesDirectCents -
      withFee.movement.restaurantOwesDirectCents,
    400,
  );
  assert.equal(
    biggerFee.movement.directNetRevenueCents,
    withFee.movement.directNetRevenueCents,
  );
});

test("24: суммы вне безопасного диапазона отклоняются fail-closed", () => {
  const unsafe = Number.MAX_SAFE_INTEGER;
  const result = computeOrderMoneyMovement(
    driverInput(ALL, {
      foodSubtotalCents: unsafe,
      deliveryFeeCents: unsafe,
      smallOrderFeeCents: unsafe,
      customerTotalCents: unsafe,
      restaurantCommissionCents: unsafe,
      driverPayoutCents: unsafe,
    }),
  );
  assert.equal(result.ok, false);
});

test("25: расчёт не мутирует входные данные", () => {
  const input = Object.freeze(driverInput(ALL));
  const before = { ...input };
  const result = computeOrderMoneyMovement(input);
  assert.equal(result.ok, true);
  assert.deepEqual({ ...input }, before);
});

// --- 26–30: legacy-заказы без режима -----------------------------------------

test("26: legacy-заказ без режима переходит в REVIEW_REQUIRED", () => {
  const { state, orderId } = platformOrder(MIXED);
  const legacy = withOrder(state, orderId, (o) => ({
    ...o,
    financials: stripMode(o.financials) as unknown as FinancialSnapshot,
  }));
  const fin = orderOf(normalizePrototypeState(legacy), orderId).financials;
  assert.equal(fin.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(fin.moneyMovement, undefined);
});

test("27: сохранённый COMPLETE без режима тоже REVIEW_REQUIRED", () => {
  const sums = {
    foodSubtotalCents: 10_000,
    deliveryFeeCents: 500,
    smallOrderFeeCents: 0,
    customerTotalCents: 10_500,
    restaurantCommissionCents: 1_500,
    driverPayoutCents: 500,
    financialRule: V1_RULE,
    moneyMovementStatus: "COMPLETE",
  };
  const context = { pickupPaidWith: null, pickupSettled: false } as const;
  const withoutMode = normalizeStoredMoneyMovement(
    sums,
    "PLATFORM_DRIVER",
    context,
  );
  assert.equal(withoutMode.moneyMovementStatus, "REVIEW_REQUIRED");
  // Правило само по себе отсутствие режима не заменяет — режим обязателен.
  const withMode = normalizeStoredMoneyMovement(
    { ...sums, moneyMovementStatus: undefined, financialCollectionMode: MIXED },
    "PLATFORM_DRIVER",
    context,
  );
  assert.equal(withMode.moneyMovementStatus, "COMPLETE");
});

test("28: legacy-заказ не получает текущий режим ресторана", () => {
  const { state, orderId } = platformOrder(MIXED);
  const legacy = withOrder(state, orderId, (o) => ({
    ...o,
    financials: stripMode(o.financials) as unknown as FinancialSnapshot,
  }));
  // Ресторан переведён в другой режим — заказ всё равно не восстанавливается.
  const switched = stateWithMode("restaurant-2", ALL, legacy);
  const fin = orderOf(normalizePrototypeState(switched), orderId).financials;
  assert.equal(fin.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(fin.financialCollectionMode, undefined);
});

test("29: самовывоз без режима нельзя финализировать", () => {
  const { state, orderId } = pickupOrder(MIXED);
  const snapshot = orderOf(state, orderId).financials;
  const withoutMode = stripMode(snapshot) as unknown as FinancialSnapshot;
  const result = finalizePickupMoneyMovement(withoutMode, "CASH");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /финансовый режим/.test(result.error));
  // С режимом финализация проходит.
  const ok = finalizePickupMoneyMovement(snapshot, "CASH");
  assert.equal(ok.ok, true);
});

test("30: REVIEW_REQUIRED не создаёт бухгалтерское обязательство", () => {
  const { state, orderId } = platformOrder(ALL);
  const broken = withOrder(state, orderId, (o) => ({
    ...o,
    status: "DELIVERED",
    financials: {
      ...o.financials,
      moneyMovementStatus: "REVIEW_REQUIRED",
      moneyMovement: undefined,
    },
  }));
  const computed = computeCompletedOrderAccounting(
    orderOf(broken, orderId),
    [],
  );
  assert.equal(computed.ok, true);
  assert.deepEqual(computed.entries, []);
});

// --- 31–40: accounting, пары и расчёты ---------------------------------------

/** Завершённый доставкой Direct заказ в заданном режиме. */
function deliveredDriverOrder(mode: RestaurantFinancialCollectionMode): {
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
  }));
  const res = markOrderDeliveredByDriverWithResult(prepared, orderId);
  assert.equal(res.result.error, null);
  return { state: res.state, orderId };
}

test("31: доставка Direct с платежом ресторану создаёт RESTAURANT_REMITTANCE", () => {
  const { state, orderId } = deliveredDriverOrder(ALL);
  const entries = state.restaurantAccountingEntries.filter(
    (e) => e.orderId === orderId,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "RESTAURANT_REMITTANCE");
  assert.equal(entries[0].direction, "RESTAURANT_OWES_DIRECT");
});

test("32: доставка Direct в MIXED создаёт RESTAURANT_PAYOUT", () => {
  const { state, orderId } = deliveredDriverOrder(MIXED);
  const entries = state.restaurantAccountingEntries.filter(
    (e) => e.orderId === orderId,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "RESTAURANT_PAYOUT");
  assert.equal(entries[0].direction, "DIRECT_OWES_RESTAURANT");
});

test("33: самовывоз и курьер ресторана создают PLATFORM_COMMISSION", () => {
  for (const mode of [MIXED, ALL]) {
    const { state, orderId } = pickupOrder(mode);
    const finalized = finalizePickupMoneyMovement(
      orderOf(state, orderId).financials,
      "CASH",
    );
    assert.ok(finalized.ok);
    const completedOrder: Order = {
      ...orderOf(state, orderId),
      status: "PICKED_UP",
      financials: {
        ...orderOf(state, orderId).financials,
        moneyMovementStatus: finalized.moneyMovementStatus,
        moneyMovement: finalized.moneyMovement,
      },
    };
    const computed = computeCompletedOrderAccounting(completedOrder, []);
    assert.equal(computed.ok, true);
    assert.equal(computed.entries.length, 1);
    assert.equal(computed.entries[0].type, "PLATFORM_COMMISSION");
  }
});

test("34: три допустимые пары направление/тип проходят валидацию", () => {
  assert.equal(
    isAllowedDirectionTypePair("RESTAURANT_OWES_DIRECT", "PLATFORM_COMMISSION"),
    true,
  );
  assert.equal(
    isAllowedDirectionTypePair("RESTAURANT_OWES_DIRECT", "RESTAURANT_REMITTANCE"),
    true,
  );
  assert.equal(
    isAllowedDirectionTypePair("DIRECT_OWES_RESTAURANT", "RESTAURANT_PAYOUT"),
    true,
  );
});

test("35: несовместимые пары направление/тип отклоняются", () => {
  const forbidden: [string, string][] = [
    ["DIRECT_OWES_RESTAURANT", "PLATFORM_COMMISSION"],
    ["DIRECT_OWES_RESTAURANT", "RESTAURANT_REMITTANCE"],
    ["RESTAURANT_OWES_DIRECT", "RESTAURANT_PAYOUT"],
    ["RESTAURANT_OWES_DIRECT", "UNKNOWN_TYPE"],
    ["SOMETHING_ELSE", "PLATFORM_COMMISSION"],
  ];
  for (const [direction, type] of forbidden) {
    assert.equal(
      isAllowedDirectionTypePair(direction, type),
      false,
      `${direction}+${type}`,
    );
  }
});

test("36: RESTAURANT_REMITTANCE нельзя списать (WAIVED)", () => {
  const { state, orderId } = deliveredDriverOrder(ALL);
  const entry = state.restaurantAccountingEntries.find(
    (e) => e.orderId === orderId,
  );
  assert.ok(entry);
  const res = resolveRestaurantAccountingEntry(
    state,
    entry.id,
    "WAIVED",
    "Основание",
    null,
    NOW,
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
  // UI-модель тоже не предлагает списание.
  const view = buildAdminAccountingView(state, "restaurant-2");
  const row = view.rows.find((r) => r.entryId === entry.id);
  assert.ok(row);
  assert.equal(row.canWaive, false);
  assert.equal(row.canSettle, true);
});

test("37: PLATFORM_COMMISSION по-прежнему можно списать", () => {
  const entry: RestaurantAccountingEntry = {
    id: "acc-commission",
    orderId: "order-x",
    restaurantId: "restaurant-2",
    direction: "RESTAURANT_OWES_DIRECT",
    type: "PLATFORM_COMMISSION",
    amountCents: 800,
    currencyCode: "USD",
    status: "OPEN",
    recognizedAt: NOW,
    settledAt: null,
    source: "ORDER_FINANCIAL_SNAPSHOT",
    legacySettlementId: null,
  };
  const state: PrototypeState = {
    ...createDefaultState(),
    restaurantAccountingEntries: [entry],
  };
  const res = resolveRestaurantAccountingEntry(
    state,
    entry.id,
    "WAIVED",
    "Списываем своё требование",
    null,
    NOW,
  );
  assert.equal(res.result.ok, true);
  assert.equal(
    res.state.restaurantAccountingEntries[0].status,
    "WAIVED",
  );
});

test("38: групповой расчёт закрывает перечисление как SETTLED", () => {
  const { state, orderId } = deliveredDriverOrder(ALL);
  const entry = state.restaurantAccountingEntries.find(
    (e) => e.orderId === orderId,
  );
  assert.ok(entry);
  const res = confirmRestaurantSettlement(state, {
    restaurantId: "restaurant-2",
    accountingEntryIds: [entry.id],
    method: "BANK_TRANSFER",
    transferredAmountCents: entry.amountCents,
    note: "Перечисление получено",
    externalReference: "ref-42",
    nowIso: NOW,
  });
  assert.equal(res.result.error, null);
  assert.ok(res.result.settlementRecordId);
  const closed = res.state.restaurantAccountingEntries.find(
    (e) => e.id === entry.id,
  );
  assert.ok(closed);
  assert.equal(closed.status, "SETTLED");
});

test("39: legacy SettlementEntry для перечисления не создаётся", () => {
  const { state, orderId } = deliveredDriverOrder(ALL);
  assert.deepEqual(
    state.settlements.filter((s) => s.orderId === orderId),
    [],
  );
  const entry = state.restaurantAccountingEntries.find(
    (e) => e.orderId === orderId,
  );
  assert.ok(entry);
  const res = confirmRestaurantSettlement(state, {
    restaurantId: "restaurant-2",
    accountingEntryIds: [entry.id],
    method: "BANK_TRANSFER",
    transferredAmountCents: entry.amountCents,
    note: "Перечисление получено",
    externalReference: "ref-43",
    nowIso: NOW,
  });
  assert.equal(res.result.error, null);
  // Групповое закрытие перечисления не порождает старую запись комиссии.
  assert.deepEqual(
    res.state.settlements.filter((s) => s.orderId === orderId),
    [],
  );
});

test("40: read-model принимает перечисление и считает его долгом ресторана", () => {
  const { state, orderId } = deliveredDriverOrder(ALL);
  const model = buildRestaurantFinanceReadModel(state, "restaurant-2");
  assert.equal(model.ok, true, model.ok ? "" : model.error);
  assert.ok(model.ok);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  assert.equal(
    model.model.restaurantOwesDirectCents,
    movement.restaurantOwesDirectCents,
  );
  assert.equal(model.model.netDirection, "RESTAURANT_OWES_DIRECT");
});

// --- 41–45: подписи, отображение и совместимость ------------------------------

test("41: подписи режимов и типов не показывают сырой enum", () => {
  assert.equal(
    financialCollectionModeLabels.MIXED_COLLECTION,
    "Смешанный: онлайн-доставку получает Direct",
  );
  assert.equal(
    financialCollectionModeLabels.RESTAURANT_COLLECTS_ALL,
    "Все платежи получает ресторан",
  );
  assert.equal(
    ACCOUNTING_TYPE_LABELS.RESTAURANT_REMITTANCE,
    "Перечисление рестораном",
  );
  for (const label of [
    ...Object.values(financialCollectionModeLabels),
    ...Object.values(ACCOUNTING_TYPE_LABELS),
  ]) {
    assert.ok(!/[A-Z]{2,}_[A-Z]/.test(label), label);
  }
  // Конструктор ресторана показывает выбор режима без технических терминов.
  const FORM = readFileSync("src/components/admin/restaurant-form.tsx", "utf8");
  assert.ok(FORM.includes("Кто получает платежи клиентов"));
  assert.ok(FORM.includes("financialCollectionModeLabels.MIXED_COLLECTION"));
  assert.ok(
    FORM.includes("financialCollectionModeLabels.RESTAURANT_COLLECTS_ALL"),
  );
});

test("42: ресторанский обзор показывает новый канал оплаты", () => {
  assert.equal(
    FINANCE_CHANNEL_LABELS.ONLINE_CARD_TO_RESTAURANT,
    "Онлайн-карта · получает ресторан",
  );
  assert.equal(FINANCE_CHANNEL_LABELS.ONLINE_CARD, "Онлайн-карта · получает Direct");
  const { state } = deliveredDriverOrder(ALL);
  const model = buildRestaurantFinanceReadModel(state, "restaurant-2");
  assert.ok(model.ok);
  const row = model.model.openOrders[0];
  assert.ok(row);
  assert.equal(row.paymentChannel, "ONLINE_CARD_TO_RESTAURANT");
  assert.ok(FINANCE_CHANNEL_LABELS[row.paymentChannel].length > 0);
});

test("43: прежние примеры MIXED не изменились", () => {
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

test("44: снимок финансового правила заказа сохраняется вместе с режимом", () => {
  const { state, orderId } = platformOrder(ALL);
  const fin = orderOf(state, orderId).financials;
  assert.deepEqual(fin.financialRule, V1_RULE);
  assert.equal(fin.financialCollectionMode, ALL);
  // Оба снимка одинаково обязательны: без правила расчёт тоже невозможен.
  const noRule = buildCreationMoneyMovement({
    deliveryMode: "PLATFORM_DRIVER",
    foodSubtotalCents: 10_000,
    deliveryFeeCents: 500,
    smallOrderFeeCents: 0,
    customerTotalCents: 10_500,
    restaurantCommissionCents: 1_500,
    driverPayoutCents: 500,
    financialCollectionMode: ALL,
  } as unknown as Parameters<typeof buildCreationMoneyMovement>[0]);
  assert.equal(noRule.ok, false);
});

test("45: полный оборот заказа в новом режиме сходится до цента", () => {
  const { state, orderId } = deliveredDriverOrder(ALL);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  const fin = orderOf(state, orderId).financials;
  assert.equal(
    movement.restaurantNetCents +
      movement.restaurantOwesDirectCents +
      movement.restaurantBankFeeCents,
    fin.customerTotalCents,
  );
  assert.equal(movement.directOwesRestaurantCents, 0);
  assert.equal(movement.directBankFeeCents, 0);
});
