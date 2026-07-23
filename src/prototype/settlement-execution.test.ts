import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type {
  PrototypeState,
  RestaurantAccountingEntry,
  RestaurantAccountingResolutionEvent,
  RestaurantSettlementExecution,
  RestaurantSettlementRecord,
  SettlementEntry,
} from "./models.ts";
import { normalizePrototypeState, parseStoredState } from "./prototype-store.ts";
import {
  buildRestaurantSettlementPreview,
  confirmRestaurantSettlement,
  type ConfirmRestaurantSettlementInput,
} from "./restaurant-settlement-records.ts";
import { validateRestaurantSettlementRecord } from "./restaurant-settlement-integrity.ts";
import {
  canConfirmSettlement,
  isMethodAllowedForNet,
  parseSettlementAmountToCents,
  RESTAURANT_SETTLEMENT_METHOD_LABELS,
  toSettlementHistoryRows,
} from "../app/admin/settlements/settlement-selection.ts";

/**
 * v14: закрытый расчёт фиксирует способ, фактически переданную сумму и остаток
 * открытой позиции. Частичные расчёты не поддерживаются, исторические записи
 * не получают выдуманные детали.
 */

const RID = "restaurant-1";
const OTHER_RID = "restaurant-2";
const NOW = "2026-07-22T12:00:00.000Z";
const T0 = "2026-07-21T10:00:00.000Z";
const MAX = Number.MAX_SAFE_INTEGER;
const PAGE = readFileSync("src/app/admin/settlements/page.tsx", "utf8");

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

function previewOf(
  state: PrototypeState,
  ids: readonly string[],
  restaurantId = RID,
) {
  return buildRestaurantSettlementPreview(state, restaurantId, ids);
}

function okPreview(state: PrototypeState, ids: readonly string[]) {
  const result = previewOf(state, ids);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.preview;
}

function confirmInput(
  overrides: Partial<ConfirmRestaurantSettlementInput> = {},
): ConfirmRestaurantSettlementInput {
  return {
    restaurantId: RID,
    accountingEntryIds: ["c1"],
    method: "BANK_TRANSFER",
    transferredAmountCents: 800,
    note: "Оплата",
    externalReference: "ref-1",
    nowIso: NOW,
    ...overrides,
  };
}

/** Валидная запись расчёта с настраиваемым execution. */
function record(
  overrides: Partial<RestaurantSettlementRecord> = {},
): RestaurantSettlementRecord {
  return {
    id: "settlement-record-1",
    restaurantId: RID,
    currencyCode: "USD",
    accountingEntryIds: ["c1"],
    restaurantOwesDirectCents: 800,
    directOwesRestaurantCents: 0,
    netDirection: "RESTAURANT_OWES_DIRECT",
    netAmountCents: 800,
    settledAt: NOW,
    actor: "ADMIN",
    note: "Оплата",
    externalReference: "ref-1",
    execution: {
      dataStatus: "COMPLETE",
      method: "BANK_TRANSFER",
      transferredAmountCents: 800,
      remainingOpenEntryCount: 0,
      remainingRestaurantOwesDirectCents: 0,
      remainingDirectOwesRestaurantCents: 0,
      remainingNetDirection: "BALANCED",
      remainingNetAmountCents: 0,
    },
    // v15: выборочный расчёт по умолчанию — тесты этого файла проверяют
    // детали исполнения, а не область расчёта.
    selection: { scope: "SELECTED_ENTRIES" },
    ...overrides,
  };
}

function withExecution(
  execution: unknown,
  overrides: Partial<RestaurantSettlementRecord> = {},
): unknown {
  return { ...record(overrides), execution };
}

// --- 1–5: типы и схема --------------------------------------------------------

test("1: схема поднята до текущей версии", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 21);
});

test("2: состояния прежних схем по-прежнему парсятся", () => {
  for (const version of [11, 12, 13, 14, 15]) {
    const legacy = createDefaultState() as unknown as Record<string, unknown>;
    legacy.schemaVersion = version;
    const parsed = parseStoredState(JSON.stringify(legacy));
    assert.ok(parsed, String(version));
    assert.equal(parsed.schemaVersion, 21, String(version));
  }
});

test("3: запись без execution отклоняется валидатором", () => {
  const { execution, ...withoutExecution } = record();
  void execution;
  assert.equal(validateRestaurantSettlementRecord(withoutExecution).ok, false);
});

test("4: оба dataStatus деталей исполнения валидны", () => {
  assert.equal(validateRestaurantSettlementRecord(record()).ok, true);
  const legacy = validateRestaurantSettlementRecord(
    withExecution({ dataStatus: "LEGACY_UNKNOWN" }),
  );
  assert.equal(legacy.ok, true);
  assert.ok(legacy.ok && legacy.record.execution.dataStatus === "LEGACY_UNKNOWN");
});

test("5: неизвестный dataStatus отклоняется", () => {
  assert.equal(
    validateRestaurantSettlementRecord(withExecution({ dataStatus: "GUESS" })).ok,
    false,
  );
  assert.equal(validateRestaurantSettlementRecord(withExecution(null)).ok, false);
});

// --- 6–11: способы расчёта ----------------------------------------------------

const debtState = () => stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 800)]);
const balancedState = () =>
  stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("p1", "DIRECT_OWES_RESTAURANT", 800),
  ]);

test("6: банковский перевод допустим при ненулевом итоге", () => {
  const res = confirmRestaurantSettlement(debtState(), confirmInput());
  assert.equal(res.result.error, null);
  const stored = res.state.restaurantSettlementRecords[0];
  assert.ok(stored);
  assert.equal(stored.execution.dataStatus, "COMPLETE");
  assert.ok(
    stored.execution.dataStatus === "COMPLETE" &&
      stored.execution.method === "BANK_TRANSFER",
  );
});

