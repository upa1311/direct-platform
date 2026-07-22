import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACTIVE_FINANCIAL_RULE_VERSION,
  FINANCIAL_RULES,
  getActiveFinancialRule,
  isKnownFinancialRuleVersion,
  validateFinancialRuleSnapshot,
  type FinancialRuleSnapshot,
} from "./financial-rule.ts";
import { allocateBankFee } from "./bank-fee.ts";
import { computeOrderMoneyMovement } from "./order-money-movement.ts";
import {
  buildCreationMoneyMovement,
  finalizePickupMoneyMovement,
  normalizeStoredMoneyMovement,
} from "./money-movement-snapshot.ts";
import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  completePickupAtRestaurant,
  createOrderFromCart,
  markOrderReady,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import { normalizePrototypeState, parseStoredState } from "./prototype-store.ts";
import { computeCompletedOrderAccounting } from "./restaurant-accounting.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type { FinancialSnapshot, Order, PrototypeState } from "./models.ts";

/**
 * Provenance финансового правила: заказ объясняется по СВОЕМУ снимку правила,
 * а не по текущим константам кода. Legacy-заказ без снимка не восстанавливается
 * подстановкой актуальной ставки.
 */

const V1 = FINANCIAL_RULES.DIRECT_FINANCIAL_RULE_V1;
const ADDR = { street: "Тестовая улица 1", house: "1" };

/** Гипотетическое будущее правило с другой ставкой (в registry его нет). */
const FUTURE_RULE_2X: FinancialRuleSnapshot = {
  version: "DIRECT_FINANCIAL_RULE_V1",
  effectiveAt: V1.effectiveAt,
  bankCardFeeRateBps: 200,
};

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
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

/** Снимок без provenance — имитация заказа, созданного до v12. */
function stripRule(financials: FinancialSnapshot): FinancialSnapshot {
  const { financialRule, ...rest } = financials;
  void financialRule;
  return rest as FinancialSnapshot;
}

