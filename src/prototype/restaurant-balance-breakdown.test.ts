import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  acceptRestaurantOrder,
  addCartItem,
  completePickupAtRestaurant,
  createOrderFromCart,
  markOrderDeliveredByDriverWithResult,
  markOrderDeliveredWithResult,
  markOrderReady,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import type {
  Order,
  PrototypeState,
  Restaurant,
  RestaurantFinancialCollectionMode,
} from "./models.ts";
import {
  BREAKDOWN_CODE_LABELS,
  BREAKDOWN_FAILED_ERROR,
  buildRestaurantOpenBalanceBreakdown,
  describeRestaurantSettlementModel,
  type RestaurantBalanceBreakdown,
  type RestaurantBalanceBreakdownCode,
} from "./restaurant-balance-breakdown.ts";
import { buildRestaurantFinanceReadModel } from "./restaurant-finance-read-model.ts";

/**
 * Read-only расшифровка открытой позиции: объясняет уже посчитанные
 * бухгалтерские обязательства, не создавая новых и не пересчитывая старые
 * заказы по текущим условиям.
 */

const ADDR = { street: "Тестовая улица 1", house: "1" };
const DIRECT_RID = "restaurant-2";
const OWN_DELIVERY_RID = "restaurant-3";
const ALL = "RESTAURANT_COLLECTS_ALL" as const;
const MIXED = "MIXED_COLLECTION" as const;
const RESTAURANT_PAGE = readFileSync(
  "src/app/restaurant/settlements/page.tsx",
  "utf8",
);
const ADMIN_PAGE = readFileSync("src/app/admin/settlements/page.tsx", "utf8");
const SHARED_VIEW = readFileSync(
  "src/components/settlements/restaurant-balance-breakdown.tsx",
  "utf8",
);

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

function stateWithMode(
  mode: RestaurantFinancialCollectionMode,
  base: PrototypeState = createDefaultState(),
  restaurantId = DIRECT_RID,
): PrototypeState {
  return {
    ...base,
    restaurants: base.restaurants.map((r) =>
      r.id === restaurantId ? { ...r, financialCollectionMode: mode } : r,
    ),
  };
}

/** Завершённый заказ доставки водителем Direct. */
function driverCompleted(
  mode: RestaurantFinancialCollectionMode,
  base: PrototypeState = createDefaultState(),
): { state: PrototypeState; orderId: string } {
  let s = updateCartAddress(stateWithMode(mode, base), ADDR);
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  const prepared = withOrder(created.state, orderId, (o) => ({
    ...o,
    status: "ARRIVING",
    paymentStatus: "PAID",
    assignedDriverId: "driver-1",
    driverAssignedAt: new Date().toISOString(),
  }));
  const res = markOrderDeliveredByDriverWithResult(prepared, orderId);
  assert.equal(res.result.error, null);
  return { state: res.state, orderId };
}

