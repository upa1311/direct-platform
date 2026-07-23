import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  addCartItem,
  createOrderFromCart,
  markOrderDeliveredByDriverWithResult,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type {
  FinancialSnapshot,
  Order,
  PrototypeState,
  RestaurantFinancialCollectionMode,
  SettlementEntry,
} from "./models.ts";
import {
  buildRestaurantDailySettlement,
  buildRestaurantSettlementOverview,
  isTrueLegacyFinancialSnapshot,
  SETTLEMENT_OVERFLOW_ERROR,
  SETTLEMENT_ROW_DATA_STATUS_LABELS,
  type RestaurantSettlementOverview,
  type RestaurantSettlementRow,
} from "./restaurant-settlements.ts";

/**
 * Fail-closed старый ресторанский отчёт: повреждённый современный заказ не
 * маскируется под архивный, а денежные итоги накапливаются только проверенным
 * сложением — при переполнении отчёт отказывается целиком.
 */

const ADDR = { street: "Тестовая улица 1", house: "1" };
const NOW = "2026-07-21T10:00:00.000Z";
const TZ = "Europe/Chisinau";
const RID = "restaurant-2";
const MAX = Number.MAX_SAFE_INTEGER;
const ALL = "RESTAURANT_COLLECTS_ALL" as const;
const MIXED = "MIXED_COLLECTION" as const;
const PAGE = readFileSync("src/app/restaurant/settlements/page.tsx", "utf8");

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

function withFinancials(
  state: PrototypeState,
  orderId: string,
  patch: Partial<FinancialSnapshot>,
): PrototypeState {
  return withOrder(state, orderId, (o) => ({
    ...o,
    financials: { ...o.financials, ...patch },
  }));
}

/** Завершённый доставкой Direct заказ ресторана-2 в заданном режиме. */
function driverCompleted(mode: RestaurantFinancialCollectionMode): {
  state: PrototypeState;
  orderId: string;
} {
  const base = createDefaultState();
  let s = updateCartAddress(
    {
      ...base,
      restaurants: base.restaurants.map((r) =>
        r.id === RID ? { ...r, financialCollectionMode: mode } : r,
      ),
    },
    ADDR,
  );
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  const prepared = withOrder(created.state, orderId, (o) => ({
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

/** Второй завершённый заказ того же ресторана (для агрегатных проверок). */
function twoCompletedOrders(): { state: PrototypeState; orderIds: string[] } {
  const first = driverCompleted(MIXED);
  const base = first.state;
  let s = updateCartAddress(base, ADDR);
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const secondId = created.result.orderId as string;
  const prepared = withOrder(created.state, secondId, (o) => ({
    ...o,
    status: "ARRIVING",
    paymentStatus: "PAID",
    assignedDriverId: "driver-2",
    driverAssignedAt: NOW,
  }));
  const res = markOrderDeliveredByDriverWithResult(prepared, secondId);
  assert.equal(res.result.error, null);
  return { state: res.state, orderIds: [first.orderId, secondId] };
}

/** Отчёт строится «сейчас»: заказы фикстур создаются реальным временем. */
function nowIso(): string {
  return new Date().toISOString();
}

function overviewResult(state: PrototypeState) {
  return buildRestaurantSettlementOverview(state, RID, "ALL", nowIso(), TZ);
}

function okOverview(state: PrototypeState): RestaurantSettlementOverview {
  const result = overviewResult(state);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.overview;
}

function firstRow(state: PrototypeState): RestaurantSettlementRow {
  const row = okOverview(state).rows[0];
  assert.ok(row);
  return row;
}

/** Доказуемо исторический снимок: без движения, правила и режима. */
function toTrueLegacy(
  state: PrototypeState,
  orderId: string,
  compat: Partial<FinancialSnapshot> = {},
): PrototypeState {
  return withOrder(state, orderId, (o) => {
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
        ...compat,
      } as FinancialSnapshot,
    };
  });
}

// --- 1–11: классификация строки ----------------------------------------------

test("1: COMPLETE с движением классифицируется как COMPLETE", () => {
  const { state, orderId } = driverCompleted(ALL);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  const row = firstRow(state);
  assert.equal(row.dataStatus, "COMPLETE");
  assert.equal(row.restaurantNetCents, movement.restaurantNetCents);
  assert.equal(row.paymentChannel, movement.paymentChannel);
});

test("2: COMPLETE без движения → REVIEW_REQUIRED", () => {
  const { state, orderId } = driverCompleted(ALL);
  const broken = withFinancials(state, orderId, {
    moneyMovement: undefined,
    restaurantCollectedFromCustomerCents: 7_777,
    platformCollectedFromCustomerCents: 0,
    platformCommissionReceivableCents: 555,
    restaurantNetAfterPlatformCommissionCents: 6_666,
  });
  const overview = okOverview(broken);
  const row = overview.rows[0];
  assert.ok(row);
  assert.equal(row.dataStatus, "REVIEW_REQUIRED");
  // Compatibility-поля повреждённого современного заказа не читаются.
  assert.equal(row.restaurantCollectedFromCustomerCents, 0);
  assert.equal(row.restaurantNetAfterPlatformCommissionCents, 0);
  assert.equal(row.platformCommissionReceivableCents, 0);
  assert.equal(overview.summary.restaurantNetCents, 0);
  assert.equal(overview.summary.reviewRequiredOrderCount, 1);
});

test("3: явный REVIEW_REQUIRED остаётся REVIEW_REQUIRED", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const broken = withFinancials(state, orderId, {
    moneyMovementStatus: "REVIEW_REQUIRED",
    moneyMovement: undefined,
  });
  assert.equal(firstRow(broken).dataStatus, "REVIEW_REQUIRED");
});

test("4: завершённый PENDING_PAYMENT_CHANNEL → REVIEW_REQUIRED", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const broken = withFinancials(state, orderId, {
    moneyMovementStatus: "PENDING_PAYMENT_CHANNEL",
    moneyMovement: undefined,
    platformCollectedFromCustomerCents: 4_242,
  });
  const row = firstRow(broken);
  assert.equal(row.dataStatus, "REVIEW_REQUIRED");
  assert.equal(row.platformCollectedFromCustomerCents, 0);
});

