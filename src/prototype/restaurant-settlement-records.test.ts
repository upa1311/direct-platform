import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  buildRestaurantSettlementPreview,
  confirmRestaurantSettlement,
  getRestaurantSettlementRecords,
} from "./restaurant-settlement-records.ts";
import { resolveRestaurantAccountingEntry } from "./restaurant-accounting.ts";
import { parseStoredState } from "./prototype-store.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type {
  PrototypeState,
  RestaurantAccountingEntry,
  RestaurantAccountingResolutionEvent,
  SettlementEntry,
} from "./models.ts";

/**
 * Групповой закрытый расчёт: чистый preview, атомарное административное
 * подтверждение и persistence записей (schema v11).
 */

/**
 * v14: домен принимает объектный вход со способом и фактической суммой. Эти
 * тесты проверяют состав транзакции, а не детали исполнения, поэтому обёртка
 * подставляет канонически совместимые способ и сумму из свежего preview.
 */
function confirmPositional(
  state: PrototypeState,
  restaurantId: string,
  accountingEntryIds: readonly string[],
  note: string,
  externalReference: string | null,
  nowIso: string,
) {
  const preview = buildRestaurantSettlementPreview(
    state,
    restaurantId,
    accountingEntryIds,
  );
  const balanced = preview.ok && preview.preview.netDirection === "BALANCED";
  return confirmRestaurantSettlement(state, {
    restaurantId,
    accountingEntryIds,
    method: balanced ? "NETTING" : "BANK_TRANSFER",
    transferredAmountCents:
      balanced || !preview.ok ? 0 : preview.preview.netAmountCents,
    note,
    externalReference,
    nowIso,
  });
}

const RID = "restaurant-1";
const OTHER_RID = "restaurant-2";
const NOW = "2026-07-20T12:00:00.000Z";
const T0 = "2026-07-19T10:00:00.000Z";

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
  records: PrototypeState["restaurantSettlementRecords"] = [],
): PrototypeState {
  return {
    ...createDefaultState(),
    restaurantAccountingEntries: entries,
    settlements,
    restaurantAccountingResolutionEvents: events,
    restaurantSettlementRecords: records,
  };
}

function okPreview(state: PrototypeState, ids: string[], rid = RID) {
  const result = buildRestaurantSettlementPreview(state, rid, ids);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) throw new Error("unreachable");
  return result.preview;
}

// 1-6 — preview и net ------------------------------------------------------------

test("preview: комиссия ресторана, выплата Direct, смешанные направления", () => {
  const commission = entry("c1", "RESTAURANT_OWES_DIRECT", 800);
  const payout = entry("p1", "DIRECT_OWES_RESTAURANT", 5100);
  const st = stateWith([commission, payout]);

  const onlyCommission = okPreview(st, ["c1"]);
  assert.equal(onlyCommission.restaurantOwesDirectCents, 800);
  assert.equal(onlyCommission.directOwesRestaurantCents, 0);
  assert.equal(onlyCommission.netDirection, "RESTAURANT_OWES_DIRECT");
  assert.equal(onlyCommission.netAmountCents, 800);
  assert.equal(onlyCommission.entryCount, 1);
  assert.equal(onlyCommission.currencyCode, "USD");

  const onlyPayout = okPreview(st, ["p1"]);
  assert.equal(onlyPayout.directOwesRestaurantCents, 5100);
  assert.equal(onlyPayout.netDirection, "DIRECT_OWES_RESTAURANT");
  assert.equal(onlyPayout.netAmountCents, 5100);

  const mixed = okPreview(st, ["c1", "p1"]);
  assert.equal(mixed.restaurantOwesDirectCents, 800);
  assert.equal(mixed.directOwesRestaurantCents, 5100);
  assert.equal(mixed.netDirection, "DIRECT_OWES_RESTAURANT");
  assert.equal(mixed.netAmountCents, 4300);
  assert.equal(mixed.entryCount, 2);
});

test("preview: равные суммы дают BALANCED и ноль", () => {
  const st = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 900),
    entry("p1", "DIRECT_OWES_RESTAURANT", 900),
  ]);
  const preview = okPreview(st, ["c1", "p1"]);
  assert.equal(preview.netDirection, "BALANCED");
  assert.equal(preview.netAmountCents, 0);
});

