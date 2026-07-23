import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type {
  PrototypeState,
  RestaurantAccountingEntry,
  RestaurantAccountingResolutionEvent,
  RestaurantSettlementMethod,
  RestaurantSettlementRecord,
  SettlementEntry,
} from "./models.ts";
import { normalizePrototypeState, parseStoredState } from "./prototype-store.ts";
import {
  getRestaurantOpenPayableCents,
  getRestaurantOpenReceivableCents,
  getRestaurantNetPositionCents,
} from "./restaurant-accounting.ts";
import {
  buildFullRestaurantSettlementPreview,
  confirmFullRestaurantSettlement,
  FULL_SETTLEMENT_REVIEW_REQUIRED_ERROR,
  confirmRestaurantSettlement,
  getLatestFullRestaurantSettlement,
  NO_OPEN_OBLIGATIONS_ERROR,
  STALE_FULL_SETTLEMENT_ERROR,
  type ConfirmFullRestaurantSettlementInput,
} from "./restaurant-settlement-records.ts";
import { validateRestaurantSettlementRecord } from "./restaurant-settlement-integrity.ts";
import {
  describeFullSettlementNet,
  SETTLEMENT_SCOPE_LABELS,
} from "../app/admin/settlements/settlement-selection.ts";

/**
 * v15: полный расчёт всей открытой позиции ресторана. Закрывает обе стороны,
 * фиксирует момент отсечки и строго нулевой остаток; выборочный расчёт полным
 * не считается, а изменившийся баланс закрыть нельзя.
 */

const RID = "restaurant-1";
const OTHER_RID = "restaurant-2";
const CUTOFF = "2026-07-22T14:35:00.000Z";
const T0 = "2026-07-21T10:00:00.000Z";
const MAX = Number.MAX_SAFE_INTEGER;
const ADMIN_PAGE = readFileSync("src/app/admin/settlements/page.tsx", "utf8");
const RESTAURANT_PAGE = readFileSync(
  "src/app/restaurant/settlements/page.tsx",
  "utf8",
);

function entry(
  id: string,
  direction: RestaurantAccountingEntry["direction"],
  amountCents: number,
  overrides: Partial<RestaurantAccountingEntry> = {},
): RestaurantAccountingEntry {
  const type =
    direction === "RESTAURANT_OWES_DIRECT"
      ? "PLATFORM_COMMISSION"
      : "RESTAURANT_PAYOUT";
  return {
    id,
    orderId: `order-${id}`,
    restaurantId: RID,
    direction,
    type,
    amountCents,
    currencyCode: "USD",
    status: "OPEN",
    recognizedAt: T0,
    settledAt: null,
    source: "ORDER_FINANCIAL_SNAPSHOT",
    legacySettlementId: null,
    ...overrides,
  };
}

function stateWith(
  entries: RestaurantAccountingEntry[],
  settlements: SettlementEntry[] = [],
  events: RestaurantAccountingResolutionEvent[] = [],
  records: RestaurantSettlementRecord[] = [],
): PrototypeState {
  return {
    ...createDefaultState(),
    restaurantAccountingEntries: entries,
    settlements,
    restaurantAccountingResolutionEvents: events,
    restaurantSettlementRecords: records,
  };
}

function previewOf(state: PrototypeState, cutoffAt = CUTOFF, rid = RID) {
  return buildFullRestaurantSettlementPreview(state, rid, cutoffAt);
}

function okPreview(state: PrototypeState, cutoffAt = CUTOFF, rid = RID) {
  const result = previewOf(state, cutoffAt, rid);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.preview;
}

/** Ресторан должен Direct $180, Direct должен ресторану $50 → ресторан платит $130. */
const restaurantOwesState = () =>
  stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 18_000),
    entry("p1", "DIRECT_OWES_RESTAURANT", 5_000),
  ]);

/** Ресторан должен Direct $40, Direct должен ресторану $140 → Direct платит $100. */
const directOwesState = () =>
  stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 4_000),
    entry("p1", "DIRECT_OWES_RESTAURANT", 14_000),
  ]);

/** Обе стороны по $100 → взаимозачёт. */
const balancedState = () =>
  stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 10_000),
    entry("p1", "DIRECT_OWES_RESTAURANT", 10_000),
  ]);

function fullInput(
  state: PrototypeState,
  overrides: Partial<ConfirmFullRestaurantSettlementInput> = {},
  cutoffAt = CUTOFF,
): ConfirmFullRestaurantSettlementInput & { cutoffAt: string } {
  const preview = okPreview(state, cutoffAt);
  const balanced = preview.netDirection === "BALANCED";
  return {
    restaurantId: RID,
    expectedAccountingEntryIds: preview.accountingEntryIds,
    expectedRestaurantOwesDirectCents: preview.restaurantOwesDirectCents,
    expectedDirectOwesRestaurantCents: preview.directOwesRestaurantCents,
    expectedNetDirection: preview.netDirection,
    expectedNetAmountCents: preview.netAmountCents,
    method: (balanced ? "NETTING" : "BANK_TRANSFER") as RestaurantSettlementMethod,
    transferredAmountCents: balanced ? 0 : preview.netAmountCents,
    note: "Полный расчёт",
    externalReference: balanced ? null : "ref-full",
    cutoffAt,
    ...overrides,
  };
}

// --- 1–14: полная позиция -----------------------------------------------------

test("1: preview собирает все открытые обязательства ресторана", () => {
  const preview = okPreview(restaurantOwesState());
  assert.equal(preview.openEntryCount, 2);
  assert.deepEqual([...preview.accountingEntryIds].sort(), ["c1", "p1"]);
  assert.equal(preview.cutoffAt, CUTOFF);
});

test("2: закрытые обязательства не входят в позицию", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 4_000),
    entry("c2", "RESTAURANT_OWES_DIRECT", 900, {
      status: "SETTLED",
      settledAt: T0,
    }),
  ]);
  const preview = okPreview(state);
  assert.deepEqual(preview.accountingEntryIds, ["c1"]);
  assert.equal(preview.restaurantOwesDirectCents, 4_000);
});