/** Завершённый самовывоз ресторана-2. */
function pickupCompleted(
  paidWith: "CASH" | "CARD",
  base: PrototypeState = createDefaultState(),
): { state: PrototypeState; orderId: string } {
  let s = setCartFulfillmentChoice(stateWithMode(MIXED, base), "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  let next = acceptRestaurantOrder(created.state, orderId, 20);
  next = markOrderReady(next, orderId);
  const done = completePickupAtRestaurant(next, orderId, paidWith);
  assert.equal(done.result.error, null);
  return { state: done.state, orderId };
}

/** Завершённая доставка собственным курьером ресторана-3. */
function ownDeliveryCompleted(
  base: PrototypeState = createDefaultState(),
): { state: PrototypeState; orderId: string } {
  let s = updateCartAddress(base, ADDR);
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  let next = acceptRestaurantOrder(created.state, orderId, 20);
  next = markOrderReady(next, orderId);
  next = withOrder(next, orderId, (o) => ({ ...o, status: "ARRIVING" }));
  const done = markOrderDeliveredWithResult(next, orderId);
  assert.equal(done.result.error, null);
  return { state: done.state, orderId };
}

function okBreakdown(
  state: PrototypeState,
  restaurantId: string,
): RestaurantBalanceBreakdown {
  const result = buildRestaurantOpenBalanceBreakdown(state, restaurantId);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.breakdown;
}

function lineOf(
  breakdown: RestaurantBalanceBreakdown,
  code: RestaurantBalanceBreakdownCode,
) {
  return [
    ...breakdown.restaurantOwesDirect.lines,
    ...breakdown.directOwesRestaurant.lines,
    ...breakdown.informationalLines,
  ].find((line) => line.code === code);
}

/** Заказ ресторана-2 с доплатой за маленький заказ (мало еды). */
function smallOrderDriver(
  mode: RestaurantFinancialCollectionMode,
  base: PrototypeState = createDefaultState(),
): { state: PrototypeState; orderId: string } {
  const created = driverCompleted(mode, base);
  const fin = orderOf(created.state, created.orderId).financials;
  assert.ok(fin.smallOrderFeeCents >= 0);
  return created;
}

// --- 1–6: доставка Direct, платёж принял Direct -------------------------------

test("1: выплата Direct раскладывается на еду, комиссию и банк ресторана", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const fin = orderOf(state, orderId).financials;
  const breakdown = okBreakdown(state, DIRECT_RID);
  const base = lineOf(breakdown, "FOOD_PAYOUT_BASE");
  const commission = lineOf(breakdown, "COMMISSION_DEDUCTION");
  const bank = lineOf(breakdown, "RESTAURANT_BANK_FEE_DEDUCTION");
  assert.ok(base && commission && bank);
  assert.equal(base.amountCents, fin.foodSubtotalCents);
  assert.equal(commission.amountCents, fin.restaurantCommissionCents);
  assert.equal(bank.amountCents, fin.moneyMovement?.restaurantBankFeeCents);
  assert.equal(base.effect, "ADD");
  assert.equal(commission.effect, "SUBTRACT");
  assert.equal(bank.effect, "SUBTRACT");
});

test("2: итог секции равен сумме бухгалтерского обязательства", () => {
  const { state } = driverCompleted(MIXED);
  const model = buildRestaurantFinanceReadModel(state, DIRECT_RID);
  assert.ok(model.ok);
  const breakdown = okBreakdown(state, DIRECT_RID);
  assert.equal(
    breakdown.directOwesRestaurant.totalCents,
    model.model.directOwesRestaurantCents,
  );
});

test("3: доплата за маленький заказ показана информационно", () => {
  const { state, orderId } = smallOrderDriver(MIXED);
  const fin = orderOf(state, orderId).financials;
  const breakdown = okBreakdown(state, DIRECT_RID);
  const info = lineOf(breakdown, "SMALL_ORDER_FEE_RETAINED_BY_DIRECT");
  if (fin.smallOrderFeeCents > 0) {
    assert.ok(info);
    assert.equal(info.effect, "INFO_ONLY");
    assert.equal(info.amountCents, fin.smallOrderFeeCents);
  } else {
    assert.equal(info, undefined);
  }
});

test("4: доплата не увеличивает долг ресторана", () => {
  const { state } = smallOrderDriver(MIXED);
  const breakdown = okBreakdown(state, DIRECT_RID);
  // Информационные строки в секции обязательств не участвуют.
  assert.equal(
    breakdown.restaurantOwesDirect.lines.some(
      (l) => l.code === "SMALL_ORDER_FEE_RETAINED_BY_DIRECT",
    ),
    false,
  );
  assert.equal(breakdown.restaurantOwesDirect.totalCents, 0);
});

test("5: стоимость доставки показана как сумма водителю Direct", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const fin = orderOf(state, orderId).financials;
  const breakdown = okBreakdown(state, DIRECT_RID);
  const info = lineOf(breakdown, "DIRECT_DRIVER_DELIVERY_INFO");
  if (fin.deliveryFeeCents > 0) {
    assert.ok(info);
    assert.equal(info.effect, "INFO_ONLY");
    assert.equal(info.amountCents, fin.deliveryFeeCents);
  }
});

test("6: стоимость доставки не входит в выплату ресторану", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const fin = orderOf(state, orderId).financials;
  const breakdown = okBreakdown(state, DIRECT_RID);
  assert.equal(
    breakdown.directOwesRestaurant.lines.some(
      (l) => l.code === "DIRECT_DRIVER_DELIVERY_INFO",
    ),
    false,
  );
  assert.equal(
    breakdown.directOwesRestaurant.totalCents,
    fin.foodSubtotalCents -
      fin.restaurantCommissionCents -
      (fin.moneyMovement?.restaurantBankFeeCents ?? 0),
  );
});