test("7: наличные допустимы при ненулевом итоге", () => {
  const res = confirmRestaurantSettlement(
    debtState(),
    confirmInput({ method: "CASH" }),
  );
  assert.equal(res.result.error, null);
});

test("8: другой способ допустим при ненулевом итоге", () => {
  const res = confirmRestaurantSettlement(
    debtState(),
    confirmInput({ method: "OTHER" }),
  );
  assert.equal(res.result.error, null);
});

test("9: взаимозачёт допустим только при нулевом итоге", () => {
  const res = confirmRestaurantSettlement(
    balancedState(),
    confirmInput({
      accountingEntryIds: ["c1", "p1"],
      method: "NETTING",
      transferredAmountCents: 0,
      externalReference: null,
    }),
  );
  assert.equal(res.result.error, null);
  const stored = res.state.restaurantSettlementRecords[0];
  assert.ok(stored && stored.execution.dataStatus === "COMPLETE");
  assert.equal(
    stored.execution.dataStatus === "COMPLETE" && stored.execution.method,
    "NETTING",
  );
});

test("10: взаимозачёт при ненулевом итоге отклоняется", () => {
  const state = debtState();
  const res = confirmRestaurantSettlement(
    state,
    confirmInput({ method: "NETTING", transferredAmountCents: 0 }),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
});

test("11: внешние способы при нулевом итоге отклоняются", () => {
  for (const method of ["BANK_TRANSFER", "CASH", "OTHER"] as const) {
    const state = balancedState();
    const res = confirmRestaurantSettlement(
      state,
      confirmInput({
        accountingEntryIds: ["c1", "p1"],
        method,
        transferredAmountCents: 0,
        externalReference: null,
      }),
    );
    assert.equal(res.result.ok, false, method);
    assert.equal(res.state, state);
  }
});

// --- 12–18: фактическая сумма -------------------------------------------------

test("12: точное совпадение суммы с итогом проходит", () => {
  const res = confirmRestaurantSettlement(
    debtState(),
    confirmInput({ transferredAmountCents: 800 }),
  );
  assert.equal(res.result.error, null);
});

test("13: сумма меньше итога отклоняется", () => {
  const state = debtState();
  const res = confirmRestaurantSettlement(
    state,
    confirmInput({ transferredAmountCents: 700 }),
  );
  assert.equal(res.result.ok, false);
  assert.ok(res.result.error?.includes("Частичный расчёт пока не поддерживается"));
  assert.equal(res.state, state);
});

test("14: сумма больше итога отклоняется", () => {
  const state = debtState();
  const res = confirmRestaurantSettlement(
    state,
    confirmInput({ transferredAmountCents: 900 }),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
});

test("15: нулевая сумма при ненулевом итоге отклоняется", () => {
  const state = debtState();
  const res = confirmRestaurantSettlement(
    state,
    confirmInput({ transferredAmountCents: 0 }),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
});

test("16: взаимозачёт требует нулевой переданной суммы", () => {
  const state = balancedState();
  const res = confirmRestaurantSettlement(
    state,
    confirmInput({
      accountingEntryIds: ["c1", "p1"],
      method: "NETTING",
      transferredAmountCents: 800,
      externalReference: null,
    }),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
});

test("17: небезопасные, отрицательные и дробные центы отклоняются", () => {
  for (const amount of [MAX + 1, -1, 800.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const state = debtState();
    const res = confirmRestaurantSettlement(
      state,
      confirmInput({ transferredAmountCents: amount }),
    );
    assert.equal(res.result.ok, false, String(amount));
    assert.equal(res.state, state);
  }
});

test("18: неуспешное подтверждение не меняет обязательства и записи", () => {
  const state = debtState();
  const res = confirmRestaurantSettlement(
    state,
    confirmInput({ transferredAmountCents: 1 }),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
  assert.equal(res.state.restaurantAccountingEntries[0].status, "OPEN");
  assert.deepEqual(res.state.restaurantSettlementRecords, []);
  assert.equal(res.state.revision, state.revision);
});

// --- 19–26: остаток открытой позиции -----------------------------------------

test("19: выбраны все открытые обязательства — остатка нет", () => {
  const state = balancedState();
  const preview = okPreview(state, ["c1", "p1"]);
  assert.equal(preview.remainingOpenEntryCount, 0);
  assert.equal(preview.remainingRestaurantOwesDirectCents, 0);
  assert.equal(preview.remainingDirectOwesRestaurantCents, 0);
  assert.equal(preview.remainingNetDirection, "BALANCED");
  assert.equal(preview.remainingNetAmountCents, 0);
});

test("20: остался долг ресторана — направление и сумма остатка верны", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("c2", "RESTAURANT_OWES_DIRECT", 500),
  ]);
  const preview = okPreview(state, ["c1"]);
  assert.equal(preview.remainingOpenEntryCount, 1);
  assert.equal(preview.remainingRestaurantOwesDirectCents, 500);
  assert.equal(preview.remainingDirectOwesRestaurantCents, 0);
  assert.equal(preview.remainingNetDirection, "RESTAURANT_OWES_DIRECT");
  assert.equal(preview.remainingNetAmountCents, 500);
});

test("21: осталась выплата ресторану — направление и сумма остатка верны", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("p1", "DIRECT_OWES_RESTAURANT", 1_200),
  ]);
  const preview = okPreview(state, ["c1"]);
  assert.equal(preview.remainingOpenEntryCount, 1);
  assert.equal(preview.remainingDirectOwesRestaurantCents, 1_200);
  assert.equal(preview.remainingNetDirection, "DIRECT_OWES_RESTAURANT");
  assert.equal(preview.remainingNetAmountCents, 1_200);
});