test("5: неизвестный moneyMovementStatus → REVIEW_REQUIRED", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const broken = withFinancials(state, orderId, {
    moneyMovementStatus:
      "SOMETHING_ELSE" as unknown as FinancialSnapshot["moneyMovementStatus"],
    moneyMovement: undefined,
    platformCollectedFromCustomerCents: 4_242,
  });
  const row = firstRow(broken);
  assert.equal(row.dataStatus, "REVIEW_REQUIRED");
  assert.equal(row.platformCollectedFromCustomerCents, 0);
});

test("6: движение при статусе не COMPLETE → REVIEW_REQUIRED", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const broken = withFinancials(state, orderId, {
    moneyMovementStatus: "PENDING_PAYMENT_CHANNEL",
  });
  const row = firstRow(broken);
  assert.equal(row.dataStatus, "REVIEW_REQUIRED");
  assert.equal(row.restaurantNetCents, null);
});

test("7: настоящий legacy без правила, режима и движения → LEGACY", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const legacy = toTrueLegacy(state, orderId);
  assert.equal(
    isTrueLegacyFinancialSnapshot(orderOf(legacy, orderId).financials),
    true,
  );
  assert.equal(firstRow(legacy).dataStatus, "LEGACY");
});

test("8: legacy-строка сохраняет compatibility-поля", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const legacy = toTrueLegacy(state, orderId, {
    restaurantCollectedFromCustomerCents: 0,
    platformCollectedFromCustomerCents: 4_242,
    platformCommissionReceivableCents: 111,
    restaurantNetAfterPlatformCommissionCents: 2_222,
  });
  const overview = okOverview(legacy);
  const row = overview.rows[0];
  assert.ok(row);
  assert.equal(row.dataStatus, "LEGACY");
  assert.equal(row.collector, "DIRECT");
  assert.equal(row.platformCollectedFromCustomerCents, 4_242);
  assert.equal(row.platformCommissionReceivableCents, 111);
  assert.equal(row.restaurantNetAfterPlatformCommissionCents, 2_222);
  assert.equal(overview.summary.reviewRequiredOrderCount, 0);
  assert.equal(overview.summary.restaurantNetCents, 2_222);
});

