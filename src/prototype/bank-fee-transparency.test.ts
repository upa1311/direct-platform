import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  acceptRestaurantOrder,
  addCartItem,
  completePickupAtRestaurant,
  createOrderFromCart,
  markOrderDeliveredByDriverWithResult,
  markOrderReady,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import type {
  FinancialSnapshot,
  Order,
  PrototypeState,
  RestaurantFinancialCollectionMode,
} from "./models.ts";
import {
  buildRestaurantSettlementOverview,
  type RestaurantSettlementOverview,
} from "./restaurant-settlements.ts";

/**
 * Прозрачность банковской комиссии для ресторана: суммы показываются как они
 * СОХРАНЕНЫ в каноническом движении заказа. Ни ставка 1%, ни распределение
 * между сторонами в презентации не пересчитываются.
 */

const ADDR = { street: "Тестовая улица 1", house: "1" };
const TZ = "Europe/Chisinau";
const RID = "restaurant-2";
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

function stateWithMode(
  mode: RestaurantFinancialCollectionMode,
  restaurantId = RID,
): PrototypeState {
  const base = createDefaultState();
  return {
    ...base,
    restaurants: base.restaurants.map((r) =>
      r.id === restaurantId ? { ...r, financialCollectionMode: mode } : r,
    ),
  };
}

/** Завершённый доставкой Direct заказ ресторана-2. */
function driverCompleted(mode: RestaurantFinancialCollectionMode): {
  state: PrototypeState;
  orderId: string;
} {
  let s = updateCartAddress(stateWithMode(mode), ADDR);
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

/** Завершённый самовывоз ресторана-2 с фактическим способом оплаты. */
function pickupCompleted(paidWith: "CASH" | "CARD"): {
  state: PrototypeState;
  orderId: string;
} {
  let s = setCartFulfillmentChoice(stateWithMode(MIXED), "PICKUP");
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

/** Завершённая доставка собственным курьером (наличные). */
function courierCompleted(): { state: PrototypeState; orderId: string } {
  let s = updateCartAddress(createDefaultState(), ADDR);
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  const prepared = withOrder(created.state, orderId, (o) => ({
    ...o,
    status: "ARRIVING",
  }));
  return { state: prepared, orderId };
}

function okOverview(
  state: PrototypeState,
  restaurantId = RID,
): RestaurantSettlementOverview {
  const result = buildRestaurantSettlementOverview(
    state,
    restaurantId,
    "ALL",
    new Date().toISOString(),
    TZ,
  );
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.overview;
}

// --- 1–5: канонические сценарии --------------------------------------------

test("1: доставка Direct — банк делится между рестораном и Direct", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  const row = okOverview(state).rows[0];
  assert.ok(row);
  // Показываются ровно сохранённые суммы движения.
  assert.equal(row.totalBankFeeCents, movement.totalBankFeeCents);
  assert.equal(row.restaurantBankFeeCents, movement.restaurantBankFeeCents);
  assert.equal(row.directBankFeeCents, movement.directBankFeeCents);
  // Ресторан несёт часть от еды, Direct — остаток.
  assert.ok((row.restaurantBankFeeCents ?? 0) > 0);
  assert.ok((row.directBankFeeCents ?? 0) > 0);
  assert.equal(
    (row.restaurantBankFeeCents ?? 0) + (row.directBankFeeCents ?? 0),
    row.totalBankFeeCents,
  );
});

test("2: самовывоз картой — всю комиссию несёт ресторан", () => {
  const { state, orderId } = pickupCompleted("CARD");
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  const row = okOverview(state).rows[0];
  assert.ok(row);
  assert.equal(row.totalBankFeeCents, movement.totalBankFeeCents);
  assert.equal(row.restaurantBankFeeCents, movement.totalBankFeeCents);
  assert.equal(row.directBankFeeCents, 0);
  assert.ok((row.totalBankFeeCents ?? 0) > 0);
});

test("3: самовывоз наличными — банковской комиссии нет", () => {
  const { state } = pickupCompleted("CASH");
  const row = okOverview(state).rows[0];
  assert.ok(row);
  assert.equal(row.totalBankFeeCents, 0);
  assert.equal(row.restaurantBankFeeCents, 0);
  assert.equal(row.directBankFeeCents, 0);
});

test("4: собственный курьер наличными — банковской комиссии нет", () => {
  const { state, orderId } = courierCompleted();
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  assert.equal(movement.totalBankFeeCents, 0);
  assert.equal(movement.restaurantBankFeeCents, 0);
  assert.equal(movement.directBankFeeCents, 0);
});

test("5: RESTAURANT_COLLECTS_ALL с картой — вся комиссия у ресторана", () => {
  const { state, orderId } = driverCompleted(ALL);
  const movement = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(movement);
  const row = okOverview(state).rows[0];
  assert.ok(row);
  assert.equal(row.restaurantBankFeeCents, movement.totalBankFeeCents);
  assert.equal(row.directBankFeeCents, 0);
  assert.ok((row.totalBankFeeCents ?? 0) > 0);
});

// --- 6–8: агрегаты периода ---------------------------------------------------

test("6: агрегаты периода сходятся: ресторан + Direct = всего", () => {
  const first = driverCompleted(MIXED);
  // Второй заказ того же ресторана — самовывоз картой.
  let s = setCartFulfillmentChoice(first.state, "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const pickupId = created.result.orderId as string;
  let next = acceptRestaurantOrder(created.state, pickupId, 20);
  next = markOrderReady(next, pickupId);
  const done = completePickupAtRestaurant(next, pickupId, "CARD");
  assert.equal(done.result.error, null);

  const summary = okOverview(done.state).summary;
  assert.equal(
    summary.restaurantBankFeeCents + summary.directBankFeeCents,
    summary.totalBankFeeCents,
  );
  assert.ok(summary.totalBankFeeCents > 0);
});

test("7: REVIEW_REQUIRED не входит в банковские итоги", () => {
  const { state, orderId } = driverCompleted(MIXED);
  const good = okOverview(state).summary;
  assert.ok(good.totalBankFeeCents > 0);

  const broken = withOrder(state, orderId, (o) => ({
    ...o,
    financials: {
      ...o.financials,
      moneyMovementStatus: "REVIEW_REQUIRED",
      moneyMovement: undefined,
    },
  }));
  const summary = okOverview(broken).summary;
  assert.equal(summary.totalBankFeeCents, 0);
  assert.equal(summary.restaurantBankFeeCents, 0);
  assert.equal(summary.directBankFeeCents, 0);
  assert.equal(summary.reviewRequiredOrderCount, 1);
});

test("8: архивная строка не считается нулевой банковской комиссией", () => {
  const { state, orderId } = driverCompleted(MIXED);
  // Доказуемо исторический снимок: нет движения, правила и режима.
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
      } as FinancialSnapshot,
    };
  });
  const overview = okOverview(legacy);
  const row = overview.rows[0];
  assert.ok(row);
  assert.equal(row.dataStatus, "LEGACY");
  // Сумм нет — это не ноль.
  assert.equal(row.totalBankFeeCents, null);
  assert.equal(row.restaurantBankFeeCents, null);
  assert.equal(row.directBankFeeCents, null);
  assert.equal(overview.summary.totalBankFeeCents, 0);
});