test("22: встречные остатки дают обе стороны и корректный net", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("c2", "RESTAURANT_OWES_DIRECT", 300),
    entry("p1", "DIRECT_OWES_RESTAURANT", 1_000),
  ]);
  const preview = okPreview(state, ["c1"]);
  assert.equal(preview.remainingOpenEntryCount, 2);
  assert.equal(preview.remainingRestaurantOwesDirectCents, 300);
  assert.equal(preview.remainingDirectOwesRestaurantCents, 1_000);
  assert.equal(preview.remainingNetDirection, "DIRECT_OWES_RESTAURANT");
  assert.equal(preview.remainingNetAmountCents, 700);
});

test("23: равные остатки дают BALANCED", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("c2", "RESTAURANT_OWES_DIRECT", 400),
    entry("p1", "DIRECT_OWES_RESTAURANT", 400),
  ]);
  const preview = okPreview(state, ["c1"]);
  assert.equal(preview.remainingNetDirection, "BALANCED");
  assert.equal(preview.remainingNetAmountCents, 0);
});

test("24: переполнение остатка отклоняет preview", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("c2", "RESTAURANT_OWES_DIRECT", MAX - 1),
    entry("c3", "RESTAURANT_OWES_DIRECT", MAX - 1),
  ]);
  const result = previewOf(state, ["c1"]);
  assert.equal(result.ok, false);
});

test("25: повреждённое оставшееся обязательство ломает preview", () => {
  const broken = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("c2", "RESTAURANT_OWES_DIRECT", 0),
  ]);
  assert.equal(previewOf(broken, ["c1"]).ok, false);

  const mixedPair = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("c2", "DIRECT_OWES_RESTAURANT", 500, {
      type: "PLATFORM_COMMISSION",
    }),
  ]);
  assert.equal(previewOf(mixedPair, ["c1"]).ok, false);
});

test("26: остаток фиксируется в записи и позже не пересчитывается", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("c2", "RESTAURANT_OWES_DIRECT", 500),
  ]);
  const res = confirmRestaurantSettlement(state, confirmInput());
  assert.equal(res.result.error, null);
  const stored = res.state.restaurantSettlementRecords[0];
  assert.ok(stored && stored.execution.dataStatus === "COMPLETE");
  if (stored.execution.dataStatus !== "COMPLETE") throw new Error("unreachable");
  assert.equal(stored.execution.remainingRestaurantOwesDirectCents, 500);

  // Появилось новое обязательство — исторический остаток не меняется.
  const later: PrototypeState = {
    ...res.state,
    restaurantAccountingEntries: [
      ...res.state.restaurantAccountingEntries,
      entry("c9", "RESTAURANT_OWES_DIRECT", 999),
    ],
  };
  const normalized = normalizePrototypeState(later);
  const after = normalized.restaurantSettlementRecords[0];
  assert.ok(after && after.execution.dataStatus === "COMPLETE");
  assert.deepEqual(after.execution, stored.execution);
});

// --- 27–34: валидатор записи --------------------------------------------------

test("27: корректный COMPLETE execution проходит валидатор", () => {
  const validated = validateRestaurantSettlementRecord(record());
  assert.equal(validated.ok, true);
  assert.ok(validated.ok && validated.record.execution.dataStatus === "COMPLETE");
});

test("28: несоответствие остатка сумме сторон отклоняется", () => {
  const broken = withExecution({
    dataStatus: "COMPLETE",
    method: "BANK_TRANSFER",
    transferredAmountCents: 800,
    remainingOpenEntryCount: 1,
    remainingRestaurantOwesDirectCents: 500,
    remainingDirectOwesRestaurantCents: 0,
    remainingNetDirection: "RESTAURANT_OWES_DIRECT",
    remainingNetAmountCents: 400,
  });
  assert.equal(validateRestaurantSettlementRecord(broken).ok, false);
});

test("29: несоответствие направления остатка отклоняется", () => {
  const broken = withExecution({
    dataStatus: "COMPLETE",
    method: "BANK_TRANSFER",
    transferredAmountCents: 800,
    remainingOpenEntryCount: 1,
    remainingRestaurantOwesDirectCents: 500,
    remainingDirectOwesRestaurantCents: 0,
    remainingNetDirection: "DIRECT_OWES_RESTAURANT",
    remainingNetAmountCents: 500,
  });
  assert.equal(validateRestaurantSettlementRecord(broken).ok, false);
});

test("30: несовпадение переданной суммы с итогом отклоняется", () => {
  const broken = withExecution({
    dataStatus: "COMPLETE",
    method: "BANK_TRANSFER",
    transferredAmountCents: 700,
    remainingOpenEntryCount: 0,
    remainingRestaurantOwesDirectCents: 0,
    remainingDirectOwesRestaurantCents: 0,
    remainingNetDirection: "BALANCED",
    remainingNetAmountCents: 0,
  });
  assert.equal(validateRestaurantSettlementRecord(broken).ok, false);
});

test("31: COMPLETE без способа отклоняется", () => {
  const broken = withExecution({
    dataStatus: "COMPLETE",
    transferredAmountCents: 800,
    remainingOpenEntryCount: 0,
    remainingRestaurantOwesDirectCents: 0,
    remainingDirectOwesRestaurantCents: 0,
    remainingNetDirection: "BALANCED",
    remainingNetAmountCents: 0,
  });
  assert.equal(validateRestaurantSettlementRecord(broken).ok, false);
});

test("32: неполный COMPLETE execution отклоняется", () => {
  const broken = withExecution({
    dataStatus: "COMPLETE",
    method: "BANK_TRANSFER",
    transferredAmountCents: 800,
  });
  assert.equal(validateRestaurantSettlementRecord(broken).ok, false);
});

test("33: LEGACY_UNKNOWN без дополнительных полей проходит", () => {
  const validated = validateRestaurantSettlementRecord(
    withExecution({ dataStatus: "LEGACY_UNKNOWN" }),
  );
  assert.equal(validated.ok, true);
  assert.deepEqual(
    validated.ok ? validated.record.execution : null,
    { dataStatus: "LEGACY_UNKNOWN" } satisfies RestaurantSettlementExecution,
  );
});

