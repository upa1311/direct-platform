import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isAllowedDirectionTypePair,
  SETTLEMENT_DIRECTION_TYPE_ERROR,
  validateRestaurantSettlementRecord,
} from "./restaurant-settlement-integrity.ts";
import {
  ACCOUNTING_RESOLUTION_NOTE_MAX,
  ACCOUNTING_RESOLUTION_REFERENCE_MAX,
} from "./restaurant-accounting.ts";
import { createDefaultState, } from "./default-state.ts";
import { parseStoredState } from "./prototype-store.ts";
import type { PrototypeState, RestaurantSettlementRecord } from "./models.ts";

/**
 * Intrinsic-валидация записи закрытого расчёта и целостность коллекции при
 * нормализации сохранённого состояния. Значения не пересчитываются: запись
 * либо валидна целиком, либо отклоняется.
 */

const NOW = "2026-07-20T12:00:00.000Z";

function validRecord(
  overrides: Partial<RestaurantSettlementRecord> = {},
): RestaurantSettlementRecord {
  return {
    id: "settlement-record-1",
    restaurantId: "restaurant-1",
    currencyCode: "USD",
    accountingEntryIds: ["c1", "p1"],
    restaurantOwesDirectCents: 800,
    directOwesRestaurantCents: 5100,
    netDirection: "DIRECT_OWES_RESTAURANT",
    netAmountCents: 4300,
    settledAt: NOW,
    actor: "ADMIN",
    note: "Перевод подтверждён",
    externalReference: "bank-777",
    ...overrides,
  };
}

/** Валидация с произвольным (в т.ч. повреждённым) значением поля. */
function withField(field: string, value: unknown) {
  return validateRestaurantSettlementRecord({
    ...validRecord(),
    [field]: value,
  });
}

// --- Пары направление/основание ---------------------------------------------------

test("допустимы только две пары направление + основание", () => {
  assert.equal(
    isAllowedDirectionTypePair("RESTAURANT_OWES_DIRECT", "PLATFORM_COMMISSION"),
    true,
  );
  assert.equal(
    isAllowedDirectionTypePair("DIRECT_OWES_RESTAURANT", "RESTAURANT_PAYOUT"),
    true,
  );
  // Смешанные пары — повреждение.
  assert.equal(
    isAllowedDirectionTypePair("RESTAURANT_OWES_DIRECT", "RESTAURANT_PAYOUT"),
    false,
  );
  assert.equal(
    isAllowedDirectionTypePair("DIRECT_OWES_RESTAURANT", "PLATFORM_COMMISSION"),
    false,
  );
  // Неизвестные значения.
  assert.equal(isAllowedDirectionTypePair("SIDEWAYS", "PLATFORM_COMMISSION"), false);
  assert.equal(isAllowedDirectionTypePair("RESTAURANT_OWES_DIRECT", "MYSTERY"), false);
  assert.ok(SETTLEMENT_DIRECTION_TYPE_ERROR.length > 0);
});

// --- Валидатор записи: успешный случай ---------------------------------------------

test("полностью корректная запись принимается и возвращается новым объектом", () => {
  const source = validRecord();
  const result = validateRestaurantSettlementRecord(source);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.deepEqual(result.record, source);
  // Не blind cast: возвращается новый объект, вход не мутируется.
  assert.notEqual(result.record, source);
  assert.notEqual(result.record.accountingEntryIds, source.accountingEntryIds);
});

// --- Identity, валюта, состав обязательств -----------------------------------------

test("identity, валюта и состав обязательств проверяются строго", () => {
  const cases: [string, unknown][] = [
    ["id", ""],
    ["id", "   "],
    ["id", 42],
    ["restaurantId", ""],
    ["restaurantId", "  "],
    ["currencyCode", "EUR"],
    ["accountingEntryIds", []],
    ["accountingEntryIds", "c1"],
    ["accountingEntryIds", ["c1", "c1"]],
    ["accountingEntryIds", ["c1", ""]],
    ["accountingEntryIds", ["c1", "   "]],
    ["accountingEntryIds", ["c1", 7]],
  ];
  for (const [field, value] of cases) {
    const result = withField(field, value);
    assert.equal(result.ok, false, `${field}=${JSON.stringify(value)}`);
  }
  // Не объект вовсе.
  assert.equal(validateRestaurantSettlementRecord(null).ok, false);
  assert.equal(validateRestaurantSettlementRecord([]).ok, false);
  assert.equal(validateRestaurantSettlementRecord("запись").ok, false);
});