// 7-16 — fail-closed валидация ----------------------------------------------------

test("preview отклоняет некорректный вход и обязательства", () => {
  const open = entry("c1", "RESTAURANT_OWES_DIRECT", 800);
  const closed = entry("c2", "RESTAURANT_OWES_DIRECT", 200, {
    status: "SETTLED",
    settledAt: T0,
  });
  const foreign = entry("f1", "RESTAURANT_OWES_DIRECT", 300, {
    restaurantId: OTHER_RID,
  });
  const badAmount = entry("b1", "RESTAURANT_OWES_DIRECT", 0);
  const st = stateWith([open, closed, foreign, badAmount]);

  const cases: [string, string[], RegExp][] = [
    ["пустой список", [], /Выберите обязательства/],
    ["дубли во входе", ["c1", "c1"], /несколько раз/],
    ["несуществующий", ["нет"], /не найдено/],
    ["чужой ресторан", ["f1"], /другому ресторану/],
    ["уже закрыт", ["c2"], /уже закрыто/],
    ["некорректная сумма", ["b1"], /Некорректная сумма/],
  ];
  for (const [label, ids, pattern] of cases) {
    const result = buildRestaurantSettlementPreview(st, RID, ids);
    assert.equal(result.ok, false, label);
    assert.ok(!result.ok && pattern.test(result.error), label);
  }
});

test("preview отклоняет уже решённые, включённые в расчёт и разные валюты", () => {
  const a = entry("c1", "RESTAURANT_OWES_DIRECT", 800);
  const b = entry("c2", "RESTAURANT_OWES_DIRECT", 400);
  const eur = entry("c3", "RESTAURANT_OWES_DIRECT", 100, {
    currencyCode: "EUR" as RestaurantAccountingEntry["currencyCode"],
  });

  // Обязательство с существующим audit-событием.
  const withEvent = stateWith(
    [a],
    [],
    [
      {
        id: "accounting-resolution-c1",
        accountingEntryId: "c1",
        restaurantId: RID,
        previousStatus: "OPEN",
        nextStatus: "SETTLED",
        occurredAt: T0,
        actor: "ADMIN",
        note: "ранее",
        externalReference: null,
      },
    ],
  );
  const resolved = buildRestaurantSettlementPreview(withEvent, RID, ["c1"]);
  assert.equal(resolved.ok, false);
  assert.ok(!resolved.ok && /уже есть решение/.test(resolved.error));

  // Обязательство, уже входящее в закрытый расчёт.
  const withRecord = stateWith([a], [], [], [
    {
      id: "settlement-record-old",
      restaurantId: RID,
      currencyCode: "USD",
      accountingEntryIds: ["c1"],
      restaurantOwesDirectCents: 800,
      directOwesRestaurantCents: 0,
      netDirection: "RESTAURANT_OWES_DIRECT",
      netAmountCents: 800,
      settledAt: T0,
      actor: "ADMIN",
      note: "ранее",
      externalReference: "ref-old",
    },
  ]);
  const inRecord = buildRestaurantSettlementPreview(withRecord, RID, ["c1"]);
  assert.equal(inRecord.ok, false);
  assert.ok(!inRecord.ok && /уже входит в закрытый расчёт/.test(inRecord.error));

  // Разные валюты в одном расчёте.
  const mixedCurrency = buildRestaurantSettlementPreview(
    stateWith([b, eur]),
    RID,
    ["c2", "c3"],
  );
  assert.equal(mixedCurrency.ok, false);

  // Несколько обязательств одного заказа.
  const sameOrder = buildRestaurantSettlementPreview(
    stateWith([
      entry("s1", "RESTAURANT_OWES_DIRECT", 100, { orderId: "order-x" }),
      entry("s2", "DIRECT_OWES_RESTAURANT", 200, { orderId: "order-x" }),
    ]),
    RID,
    ["s1", "s2"],
  );
  assert.equal(sameOrder.ok, false);
  assert.ok(!sameOrder.ok && /несколько обязательств/.test(sameOrder.error));
});