test("34: LEGACY_UNKNOWN со способом или суммой отклоняется", () => {
  assert.equal(
    validateRestaurantSettlementRecord(
      withExecution({ dataStatus: "LEGACY_UNKNOWN", method: "CASH" }),
    ).ok,
    false,
  );
  assert.equal(
    validateRestaurantSettlementRecord(
      withExecution({
        dataStatus: "LEGACY_UNKNOWN",
        transferredAmountCents: 800,
      }),
    ).ok,
    false,
  );
});

// --- 35–40: миграция ----------------------------------------------------------

/** Состояние прежней схемы с записью без execution. */
function legacyStoredState(version: number): string {
  const { execution, ...withoutExecution } = record();
  void execution;
  const state = {
    ...createDefaultState(),
    schemaVersion: version,
    restaurantSettlementRecords: [withoutExecution],
    restaurantAccountingEntries: [
      entry("c1", "RESTAURANT_OWES_DIRECT", 800, {
        status: "SETTLED",
        settledAt: NOW,
      }),
    ],
  } as unknown as Record<string, unknown>;
  return JSON.stringify(state);
}

test("35: запись схемы 13 без execution становится LEGACY_UNKNOWN", () => {
  const parsed = parseStoredState(legacyStoredState(13));
  assert.ok(parsed);
  const stored = parsed.restaurantSettlementRecords[0];
  assert.ok(stored);
  assert.equal(stored.execution.dataStatus, "LEGACY_UNKNOWN");
});

test("36: исторические суммы, основание и ссылка сохраняются", () => {
  const parsed = parseStoredState(legacyStoredState(11));
  assert.ok(parsed);
  const stored = parsed.restaurantSettlementRecords[0];
  assert.ok(stored);
  assert.equal(stored.restaurantOwesDirectCents, 800);
  assert.equal(stored.directOwesRestaurantCents, 0);
  assert.equal(stored.netDirection, "RESTAURANT_OWES_DIRECT");
  assert.equal(stored.netAmountCents, 800);
  assert.equal(stored.note, "Оплата");
  assert.equal(stored.externalReference, "ref-1");
});

test("37: исторический способ не выдумывается", () => {
  const parsed = parseStoredState(legacyStoredState(12));
  assert.ok(parsed);
  const stored = parsed.restaurantSettlementRecords[0];
  assert.ok(stored);
  assert.equal(stored.execution.dataStatus, "LEGACY_UNKNOWN");
  assert.ok(!("method" in stored.execution));
  assert.ok(!("transferredAmountCents" in stored.execution));
});

test("38: исторический остаток не считается по текущему состоянию", () => {
  const parsed = parseStoredState(legacyStoredState(13));
  assert.ok(parsed);
  const stored = parsed.restaurantSettlementRecords[0];
  assert.ok(stored);
  assert.ok(!("remainingNetAmountCents" in stored.execution));
});

test("39: запись схемы 14 без execution отклоняется, а не помечается архивной", () => {
  const parsed = parseStoredState(legacyStoredState(14));
  assert.ok(parsed);
  assert.deepEqual(parsed.restaurantSettlementRecords, []);
});

test("40: повторная нормализация идемпотентна", () => {
  const parsed = parseStoredState(legacyStoredState(13));
  assert.ok(parsed);
  const twice = normalizePrototypeState(parsed);
  assert.deepEqual(
    twice.restaurantSettlementRecords,
    parsed.restaurantSettlementRecords,
  );
});

// --- 41–50: транзакция подтверждения ------------------------------------------

test("41: preview пересчитывается внутри подтверждения", () => {
  // Обязательство закрыто между UI-preview и подтверждением.
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800, {
      status: "SETTLED",
      settledAt: T0,
    }),
  ]);
  const res = confirmRestaurantSettlement(state, confirmInput());
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
});

test("42: изменившаяся сумма обязательства проверяется заново", () => {
  const state = stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 900)]);
  // UI показывал 800, состояние уже другое — точное совпадение не выполняется.
  const res = confirmRestaurantSettlement(
    state,
    confirmInput({ transferredAmountCents: 800 }),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
});

test("43: успех создаёт ровно одну запись с COMPLETE execution", () => {
  const res = confirmRestaurantSettlement(debtState(), confirmInput());
  assert.equal(res.result.error, null);
  assert.equal(res.state.restaurantSettlementRecords.length, 1);
  assert.equal(
    res.state.restaurantSettlementRecords[0].execution.dataStatus,
    "COMPLETE",
  );
});

test("44: все выбранные обязательства становятся SETTLED", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("p1", "DIRECT_OWES_RESTAURANT", 800),
  ]);
  const res = confirmRestaurantSettlement(
    state,
    confirmInput({
      accountingEntryIds: ["c1", "p1"],
      method: "NETTING",
      transferredAmountCents: 0,
      externalReference: null,
    }),
  );
  assert.equal(res.result.error, null);
  for (const stored of res.state.restaurantAccountingEntries) {
    assert.equal(stored.status, "SETTLED");
    assert.equal(stored.settledAt, NOW);
  }
});

test("45: на каждое обязательство создаётся ровно одно событие", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("p1", "DIRECT_OWES_RESTAURANT", 800),
  ]);
  const res = confirmRestaurantSettlement(
    state,
    confirmInput({
      accountingEntryIds: ["c1", "p1"],
      method: "NETTING",
      transferredAmountCents: 0,
      externalReference: null,
    }),
  );
  assert.equal(res.result.error, null);
  const events = res.state.restaurantAccountingResolutionEvents;
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((e) => e.accountingEntryId)).size, 2);
});