test("3: списанные обязательства не входят в позицию", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 4_000),
    entry("c2", "RESTAURANT_OWES_DIRECT", 900, {
      status: "WAIVED",
      settledAt: T0,
    }),
  ]);
  assert.deepEqual(okPreview(state).accountingEntryIds, ["c1"]);
});

test("4: обязательства другого ресторана не входят в позицию", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 4_000),
    entry("x1", "RESTAURANT_OWES_DIRECT", 700, { restaurantId: OTHER_RID }),
  ]);
  const preview = okPreview(state);
  assert.deepEqual(preview.accountingEntryIds, ["c1"]);
  assert.equal(preview.restaurantOwesDirectCents, 4_000);
});

test("5: считаются обе gross-стороны", () => {
  const preview = okPreview(directOwesState());
  assert.equal(preview.restaurantOwesDirectCents, 4_000);
  assert.equal(preview.directOwesRestaurantCents, 14_000);
});

test("6: Direct должен ресторану — направление и итог верны", () => {
  const preview = okPreview(directOwesState());
  assert.equal(preview.netDirection, "DIRECT_OWES_RESTAURANT");
  assert.equal(preview.netAmountCents, 10_000);
});

test("7: ресторан должен Direct — направление и итог верны", () => {
  const preview = okPreview(restaurantOwesState());
  assert.equal(preview.netDirection, "RESTAURANT_OWES_DIRECT");
  assert.equal(preview.netAmountCents, 13_000);
});

test("8: равные стороны дают BALANCED", () => {
  const preview = okPreview(balancedState());
  assert.equal(preview.netDirection, "BALANCED");
  assert.equal(preview.netAmountCents, 0);
});

test("9: два обязательства одного заказа отклоняются", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 4_000, { orderId: "order-1" }),
    entry("c2", "RESTAURANT_OWES_DIRECT", 900, { orderId: "order-1" }),
  ]);
  const result = previewOf(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("несколько открытых"));
});

test("10: некорректная сумма отклоняется", () => {
  for (const amount of [0, -1, 10.5, MAX + 1]) {
    const state = stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", amount)]);
    assert.equal(previewOf(state).ok, false, String(amount));
  }
});

test("11: несовместимая пара направление/тип отклоняется", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 4_000, {
      type: "RESTAURANT_PAYOUT",
    }),
  ]);
  const result = previewOf(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("не соответствует направлению"));
});

test("12: переполнение суммы позиции отклоняется", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", MAX - 1),
    entry("c2", "RESTAURANT_OWES_DIRECT", MAX - 1),
  ]);
  assert.equal(previewOf(state).ok, false);
});

test("13: неканоническая дата признания отклоняется", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 4_000, {
      recognizedAt: "2026-07-21",
    }),
  ]);
  const result = previewOf(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("дата признания"));
});

test("14: обязательство позже отсечки отклоняется", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 4_000, {
      recognizedAt: "2026-07-23T00:00:00.000Z",
    }),
  ]);
  const result = previewOf(state);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("позже момента расчёта"));
  // Некорректный cutoff — тоже отказ.
  assert.equal(previewOf(restaurantOwesState(), "2026-07-22").ok, false);
});

// --- 15–22: направление, способ и сумма ---------------------------------------

test("15: Direct должен ресторану — банковский перевод проходит", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(res.result.error, null);
});

test("16: Direct должен ресторану — наличные проходят", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(
    state,
    fullInput(state, { method: "CASH" }),
  );
  assert.equal(res.result.error, null);
});

test("17: ресторан должен Direct — банковский перевод проходит", () => {
  const state = restaurantOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(res.result.error, null);
});

test("18: ресторан должен Direct — наличные проходят", () => {
  const state = restaurantOwesState();
  const res = confirmFullRestaurantSettlement(
    state,
    fullInput(state, { method: "OTHER" }),
  );
  assert.equal(res.result.error, null);
});

test("19: нулевой итог требует взаимозачёта", () => {
  const state = balancedState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(res.result.error, null);
  const record = res.state.restaurantSettlementRecords[0];
  assert.ok(record && record.execution.dataStatus === "COMPLETE");
  assert.equal(
    record.execution.dataStatus === "COMPLETE" && record.execution.method,
    "NETTING",
  );
});

test("20: взаимозачёт при ненулевом итоге отклоняется", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(
    state,
    fullInput(state, { method: "NETTING", transferredAmountCents: 0 }),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
});

test("21: внешний способ при нулевом итоге отклоняется", () => {
  const state = balancedState();
  const res = confirmFullRestaurantSettlement(
    state,
    fullInput(state, { method: "CASH", externalReference: "ref" }),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
});

test("22: сумма обязана точно равняться итогу", () => {
  const state = directOwesState();
  for (const amount of [9_900, 10_100, 0]) {
    const res = confirmFullRestaurantSettlement(
      state,
      fullInput(state, { transferredAmountCents: amount }),
    );
    assert.equal(res.result.ok, false, String(amount));
    assert.equal(res.state, state);
  }
});

// --- 23–28: защита от устаревшего preview --------------------------------------

test("23: новое обязательство между preview и подтверждением — отказ", () => {
  const state = directOwesState();
  const input = fullInput(state);
  const changed: PrototypeState = {
    ...state,
    restaurantAccountingEntries: [
      ...state.restaurantAccountingEntries,
      entry("c9", "RESTAURANT_OWES_DIRECT", 2_000),
    ],
  };
  const res = confirmFullRestaurantSettlement(changed, input);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, STALE_FULL_SETTLEMENT_ERROR);
});

test("24: закрытое обязательство между preview и подтверждением — отказ", () => {
  const state = directOwesState();
  const input = fullInput(state);
  const changed: PrototypeState = {
    ...state,
    restaurantAccountingEntries: state.restaurantAccountingEntries.map((e) =>
      e.id === "c1" ? { ...e, status: "SETTLED" as const, settledAt: T0 } : e,
    ),
  };
  const res = confirmFullRestaurantSettlement(changed, input);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, STALE_FULL_SETTLEMENT_ERROR);
});