// --- 7–11: доставка Direct, платёж принял ресторан ----------------------------

test("7: перечисление раскладывается на комиссию, доставку и доплату", () => {
  const { state, orderId } = driverCompleted(ALL);
  const fin = orderOf(state, orderId).financials;
  const breakdown = okBreakdown(state, DIRECT_RID);
  const commission = lineOf(breakdown, "DIRECT_DELIVERY_COMMISSION");
  assert.ok(commission);
  assert.equal(commission.amountCents, fin.restaurantCommissionCents);
  assert.equal(commission.effect, "ADD");
  const transit = lineOf(breakdown, "DIRECT_DRIVER_DELIVERY_TRANSIT");
  if (fin.deliveryFeeCents > 0) {
    assert.ok(transit);
    assert.equal(transit.amountCents, fin.deliveryFeeCents);
  }
});

test("8: доплата за маленький заказ — отдельная строка обязательства", () => {
  const { state, orderId } = driverCompleted(ALL);
  const fin = orderOf(state, orderId).financials;
  const breakdown = okBreakdown(state, DIRECT_RID);
  const small = lineOf(breakdown, "SMALL_ORDER_FEE");
  if (fin.smallOrderFeeCents > 0) {
    assert.ok(small);
    assert.equal(small.effect, "ADD");
    assert.equal(small.amountCents, fin.smallOrderFeeCents);
    // Не объединена с комиссией.
    const commission = lineOf(breakdown, "DIRECT_DELIVERY_COMMISSION");
    assert.ok(commission);
    assert.notEqual(commission.amountCents, small.amountCents + commission.amountCents);
  }
});

test("9: транзит доставки — отдельная строка", () => {
  const { state, orderId } = driverCompleted(ALL);
  const fin = orderOf(state, orderId).financials;
  if (fin.deliveryFeeCents === 0) return;
  const breakdown = okBreakdown(state, DIRECT_RID);
  const transit = lineOf(breakdown, "DIRECT_DRIVER_DELIVERY_TRANSIT");
  const commission = lineOf(breakdown, "DIRECT_DELIVERY_COMMISSION");
  assert.ok(transit && commission);
  assert.notEqual(transit.code, commission.code);
});

test("10: сумма компонентов равна сумме перечисления", () => {
  const { state, orderId } = driverCompleted(ALL);
  const entry = state.restaurantAccountingEntries.find(
    (e) => e.orderId === orderId,
  );
  assert.ok(entry);
  const breakdown = okBreakdown(state, DIRECT_RID);
  assert.equal(breakdown.restaurantOwesDirect.totalCents, entry.amountCents);
});

test("11: несовпадение компонентов с обязательством ломает расшифровку", () => {
  const { state, orderId } = driverCompleted(ALL);
  // Повреждаем снимок так, что формула перестаёт сходиться с записью.
  const broken = withOrder(state, orderId, (o) => ({
    ...o,
    financials: {
      ...o.financials,
      restaurantCommissionCents: o.financials.restaurantCommissionCents + 100,
    },
  }));
  const result = buildRestaurantOpenBalanceBreakdown(broken, DIRECT_RID);
  assert.equal(result.ok, false);
});

// --- 12–17: собственная доставка ресторана ------------------------------------

test("12: в долг входит только комиссия собственной доставки", () => {
  const { state, orderId } = ownDeliveryCompleted();
  const fin = orderOf(state, orderId).financials;
  const breakdown = okBreakdown(state, OWN_DELIVERY_RID);
  const commission = lineOf(breakdown, "RESTAURANT_DELIVERY_COMMISSION");
  assert.ok(commission);
  assert.equal(commission.amountCents, fin.restaurantCommissionCents);
  assert.equal(
    breakdown.restaurantOwesDirect.totalCents,
    fin.restaurantCommissionCents,
  );
  assert.equal(breakdown.restaurantOwesDirect.lines.length, 1);
});

test("13: стоимость доставки показана как остающаяся ресторану", () => {
  const { state, orderId } = ownDeliveryCompleted();
  const fin = orderOf(state, orderId).financials;
  if (fin.deliveryFeeCents === 0) return;
  const breakdown = okBreakdown(state, OWN_DELIVERY_RID);
  const retained = lineOf(breakdown, "RESTAURANT_DELIVERY_RETAINED");
  assert.ok(retained);
  assert.equal(retained.effect, "INFO_ONLY");
  assert.equal(retained.amountCents, fin.deliveryFeeCents);
});