test("46: legacy settlement синхронизируется только для комиссии", () => {
  const legacy: SettlementEntry = {
    id: "settlement-order-c1",
    orderId: "order-c1",
    restaurantId: RID,
    type: "PICKUP_COMMISSION",
    amountCents: 800,
    status: "PENDING",
    createdAt: T0,
  };
  const res = confirmRestaurantSettlement(
    stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 800)], [legacy]),
    confirmInput(),
  );
  assert.equal(res.result.error, null);
  assert.equal(res.state.settlements[0].status, "PAID");
});

test("47: перечисление ресторана не трогает legacy settlement", () => {
  const legacy: SettlementEntry = {
    id: "settlement-order-r1",
    orderId: "order-r1",
    restaurantId: RID,
    type: "PICKUP_COMMISSION",
    amountCents: 800,
    status: "PENDING",
    createdAt: T0,
  };
  const res = confirmRestaurantSettlement(
    stateWith(
      [
        entry("r1", "RESTAURANT_OWES_DIRECT", 800, {
          type: "RESTAURANT_REMITTANCE",
        }),
      ],
      [legacy],
    ),
    confirmInput({ accountingEntryIds: ["r1"] }),
  );
  assert.equal(res.result.error, null);
  assert.equal(res.state.settlements[0].status, "PENDING");
});

test("48: ревизия растёт ровно один раз", () => {
  const state = debtState();
  const res = confirmRestaurantSettlement(state, confirmInput());
  assert.equal(res.result.error, null);
  assert.equal(res.state.revision, state.revision + 1);
});

test("49: любая ошибка возвращает исходный state тем же объектом", () => {
  const state = debtState();
  const inputs: Partial<ConfirmRestaurantSettlementInput>[] = [
    { note: "   " },
    { externalReference: null },
    { transferredAmountCents: 1 },
    { method: "NETTING" },
    { nowIso: "2026-07-22" },
    { accountingEntryIds: [] },
  ];
  for (const overrides of inputs) {
    const res = confirmRestaurantSettlement(state, confirmInput(overrides));
    assert.equal(res.result.ok, false, JSON.stringify(overrides));
    assert.equal(res.state, state, JSON.stringify(overrides));
  }
});

test("50: повторное подтверждение того же расчёта отклоняется", () => {
  const first = confirmRestaurantSettlement(debtState(), confirmInput());
  assert.equal(first.result.error, null);
  const second = confirmRestaurantSettlement(first.state, confirmInput());
  assert.equal(second.result.ok, false);
  assert.equal(second.state, first.state);
});

// --- 51–59: строгий парсер суммы ----------------------------------------------

test("51: 10 разбирается как 1000 центов", () => {
  assert.deepEqual(parseSettlementAmountToCents("10"), { ok: true, cents: 1_000 });
});

test("52: 10.5 разбирается как 1050 центов", () => {
  assert.deepEqual(parseSettlementAmountToCents("10.5"), {
    ok: true,
    cents: 1_050,
  });
});

test("53: 10.50 разбирается как 1050 центов", () => {
  assert.deepEqual(parseSettlementAmountToCents("10.50"), {
    ok: true,
    cents: 1_050,
  });
});

test("54: 0.01 разбирается как 1 цент", () => {
  assert.deepEqual(parseSettlementAmountToCents("0.01"), { ok: true, cents: 1 });
});

test("55: пустая строка отклоняется", () => {
  assert.equal(parseSettlementAmountToCents("").ok, false);
  assert.equal(parseSettlementAmountToCents("   ").ok, false);
});

test("56: три знака после точки отклоняются", () => {
  assert.equal(parseSettlementAmountToCents("10.555").ok, false);
});

test("57: экспоненциальная запись отклоняется", () => {
  for (const value of ["1e3", "1E3", "NaN", "Infinity"]) {
    assert.equal(parseSettlementAmountToCents(value).ok, false, value);
  }
});

test("58: отрицательная сумма отклоняется", () => {
  assert.equal(parseSettlementAmountToCents("-10").ok, false);
  assert.equal(parseSettlementAmountToCents("-0.01").ok, false);
});

test("59: сумма вне безопасного диапазона отклоняется", () => {
  assert.equal(parseSettlementAmountToCents("999999999999999999").ok, false);
});

// --- 60–68: контракт интерфейса -----------------------------------------------

test("60: при ненулевом итоге показывается выбор способа", () => {
  assert.ok(PAGE.includes("MANUAL_SETTLEMENT_METHODS.map"));
  assert.ok(PAGE.includes("<span>Способ расчёта</span>"));
});

test("61: при нулевом итоге взаимозачёт показан read-only", () => {
  assert.ok(PAGE.includes('previewOk.netDirection === "BALANCED" ?'));
  assert.ok(PAGE.includes("RESTAURANT_SETTLEMENT_METHOD_LABELS.NETTING"));
  assert.ok(PAGE.includes("Фактически передано:"));
});

test("62: поле фактической суммы присутствует для ненулевого итога", () => {
  assert.ok(PAGE.includes("<span>Фактически переданная сумма</span>"));
  // Подсказка в JSX переносится по строкам — сравниваем по сжатым пробелам.
  const flattened = PAGE.replace(/\s+/g, " ");
  assert.ok(
    flattened.includes(
      "Для полного закрытия сумма должна совпадать с итогом расчёта. Частичные расчёты пока не поддерживаются.",
    ),
  );
});

test("63: остаток берётся из доменного preview, а не считается в React", () => {
  assert.ok(PAGE.includes("После этого расчёта"));
  assert.ok(PAGE.includes("previewOk.remainingOpenEntryCount"));
  assert.ok(PAGE.includes("previewOk.remainingRestaurantOwesDirectCents"));
  assert.ok(PAGE.includes("previewOk.remainingDirectOwesRestaurantCents"));
  assert.ok(PAGE.includes("previewOk.remainingNetAmountCents"));
  assert.ok(PAGE.includes("Открытая позиция будет закрыта полностью."));
});