test("9: современный повреждённый заказ не использует legacy fallback", () => {
  const { state, orderId } = driverCompleted(ALL);
  // Provenance на месте (значит, заказ современный), движения нет.
  const broken = withFinancials(state, orderId, {
    moneyMovementStatus: "REVIEW_REQUIRED",
    moneyMovement: undefined,
    restaurantCollectedFromCustomerCents: 9_999,
    restaurantNetAfterPlatformCommissionCents: 8_888,
  });
  const fin = orderOf(broken, orderId).financials;
  assert.equal(isTrueLegacyFinancialSnapshot(fin), false);
  const row = firstRow(broken);
  assert.equal(row.dataStatus, "REVIEW_REQUIRED");
  assert.equal(row.restaurantCollectedFromCustomerCents, 0);
  assert.equal(row.restaurantNetAfterPlatformCommissionCents, 0);
});

test("10: REVIEW_REQUIRED не входит в достоверные итоги", () => {
  const { state, orderIds } = twoCompletedOrders();
  const good = okOverview(state);
  const broken = withFinancials(state, orderIds[0], {
    moneyMovementStatus: "REVIEW_REQUIRED",
    moneyMovement: undefined,
  });
  const overview = okOverview(broken);
  assert.equal(overview.summary.reviewRequiredOrderCount, 1);
  assert.equal(overview.summary.completedOrderCount, 2);
  // Итог уменьшился ровно на вклад исключённой строки.
  assert.ok(overview.summary.restaurantNetCents < good.summary.restaurantNetCents);
});

test("11: COMPLETE использует движение при повреждённых compatibility-полях", () => {
  const { state, orderId } = driverCompleted(ALL);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  const corrupted = withFinancials(state, orderId, {
    restaurantCollectedFromCustomerCents: 0,
    platformCollectedFromCustomerCents: 999_999,
    platformCommissionReceivableCents: 999_999,
    restaurantNetAfterPlatformCommissionCents: 999_999,
  });
  const row = firstRow(corrupted);
  assert.equal(row.dataStatus, "COMPLETE");
  assert.equal(row.collector, "RESTAURANT");
  assert.equal(row.platformCollectedFromCustomerCents, 0);
  assert.equal(
    row.restaurantNetAfterPlatformCommissionCents,
    movement.restaurantNetCents,
  );
});

// --- 12–20: переполнение агрегатов обзора -------------------------------------

/** Два заказа, каждый по отдельности безопасный, вместе — вне диапазона. */
function overflowingPair(field: keyof FinancialSnapshot): PrototypeState {
  const { state, orderIds } = twoCompletedOrders();
  let next = state;
  for (const id of orderIds) {
    next = withFinancials(next, id, {
      [field]: MAX - 1,
    } as Partial<FinancialSnapshot>);
  }
  return next;
}

test("12: переполнение суммы клиента → ok:false", () => {
  const result = overviewResult(overflowingPair("customerTotalCents"));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error === SETTLEMENT_OVERFLOW_ERROR);
});

test("13: переполнение продаж блюд → ошибка", () => {
  const result = overviewResult(overflowingPair("foodSubtotalCents"));
  assert.equal(result.ok, false);
});

test("14: переполнение чистой суммы ресторана → ошибка", () => {
  const { state, orderIds } = twoCompletedOrders();
  let next = state;
  for (const id of orderIds) {
    const movement = orderOf(next, id).financials.moneyMovement;
    assert.ok(movement);
    next = withFinancials(next, id, {
      moneyMovement: { ...movement, restaurantNetCents: MAX - 1 },
    });
  }
  const result = overviewResult(next);
  assert.equal(result.ok, false);
});

test("15: переполнение собранного рестораном → ошибка", () => {
  // Собранное рестораном = сумма клиента у ALL-режима.
  const first = driverCompleted(ALL);
  let s = updateCartAddress(first.state, ADDR);
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const secondId = created.result.orderId as string;
  const prepared = withOrder(created.state, secondId, (o) => ({
    ...o,
    status: "ARRIVING",
    paymentStatus: "PAID",
    assignedDriverId: "driver-2",
    driverAssignedAt: NOW,
  }));
  const delivered = markOrderDeliveredByDriverWithResult(prepared, secondId);
  assert.equal(delivered.result.error, null);
  let next = delivered.state;
  for (const id of [first.orderId, secondId]) {
    next = withFinancials(next, id, { customerTotalCents: MAX - 1 });
  }
  const result = overviewResult(next);
  assert.equal(result.ok, false);
});