test("25: изменившаяся сумма обязательства — отказ", () => {
  const state = directOwesState();
  const input = fullInput(state);
  const changed: PrototypeState = {
    ...state,
    restaurantAccountingEntries: state.restaurantAccountingEntries.map((e) =>
      e.id === "p1" ? { ...e, amountCents: 15_000 } : e,
    ),
  };
  const res = confirmFullRestaurantSettlement(changed, input);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, STALE_FULL_SETTLEMENT_ERROR);
});

test("26: изменившееся направление итога — отказ", () => {
  const state = directOwesState();
  const input = fullInput(state);
  const changed: PrototypeState = {
    ...state,
    restaurantAccountingEntries: state.restaurantAccountingEntries.map((e) =>
      e.id === "c1" ? { ...e, amountCents: 20_000 } : e,
    ),
  };
  const res = confirmFullRestaurantSettlement(changed, input);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, STALE_FULL_SETTLEMENT_ERROR);
});

test("27: другой набор обязательств с тем же итогом — отказ", () => {
  const state = directOwesState();
  const input = fullInput(state);
  // Тот же net $100, но состав позиции другой.
  const changed = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 4_000),
    entry("p2", "DIRECT_OWES_RESTAURANT", 14_000),
  ]);
  const res = confirmFullRestaurantSettlement(changed, input);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, STALE_FULL_SETTLEMENT_ERROR);
});

test("28: отказ по устаревшему preview возвращает исходный state", () => {
  const state = directOwesState();
  const input = fullInput(state);
  const changed: PrototypeState = {
    ...state,
    restaurantAccountingEntries: [
      ...state.restaurantAccountingEntries,
      entry("c9", "RESTAURANT_OWES_DIRECT", 2_000),
    ],
  };
  const res = confirmFullRestaurantSettlement(changed, input);
  assert.equal(res.state, changed);
  assert.equal(res.state.revision, changed.revision);
  assert.deepEqual(res.state.restaurantSettlementRecords, []);
});

// --- 29–41: успешный полный расчёт ---------------------------------------------

test("29: закрываются все открытые обязательства", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(res.result.error, null);
  for (const stored of res.state.restaurantAccountingEntries) {
    assert.equal(stored.status, "SETTLED");
    assert.equal(stored.settledAt, CUTOFF);
  }
});

test("30: создаётся одна запись полного расчёта", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(res.state.restaurantSettlementRecords.length, 1);
  assert.equal(
    res.state.restaurantSettlementRecords[0].selection.scope,
    "FULL_OPEN_POSITION",
  );
});

test("31: момент отсечки совпадает с моментом расчёта", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  const record = res.state.restaurantSettlementRecords[0];
  assert.ok(record && record.selection.scope === "FULL_OPEN_POSITION");
  if (record.selection.scope !== "FULL_OPEN_POSITION") throw new Error("x");
  assert.equal(record.selection.cutoffAt, record.settledAt);
  assert.equal(record.settledAt, CUTOFF);
});

test("32: остаток строго нулевой", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  const record = res.state.restaurantSettlementRecords[0];
  assert.ok(record && record.execution.dataStatus === "COMPLETE");
  if (record.execution.dataStatus !== "COMPLETE") throw new Error("x");
  assert.equal(record.execution.remainingOpenEntryCount, 0);
  assert.equal(record.execution.remainingRestaurantOwesDirectCents, 0);
  assert.equal(record.execution.remainingDirectOwesRestaurantCents, 0);
  assert.equal(record.execution.remainingNetDirection, "BALANCED");
  assert.equal(record.execution.remainingNetAmountCents, 0);
});

test("33: на каждое обязательство создаётся одно событие", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  const events = res.state.restaurantAccountingResolutionEvents;
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((e) => e.accountingEntryId)).size, 2);
  assert.ok(events.every((e) => e.occurredAt === CUTOFF));
});

test("34: ревизия растёт ровно один раз", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(res.state.revision, state.revision + 1);
});

test("35: legacy-комиссия синхронизируется", () => {
  const legacy: SettlementEntry = {
    id: "settlement-order-c1",
    orderId: "order-c1",
    restaurantId: RID,
    type: "PICKUP_COMMISSION",
    amountCents: 4_000,
    status: "PENDING",
    createdAt: T0,
  };
  const state = stateWith(
    [
      entry("c1", "RESTAURANT_OWES_DIRECT", 4_000),
      entry("p1", "DIRECT_OWES_RESTAURANT", 14_000),
    ],
    [legacy],
  );
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(res.result.error, null);
  assert.equal(res.state.settlements[0].status, "PAID");
});

test("36: перечисление ресторана legacy-запись не трогает", () => {
  const legacy: SettlementEntry = {
    id: "settlement-order-r1",
    orderId: "order-r1",
    restaurantId: RID,
    type: "PICKUP_COMMISSION",
    amountCents: 4_000,
    status: "PENDING",
    createdAt: T0,
  };
  const state = stateWith(
    [
      entry("r1", "RESTAURANT_OWES_DIRECT", 4_000, {
        type: "RESTAURANT_REMITTANCE",
      }),
    ],
    [legacy],
  );
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(res.result.error, null);
  assert.equal(res.state.settlements[0].status, "PENDING");
});

test("37: после расчёта открытый долг ресторана равен нулю", () => {
  const state = restaurantOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(getRestaurantOpenReceivableCents(res.state, RID), 0);
});

test("38: после расчёта открытая выплата равна нулю", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(getRestaurantOpenPayableCents(res.state, RID), 0);
});

test("39: после расчёта чистая позиция равна нулю", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(getRestaurantNetPositionCents(res.state, RID), 0);
});