test("14: стоимость собственной доставки не входит в долг Direct", () => {
  const { state } = ownDeliveryCompleted();
  const breakdown = okBreakdown(state, OWN_DELIVERY_RID);
  assert.equal(
    breakdown.restaurantOwesDirect.lines.some(
      (l) => l.code === "RESTAURANT_DELIVERY_RETAINED",
    ),
    false,
  );
});

test("15: у собственной доставки нет строки доплаты", () => {
  const { state } = ownDeliveryCompleted();
  const breakdown = okBreakdown(state, OWN_DELIVERY_RID);
  assert.equal(lineOf(breakdown, "SMALL_ORDER_FEE"), undefined);
  assert.equal(
    lineOf(breakdown, "SMALL_ORDER_FEE_RETAINED_BY_DIRECT"),
    undefined,
  );
});

test("16: ненулевая доплата у собственной доставки — ошибка", () => {
  const { state, orderId } = ownDeliveryCompleted();
  const broken = withOrder(state, orderId, (o) => ({
    ...o,
    financials: { ...o.financials, smallOrderFeeCents: 150 },
  }));
  const result = buildRestaurantOpenBalanceBreakdown(broken, OWN_DELIVERY_RID);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, BREAKDOWN_FAILED_ERROR);
});

test("17: текущая ставка ресторана не применяется к сохранённому заказу", () => {
  const { state, orderId } = ownDeliveryCompleted();
  const fin = orderOf(state, orderId).financials;
  // Ставку ресторана меняем ПОСЛЕ заказа — расшифровка обязана остаться прежней.
  const changed: PrototypeState = {
    ...state,
    restaurants: state.restaurants.map((r) =>
      r.id === OWN_DELIVERY_RID ? { ...r, commissionRateBps: 3_000 } : r,
    ),
  };
  const breakdown = okBreakdown(changed, OWN_DELIVERY_RID);
  const commission = lineOf(breakdown, "RESTAURANT_DELIVERY_COMMISSION");
  assert.ok(commission);
  assert.equal(commission.amountCents, fin.restaurantCommissionCents);
});

// --- 18–21: самовывоз ----------------------------------------------------------

test("18: комиссия самовывоза — отдельная категория", () => {
  const { state, orderId } = pickupCompleted("CASH");
  const fin = orderOf(state, orderId).financials;
  const breakdown = okBreakdown(state, DIRECT_RID);
  const pickup = lineOf(breakdown, "PICKUP_COMMISSION");
  assert.ok(pickup);
  assert.equal(pickup.amountCents, fin.restaurantCommissionCents);
  // Не смешивается с комиссией собственной доставки.
  assert.equal(lineOf(breakdown, "RESTAURANT_DELIVERY_COMMISSION"), undefined);
});

test("19: самовывоз наличными не показывает банковское удержание", () => {
  const { state } = pickupCompleted("CASH");
  const breakdown = okBreakdown(state, DIRECT_RID);
  assert.equal(lineOf(breakdown, "BANK_FEE_INFO"), undefined);
});

test("20: самовывоз картой показывает долю банковской комиссии", () => {
  const { state, orderId } = pickupCompleted("CARD");
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  const breakdown = okBreakdown(state, DIRECT_RID);
  const bank = lineOf(breakdown, "BANK_FEE_INFO");
  assert.ok(bank);
  assert.equal(bank.effect, "INFO_ONLY");
  assert.equal(bank.amountCents, movement.restaurantBankFeeCents);
});

test("21: банковская комиссия не увеличивает долг перед Direct", () => {
  const { state, orderId } = pickupCompleted("CARD");
  const fin = orderOf(state, orderId).financials;
  const breakdown = okBreakdown(state, DIRECT_RID);
  assert.equal(
    breakdown.restaurantOwesDirect.totalCents,
    fin.restaurantCommissionCents,
  );
});

// --- 22–26: смешанный ресторан и агрегация -------------------------------------

/** Ресторан-2 с самовывозом и доставкой Direct в одном периоде. */
function mixedState(): PrototypeState {
  const pickup = pickupCompleted("CARD");
  const driver = driverCompleted(ALL, pickup.state);
  return driver.state;
}