test("16: переполнение собранного Direct → ошибка", () => {
  const result = overviewResult(overflowingPair("customerTotalCents"));
  assert.equal(result.ok, false);
  // MIXED-заказы: вся сумма клиента считается собранной Direct.
  const { state, orderIds } = twoCompletedOrders();
  const rows = okOverview(state).rows;
  assert.equal(rows.length, orderIds.length);
  assert.ok(rows.every((row) => row.collector === "DIRECT"));
});

test("17: переполнение комиссии → ошибка", () => {
  const { state, orderIds } = twoCompletedOrders();
  let next = state;
  for (const id of orderIds) {
    next = toTrueLegacy(next, id, {
      platformCommissionReceivableCents: MAX - 1,
      restaurantCollectedFromCustomerCents: 0,
      platformCollectedFromCustomerCents: 0,
      restaurantNetAfterPlatformCommissionCents: 0,
      customerTotalCents: 0,
      foodSubtotalCents: 0,
    });
  }
  const result = overviewResult(next);
  assert.equal(result.ok, false);
});

test("18: переполнение ожидающего начисления по одному заказу → ошибка", () => {
  const { state, orderIds } = twoCompletedOrders();
  const pending = (id: string, suffix: string): SettlementEntry => ({
    id: `settlement-${id}-${suffix}`,
    orderId: id,
    restaurantId: RID,
    type: "PICKUP_COMMISSION",
    amountCents: MAX - 1,
    status: "PENDING",
    createdAt: NOW,
  });
  const next: PrototypeState = {
    ...state,
    settlements: [pending(orderIds[0], "a"), pending(orderIds[0], "b")],
  };
  const result = overviewResult(next);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error === SETTLEMENT_OVERFLOW_ERROR);
});

test("19: переполнение ожидающего начисления между заказами → ошибка", () => {
  const { state, orderIds } = twoCompletedOrders();
  const pending = (id: string): SettlementEntry => ({
    id: `settlement-${id}`,
    orderId: id,
    restaurantId: RID,
    type: "PICKUP_COMMISSION",
    amountCents: MAX - 1,
    status: "PENDING",
    createdAt: NOW,
  });
  const next: PrototypeState = {
    ...state,
    settlements: orderIds.map(pending),
  };
  const result = overviewResult(next);
  assert.equal(result.ok, false);
});

test("20: ошибка не возвращает частичный отчёт", () => {
  const result = overviewResult(overflowingPair("customerTotalCents"));
  assert.equal(result.ok, false);
  assert.ok(!("overview" in result));
  assert.ok(!result.ok && typeof result.error === "string");
});

// --- 21–25: дневная сверка ----------------------------------------------------

function dailyResult(state: PrototypeState) {
  return buildRestaurantDailySettlement(state, RID, "ALL", nowIso(), TZ);
}

test("21: переполнение внутри дня → ok:false", () => {
  const result = dailyResult(overflowingPair("customerTotalCents"));
  assert.equal(result.ok, false);
});

test("22: переполнение между строками одного дня → ok:false", () => {
  const { state, orderIds } = twoCompletedOrders();
  // Обе строки одного дня; по отдельности суммы безопасны.
  let next = state;
  for (const id of orderIds) {
    next = withFinancials(next, id, { foodSubtotalCents: MAX - 1 });
  }
  const result = dailyResult(next);
  assert.equal(result.ok, false);
});

test("23: ошибка обзора передаётся дневной сверке", () => {
  const broken = overflowingPair("customerTotalCents");
  const overview = overviewResult(broken);
  const daily = dailyResult(broken);
  assert.equal(overview.ok, false);
  assert.equal(daily.ok, false);
  assert.ok(
    !overview.ok && !daily.ok && overview.error === daily.error,
  );
});

test("24: дневная сверка не возвращает частичные дни", () => {
  const result = dailyResult(overflowingPair("customerTotalCents"));
  assert.equal(result.ok, false);
  assert.ok(!("days" in result));
});

test("25: нормальные дневные итоги совпадают с итогами обзора", () => {
  const { state } = twoCompletedOrders();
  const overview = okOverview(state);
  const daily = dailyResult(state);
  assert.ok(daily.ok);
  const sum = (pick: (d: (typeof daily.days)[number]) => number) =>
    daily.days.reduce((acc, day) => acc + pick(day), 0);
  assert.equal(sum((d) => d.customerTotalCents), overview.summary.customerTotalCents);
  assert.equal(sum((d) => d.foodSubtotalCents), overview.summary.foodSubtotalCents);
  assert.equal(sum((d) => d.restaurantNetCents), overview.summary.restaurantNetCents);
  assert.equal(
    sum((d) => d.completedOrderCount),
    overview.summary.completedOrderCount,
  );
});