test("40: новое обязательство открывает новый расчётный период", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  const later: PrototypeState = {
    ...res.state,
    restaurantAccountingEntries: [
      ...res.state.restaurantAccountingEntries,
      entry("c9", "RESTAURANT_OWES_DIRECT", 2_500),
    ],
  };
  assert.equal(getRestaurantNetPositionCents(later, RID), -2_500);
  const preview = okPreview(later, "2026-07-23T09:00:00.000Z");
  assert.deepEqual(preview.accountingEntryIds, ["c9"]);
  assert.equal(preview.netAmountCents, 2_500);
});

test("41: исторический полный расчёт не меняется от новых обязательств", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  const before = res.state.restaurantSettlementRecords[0];
  const later: PrototypeState = {
    ...res.state,
    restaurantAccountingEntries: [
      ...res.state.restaurantAccountingEntries,
      entry("c9", "RESTAURANT_OWES_DIRECT", 2_500),
    ],
  };
  const normalized = normalizePrototypeState(later);
  assert.deepEqual(normalized.restaurantSettlementRecords[0], before);
});

// --- 42–45: оба направления и взаимозачёт ---------------------------------------

test("42: полный расчёт Direct → ресторан", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  const record = res.state.restaurantSettlementRecords[0];
  assert.ok(record);
  assert.equal(record.netDirection, "DIRECT_OWES_RESTAURANT");
  assert.equal(record.netAmountCents, 10_000);
  assert.equal(
    record.execution.dataStatus === "COMPLETE" &&
      record.execution.transferredAmountCents,
    10_000,
  );
});

test("43: полный расчёт ресторан → Direct", () => {
  const state = restaurantOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  const record = res.state.restaurantSettlementRecords[0];
  assert.ok(record);
  assert.equal(record.netDirection, "RESTAURANT_OWES_DIRECT");
  assert.equal(record.netAmountCents, 13_000);
});

test("44: полный взаимозачёт без передачи денег", () => {
  const state = balancedState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  const record = res.state.restaurantSettlementRecords[0];
  assert.ok(record);
  assert.equal(record.netDirection, "BALANCED");
  assert.equal(record.netAmountCents, 0);
  assert.equal(
    record.execution.dataStatus === "COMPLETE" &&
      record.execution.transferredAmountCents,
    0,
  );
  assert.equal(record.externalReference, null);
});

test("45: во всех трёх сценариях обязательства закрыты", () => {
  for (const make of [directOwesState, restaurantOwesState, balancedState]) {
    const state = make();
    const res = confirmFullRestaurantSettlement(state, fullInput(state));
    assert.equal(res.result.error, null);
    assert.ok(
      res.state.restaurantAccountingEntries.every((e) => e.status === "SETTLED"),
    );
    assert.equal(getRestaurantNetPositionCents(res.state, RID), 0);
  }
});

// --- 46–52: валидация записи ----------------------------------------------------

function fullRecord(
  overrides: Partial<RestaurantSettlementRecord> = {},
): RestaurantSettlementRecord {
  return {
    id: "settlement-record-full",
    restaurantId: RID,
    currencyCode: "USD",
    accountingEntryIds: ["c1", "p1"],
    restaurantOwesDirectCents: 4_000,
    directOwesRestaurantCents: 14_000,
    netDirection: "DIRECT_OWES_RESTAURANT",
    netAmountCents: 10_000,
    settledAt: CUTOFF,
    actor: "ADMIN",
    note: "Полный расчёт",
    externalReference: "ref-full",
    execution: {
      dataStatus: "COMPLETE",
      method: "BANK_TRANSFER",
      transferredAmountCents: 10_000,
      remainingOpenEntryCount: 0,
      remainingRestaurantOwesDirectCents: 0,
      remainingDirectOwesRestaurantCents: 0,
      remainingNetDirection: "BALANCED",
      remainingNetAmountCents: 0,
    },
    selection: { scope: "FULL_OPEN_POSITION", cutoffAt: CUTOFF },
    ...overrides,
  };
}

test("46: полный расчёт с нулевым остатком проходит валидатор", () => {
  const validated = validateRestaurantSettlementRecord(fullRecord());
  assert.equal(validated.ok, true);
});

test("47: полный расчёт с оставшимися обязательствами отклоняется", () => {
  const broken = fullRecord({
    execution: {
      dataStatus: "COMPLETE",
      method: "BANK_TRANSFER",
      transferredAmountCents: 10_000,
      remainingOpenEntryCount: 2,
      remainingRestaurantOwesDirectCents: 0,
      remainingDirectOwesRestaurantCents: 0,
      remainingNetDirection: "BALANCED",
      remainingNetAmountCents: 0,
    },
  });
  assert.equal(validateRestaurantSettlementRecord(broken).ok, false);
});

test("48: полный расчёт с ненулевым остатком отклоняется", () => {
  const broken = fullRecord({
    execution: {
      dataStatus: "COMPLETE",
      method: "BANK_TRANSFER",
      transferredAmountCents: 10_000,
      remainingOpenEntryCount: 0,
      remainingRestaurantOwesDirectCents: 500,
      remainingDirectOwesRestaurantCents: 0,
      remainingNetDirection: "RESTAURANT_OWES_DIRECT",
      remainingNetAmountCents: 500,
    },
  });
  assert.equal(validateRestaurantSettlementRecord(broken).ok, false);
});

test("49: cutoffAt, отличный от settledAt, отклоняется", () => {
  const broken = fullRecord({
    selection: { scope: "FULL_OPEN_POSITION", cutoffAt: T0 },
  });
  assert.equal(validateRestaurantSettlementRecord(broken).ok, false);
});

test("50: полный расчёт без cutoffAt отклоняется", () => {
  const broken = {
    ...fullRecord(),
    selection: { scope: "FULL_OPEN_POSITION" },
  };
  assert.equal(validateRestaurantSettlementRecord(broken).ok, false);
});