test("64: кнопка недоступна при несовпадении суммы", () => {
  const base = {
    hasSelection: true,
    previewOk: true,
    netDirection: "RESTAURANT_OWES_DIRECT" as const,
    netAmountCents: 800,
    method: "BANK_TRANSFER" as const,
    note: "Основание",
    reference: "ref-1",
    pending: false,
  };
  assert.equal(canConfirmSettlement({ ...base, amountInput: "8.00" }), true);
  assert.equal(canConfirmSettlement({ ...base, amountInput: "7.99" }), false);
  assert.equal(canConfirmSettlement({ ...base, amountInput: "8.01" }), false);
  assert.equal(canConfirmSettlement({ ...base, amountInput: "" }), false);
  // Взаимозачёт: сумма и ссылка не требуются, но способ обязан совпасть.
  const balanced = {
    ...base,
    netDirection: "BALANCED" as const,
    netAmountCents: 0,
    reference: "",
    amountInput: "",
  };
  assert.equal(
    canConfirmSettlement({ ...balanced, method: "NETTING" }),
    true,
  );
  assert.equal(canConfirmSettlement(balanced), false);
});

test("65: история COMPLETE показывает способ, сумму и остаток", () => {
  const rows = toSettlementHistoryRows([record()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].execution.dataStatus, "COMPLETE");
  assert.ok(PAGE.includes("Фактически передано"));
  assert.ok(PAGE.includes("Осталось обязательств"));
  assert.ok(PAGE.includes("record.execution.remainingNetAmountCents"));
});

test("66: история архивной записи показывает честное сообщение", () => {
  const legacy = validateRestaurantSettlementRecord(
    withExecution({ dataStatus: "LEGACY_UNKNOWN" }),
  );
  assert.ok(legacy.ok);
  const rows = toSettlementHistoryRows([legacy.record]);
  assert.equal(rows[0].execution.dataStatus, "LEGACY_UNKNOWN");
  assert.ok(PAGE.includes("LEGACY_EXECUTION_MESSAGE"));
});

test("67: сырые enum наружу не выводятся", () => {
  for (const label of Object.values(RESTAURANT_SETTLEMENT_METHOD_LABELS)) {
    assert.ok(!/[A-Z]{2,}_[A-Z]/.test(label), label);
  }
  assert.equal(RESTAURANT_SETTLEMENT_METHOD_LABELS.BANK_TRANSFER, "Банковский перевод");
  assert.equal(RESTAURANT_SETTLEMENT_METHOD_LABELS.CASH, "Наличные");
  assert.equal(RESTAURANT_SETTLEMENT_METHOD_LABELS.OTHER, "Другой способ");
  assert.equal(RESTAURANT_SETTLEMENT_METHOD_LABELS.NETTING, "Взаимозачёт");
});

test("68: выбор, фильтры и одиночное списание не сломаны", () => {
  assert.ok(PAGE.includes("reconcileSelection"));
  assert.ok(PAGE.includes("changeStatusFilter"));
  assert.ok(PAGE.includes("Снять выбор"));
  assert.equal(isMethodAllowedForNet("NETTING", "BALANCED"), true);
  assert.equal(isMethodAllowedForNet("NETTING", "RESTAURANT_OWES_DIRECT"), false);
  assert.equal(
    isMethodAllowedForNet("BANK_TRANSFER", "DIRECT_OWES_RESTAURANT"),
    true,
  );
});

// --- 69–72: регрессия ---------------------------------------------------------

test("69: расчёт другого ресторана не влияет на остаток", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("x1", "RESTAURANT_OWES_DIRECT", 700, { restaurantId: OTHER_RID }),
  ]);
  const preview = okPreview(state, ["c1"]);
  assert.equal(preview.remainingOpenEntryCount, 0);
  assert.equal(preview.remainingRestaurantOwesDirectCents, 0);
});

test("70: закрытые и списанные обязательства в остаток не входят", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800),
    entry("c2", "RESTAURANT_OWES_DIRECT", 500, {
      status: "SETTLED",
      settledAt: T0,
    }),
    entry("c3", "RESTAURANT_OWES_DIRECT", 300, {
      status: "WAIVED",
      settledAt: T0,
    }),
  ]);
  const preview = okPreview(state, ["c1"]);
  assert.equal(preview.remainingOpenEntryCount, 0);
  assert.equal(preview.remainingNetDirection, "BALANCED");
});

test("71: запись расчёта переживает serialize/parse без изменений", () => {
  const res = confirmRestaurantSettlement(debtState(), confirmInput());
  assert.equal(res.result.error, null);
  const parsed = parseStoredState(JSON.stringify(res.state));
  assert.ok(parsed);
  assert.deepEqual(
    parsed.restaurantSettlementRecords,
    res.state.restaurantSettlementRecords,
  );
});

test("72: подтверждение не мутирует исходные коллекции state", () => {
  const state = debtState();
  const entriesRef = state.restaurantAccountingEntries;
  const recordsRef = state.restaurantSettlementRecords;
  const res = confirmRestaurantSettlement(state, confirmInput());
  assert.equal(res.result.error, null);
  assert.equal(state.restaurantAccountingEntries, entriesRef);
  assert.equal(state.restaurantSettlementRecords, recordsRef);
  assert.equal(entriesRef[0].status, "OPEN");
  assert.equal(recordsRef.length, 0);
});

// --- 73–98: integrity-регрессия (миграция execution и границы orderId) --------

/**
 * Состояние прежней схемы с одной записью расчёта и произвольным (в том числе
 * недостоверным) execution внутри неё.
 */