// --- 26–30: контракт страницы -------------------------------------------------

test("26: страница обрабатывает неуспешный результат обзора", () => {
  assert.ok(PAGE.includes("overviewResult && overviewResult.ok"));
  assert.ok(PAGE.includes("dailyResult && dailyResult.ok"));
  assert.ok(PAGE.includes("const reportError ="));
});

test("27: страница показывает предупреждение с role=alert", () => {
  assert.ok(PAGE.includes('role="alert"'));
  assert.ok(
    PAGE.includes("Не удалось безопасно сформировать финансовый отчёт."),
  );
});

test("28: страница не использует result как готовый обзор", () => {
  // Ни одного прямого обращения к полям обзора через result-переменную.
  assert.ok(!/overviewResult\.(summary|rows|paidCanceled|currencyCode)/.test(PAGE));
  assert.ok(!/dailyResult\.map|dailyResult\.length/.test(PAGE));
  // Итоги отрисовываются только при отсутствии ошибки.
  assert.ok(PAGE.includes("isPeriodReport && !reportError && overview"));
});

test("29: переключатель периода продолжает работать", () => {
  const { state } = twoCompletedOrders();
  for (const period of ["TODAY", "LAST_7_DAYS", "LAST_30_DAYS", "ALL"] as const) {
    const result = buildRestaurantSettlementOverview(
      state,
      RID,
      period,
      nowIso(),
      TZ,
    );
    assert.ok(result.ok, period);
  }
  assert.ok(PAGE.includes("RESTAURANT_SETTLEMENT_PERIOD_ORDER.map"));
});

test("30: детали заказа продолжают работать", () => {
  const { state } = twoCompletedOrders();
  const row = firstRow(state);
  assert.ok(row.publicNumber.length > 0);
  assert.ok(PAGE.includes("<OrderDetails row={row} money={money} />"));
  assert.ok(PAGE.includes("Источник данных"));
});

// --- 31–36: регрессия ---------------------------------------------------------

test("31: ALL-заказ по-прежнему собран рестораном", () => {
  const { state } = driverCompleted(ALL);
  assert.equal(firstRow(state).collector, "RESTAURANT");
});

test("32: MIXED-заказ по-прежнему собран Direct", () => {
  const { state } = driverCompleted(MIXED);
  assert.equal(firstRow(state).collector, "DIRECT");
});

test("33: счётчик REVIEW_REQUIRED считается корректно", () => {
  const { state, orderIds } = twoCompletedOrders();
  const broken = withFinancials(state, orderIds[0], {
    moneyMovementStatus: "REVIEW_REQUIRED",
    moneyMovement: undefined,
  });
  const overview = okOverview(broken);
  assert.equal(overview.summary.reviewRequiredOrderCount, 1);
  const bothBroken = withFinancials(broken, orderIds[1], {
    moneyMovementStatus: "REVIEW_REQUIRED",
    moneyMovement: undefined,
  });
  assert.equal(okOverview(bothBroken).summary.reviewRequiredOrderCount, 2);
});

test("34: подпись архивных данных не изменилась", () => {
  assert.equal(SETTLEMENT_ROW_DATA_STATUS_LABELS.LEGACY, "Архивные данные");
  assert.equal(SETTLEMENT_ROW_DATA_STATUS_LABELS.COMPLETE, "Данные подтверждены");
  assert.equal(
    SETTLEMENT_ROW_DATA_STATUS_LABELS.REVIEW_REQUIRED,
    "Требует проверки",
  );
});

test("35: версия схемы актуальна", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 20);
});

test("36: нормальный отчёт остаётся успешным и не мутирует state", () => {
  const { state } = twoCompletedOrders();
  const before = JSON.stringify(state);
  const overview = okOverview(state);
  assert.equal(overview.rows.length, 2);
  assert.equal(overview.summary.reviewRequiredOrderCount, 0);
  assert.ok(overview.summary.restaurantNetCents > 0);
  assert.equal(JSON.stringify(state), before);
});