test("51: выборочный расчёт сохраняет прежнее поведение", () => {
  const selected = fullRecord({
    selection: { scope: "SELECTED_ENTRIES" },
    execution: {
      dataStatus: "COMPLETE",
      method: "BANK_TRANSFER",
      transferredAmountCents: 10_000,
      remainingOpenEntryCount: 3,
      remainingRestaurantOwesDirectCents: 700,
      remainingDirectOwesRestaurantCents: 0,
      remainingNetDirection: "RESTAURANT_OWES_DIRECT",
      remainingNetAmountCents: 700,
    },
  });
  const validated = validateRestaurantSettlementRecord(selected);
  assert.equal(validated.ok, true);
  assert.equal(
    validated.ok ? validated.record.selection.scope : null,
    "SELECTED_ENTRIES",
  );
});

test("52: неизвестная область расчёта отклоняется", () => {
  for (const selection of [
    { scope: "EVERYTHING" },
    { scope: "SELECTED_ENTRIES", cutoffAt: CUTOFF },
    null,
    undefined,
  ]) {
    const broken = { ...fullRecord(), selection };
    assert.equal(
      validateRestaurantSettlementRecord(broken).ok,
      false,
      JSON.stringify(selection),
    );
  }
});

// --- 53–57: миграция ------------------------------------------------------------

function storedState(version: number, record: unknown): string {
  const state = {
    ...createDefaultState(),
    schemaVersion: version,
    restaurantSettlementRecords: [record],
    restaurantAccountingEntries: [
      entry("c1", "RESTAURANT_OWES_DIRECT", 4_000, {
        status: "SETTLED",
        settledAt: CUTOFF,
      }),
    ],
  } as unknown as Record<string, unknown>;
  return JSON.stringify(state);
}

test("53: запись схемы 14 становится выборочной", () => {
  const { selection, ...withoutSelection } = fullRecord();
  void selection;
  const parsed = parseStoredState(storedState(14, withoutSelection));
  assert.ok(parsed);
  const stored = parsed.restaurantSettlementRecords[0];
  assert.ok(stored);
  assert.deepEqual(stored.selection, { scope: "SELECTED_ENTRIES" });
});

test("54: старая запись не становится полной из-за нулевого остатка", () => {
  // Остаток нулевой, но полнота расчёта в старой схеме не фиксировалась.
  const parsed = parseStoredState(storedState(14, fullRecord()));
  assert.ok(parsed);
  const stored = parsed.restaurantSettlementRecords[0];
  assert.ok(stored);
  assert.equal(stored.selection.scope, "SELECTED_ENTRIES");
});

test("55: запись схемы 15 без области расчёта отклоняется", () => {
  const { selection, ...withoutSelection } = fullRecord();
  void selection;
  const parsed = parseStoredState(storedState(15, withoutSelection));
  assert.ok(parsed);
  assert.deepEqual(parsed.restaurantSettlementRecords, []);
});

test("56: повторная нормализация идемпотентна", () => {
  const parsed = parseStoredState(storedState(14, fullRecord()));
  assert.ok(parsed);
  const twice = normalizePrototypeState(parsed);
  assert.deepEqual(
    twice.restaurantSettlementRecords,
    parsed.restaurantSettlementRecords,
  );
});

test("57: миграция execution схем до 14 не сломана", () => {
  const { execution, selection, ...legacy } = fullRecord();
  void execution;
  void selection;
  const parsed = parseStoredState(storedState(13, legacy));
  assert.ok(parsed);
  const stored = parsed.restaurantSettlementRecords[0];
  assert.ok(stored);
  assert.deepEqual(stored.execution, { dataStatus: "LEGACY_UNKNOWN" });
  assert.deepEqual(stored.selection, { scope: "SELECTED_ENTRIES" });
});

// --- 58–67: контракты интерфейса -------------------------------------------------

test("58: админ показывает блок полного расчёта", () => {
  assert.ok(ADMIN_PAGE.includes("Полный расчёт сейчас"));
  assert.ok(ADMIN_PAGE.includes("buildFullRestaurantSettlementPreview("));
  assert.ok(ADMIN_PAGE.includes("Выборочный расчёт"));
});

test("59: показываются обе стороны позиции", () => {
  assert.ok(ADMIN_PAGE.includes("fullPreview.restaurantOwesDirectCents"));
  assert.ok(ADMIN_PAGE.includes("fullPreview.directOwesRestaurantCents"));
  assert.ok(ADMIN_PAGE.includes("fullPreview.openEntryCount"));
});

test("60: кнопка учитывает направление Direct → ресторан", () => {
  assert.ok(ADMIN_PAGE.includes("fullSettlementConfirmLabel("));
  assert.equal(
    describeFullSettlementNet("DIRECT_OWES_RESTAURANT").buttonPrefix,
    "Подтвердить: Direct передал ресторану",
  );
});

test("61: кнопка учитывает направление ресторан → Direct", () => {
  assert.equal(
    describeFullSettlementNet("RESTAURANT_OWES_DIRECT").buttonPrefix,
    "Подтвердить: ресторан передал Direct",
  );
});

test("62: нулевой итог показывает взаимозачёт", () => {
  assert.equal(
    describeFullSettlementNet("BALANCED").title,
    "Взаимозачёт без передачи денег",
  );
  assert.ok(ADMIN_PAGE.includes("RESTAURANT_SETTLEMENT_METHOD_LABELS.NETTING"));
});

test("63: сумму полного расчёта нельзя изменить вручную", () => {
  assert.ok(ADMIN_PAGE.includes("<span>Сумма полного расчёта</span>"));
  assert.ok(ADMIN_PAGE.includes("readOnly"));
  assert.ok(ADMIN_PAGE.includes("fullTransferredCents"));
});

test("64: ресторан видит последний полный расчёт", () => {
  assert.ok(RESTAURANT_PAGE.includes("getLatestFullRestaurantSettlement("));
  assert.ok(RESTAURANT_PAGE.includes("Последний полный расчёт:"));
  assert.ok(
    RESTAURANT_PAGE.includes("На этот момент баланс был закрыт полностью."),
  );
  assert.ok(RESTAURANT_PAGE.includes("Полных расчётов пока не было."));
  assert.ok(
    RESTAURANT_PAGE.includes(
      "Текущий баланс сформирован после последнего полного расчёта.",
    ),
  );
});