function storedStateWithExecution(version: number, execution: unknown): string {
  const stored: Record<string, unknown> = { ...record() };
  if (execution === undefined) {
    delete stored.execution;
  } else {
    stored.execution = execution;
  }
  const state = {
    ...createDefaultState(),
    schemaVersion: version,
    restaurantSettlementRecords: [stored],
    restaurantAccountingEntries: [
      entry("c1", "RESTAURANT_OWES_DIRECT", 800, {
        status: "SETTLED",
        settledAt: NOW,
      }),
    ],
  } as unknown as Record<string, unknown>;
  return JSON.stringify(state);
}

function storedRecord(json: string): RestaurantSettlementRecord | undefined {
  const parsed = parseStoredState(json);
  assert.ok(parsed);
  return parsed.restaurantSettlementRecords[0];
}

/** Структурно валидный, но исторически невозможный execution старой схемы. */
const FOREIGN_EXECUTION = {
  dataStatus: "COMPLETE",
  method: "CASH",
  transferredAmountCents: 800,
  remainingOpenEntryCount: 3,
  remainingRestaurantOwesDirectCents: 0,
  remainingDirectOwesRestaurantCents: 0,
  remainingNetDirection: "BALANCED",
  remainingNetAmountCents: 0,
};

test("73: запись схемы 13 без execution становится архивной", () => {
  const stored = storedRecord(storedStateWithExecution(13, undefined));
  assert.ok(stored);
  assert.deepEqual(stored.execution, { dataStatus: "LEGACY_UNKNOWN" });
});

test("74: валидный COMPLETE в схеме 13 всё равно становится архивным", () => {
  // В схемах 11–13 деталей исполнения не существовало: найденное значение
  // недостоверно, даже если структурно валидно.
  const stored = storedRecord(storedStateWithExecution(13, FOREIGN_EXECUTION));
  assert.ok(stored);
  assert.deepEqual(stored.execution, { dataStatus: "LEGACY_UNKNOWN" });
});

test("75: неизвестный dataStatus в схеме 13 становится архивным", () => {
  const stored = storedRecord(
    storedStateWithExecution(13, { dataStatus: "GUESSED", method: "CASH" }),
  );
  assert.ok(stored);
  assert.deepEqual(stored.execution, { dataStatus: "LEGACY_UNKNOWN" });
});

test("76: частичный execution в схеме 13 становится архивным", () => {
  const stored = storedRecord(
    storedStateWithExecution(13, {
      dataStatus: "COMPLETE",
      method: "BANK_TRANSFER",
    }),
  );
  assert.ok(stored);
  assert.deepEqual(stored.execution, { dataStatus: "LEGACY_UNKNOWN" });
});

test("77: при замене execution канонические поля записи сохраняются", () => {
  const stored = storedRecord(storedStateWithExecution(12, FOREIGN_EXECUTION));
  assert.ok(stored);
  assert.equal(stored.id, "settlement-record-1");
  assert.equal(stored.restaurantId, RID);
  assert.equal(stored.currencyCode, "USD");
  assert.deepEqual(stored.accountingEntryIds, ["c1"]);
  assert.equal(stored.restaurantOwesDirectCents, 800);
  assert.equal(stored.directOwesRestaurantCents, 0);
  assert.equal(stored.netDirection, "RESTAURANT_OWES_DIRECT");
  assert.equal(stored.netAmountCents, 800);
  assert.equal(stored.settledAt, NOW);
  assert.equal(stored.actor, "ADMIN");
  assert.equal(stored.note, "Оплата");
  assert.equal(stored.externalReference, "ref-1");
});

test("78: вложенные поля execution старой схемы не переносятся", () => {
  const stored = storedRecord(storedStateWithExecution(11, FOREIGN_EXECUTION));
  assert.ok(stored);
  assert.deepEqual(Object.keys(stored.execution), ["dataStatus"]);
  for (const key of [
    "method",
    "transferredAmountCents",
    "remainingOpenEntryCount",
    "remainingRestaurantOwesDirectCents",
    "remainingDirectOwesRestaurantCents",
    "remainingNetDirection",
    "remainingNetAmountCents",
  ]) {
    assert.ok(!(key in stored.execution), key);
  }
});

test("79: схема 14 сохраняет валидный COMPLETE без изменений", () => {
  const stored = storedRecord(storedStateWithExecution(14, record().execution));
  assert.ok(stored);
  assert.deepEqual(stored.execution, record().execution);
});

test("80: схема 14 без execution отклоняется", () => {
  const parsed = parseStoredState(storedStateWithExecution(14, undefined));
  assert.ok(parsed);
  assert.deepEqual(parsed.restaurantSettlementRecords, []);
});

test("81: схема 14 с повреждённым execution отклоняется", () => {
  for (const execution of [
    { dataStatus: "GUESSED" },
    { dataStatus: "COMPLETE", method: "BANK_TRANSFER" },
    { dataStatus: "LEGACY_UNKNOWN", method: "CASH" },
    { ...record().execution, method: "UNKNOWN_METHOD" },
    { ...record().execution, transferredAmountCents: 700 },
  ]) {
    const parsed = parseStoredState(storedStateWithExecution(14, execution));
    assert.ok(parsed);
    assert.deepEqual(
      parsed.restaurantSettlementRecords,
      [],
      JSON.stringify(execution),
    );
  }
});

test("82: схема 14 принимает уже мигрированную архивную запись", () => {
  const stored = storedRecord(
    storedStateWithExecution(14, { dataStatus: "LEGACY_UNKNOWN" }),
  );
  assert.ok(stored);
  assert.deepEqual(stored.execution, { dataStatus: "LEGACY_UNKNOWN" });
});

test("83: повторная нормализация мигрированной записи идемпотентна", () => {
  const parsed = parseStoredState(
    storedStateWithExecution(13, FOREIGN_EXECUTION),
  );
  assert.ok(parsed);
  const twice = normalizePrototypeState(parsed);
  assert.deepEqual(
    twice.restaurantSettlementRecords,
    parsed.restaurantSettlementRecords,
  );
  const thrice = parseStoredState(JSON.stringify(twice));
  assert.ok(thrice);
  assert.deepEqual(
    thrice.restaurantSettlementRecords,
    parsed.restaurantSettlementRecords,
  );
});