test("preview отклоняет несовместимую пару направление/основание", () => {
  // Комиссия не может идти от Direct ресторану, а выплата — от ресторана Direct.
  const wrongCommission = entry("w1", "RESTAURANT_OWES_DIRECT", 800, {
    type: "RESTAURANT_PAYOUT",
  });
  const wrongPayout = entry("w2", "DIRECT_OWES_RESTAURANT", 500, {
    type: "PLATFORM_COMMISSION",
    orderId: "order-w2",
  });
  const valid = entry("c1", "RESTAURANT_OWES_DIRECT", 300, {
    orderId: "order-c1",
  });
  const st = stateWith([wrongCommission, wrongPayout, valid]);

  for (const id of ["w1", "w2"]) {
    const result = buildRestaurantSettlementPreview(st, RID, [id]);
    assert.equal(result.ok, false, id);
    assert.ok(!result.ok && /не соответствует направлению/.test(result.error), id);
  }

  // Повреждённая пара не попадает в gross/net даже вместе с валидной записью.
  const mixed = buildRestaurantSettlementPreview(st, RID, ["c1", "w1"]);
  assert.equal(mixed.ok, false);
  // v14: повреждённая пара, ОСТАВШАЯСЯ открытой, тоже ломает preview — иначе
  // остаток в записи был бы правдоподобным, но недостоверным.
  const leftCorrupted = buildRestaurantSettlementPreview(st, RID, ["c1"]);
  assert.equal(leftCorrupted.ok, false);
  // Валидная запись без повреждённого окружения по-прежнему считается.
  const onlyValid = okPreview(stateWith([valid]), ["c1"]);
  assert.equal(onlyValid.restaurantOwesDirectCents, 300);
  assert.equal(onlyValid.netAmountCents, 300);

  // Confirm получает ту же защиту через повторный preview: state тем же объектом.
  const confirmed = confirmPositional(
    st,
    RID,
    ["w1"],
    "Основание",
    "ref-1",
    NOW,
  );
  assert.equal(confirmed.result.ok, false);
  assert.equal(confirmed.state, st);
  assert.equal(confirmed.state.restaurantSettlementRecords.length, 0);
  assert.equal(confirmed.state.restaurantAccountingResolutionEvents.length, 0);
  assert.ok(
    confirmed.state.restaurantAccountingEntries.every((e) => e.status === "OPEN"),
  );
});

test("preview отклоняет переполнение safe integer", () => {
  const huge = Number.MAX_SAFE_INTEGER - 1;
  const st = stateWith([
    entry("h1", "RESTAURANT_OWES_DIRECT", huge, { orderId: "order-h1" }),
    entry("h2", "RESTAURANT_OWES_DIRECT", huge, { orderId: "order-h2" }),
  ]);
  const result = buildRestaurantSettlementPreview(st, RID, ["h1", "h2"]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /слишком велика/.test(result.error));
});

// 17 — чистота preview ------------------------------------------------------------

test("preview не мутирует state", () => {
  const st = stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 800)]);
  const snapshot = JSON.stringify(st);
  const entriesRef = st.restaurantAccountingEntries;
  okPreview(st, ["c1"]);
  assert.equal(JSON.stringify(st), snapshot);
  assert.equal(st.restaurantAccountingEntries, entriesRef);
});

// 18-25 — успешное подтверждение ---------------------------------------------------