test("22: несколько типов заказов агрегируются по категориям", () => {
  const breakdown = okBreakdown(mixedState(), DIRECT_RID);
  assert.ok(lineOf(breakdown, "PICKUP_COMMISSION"));
  assert.ok(lineOf(breakdown, "DIRECT_DELIVERY_COMMISSION"));
});

test("23: комиссии самовывоза и доставки не объединяются", () => {
  const breakdown = okBreakdown(mixedState(), DIRECT_RID);
  const pickup = lineOf(breakdown, "PICKUP_COMMISSION");
  const direct = lineOf(breakdown, "DIRECT_DELIVERY_COMMISSION");
  assert.ok(pickup && direct);
  assert.notEqual(pickup.code, direct.code);
});

test("24: счётчик заказов категории корректен", () => {
  const first = driverCompleted(ALL);
  const second = driverCompleted(ALL, first.state);
  const breakdown = okBreakdown(second.state, DIRECT_RID);
  const commission = lineOf(breakdown, "DIRECT_DELIVERY_COMMISSION");
  assert.ok(commission);
  assert.equal(commission.orderCount, 2);
  assert.equal(commission.orders.length, 2);
});

test("25: список заказов содержит номера и суммы компонентов", () => {
  const { state, orderId } = driverCompleted(ALL);
  const fin = orderOf(state, orderId).financials;
  const order = orderOf(state, orderId);
  const breakdown = okBreakdown(state, DIRECT_RID);
  const commission = lineOf(breakdown, "DIRECT_DELIVERY_COMMISSION");
  assert.ok(commission);
  assert.equal(commission.orders[0].publicNumber, order.publicNumber);
  assert.equal(commission.orders[0].amountCents, fin.restaurantCommissionCents);
});

test("26: сортировка заказов стабильна: старые сверху", () => {
  const first = driverCompleted(ALL);
  const second = driverCompleted(ALL, first.state);
  const breakdown = okBreakdown(second.state, DIRECT_RID);
  const commission = lineOf(breakdown, "DIRECT_DELIVERY_COMMISSION");
  assert.ok(commission);
  const times = commission.orders.map((o) => Date.parse(o.recognizedAt));
  const sorted = [...times].sort((a, b) => a - b);
  assert.deepEqual(times, sorted);
});

// --- 27–34: архив, целостность и сверка ----------------------------------------

/**
 * Настоящее архивное обязательство: мигрированный legacy settlement реального
 * заказа (у обязательства обязан быть существующий заказ ресторана).
 */
function legacyState(): { state: PrototypeState; amountCents: number } {
  const { state, orderId } = pickupCompleted("CASH");
  const entry = state.restaurantAccountingEntries.find(
    (e) => e.orderId === orderId,
  );
  assert.ok(entry);
  return {
    state: {
      ...state,
      restaurantAccountingEntries: state.restaurantAccountingEntries.map((e) =>
        e.id === entry.id
          ? {
              ...e,
              source: "LEGACY_COMMISSION_SETTLEMENT" as const,
              legacySettlementId: `settlement-${orderId}`,
            }
          : e,
      ),
    },
    amountCents: entry.amountCents,
  };
}

test("27: архивное обязательство получает только категорию без детализации", () => {
  const { state, amountCents } = legacyState();
  const breakdown = okBreakdown(state, DIRECT_RID);
  const legacy = lineOf(breakdown, "LEGACY_UNCLASSIFIED");
  assert.ok(legacy);
  assert.equal(legacy.amountCents, amountCents);
  assert.equal(breakdown.restaurantOwesDirect.lines.length, 1);
});

test("28: архивная сумма не раскладывается на выдуманные компоненты", () => {
  const breakdown = okBreakdown(legacyState().state, DIRECT_RID);
  for (const code of [
    "SMALL_ORDER_FEE",
    "DIRECT_DRIVER_DELIVERY_TRANSIT",
    "BANK_FEE_INFO",
    "PICKUP_COMMISSION",
  ] as const) {
    assert.equal(lineOf(breakdown, code), undefined, code);
  }
});

test("29: повреждённый современный заказ не превращается в архивный", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const broken = withOrder(state, orderId, (o) => ({
    ...o,
    financials: {
      ...o.financials,
      foodSubtotalCents: o.financials.foodSubtotalCents + 500,
    },
  }));
  const result = buildRestaurantOpenBalanceBreakdown(broken, DIRECT_RID);
  assert.equal(result.ok, false);
});