/** Ledger, где один заказ дал и выбранное, и оставшееся обязательство. */
function crossBoundaryDuplicate(
  remainingOverrides: Partial<RestaurantAccountingEntry> = {},
): PrototypeState {
  return stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800, { orderId: "order-1" }),
    entry("c2", "RESTAURANT_OWES_DIRECT", 500, {
      orderId: "order-1",
      ...remainingOverrides,
    }),
  ]);
}

test("84: один заказ в выбранном расчёте и в остатке ломает preview", () => {
  const result = previewOf(crossBoundaryDuplicate(), ["c1"]);
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && result.error.includes("между выбранным расчётом и остатком"),
  );
});

test("85: тип и направление оставшегося дубликата ledger не спасают", () => {
  const asPayout = crossBoundaryDuplicate({
    direction: "DIRECT_OWES_RESTAURANT",
    type: "RESTAURANT_PAYOUT",
  });
  assert.equal(previewOf(asPayout, ["c1"]).ok, false);

  const asRemittance = crossBoundaryDuplicate({ type: "RESTAURANT_REMITTANCE" });
  assert.equal(previewOf(asRemittance, ["c1"]).ok, false);
});

test("86: дубликат не попадает в суммы остатка", () => {
  // Тот же ledger без дубликата даёт нормальный остаток — сравнение показывает,
  // что при дубликате preview именно отклоняется, а не считает как-то иначе.
  const ok = okPreview(
    stateWith([
      entry("c1", "RESTAURANT_OWES_DIRECT", 800, { orderId: "order-1" }),
      entry("c2", "RESTAURANT_OWES_DIRECT", 500, { orderId: "order-2" }),
    ]),
    ["c1"],
  );
  assert.equal(ok.remainingRestaurantOwesDirectCents, 500);
  const broken = previewOf(crossBoundaryDuplicate(), ["c1"]);
  assert.equal(broken.ok, false);
  assert.ok(!broken.ok && !("preview" in broken));
});

test("87: дубликат не попадает в счётчик остатка", () => {
  const broken = previewOf(crossBoundaryDuplicate(), ["c1"]);
  assert.equal(broken.ok, false);
});

test("88: confirm при таком ledger возвращает отказ", () => {
  const state = crossBoundaryDuplicate();
  const res = confirmRestaurantSettlement(state, confirmInput());
  assert.equal(res.result.ok, false);
  assert.equal(res.result.settlementRecordId, null);
});

test("89: confirm возвращает исходный state тем же объектом", () => {
  const state = crossBoundaryDuplicate();
  const res = confirmRestaurantSettlement(state, confirmInput());
  assert.equal(res.state, state);
});

test("90: обязательства остаются открытыми", () => {
  const state = crossBoundaryDuplicate();
  const res = confirmRestaurantSettlement(state, confirmInput());
  assert.equal(res.result.ok, false);
  for (const stored of res.state.restaurantAccountingEntries) {
    assert.equal(stored.status, "OPEN");
    assert.equal(stored.settledAt, null);
  }
});

test("91: запись расчёта не создаётся", () => {
  const state = crossBoundaryDuplicate();
  const res = confirmRestaurantSettlement(state, confirmInput());
  assert.deepEqual(res.state.restaurantSettlementRecords, []);
});

test("92: audit-события не создаются", () => {
  const state = crossBoundaryDuplicate();
  const res = confirmRestaurantSettlement(state, confirmInput());
  assert.deepEqual(res.state.restaurantAccountingResolutionEvents, []);
});

test("93: ревизия не растёт", () => {
  const state = crossBoundaryDuplicate();
  const res = confirmRestaurantSettlement(state, confirmInput());
  assert.equal(res.state.revision, state.revision);
  assert.equal(res.state.updatedAt, state.updatedAt);
});

test("94: разные заказы в выборе и остатке проходят", () => {
  const preview = okPreview(
    stateWith([
      entry("c1", "RESTAURANT_OWES_DIRECT", 800, { orderId: "order-1" }),
      entry("c2", "RESTAURANT_OWES_DIRECT", 500, { orderId: "order-2" }),
    ]),
    ["c1"],
  );
  assert.equal(preview.remainingOpenEntryCount, 1);
  assert.equal(preview.remainingRestaurantOwesDirectCents, 500);
});

test("95: дубли заказа внутри выбора по-прежнему отклоняются", () => {
  const state = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800, { orderId: "order-1" }),
    entry("c2", "RESTAURANT_OWES_DIRECT", 500, { orderId: "order-1" }),
  ]);
  const result = previewOf(state, ["c1", "c2"]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("выбрано несколько"));
});

test("96: дубли заказа внутри остатка по-прежнему отклоняются", () => {
  const state = stateWith([
    entry("c0", "RESTAURANT_OWES_DIRECT", 800, { orderId: "order-0" }),
    entry("c1", "RESTAURANT_OWES_DIRECT", 500, { orderId: "order-1" }),
    entry("c2", "RESTAURANT_OWES_DIRECT", 300, { orderId: "order-1" }),
  ]);
  const result = previewOf(state, ["c0"]);
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && result.error.includes("несколько открытых обязательств"),
  );
});

test("97: нормальный расчёт по-прежнему создаёт COMPLETE execution", () => {
  const res = confirmRestaurantSettlement(debtState(), confirmInput());
  assert.equal(res.result.error, null);
  const stored = res.state.restaurantSettlementRecords[0];
  assert.ok(stored);
  assert.equal(stored.execution.dataStatus, "COMPLETE");
});

test("98: версия схемы актуальна", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 21);
});