test("confirm: один record, SETTLED, события, синхронизация legacy settlements", () => {
  const commission = entry("c1", "RESTAURANT_OWES_DIRECT", 800, {
    orderId: "order-1",
  });
  const payout = entry("p1", "DIRECT_OWES_RESTAURANT", 5100, {
    orderId: "order-2",
  });
  const untouched = entry("c9", "RESTAURANT_OWES_DIRECT", 250, {
    orderId: "order-9",
  });
  const legacyCommission: SettlementEntry = {
    id: "settlement-order-1",
    orderId: "order-1",
    restaurantId: RID,
    type: "PICKUP_COMMISSION",
    amountCents: 800,
    status: "PENDING",
    createdAt: T0,
  };
  const legacyPayoutOrder: SettlementEntry = {
    id: "settlement-order-2",
    orderId: "order-2",
    restaurantId: RID,
    type: "PICKUP_COMMISSION",
    amountCents: 100,
    status: "PENDING",
    createdAt: T0,
  };
  const st = stateWith(
    [commission, payout, untouched],
    [legacyCommission, legacyPayoutOrder],
  );

  const res = confirmPositional(
    st,
    RID,
    ["c1", "p1"],
    "  Перевод подтверждён  ",
    "  bank-777  ",
    NOW,
  );
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.ok(res.result.settlementRecordId);

  // Ровно одна запись расчёта с точными gross и net.
  const records = getRestaurantSettlementRecords(res.state, RID);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.restaurantOwesDirectCents, 800);
  assert.equal(record.directOwesRestaurantCents, 5100);
  assert.equal(record.netDirection, "DIRECT_OWES_RESTAURANT");
  assert.equal(record.netAmountCents, 4300);
  assert.equal(record.settledAt, NOW);
  assert.equal(record.actor, "ADMIN");
  // Note и reference нормализованы (trim).
  assert.equal(record.note, "Перевод подтверждён");
  assert.equal(record.externalReference, "bank-777");
  assert.deepEqual(record.accountingEntryIds, ["c1", "p1"]);

  // Все выбранные обязательства закрыты одним settledAt; чужое осталось OPEN.
  const byId = new Map(
    res.state.restaurantAccountingEntries.map((e) => [e.id, e]),
  );
  for (const id of ["c1", "p1"]) {
    assert.equal(byId.get(id)!.status, "SETTLED", id);
    assert.equal(byId.get(id)!.settledAt, NOW, id);
  }
  assert.equal(byId.get("c9")!.status, "OPEN");
  assert.equal(byId.get("c9")!.settledAt, null);

  // По одному audit-событию на обязательство.
  const events = res.state.restaurantAccountingResolutionEvents;
  assert.equal(events.length, 2);
  for (const id of ["c1", "p1"]) {
    const forEntry = events.filter((e) => e.accountingEntryId === id);
    assert.equal(forEntry.length, 1, id);
    assert.equal(forEntry[0].previousStatus, "OPEN");
    assert.equal(forEntry[0].nextStatus, "SETTLED");
    assert.equal(forEntry[0].occurredAt, NOW);
    assert.equal(forEntry[0].actor, "ADMIN");
    assert.equal(forEntry[0].note, "Перевод подтверждён");
    assert.equal(forEntry[0].externalReference, "bank-777");
  }

  // Старый комиссионный settlement стал PAID; заказ выплаты не тронут.
  const settlementsById = new Map(res.state.settlements.map((s) => [s.id, s]));
  assert.equal(settlementsById.get("settlement-order-1")!.status, "PAID");
  assert.equal(settlementsById.get("settlement-order-2")!.status, "PENDING");
  // Новые SettlementEntry не создаются.
  assert.equal(res.state.settlements.length, 2);
  // Revision вырос ровно на один.
  assert.equal(res.state.revision, st.revision + 1);
});

test("confirm: BALANCED допускает пустую ссылку, ненулевой итог — нет", () => {
  const st = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 900, { orderId: "order-1" }),
    entry("p1", "DIRECT_OWES_RESTAURANT", 900, { orderId: "order-2" }),
  ]);
  const balanced = confirmPositional(
    st,
    RID,
    ["c1", "p1"],
    "Взаимозачёт равных обязательств",
    "   ",
    NOW,
  );
  assert.equal(balanced.result.ok, true, balanced.result.error ?? "");
  const record = getRestaurantSettlementRecords(balanced.state, RID)[0];
  assert.equal(record.netDirection, "BALANCED");
  assert.equal(record.netAmountCents, 0);
  assert.equal(record.externalReference, null);

  // Ненулевой итог без внешней ссылки — отказ без мутации.
  const single = stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 800)]);
  const noRef = confirmPositional(
    single,
    RID,
    ["c1"],
    "Основание есть",
    null,
    NOW,
  );
  assert.equal(noRef.result.ok, false);
  assert.ok(/внешнюю ссылку/.test(noRef.result.error ?? ""));
  assert.equal(noRef.state, single);
});