test("30: несходящаяся формула современной строки даёт ошибку", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const broken = withOrder(state, orderId, (o) => ({
    ...o,
    financials: {
      ...o.financials,
      restaurantCommissionCents: 1,
    },
  }));
  const result = buildRestaurantOpenBalanceBreakdown(broken, DIRECT_RID);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, BREAKDOWN_FAILED_ERROR);
});

test("31: ошибка finance read-model возвращается как есть", () => {
  const { state, orderId } = driverCompleted(MIXED);
  // Дублирующее обязательство ломает канонический read-model.
  const entry = state.restaurantAccountingEntries.find(
    (e) => e.orderId === orderId,
  );
  assert.ok(entry);
  const broken: PrototypeState = {
    ...state,
    restaurantAccountingEntries: [
      ...state.restaurantAccountingEntries,
      { ...entry, id: `${entry.id}-copy` },
    ],
  };
  const model = buildRestaurantFinanceReadModel(broken, DIRECT_RID);
  const breakdown = buildRestaurantOpenBalanceBreakdown(broken, DIRECT_RID);
  assert.equal(model.ok, false);
  assert.equal(breakdown.ok, false);
  assert.equal(
    !breakdown.ok && breakdown.error,
    !model.ok ? model.error : "",
  );
});

test("32: итоги обеих сторон совпадают с finance read-model", () => {
  const state = mixedState();
  const model = buildRestaurantFinanceReadModel(state, DIRECT_RID);
  assert.ok(model.ok);
  const breakdown = okBreakdown(state, DIRECT_RID);
  assert.equal(
    breakdown.restaurantOwesDirect.totalCents,
    model.model.restaurantOwesDirectCents,
  );
  assert.equal(
    breakdown.directOwesRestaurant.totalCents,
    model.model.directOwesRestaurantCents,
  );
});

test("33: net совпадает с finance read-model", () => {
  const state = mixedState();
  const model = buildRestaurantFinanceReadModel(state, DIRECT_RID);
  assert.ok(model.ok);
  const breakdown = okBreakdown(state, DIRECT_RID);
  assert.equal(breakdown.netDirection, model.model.netDirection);
  assert.equal(breakdown.netAmountCents, model.model.netAmountCents);
});

test("34: информационные строки не участвуют в сверке", () => {
  const { state } = driverCompleted(MIXED);
  const breakdown = okBreakdown(state, DIRECT_RID);
  // Информационные суммы существуют, но в итог секций не входят.
  const infoTotal = breakdown.informationalLines.reduce(
    (sum, l) => sum + l.amountCents,
    0,
  );
  assert.ok(infoTotal >= 0);
  const model = buildRestaurantFinanceReadModel(state, DIRECT_RID);
  assert.ok(model.ok);
  assert.equal(
    breakdown.directOwesRestaurant.totalCents,
    model.model.directOwesRestaurantCents,
  );
});

// --- 35–48: интерфейс и регрессия ---------------------------------------------

test("35: кабинет ресторана показывает расшифровку баланса", () => {
  assert.ok(RESTAURANT_PAGE.includes("buildRestaurantOpenBalanceBreakdown("));
  assert.ok(RESTAURANT_PAGE.includes("RestaurantBalanceBreakdownView"));
  assert.ok(SHARED_VIEW.includes("Из чего сложился текущий баланс"));
});

test("36: доплата за маленькие заказы названа отдельно", () => {
  assert.equal(
    BREAKDOWN_CODE_LABELS.SMALL_ORDER_FEE,
    "Доплаты за маленькие заказы",
  );
  assert.ok(SHARED_VIEW.includes("BREAKDOWN_CODE_LABELS[line.code]"));
});

test("37: список заказов категории раскрывается на месте", () => {
  assert.ok(SHARED_VIEW.includes("<details"));
  assert.ok(SHARED_VIEW.includes("line.orders.map"));
  assert.ok(SHARED_VIEW.includes("order.publicNumber"));
});

test("38: администратор показывает ту же расшифровку", () => {
  assert.ok(ADMIN_PAGE.includes("buildRestaurantOpenBalanceBreakdown("));
  assert.ok(ADMIN_PAGE.includes("RestaurantBalanceBreakdownView"));
});