test("65: выборочный расчёт не считается полным", () => {
  const state = stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 4_000)]);
  const res = confirmRestaurantSettlement(state, {
    restaurantId: RID,
    accountingEntryIds: ["c1"],
    method: "BANK_TRANSFER",
    transferredAmountCents: 4_000,
    note: "Выборочный",
    externalReference: "ref",
    nowIso: CUTOFF,
  });
  assert.equal(res.result.error, null);
  assert.equal(
    res.state.restaurantSettlementRecords[0].selection.scope,
    "SELECTED_ENTRIES",
  );
  assert.equal(getLatestFullRestaurantSettlement(res.state, RID), null);
});

test("66: история различает полный и выборочный расчёт", () => {
  assert.ok(ADMIN_PAGE.includes("SETTLEMENT_SCOPE_LABELS[record.selection.scope]"));
  assert.ok(ADMIN_PAGE.includes("Рассчитано полностью по"));
  assert.equal(SETTLEMENT_SCOPE_LABELS.FULL_OPEN_POSITION, "Полный расчёт");
  assert.equal(SETTLEMENT_SCOPE_LABELS.SELECTED_ENTRIES, "Выборочный расчёт");
});

test("67: сырые enum наружу не выводятся", () => {
  for (const label of Object.values(SETTLEMENT_SCOPE_LABELS)) {
    assert.ok(!/[A-Z]{2,}_[A-Z]/.test(label), label);
  }
});

// --- 68–72: регрессия ------------------------------------------------------------

test("68: пустая позиция не создаёт запись расчёта", () => {
  const state = stateWith([]);
  const preview = okPreview(state);
  assert.equal(preview.openEntryCount, 0);
  assert.equal(preview.netAmountCents, 0);
  const res = confirmFullRestaurantSettlement(state, {
    restaurantId: RID,
    expectedAccountingEntryIds: [],
    expectedRestaurantOwesDirectCents: 0,
    expectedDirectOwesRestaurantCents: 0,
    expectedNetDirection: "BALANCED",
    expectedNetAmountCents: 0,
    method: "NETTING",
    transferredAmountCents: 0,
    note: "Пусто",
    externalReference: null,
    cutoffAt: CUTOFF,
  });
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, NO_OPEN_OBLIGATIONS_ERROR);
  assert.equal(res.state, state);
});

test("69: повторный полный расчёт того же состава отклоняется", () => {
  const state = directOwesState();
  const first = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(first.result.error, null);
  const second = confirmFullRestaurantSettlement(first.state, fullInput(state));
  assert.equal(second.result.ok, false);
  assert.equal(second.state, first.state);
});

test("70: последний полный расчёт выбирается по моменту отсечки", () => {
  const state = directOwesState();
  const first = confirmFullRestaurantSettlement(state, fullInput(state));
  const later: PrototypeState = {
    ...first.state,
    restaurantAccountingEntries: [
      ...first.state.restaurantAccountingEntries,
      entry("c9", "RESTAURANT_OWES_DIRECT", 2_500),
    ],
  };
  const laterCutoff = "2026-07-23T09:00:00.000Z";
  const second = confirmFullRestaurantSettlement(
    later,
    fullInput(later, {}, laterCutoff),
  );
  assert.equal(second.result.error, null);
  const latest = getLatestFullRestaurantSettlement(second.state, RID);
  assert.ok(latest && latest.selection.scope === "FULL_OPEN_POSITION");
  if (!latest || latest.selection.scope !== "FULL_OPEN_POSITION") throw new Error("x");
  assert.equal(latest.selection.cutoffAt, laterCutoff);
});

test("71: архивная запись полным расчётом не считается", () => {
  const legacyRecord = {
    ...fullRecord(),
    execution: { dataStatus: "LEGACY_UNKNOWN" },
    selection: { scope: "SELECTED_ENTRIES" },
  };
  const parsed = parseStoredState(storedState(15, legacyRecord));
  assert.ok(parsed);
  assert.equal(parsed.restaurantSettlementRecords.length, 1);
  assert.equal(getLatestFullRestaurantSettlement(parsed, RID), null);
});

test("72: версия схемы поднята до 15", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 22);
});

// --- 73–112: авторитетный cutoff и запрет при REVIEW_REQUIRED ------------------

/** Настоящий заказ-шаблон: собирается штатным путём через корзину. */
const TEMPLATE_ORDER = (() => {
  let s = setCartFulfillmentChoice(createDefaultState(), "PICKUP");
  s = addCartItem(s, "restaurant-1-item-1").state;
  const created = createOrderFromCart(s);
  const order = created.state.orders.find(
    (o) => o.id === (created.result.orderId as string),
  );
  assert.ok(order);
  return order;
})();

/** Заказ ресторана с заданным статусом движения денег. */
function orderWithStatus(
  id: string,
  restaurantId: string,
  moneyMovementStatus: "COMPLETE" | "REVIEW_REQUIRED" | "PENDING_PAYMENT_CHANNEL",
): PrototypeState["orders"][number] {
  return {
    ...TEMPLATE_ORDER,
    id,
    publicNumber: `DIR-${id}`,
    restaurant: { ...TEMPLATE_ORDER.restaurant, id: restaurantId },
    financials: {
      ...TEMPLATE_ORDER.financials,
      moneyMovementStatus,
      ...(moneyMovementStatus === "COMPLETE" ? {} : { moneyMovement: undefined }),
    },
  };
}

/** Состояние с обязательствами и заказами (для guard REVIEW_REQUIRED). */
function stateWithOrders(
  entries: RestaurantAccountingEntry[],
  orders: PrototypeState["orders"],
): PrototypeState {
  return { ...stateWith(entries), orders };
}

test("73: успешный полный расчёт возвращает момент отсечки", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.equal(res.result.ok, true);
  assert.ok(res.result.ok && typeof res.result.cutoffAt === "string");
});

test("74: возвращённый момент равен переданному domain cutoff", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.ok(res.result.ok);
  assert.equal(res.result.ok && res.result.cutoffAt, CUTOFF);
});