// 28-31 — fail-closed и повтор ------------------------------------------------------

test("confirm: любая ошибка не меняет state и не закрывает обязательства", () => {
  const st = stateWith(
    [
      entry("c1", "RESTAURANT_OWES_DIRECT", 800, { orderId: "order-1" }),
      entry("c2", "RESTAURANT_OWES_DIRECT", 400, { orderId: "order-2" }),
    ],
    [],
    [],
    [],
  );
  const cases: [string, () => ReturnType<typeof confirmRestaurantSettlement>][] = [
    ["без основания", () => confirmPositional(st, RID, ["c1"], "   ", "ref", NOW)],
    ["плохое время", () => confirmPositional(st, RID, ["c1"], "ок", "ref", "не-дата")],
    ["несуществующий entry", () => confirmPositional(st, RID, ["c1", "нет"], "ок", "ref", NOW)],
    ["дубли", () => confirmPositional(st, RID, ["c1", "c1"], "ок", "ref", NOW)],
  ];
  for (const [label, run] of cases) {
    const res = run();
    assert.equal(res.result.ok, false, label);
    assert.equal(res.result.settlementRecordId, null, label);
    // Исходный state тем же объектом: нет частичного закрытия.
    assert.equal(res.state, st, label);
    assert.equal(res.state.revision, st.revision, label);
    assert.equal(res.state.restaurantSettlementRecords.length, 0, label);
    assert.equal(res.state.restaurantAccountingResolutionEvents.length, 0, label);
    assert.ok(
      res.state.restaurantAccountingEntries.every((e) => e.status === "OPEN"),
      label,
    );
  }
});

test("confirm: повторное подтверждение тех же обязательств отклоняется", () => {
  const st = stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 800)]);
  const first = confirmPositional(st, RID, ["c1"], "Оплата", "ref-1", NOW);
  assert.equal(first.result.ok, true, first.result.error ?? "");

  // Повтор — не идемпотентный no-op, а явный отказ (финансовое подтверждение).
  const second = confirmPositional(
    first.state,
    RID,
    ["c1"],
    "Оплата",
    "ref-1",
    NOW,
  );
  assert.equal(second.result.ok, false);
  assert.equal(second.state, first.state);
  assert.equal(getRestaurantSettlementRecords(second.state, RID).length, 1);
});

// Канонический момент операции ---------------------------------------------------------

test("confirm принимает только канонический ISO nowIso с часовым поясом", () => {
  const st = stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 800)]);

  // Неканонические значения отклоняются без единого изменения состояния.
  for (const badNow of [
    "2026-07-20",
    "2026-07-20T12:00:00",
    "2026-02-30T12:00:00Z",
    "2026-07-20T25:00:00Z",
    "не-дата",
    "",
  ]) {
    const res = confirmPositional(
      st,
      RID,
      ["c1"],
      "Оплата",
      "ref-1",
      badNow,
    );
    assert.equal(res.result.ok, false, badNow);
    assert.equal(res.result.settlementRecordId, null, badNow);
    assert.equal(res.state, st, badNow);
    assert.equal(res.state.revision, st.revision, badNow);
    assert.equal(res.state.restaurantSettlementRecords.length, 0, badNow);
    assert.equal(res.state.restaurantAccountingResolutionEvents.length, 0, badNow);
    assert.ok(
      res.state.restaurantAccountingEntries.every((e) => e.status === "OPEN"),
      badNow,
    );
  }

  // Канонический Z и канонический offset — оба подтверждают расчёт.
  for (const goodNow of ["2026-07-20T12:00:00Z", "2026-07-20T08:00:00.000-04:00"]) {
    const res = confirmPositional(
      stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 800)]),
      RID,
      ["c1"],
      "Оплата",
      "ref-1",
      goodNow,
    );
    assert.equal(res.result.ok, true, `${goodNow}: ${res.result.error ?? ""}`);
    const record = getRestaurantSettlementRecords(res.state, RID)[0];
    // Исходная строка сохранена без конвертации.
    assert.equal(record.settledAt, goodNow, goodNow);
  }
});