function platformOrder(): { state: PrototypeState; orderId: string } {
  let s = updateCartAddress(createDefaultState(), ADDR);
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

function pickupReady(): { state: PrototypeState; orderId: string } {
  let s = setCartFulfillmentChoice(createDefaultState(), "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  let st = acceptRestaurantOrder(created.state, orderId, 20);
  st = markOrderReady(st, orderId);
  return { state: st, orderId };
}

// 1 — registry --------------------------------------------------------------------

test("registry V1: ставка 100 bps, канонический effectiveAt, активная версия", () => {
  assert.equal(V1.version, "DIRECT_FINANCIAL_RULE_V1");
  assert.equal(V1.bankCardFeeRateBps, 100);
  assert.equal(V1.effectiveAt, "2026-07-20T00:00:00.000Z");
  assert.equal(ACTIVE_FINANCIAL_RULE_VERSION, "DIRECT_FINANCIAL_RULE_V1");
  assert.ok(isKnownFinancialRuleVersion("DIRECT_FINANCIAL_RULE_V1"));
  assert.ok(!isKnownFinancialRuleVersion("DIRECT_FINANCIAL_RULE_V2"));
  // Активное правило отдаётся копией, а не ссылкой на registry.
  const active = getActiveFinancialRule();
  assert.deepEqual(active, V1);
  assert.notEqual(active, V1);
});

test("validator правила: версия, дата, ставка и совпадение с registry", () => {
  assert.equal(validateFinancialRuleSnapshot(V1).ok, true);
  const bad: unknown[] = [
    null,
    "V1",
    {},
    { ...V1, version: "DIRECT_FINANCIAL_RULE_V2" },
    { ...V1, effectiveAt: "2026-07-20" },
    { ...V1, effectiveAt: "не-дата" },
    { ...V1, bankCardFeeRateBps: 0 },
    { ...V1, bankCardFeeRateBps: -100 },
    { ...V1, bankCardFeeRateBps: 100.5 },
    // Ставка не совпадает с опубликованной записью своей версии.
    { ...V1, bankCardFeeRateBps: 200 },
    // Дата не совпадает с registry.
    { ...V1, effectiveAt: "2020-01-01T00:00:00.000Z" },
  ];
  for (const value of bad) {
    assert.equal(
      validateFinancialRuleSnapshot(value).ok,
      false,
      JSON.stringify(value),
    );
  }
});

// 2/3/4 — новый заказ сохраняет правило ---------------------------------------------

test("новый PLATFORM_DRIVER заказ сохраняет правило и считает прежние суммы", () => {
  const { state, orderId } = platformOrder();
  const f = orderOf(state, orderId).financials;
  assert.deepEqual(f.financialRule, V1);
  assert.equal(f.moneyMovementStatus, "COMPLETE");
  // Ставка V1 = прежний 1%: суммы не изменились по сравнению с до-v12.
  assert.equal(
    f.moneyMovement?.totalBankFeeCents,
    Math.round(f.customerTotalCents / 100),
  );
  assert.equal(
    f.moneyMovement?.restaurantBankFeeCents,
    Math.round(f.foodSubtotalCents / 100),
  );
});

test("новый PICKUP сохраняет правило уже в PENDING_PAYMENT_CHANNEL", () => {
  const { state, orderId } = pickupReady();
  const f = orderOf(state, orderId).financials;
  assert.equal(f.moneyMovementStatus, "PENDING_PAYMENT_CHANNEL");
  assert.equal(f.moneyMovement, undefined);
  // Правило зафиксировано при СОЗДАНИИ, хотя канал ещё неизвестен.
  assert.deepEqual(f.financialRule, V1);
});

// 5 — выдача pickup использует правило заказа ----------------------------------------

test("выдача pickup считает по правилу заказа, а не по активному правилу", () => {
  const { state, orderId } = pickupReady();
  const done = completePickupAtRestaurant(state, orderId, "CARD").state;
  const f = orderOf(done, orderId).financials;
  assert.equal(f.moneyMovementStatus, "COMPLETE");
  assert.equal(
    f.moneyMovement?.restaurantBankFeeCents,
    Math.round(f.customerTotalCents / 100),
  );

  // Если бы у заказа было правило с другой ставкой — комиссия была бы другой:
  // финализация читает ставку из снимка заказа, а не из активной версии.
  const doubled = finalizePickupMoneyMovement(
    {
      ...orderOf(state, orderId).financials,
      financialRule: FUTURE_RULE_2X,
    },
    "CARD",
  );
  // FUTURE_RULE_2X не совпадает с registry → fail-closed (см. validator).
  assert.equal(doubled.ok, false);

  // Заказ БЕЗ правила финализировать нельзя.
  const noRule = finalizePickupMoneyMovement(
    stripRule(orderOf(state, orderId).financials),
    "CASH",
  );
  assert.equal(noRule.ok, false);
});

// 6/7/8 — ставка приходит извне -------------------------------------------------------

test("allocateBankFee считает по переданной ставке, а не по глобальной", () => {
  const base = {
    deliveryMode: "PICKUP" as const,
    moneyCollector: "RESTAURANT" as const,
    paymentInstrument: "CARD" as const,
    foodSubtotalCents: 10_000,
    customerTotalCents: 10_000,
    financialCollectionMode: "MIXED_COLLECTION" as const,
  };
  const v1 = allocateBankFee({ ...base, bankCardFeeRateBps: 100 });
  assert.equal(v1.ok, true);
  assert.equal(v1.ok && v1.fee.totalBankFeeCents, 100);

  // Другая ставка — детерминированно другой результат.
  const doubled = allocateBankFee({ ...base, bankCardFeeRateBps: 200 });
  assert.equal(doubled.ok, true);
  assert.equal(doubled.ok && doubled.fee.totalBankFeeCents, 200);

  // Некорректная ставка — fail-closed.
  for (const rate of [0, -1, 1.5, Number.NaN]) {
    assert.equal(
      allocateBankFee({ ...base, bankCardFeeRateBps: rate }).ok,
      false,
      String(rate),
    );
  }
});

test("computeOrderMoneyMovement не читает глобальную ставку", () => {
  const input = {
    deliveryMode: "PICKUP" as const,
    paymentChannel: "CARD_AT_RESTAURANT" as const,
    foodSubtotalCents: 10_000,
    deliveryFeeCents: 0,
    smallOrderFeeCents: 0,
    customerTotalCents: 10_000,
    restaurantCommissionCents: 1_500,
    financialCollectionMode: "MIXED_COLLECTION" as const,
  };
  const v1 = computeOrderMoneyMovement({ ...input, financialRule: V1 });
  assert.equal(v1.ok, true);
  assert.equal(v1.ok && v1.movement.totalBankFeeCents, 100);

  // Правило, не совпадающее с registry, отклоняется целиком.
  const unknown = computeOrderMoneyMovement({
    ...input,
    financialRule: FUTURE_RULE_2X,
  });
  assert.equal(unknown.ok, false);

  // Отсутствующее правило — тоже fail-closed (пустая подстановка запрещена).
  const missing = computeOrderMoneyMovement({
    ...input,
    financialRule: undefined as unknown as FinancialRuleSnapshot,
  });
  assert.equal(missing.ok, false);
});

test("новый заказ не создаётся без валидного правила", () => {
  const broken = buildCreationMoneyMovement({
    deliveryMode: "PLATFORM_DRIVER",
    foodSubtotalCents: 10_000,
    deliveryFeeCents: 500,
    smallOrderFeeCents: 0,
    customerTotalCents: 10_500,
    restaurantCommissionCents: 1_500,
    financialRule: { ...V1, bankCardFeeRateBps: 999 },
  });
  assert.equal(broken.ok, false);
  // Самовывоз тоже обязан иметь правило, хотя канал ещё неизвестен.
  const pickupNoRule = buildCreationMoneyMovement({
    deliveryMode: "PICKUP",
    foodSubtotalCents: 10_000,
    deliveryFeeCents: 0,
    smallOrderFeeCents: 0,
    customerTotalCents: 10_000,
    restaurantCommissionCents: 1_500,
    financialRule: undefined as unknown as FinancialRuleSnapshot,
  });
  assert.equal(pickupNoRule.ok, false);
});

// 9/16/17/18 — verification по правилу заказа -----------------------------------------

test("валидный COMPLETE с V1 сохраняется исходным объектом", () => {
  const { state, orderId } = platformOrder();
  const original = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(original);
  const normalized = normalizePrototypeState(state);
  const f = orderOf(normalized, orderId).financials;
  assert.equal(f.moneyMovementStatus, "COMPLETE");
  assert.deepEqual(f.moneyMovement, original);
  assert.deepEqual(f.financialRule, V1);
});

test("несовпадающий COMPLETE не исправляется, а уходит в REVIEW_REQUIRED", () => {
  const { state, orderId } = platformOrder();
  const mutated = withOrder(state, orderId, (o) => ({
    ...o,
    financials: {
      ...o.financials,
      moneyMovement: {
        ...o.financials.moneyMovement!,
        totalBankFeeCents: o.financials.moneyMovement!.totalBankFeeCents + 1,
        directBankFeeCents: o.financials.moneyMovement!.directBankFeeCents + 1,
      },
    },
  }));
  const f = orderOf(normalizePrototypeState(mutated), orderId).financials;
  assert.equal(f.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(f.moneyMovement, undefined);
});

// 10-15 — legacy без правила -----------------------------------------------------------

test("сохранённый COMPLETE без правила → REVIEW_REQUIRED", () => {
  const { state, orderId } = platformOrder();
  const legacy = withOrder(state, orderId, (o) => ({
    ...o,
    financials: stripRule(o.financials),
  }));
  const f = orderOf(normalizePrototypeState(legacy), orderId).financials;
  // Суммы структурно корректны, но provenance нет — доказанным не считается.
  assert.equal(f.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(f.moneyMovement, undefined);
  assert.equal(f.financialRule, undefined);
});

test("завершённый заказ без movement и без правила → REVIEW_REQUIRED", () => {
  const { state, orderId } = platformOrder();
  const legacy = withOrder(state, orderId, (o) => {
    const stripped = stripRule(o.financials);
    const { moneyMovement, ...rest } = stripped;
    void moneyMovement;
    return {
      ...o,
      financials: {
        ...(rest as FinancialSnapshot),
        moneyMovementStatus: "PENDING_PAYMENT_CHANNEL",
      },
    };
  });
  const f = orderOf(normalizePrototypeState(legacy), orderId).financials;
  // Все прежние суммы на месте, но восстановление без правила запрещено.
  assert.ok(f.customerTotalCents > 0);
  assert.equal(f.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(f.moneyMovement, undefined);
});

test("неизвестная версия и повреждённая ставка → REVIEW_REQUIRED", () => {
  const { state, orderId } = platformOrder();
  const corrupted: unknown[] = [
    { ...V1, version: "DIRECT_FINANCIAL_RULE_V9" },
    { ...V1, bankCardFeeRateBps: 250 },
    { ...V1, bankCardFeeRateBps: -1 },
    { ...V1, effectiveAt: "2026-07-20" },
  ];
  for (const rule of corrupted) {
    const legacy = withOrder(state, orderId, (o) => ({
      ...o,
      financials: {
        ...o.financials,
        financialRule: rule as FinancialRuleSnapshot,
      },
    }));
    const f = orderOf(normalizePrototypeState(legacy), orderId).financials;
    assert.equal(
      f.moneyMovementStatus,
      "REVIEW_REQUIRED",
      JSON.stringify(rule),
    );
    // Повреждённое правило не «дочинивается» активным.
    assert.equal(f.financialRule, undefined, JSON.stringify(rule));
  }
});

test("незавершённый legacy pickup без канала и правила остаётся PENDING", () => {
  const { state, orderId } = pickupReady();
  const legacy = withOrder(state, orderId, (o) => ({
    ...o,
    financials: stripRule(o.financials),
  }));
  const f = orderOf(normalizePrototypeState(legacy), orderId).financials;
  assert.equal(f.moneyMovementStatus, "PENDING_PAYMENT_CHANNEL");
  assert.equal(f.moneyMovement, undefined);
});

test("normalizeStoredMoneyMovement: суммы без правила не дают recovery", () => {
  const sums = {
    foodSubtotalCents: 10_000,
    deliveryFeeCents: 500,
    smallOrderFeeCents: 0,
    customerTotalCents: 10_500,
    restaurantCommissionCents: 1_500,
    driverPayoutCents: 500,
  };
  const context = { pickupPaidWith: null, pickupSettled: false } as const;
  // Без правила — REVIEW_REQUIRED, несмотря на полные суммы.
  const withoutRule = normalizeStoredMoneyMovement(
    sums,
    "PLATFORM_DRIVER",
    context,
  );
  assert.equal(withoutRule.moneyMovementStatus, "REVIEW_REQUIRED");
  // v13: правила недостаточно — без финансового режима заказа восстановление
  // тоже запрещено (режим не подставляется из текущей настройки ресторана).
  const withRuleOnly = normalizeStoredMoneyMovement(
    { ...sums, financialRule: V1 },
    "PLATFORM_DRIVER",
    context,
  );
  assert.equal(withRuleOnly.moneyMovementStatus, "REVIEW_REQUIRED");
  // С правилом И режимом — восстановление разрешено.
  const withRule = normalizeStoredMoneyMovement(
    {
      ...sums,
      financialRule: V1,
      financialCollectionMode: "MIXED_COLLECTION",
    },
    "PLATFORM_DRIVER",
    context,
  );
  assert.equal(withRule.moneyMovementStatus, "COMPLETE");
  assert.equal(withRule.moneyMovement?.totalBankFeeCents, 105);
});

// 21/22 — persistence -------------------------------------------------------------------

test("состояния v11 парсятся, схема становится текущей", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 17);
  const legacy = createDefaultState() as unknown as Record<string, unknown>;
  legacy.schemaVersion = 11;
  const parsed = parseStoredState(JSON.stringify(legacy));
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, 17);

  // Заказ с валидным правилом переживает serialize/parse без изменений.
  const { state, orderId } = platformOrder();
  const round = parseStoredState(JSON.stringify(state));
  assert.ok(round);
  const f = orderOf(round, orderId).financials;
  assert.deepEqual(f.financialRule, V1);
  assert.deepEqual(
    f.moneyMovement,
    orderOf(state, orderId).financials.moneyMovement,
  );
});

// 23 — accounting не создаётся для REVIEW_REQUIRED ---------------------------------------

test("accounting не создаётся для заказа в REVIEW_REQUIRED", () => {
  const { state, orderId } = platformOrder();
  const legacy = withOrder(state, orderId, (o) => ({
    ...o,
    status: "DELIVERED" as const,
    financials: stripRule(o.financials),
  }));
  const normalized = normalizePrototypeState(legacy);
  const order = orderOf(normalized, orderId);
  assert.equal(order.financials.moneyMovementStatus, "REVIEW_REQUIRED");
  const accounting = computeCompletedOrderAccounting(order, []);
  assert.equal(accounting.ok, true);
  assert.equal(accounting.entries.length, 0);
});