test("75: момент совпадает с selection.cutoffAt записи", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.ok(res.result.ok);
  const record = res.state.restaurantSettlementRecords[0];
  assert.ok(record && record.selection.scope === "FULL_OPEN_POSITION");
  if (!record || record.selection.scope !== "FULL_OPEN_POSITION") throw new Error("x");
  assert.equal(res.result.ok && res.result.cutoffAt, record.selection.cutoffAt);
});

test("76: момент совпадает с settledAt записи", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.ok(res.result.ok);
  const record = res.state.restaurantSettlementRecords[0];
  assert.ok(record);
  assert.equal(res.result.ok && res.result.cutoffAt, record.settledAt);
});

test("77: момент совпадает с settledAt всех закрытых обязательств", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.ok(res.result.ok);
  const cutoff = res.result.ok ? res.result.cutoffAt : null;
  for (const stored of res.state.restaurantAccountingEntries) {
    assert.equal(stored.settledAt, cutoff);
  }
});

test("78: момент совпадает с occurredAt всех новых событий", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.ok(res.result.ok);
  const cutoff = res.result.ok ? res.result.cutoffAt : null;
  for (const event of res.state.restaurantAccountingResolutionEvents) {
    assert.equal(event.occurredAt, cutoff);
  }
});

test("79: доменный отказ возвращает cutoffAt: null", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(
    state,
    fullInput(state, { note: "   " }),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.result.cutoffAt, null);
  assert.equal(res.result.settlementRecordId, null);
});

test("80: инфраструктурный отказ провайдера возвращает cutoffAt: null", () => {
  const PROVIDER = readFileSync("src/prototype/prototype-provider.tsx", "utf8");
  const body = PROVIDER.slice(
    PROVIDER.indexOf("const confirmFullSettlement = useCallback("),
    PROVIDER.indexOf("const requestRestaurantCancellation"),
  );
  assert.ok(body.includes("infrastructureFailure"));
  assert.ok(body.includes("cutoffAt: null"));
  // Момент отсечки создаётся ровно один раз и только внутри мутации.
  assert.equal(body.split("new Date().toISOString()").length - 1, 1);
  assert.ok(body.includes("cutoffAt: new Date().toISOString()"));
});

test("81: баннер администратора использует возвращённый cutoffAt", () => {
  assert.ok(ADMIN_PAGE.includes("authoritativeCutoffAt = r.cutoffAt"));
  assert.ok(ADMIN_PAGE.includes("cutoffAt: authoritativeCutoffAt"));
  assert.ok(ADMIN_PAGE.includes("res.ok && authoritativeCutoffAt !== null"));
});

test("82: администратор не ищет момент в устаревшем React-состоянии", () => {
  assert.ok(!ADMIN_PAGE.includes("getLatestFullRestaurantSettlement"));
  // И не подставляет момент из preview или часов после await.
  assert.ok(!ADMIN_PAGE.includes("confirmed.cutoffAt"));
  assert.ok(!/cutoffAt:\s*state\.updatedAt/.test(ADMIN_PAGE));
  assert.ok(!/cutoffAt:\s*new Date\(\)\.toISOString\(\)/.test(ADMIN_PAGE));
});

test("83: первый полный расчёт не показывает прежний updatedAt состояния", () => {
  const state = directOwesState();
  const res = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.ok(res.result.ok);
  assert.notEqual(res.result.ok && res.result.cutoffAt, state.updatedAt);
});

test("84: второй полный расчёт возвращает свой момент, а не первый", () => {
  const state = directOwesState();
  const first = confirmFullRestaurantSettlement(state, fullInput(state));
  assert.ok(first.result.ok);
  const later: PrototypeState = {
    ...first.state,
    restaurantAccountingEntries: [
      ...first.state.restaurantAccountingEntries,
      entry("c9", "RESTAURANT_OWES_DIRECT", 2_500),
    ],
  };
  const secondCutoff = "2026-07-23T09:00:00.000Z";
  const second = confirmFullRestaurantSettlement(
    later,
    fullInput(later, {}, secondCutoff),
  );
  assert.ok(second.result.ok);
  assert.equal(second.result.ok && second.result.cutoffAt, secondCutoff);
  assert.notEqual(
    second.result.ok && second.result.cutoffAt,
    first.result.ok && first.result.cutoffAt,
  );
});

test("85: момент preview не используется как запасной после успеха", () => {
  // Preview строится с одним cutoff, подтверждение — с другим: результат
  // обязан вернуть именно момент подтверждения.
  const state = directOwesState();
  const input = fullInput(state, {}, "2026-07-22T14:35:00.000Z");
  const confirmCutoff = "2026-07-22T18:00:00.000Z";
  const res = confirmFullRestaurantSettlement(state, {
    ...input,
    cutoffAt: confirmCutoff,
  });
  assert.ok(res.result.ok);
  assert.equal(res.result.ok && res.result.cutoffAt, confirmCutoff);
});

// --- REVIEW_REQUIRED -----------------------------------------------------------

test("86: заказ ресторана с REVIEW_REQUIRED ломает полный preview", () => {
  const state = stateWithOrders(
    [entry("c1", "RESTAURANT_OWES_DIRECT", 4_000)],
    [orderWithStatus("o1", RID, "REVIEW_REQUIRED")],
  );
  const result = previewOf(state);
  assert.equal(result.ok, false);
});

test("87: возвращается точная доменная ошибка", () => {
  const state = stateWithOrders(
    [entry("c1", "RESTAURANT_OWES_DIRECT", 4_000)],
    [orderWithStatus("o1", RID, "REVIEW_REQUIRED")],
  );
  const result = previewOf(state);
  assert.ok(!result.ok);
  assert.equal(
    !result.ok && result.error,
    FULL_SETTLEMENT_REVIEW_REQUIRED_ERROR,
  );
});