// --- Gross-суммы ---------------------------------------------------------------------

test("gross-суммы: только целые неотрицательные safe integer, не обе нулевые", () => {
  for (const field of [
    "restaurantOwesDirectCents",
    "directOwesRestaurantCents",
  ]) {
    for (const value of [
      -1,
      10.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
      "800",
    ]) {
      assert.equal(withField(field, value).ok, false, `${field}=${String(value)}`);
    }
  }
  // Обе стороны нулевые — расчёт без сумм.
  const zero = validateRestaurantSettlementRecord(
    validRecord({
      restaurantOwesDirectCents: 0,
      directOwesRestaurantCents: 0,
      netDirection: "BALANCED",
      netAmountCents: 0,
      externalReference: null,
    }),
  );
  assert.equal(zero.ok, false);
  assert.ok(!zero.ok && /без сумм/.test(zero.error));
});

// --- Net: соответствие сохранённых значений реальным gross ---------------------------

test("сохранённый net обязан совпадать с gross-суммами", () => {
  // Неверное направление при верной сумме.
  const wrongDirection = validateRestaurantSettlementRecord(
    validRecord({ netDirection: "RESTAURANT_OWES_DIRECT" }),
  );
  assert.equal(wrongDirection.ok, false);
  assert.ok(!wrongDirection.ok && /Направление итога/.test(wrongDirection.error));

  // Верное направление при неверной сумме.
  const wrongAmount = validateRestaurantSettlementRecord(
    validRecord({ netAmountCents: 4200 }),
  );
  assert.equal(wrongAmount.ok, false);
  assert.ok(!wrongAmount.ok && /Итог расчёта не соответствует/.test(wrongAmount.error));

  // Равные gross, но направление не BALANCED.
  const notBalanced = validateRestaurantSettlementRecord(
    validRecord({
      restaurantOwesDirectCents: 900,
      directOwesRestaurantCents: 900,
      netDirection: "DIRECT_OWES_RESTAURANT",
      netAmountCents: 0,
      externalReference: null,
    }),
  );
  assert.equal(notBalanced.ok, false);

  // BALANCED при неравных gross.
  const falseBalanced = validateRestaurantSettlementRecord(
    validRecord({ netDirection: "BALANCED", netAmountCents: 4300 }),
  );
  assert.equal(falseBalanced.ok, false);

  // Неизвестное направление.
  assert.equal(withField("netDirection", "SIDEWAYS").ok, false);
  // Некорректный тип итога.
  for (const value of [-1, 4300.5, Number.NaN, "4300"]) {
    assert.equal(withField("netAmountCents", value).ok, false, String(value));
  }
});

// --- Момент, автор, основание, ссылка -------------------------------------------------

test("settledAt, actor, note и externalReference проверяются строго", () => {
  for (const value of ["", "   ", "не-дата", 1_700_000_000]) {
    assert.equal(withField("settledAt", value).ok, false, String(value));
  }
  for (const value of ["RESTAURANT", "SYSTEM", "", null]) {
    assert.equal(withField("actor", value).ok, false, String(value));
  }
  for (const value of ["", "   ", 42, null]) {
    assert.equal(withField("note", value).ok, false, String(value));
  }
  assert.equal(
    withField("note", "x".repeat(ACCOUNTING_RESOLUTION_NOTE_MAX + 1)).ok,
    false,
  );
  // Пустая/пробельная ссылка в сохранённой записи — повреждение (домен пишет null).
  for (const value of ["", "   ", 7]) {
    assert.equal(withField("externalReference", value).ok, false, String(value));
  }
  assert.equal(
    withField(
      "externalReference",
      "r".repeat(ACCOUNTING_RESOLUTION_REFERENCE_MAX + 1),
    ).ok,
    false,
  );
  // Ненулевой итог без внешней ссылки — повреждение.
  const noRef = validateRestaurantSettlementRecord(
    validRecord({ externalReference: null }),
  );
  assert.equal(noRef.ok, false);
  assert.ok(!noRef.ok && /без внешней ссылки/.test(noRef.error));
  // BALANCED без ссылки — допустимо.
  const balanced = validateRestaurantSettlementRecord(
    validRecord({
      restaurantOwesDirectCents: 900,
      directOwesRestaurantCents: 900,
      netDirection: "BALANCED",
      netAmountCents: 0,
      externalReference: null,
    }),
  );
  assert.equal(balanced.ok, true, balanced.ok ? "" : balanced.error);
});