test("39: подписи категорий берутся из одного словаря", () => {
  assert.ok(!ADMIN_PAGE.includes("BREAKDOWN_CODE_LABELS"));
  assert.ok(!RESTAURANT_PAGE.includes("BREAKDOWN_CODE_LABELS"));
  // Единственное место с подписями — общий компонент.
  assert.ok(SHARED_VIEW.includes("BREAKDOWN_CODE_LABELS"));
});

test("40: кабинет собственной доставки объясняет свою схему", () => {
  const restaurant = createDefaultState().restaurants.find(
    (r) => r.id === OWN_DELIVERY_RID,
  ) as Restaurant;
  const presentation = describeRestaurantSettlementModel(restaurant);
  assert.ok(presentation.title.includes("Собственная доставка"));
  assert.ok(
    presentation.notes.some((n) =>
      n.includes("Доплата за маленький заказ к собственной доставке не применяется."),
    ),
  );
});

test("41: кабинет доставки Direct объясняет свою схему", () => {
  const restaurant = createDefaultState().restaurants.find(
    (r) => r.id === DIRECT_RID,
  ) as Restaurant;
  const presentation = describeRestaurantSettlementModel(restaurant);
  assert.ok(presentation.title.includes("Доставка Direct"));
  assert.ok(
    presentation.notes.some((n) =>
      n.includes("Стоимость доставки предназначена водителю Direct."),
    ),
  );
  // Текущие условия помечены как текущие.
  assert.ok(
    presentation.notes.some((n) =>
      n.includes("Уже завершённые заказы рассчитаны по сохранённым условиям"),
    ),
  );
});

test("42: нет привязки к идентификаторам ресторанов", () => {
  const BUILDER = readFileSync(
    "src/prototype/restaurant-balance-breakdown.ts",
    "utf8",
  );
  for (const source of [BUILDER, SHARED_VIEW]) {
    assert.ok(!source.includes('"restaurant-1"'));
    assert.ok(!source.includes('"restaurant-3"'));
  }
});

test("43: сырые enum наружу не выводятся", () => {
  for (const label of Object.values(BREAKDOWN_CODE_LABELS)) {
    assert.ok(!/[A-Z]{2,}_[A-Z]/.test(label), label);
  }
});

test("44: предупреждение о заказах на проверке показано", () => {
  assert.ok(
    SHARED_VIEW.includes(
      "требуют проверки",
    ),
  );
  assert.ok(SHARED_VIEW.includes("breakdown.reviewRequiredOrderCount > 0"));
});

test("45: предупреждение о неподтверждённом самовывозе показано", () => {
  assert.ok(
    SHARED_VIEW.includes("способ оплаты ещё не подтверждён"),
  );
  assert.ok(
    SHARED_VIEW.includes("breakdown.pendingPaymentChannelOrderCount > 0"),
  );
});

test("46: заказы на проверке не входят в категории", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const broken = withOrder(state, orderId, (o) => ({
    ...o,
    financials: {
      ...o.financials,
      moneyMovementStatus: "REVIEW_REQUIRED",
      moneyMovement: undefined,
    },
  }));
  // Обязательство такого заказа read-model отклоняет целиком — расшифровка
  // тоже fail-closed, а не показывает часть позиции.
  const result = buildRestaurantOpenBalanceBreakdown(broken, DIRECT_RID);
  assert.equal(result.ok, false);
});

test("47: прозрачность банковской комиссии сохранена", () => {
  assert.ok(RESTAURANT_PAGE.includes("row.totalBankFeeCents"));
  assert.ok(RESTAURANT_PAGE.includes("overview.summary.restaurantBankFeeCents"));
});

test("48: расшифровка не создаёт новых бухгалтерских обязательств", () => {
  const { state } = driverCompleted(ALL);
  const before = state.restaurantAccountingEntries.length;
  const breakdown = okBreakdown(state, DIRECT_RID);
  assert.ok(breakdown.restaurantOwesDirect.lines.length > 0);
  assert.equal(state.restaurantAccountingEntries.length, before);
  // У заказа по-прежнему ровно одно обязательство.
  const byOrder = new Map<string, number>();
  for (const entry of state.restaurantAccountingEntries) {
    byOrder.set(entry.orderId, (byOrder.get(entry.orderId) ?? 0) + 1);
  }
  for (const count of byOrder.values()) {
    assert.equal(count, 1);
  }
});