test("88: REVIEW_REQUIRED другого ресторана не блокирует", () => {
  const state = stateWithOrders(
    [entry("c1", "RESTAURANT_OWES_DIRECT", 4_000)],
    [orderWithStatus("o1", OTHER_RID, "REVIEW_REQUIRED")],
  );
  const preview = okPreview(state);
  assert.equal(preview.openEntryCount, 1);
});

test("89: COMPLETE-заказ не блокирует полный расчёт", () => {
  const state = stateWithOrders(
    [entry("c1", "RESTAURANT_OWES_DIRECT", 4_000)],
    [orderWithStatus("o1", RID, "COMPLETE")],
  );
  assert.equal(okPreview(state).openEntryCount, 1);
});

test("90: PENDING_PAYMENT_CHANNEL сам по себе не блокирует", () => {
  const state = stateWithOrders(
    [entry("c1", "RESTAURANT_OWES_DIRECT", 4_000)],
    [orderWithStatus("o1", RID, "PENDING_PAYMENT_CHANNEL")],
  );
  assert.equal(okPreview(state).openEntryCount, 1);
});

test("91: REVIEW_REQUIRED между preview и confirm блокирует подтверждение", () => {
  const clean = directOwesState();
  const input = fullInput(clean);
  const broken = stateWithOrders(clean.restaurantAccountingEntries, [
    orderWithStatus("o1", RID, "REVIEW_REQUIRED"),
  ]);
  const res = confirmFullRestaurantSettlement(broken, input);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, FULL_SETTLEMENT_REVIEW_REQUIRED_ERROR);
});

test("92: такой отказ возвращает cutoffAt: null и исходный state", () => {
  const clean = directOwesState();
  const input = fullInput(clean);
  const broken = stateWithOrders(clean.restaurantAccountingEntries, [
    orderWithStatus("o1", RID, "REVIEW_REQUIRED"),
  ]);
  const res = confirmFullRestaurantSettlement(broken, input);
  assert.equal(res.result.cutoffAt, null);
  assert.equal(res.result.settlementRecordId, null);
  assert.equal(res.state, broken);
});

test("93: при отказе ничего не закрывается и не создаётся", () => {
  const legacy: SettlementEntry = {
    id: "settlement-order-c1",
    orderId: "order-c1",
    restaurantId: RID,
    type: "PICKUP_COMMISSION",
    amountCents: 4_000,
    status: "PENDING",
    createdAt: T0,
  };
  const clean = directOwesState();
  const input = fullInput(clean);
  const broken: PrototypeState = {
    ...stateWithOrders(clean.restaurantAccountingEntries, [
      orderWithStatus("o1", RID, "REVIEW_REQUIRED"),
    ]),
    settlements: [legacy],
  };
  const res = confirmFullRestaurantSettlement(broken, input);
  assert.equal(res.result.ok, false);
  assert.ok(
    res.state.restaurantAccountingEntries.every((e) => e.status === "OPEN"),
  );
  assert.deepEqual(res.state.restaurantSettlementRecords, []);
  assert.deepEqual(res.state.restaurantAccountingResolutionEvents, []);
  assert.equal(res.state.settlements[0].status, "PENDING");
  assert.equal(res.state.revision, broken.revision);
  assert.equal(res.state.updatedAt, broken.updatedAt);
});

test("94: выборочный расчёт при REVIEW_REQUIRED остаётся доступным", () => {
  const state = stateWithOrders(
    [entry("c1", "RESTAURANT_OWES_DIRECT", 4_000)],
    [orderWithStatus("o1", RID, "REVIEW_REQUIRED")],
  );
  const res = confirmRestaurantSettlement(state, {
    restaurantId: RID,
    accountingEntryIds: ["c1"],
    method: "BANK_TRANSFER",
    transferredAmountCents: 4_000,
    note: "Выборочный",
    externalReference: "ref",
    nowIso: CUTOFF,
  });
  assert.equal(res.result.error, null);
  assert.equal(
    res.state.restaurantSettlementRecords[0].selection.scope,
    "SELECTED_ENTRIES",
  );
});

test("95: администратор показывает доменную ошибку полного расчёта", () => {
  assert.ok(ADMIN_PAGE.includes("fullPreviewResult && !fullPreviewResult.ok"));
  assert.ok(ADMIN_PAGE.includes("{fullPreviewResult.error}"));
  // Кнопка появляется только при успешном preview.
  assert.ok(ADMIN_PAGE.includes("fullPreview && fullNet ?"));
  assert.ok(ADMIN_PAGE.includes("disabled={!canConfirmFull}"));
});

test("96: кнопка полного расчёта недоступна без успешного preview", () => {
  assert.ok(ADMIN_PAGE.includes("fullPreview !== null &&"));
  assert.ok(ADMIN_PAGE.includes("fullPreview.openEntryCount > 0 &&"));
});

// --- регрессия ------------------------------------------------------------------

test("97: оба направления и взаимозачёт по-прежнему проходят", () => {
  for (const make of [directOwesState, restaurantOwesState, balancedState]) {
    const state = make();
    const res = confirmFullRestaurantSettlement(state, fullInput(state));
    assert.equal(res.result.ok, true);
    assert.ok(res.result.ok && res.result.cutoffAt === CUTOFF);
  }
});

test("98: устаревший снимок позиции по-прежнему отклоняется", () => {
  const state = directOwesState();
  const input = fullInput(state);
  const changed: PrototypeState = {
    ...state,
    restaurantAccountingEntries: [
      ...state.restaurantAccountingEntries,
      entry("c9", "RESTAURANT_OWES_DIRECT", 2_000),
    ],
  };
  const res = confirmFullRestaurantSettlement(changed, input);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, STALE_FULL_SETTLEMENT_ERROR);
  assert.equal(res.result.cutoffAt, null);
});

test("99: версия схемы остаётся 15", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 22);
});

test("100: ресторанный экран продолжает показывать последний полный расчёт", () => {
  assert.ok(RESTAURANT_PAGE.includes("getLatestFullRestaurantSettlement("));
  assert.ok(RESTAURANT_PAGE.includes("Последний полный расчёт:"));
});