test("успешный confirm использует один и тот же момент во всех сущностях", () => {
  const now = "2026-07-20T08:00:00.000-04:00";
  const st = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800, { orderId: "order-1" }),
    entry("p1", "DIRECT_OWES_RESTAURANT", 5100, { orderId: "order-2" }),
  ]);
  const res = confirmPositional(
    st,
    RID,
    ["c1", "p1"],
    "Оплата",
    "ref-1",
    now,
  );
  assert.equal(res.result.ok, true, res.result.error ?? "");

  const record = getRestaurantSettlementRecords(res.state, RID)[0];
  assert.equal(record.settledAt, now);
  // id расчёта построен на том же моменте.
  assert.ok(record.id.includes(now));
  for (const entryAfter of res.state.restaurantAccountingEntries) {
    assert.equal(entryAfter.settledAt, now, entryAfter.id);
  }
  for (const event of res.state.restaurantAccountingResolutionEvents) {
    assert.equal(event.occurredAt, now, event.id);
  }
  assert.equal(res.state.updatedAt, now);
});

// 32 — частичный расчёт --------------------------------------------------------------

test("частичный расчёт оставляет невыбранные обязательства открытыми", () => {
  const st = stateWith([
    entry("c1", "RESTAURANT_OWES_DIRECT", 800, { orderId: "order-1" }),
    entry("c2", "RESTAURANT_OWES_DIRECT", 400, { orderId: "order-2" }),
    entry("p1", "DIRECT_OWES_RESTAURANT", 100, { orderId: "order-3" }),
  ]);
  const res = confirmPositional(st, RID, ["c1"], "Частичный", "ref", NOW);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const byId = new Map(res.state.restaurantAccountingEntries.map((e) => [e.id, e]));
  assert.equal(byId.get("c1")!.status, "SETTLED");
  assert.equal(byId.get("c2")!.status, "OPEN");
  assert.equal(byId.get("p1")!.status, "OPEN");
  assert.deepEqual(
    getRestaurantSettlementRecords(res.state, RID)[0].accountingEntryIds,
    ["c1"],
  );
});

// 33/34 — persistence и migration -----------------------------------------------------

test("старое состояние мигрирует с пустым массивом записей", () => {
  const legacy = createDefaultState() as unknown as Record<string, unknown>;
  legacy.schemaVersion = 10;
  delete legacy.restaurantSettlementRecords;
  const parsed = parseStoredState(JSON.stringify(legacy));
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, PROTOTYPE_SCHEMA_VERSION);
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 20);
  assert.deepEqual(parsed.restaurantSettlementRecords, []);
});

test("serialize/parse сохраняет записи расчётов без изменений", () => {
  const st = stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 800)]);
  const confirmed = confirmPositional(
    st,
    RID,
    ["c1"],
    "Оплата",
    "ref-1",
    NOW,
  ).state;
  const parsed = parseStoredState(JSON.stringify(confirmed));
  assert.ok(parsed);
  assert.deepEqual(
    parsed.restaurantSettlementRecords,
    confirmed.restaurantSettlementRecords,
  );
  // Повторный parse идемпотентен.
  const twice = parseStoredState(JSON.stringify(parsed));
  assert.ok(twice);
  assert.deepEqual(
    twice.restaurantSettlementRecords,
    confirmed.restaurantSettlementRecords,
  );
});

// 35 — существующий одиночный workflow ------------------------------------------------

test("одиночное resolveRestaurantAccountingEntry продолжает работать", () => {
  const st = stateWith([entry("c1", "RESTAURANT_OWES_DIRECT", 800)]);
  const res = resolveRestaurantAccountingEntry(
    st,
    "c1",
    "WAIVED",
    "Списание требования",
    null,
    NOW,
  );
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const entryAfter = res.state.restaurantAccountingEntries[0];
  assert.equal(entryAfter.status, "WAIVED");
  // Групповой расчёт при этом не создаётся: WAIVED — отдельный workflow.
  assert.equal(res.state.restaurantSettlementRecords.length, 0);
  // И такое обязательство больше нельзя включить в batch settlement.
  const preview = buildRestaurantSettlementPreview(res.state, RID, ["c1"]);
  assert.equal(preview.ok, false);
});