// --- 9–13: презентация -------------------------------------------------------

test("9: в React нет ставки 1% и повторного распределения", () => {
  assert.ok(!PAGE.includes("bankCardFeeRateBps"));
  assert.ok(!/\/\s*10_?000/.test(PAGE));
  assert.ok(!PAGE.includes("allocateBankFee"));
  // Банковские суммы только читаются из готовых полей.
  assert.ok(PAGE.includes("row.totalBankFeeCents"));
  assert.ok(PAGE.includes("overview.summary.restaurantBankFeeCents"));
});

test("10: подробности заказа показывают три сохранённые суммы", () => {
  assert.ok(PAGE.includes('label="Комиссия банка всего"'));
  assert.ok(PAGE.includes('label="Доля ресторана"'));
  assert.ok(PAGE.includes('label="Доля Direct"'));
  assert.ok(PAGE.includes("money(row.restaurantBankFeeCents)"));
  assert.ok(PAGE.includes("money(row.directBankFeeCents)"));
});

test("11: для наличных показывается одна спокойная строка", () => {
  assert.ok(PAGE.includes('label="Банковская комиссия" value="нет"'));
  assert.ok(PAGE.includes("row.totalBankFeeCents === 0 ?"));
});

test("12: подпись чистой суммы объясняет обе комиссии", () => {
  const flat = PAGE.replace(/\s+/g, " ");
  assert.ok(flat.includes('label="Ресторану после комиссий"'));
  assert.ok(
    flat.includes(
      "Учтены комиссия Direct и доля банковской комиссии ресторана.",
    ),
  );
  // Карточка комиссии банка в подробностях сверки.
  assert.ok(flat.includes('label="Комиссия банка"'));
  assert.ok(flat.includes("За счёт ресторана:"));
  assert.ok(flat.includes("За счёт Direct:"));
});

test("13: банковская комиссия не увеличивает долг ресторана перед Direct", () => {
  const { state, orderId } = pickupCompleted("CARD");
  const fin = orderOf(state, orderId).financials;
  const movement = fin.moneyMovement;
  assert.ok(movement);
  // Долг ресторана — ровно комиссия Direct, банк в него не входит.
  assert.equal(movement.restaurantOwesDirectCents, fin.restaurantCommissionCents);
  assert.ok(movement.restaurantBankFeeCents > 0);
  // Банк уменьшает чистую сумму ресторана, а не создаёт обязательство.
  assert.equal(
    movement.restaurantNetCents +
      movement.restaurantOwesDirectCents +
      movement.restaurantBankFeeCents,
    fin.customerTotalCents,
  );
  const row = okOverview(state).rows[0];
  assert.ok(row);
  assert.equal(row.restaurantOwesDirectCents, fin.restaurantCommissionCents);
  // В интерфейсе нет формулировок про долг по банковской комиссии.
  assert.ok(!PAGE.includes("должен Direct банковскую"));
  assert.ok(!PAGE.includes("банк удержал у Direct"));
});

test("14: групповой расчёт и записи расчётов не затронуты", () => {
  const { state } = driverCompleted(MIXED);
  // Банковские суммы живут только в движении заказа и презентации.
  assert.deepEqual(state.restaurantSettlementRecords, []);
  const entries = state.restaurantAccountingEntries;
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(!("bankFeeCents" in entry));
    assert.ok(!("totalBankFeeCents" in entry));
  }
});