// --- Целостность коллекции при нормализации --------------------------------------------

function stateWithRecords(records: unknown[]): string {
  const state = createDefaultState() as unknown as Record<string, unknown>;
  state.restaurantSettlementRecords = records;
  return JSON.stringify(state);
}

function parsedRecords(json: string): PrototypeState["restaurantSettlementRecords"] {
  const parsed = parseStoredState(json);
  assert.ok(parsed);
  return parsed.restaurantSettlementRecords;
}

test("нормализация сохраняет валидные записи и исключает повреждённые", () => {
  const good1 = validRecord({ id: "rec-1", accountingEntryIds: ["c1"] , restaurantOwesDirectCents: 800, directOwesRestaurantCents: 0, netDirection: "RESTAURANT_OWES_DIRECT", netAmountCents: 800 });
  const broken = validRecord({ id: "rec-broken", accountingEntryIds: ["cX"], netAmountCents: 1 });
  const good2 = validRecord({ id: "rec-2", accountingEntryIds: ["p9"], restaurantOwesDirectCents: 0, directOwesRestaurantCents: 300, netDirection: "DIRECT_OWES_RESTAURANT", netAmountCents: 300 });

  const records = parsedRecords(stateWithRecords([good1, broken, good2]));
  // Повреждённая исключена, значения валидных не изменены, порядок сохранён.
  assert.deepEqual(records.map((r) => r.id), ["rec-1", "rec-2"]);
  assert.deepEqual(records[0], good1);
  assert.deepEqual(records[1], good2);
});

test("конфликты коллекции отбрасываются детерминированно", () => {
  const first = validRecord({ id: "rec-1", accountingEntryIds: ["c1"], restaurantOwesDirectCents: 800, directOwesRestaurantCents: 0, netDirection: "RESTAURANT_OWES_DIRECT", netAmountCents: 800 });
  // Повторный id.
  const duplicateId = validRecord({ id: "rec-1", accountingEntryIds: ["c2"], restaurantOwesDirectCents: 400, directOwesRestaurantCents: 0, netDirection: "RESTAURANT_OWES_DIRECT", netAmountCents: 400 });
  // Другое id, но то же обязательство — двойной исторический расчёт.
  const sharedEntry = validRecord({ id: "rec-3", accountingEntryIds: ["c1"], restaurantOwesDirectCents: 800, directOwesRestaurantCents: 0, netDirection: "RESTAURANT_OWES_DIRECT", netAmountCents: 800 });

  const records = parsedRecords(
    stateWithRecords([first, duplicateId, sharedEntry]),
  );
  // Первая полностью валидная запись сохраняется, конфликтующие отброшены.
  assert.deepEqual(records.map((r) => r.id), ["rec-1"]);
  assert.deepEqual(records[0], first);
});

test("нормализация идемпотентна, старое состояние получает пустой массив", () => {
  const good = validRecord({ id: "rec-1", accountingEntryIds: ["c1"], restaurantOwesDirectCents: 800, directOwesRestaurantCents: 0, netDirection: "RESTAURANT_OWES_DIRECT", netAmountCents: 800 });
  const once = parseStoredState(stateWithRecords([good]));
  assert.ok(once);
  const twice = parseStoredState(JSON.stringify(once));
  assert.ok(twice);
  assert.deepEqual(
    twice.restaurantSettlementRecords,
    once.restaurantSettlementRecords,
  );

  // Состояние до v11: поля нет.
  const legacy = createDefaultState() as unknown as Record<string, unknown>;
  legacy.schemaVersion = 10;
  delete legacy.restaurantSettlementRecords;
  const parsedLegacy = parseStoredState(JSON.stringify(legacy));
  assert.ok(parsedLegacy);
  assert.deepEqual(parsedLegacy.restaurantSettlementRecords, []);
});
