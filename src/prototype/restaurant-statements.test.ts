import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRestaurantStatementMovements } from "./restaurant-statements.ts";
import { createDefaultState } from "./default-state.ts";
import type {
  CurrencyCode,
  Order,
  PrototypeState,
  RestaurantAccountingEntry,
  RestaurantAccountingResolutionEvent,
} from "./models.ts";

const RESTAURANT_ID = "restaurant-1";
const TZ = "Europe/Chisinau";
const ASOF_FAR = "2030-01-01T00:00:00.000Z";

function entry(
  overrides: Partial<RestaurantAccountingEntry> & { id: string },
): RestaurantAccountingEntry {
  return {
    orderId: `order-${overrides.id}`,
    restaurantId: RESTAURANT_ID,
    direction: "RESTAURANT_OWES_DIRECT",
    type: "PLATFORM_COMMISSION",
    amountCents: 800,
    currencyCode: "USD",
    status: "OPEN",
    recognizedAt: "2026-07-15T10:00:00.000Z",
    settledAt: null,
    source: "ORDER_FINANCIAL_SNAPSHOT",
    legacySettlementId: null,
    ...overrides,
  };
}

function event(
  overrides: Partial<RestaurantAccountingResolutionEvent> & {
    id: string;
    accountingEntryId: string;
  },
): RestaurantAccountingResolutionEvent {
  return {
    restaurantId: RESTAURANT_ID,
    previousStatus: "OPEN",
    nextStatus: "SETTLED",
    occurredAt: "2026-07-16T10:00:00.000Z",
    actor: "ADMIN",
    note: "основание",
    externalReference: null,
    ...overrides,
  };
}

function stateWith(
  entries: RestaurantAccountingEntry[],
  events: RestaurantAccountingResolutionEvent[] = [],
  orders: Order[] = [],
): PrototypeState {
  return {
    ...createDefaultState(),
    orders,
    restaurantAccountingEntries: entries,
    restaurantAccountingResolutionEvents: events,
  };
}

function range(startLocalDate: string, endLocalDate: string, asOfIso = ASOF_FAR) {
  return { startLocalDate, endLocalDate, timeZone: TZ, asOfIso };
}

function build(state: PrototypeState, r = range("2026-07-01", "2026-07-31")) {
  const res = buildRestaurantStatementMovements(state, RESTAURANT_ID, r);
  assert.equal(res.ok, true, res.error ?? "");
  assert.ok(res.movements);
  return res.movements;
}

// 1 --------------------------------------------------------------------------

test("признанные записи фильтруются по выбранному ресторану", () => {
  const st = stateWith([
    entry({ id: "mine", restaurantId: RESTAURANT_ID }),
    entry({ id: "other", restaurantId: "restaurant-2" }),
  ]);
  const m = build(st);
  assert.equal(m.recognitions.length, 1);
  assert.equal(m.recognitions[0].entryKey, "mine");
});

// 2 --------------------------------------------------------------------------

test("диапазон включителен по локальным календарным датам ресторана", () => {
  // Europe/Chisinau лето (EEST+3): 15 июля 00:00 local = 14T21:00Z.
  const st = stateWith([
    entry({ id: "startMidnight", recognizedAt: "2026-07-14T21:00:00.000Z" }), // 15 июля 00:00
    entry({ id: "endLate", recognizedAt: "2026-07-15T20:59:00.000Z" }), // 15 июля 23:59
    entry({ id: "beforeStart", recognizedAt: "2026-07-14T20:59:00.000Z" }), // 14 июля 23:59
    entry({ id: "afterEnd", recognizedAt: "2026-07-15T21:00:00.000Z" }), // 16 июля 00:00
  ]);
  const m = build(st, range("2026-07-15", "2026-07-15"));
  const keys = new Set(m.recognitions.map((r) => r.entryKey));
  assert.ok(keys.has("startMidnight"));
  assert.ok(keys.has("endLate"));
  assert.ok(!keys.has("beforeStart"));
  assert.ok(!keys.has("afterEnd"));
});

// 3 --------------------------------------------------------------------------

test("события около UTC-полуночи относятся к правильному локальному дню", () => {
  const st = stateWith([
    entry({ id: "utc2200", recognizedAt: "2026-07-14T22:00:00.000Z" }), // 15 июля 01:00 local
    entry({ id: "utc2000", recognizedAt: "2026-07-14T20:00:00.000Z" }), // 14 июля 23:00 local
  ]);
  const m = build(st, range("2026-07-15", "2026-07-15"));
  const keys = new Set(m.recognitions.map((r) => r.entryKey));
  assert.ok(keys.has("utc2200"));
  assert.ok(!keys.has("utc2000"));
});

// 4 --------------------------------------------------------------------------

test("диапазон корректен через spring и fall DST", () => {
  // Spring: переход 29 марта 2026 03:00 (EET+2 → EEST+3). 29 марта 00:00 = 28T22:00Z.
  const spring = stateWith([
    entry({ id: "s-in", recognizedAt: "2026-03-28T22:00:00.000Z" }), // 29 марта 00:00
    entry({ id: "s-out", recognizedAt: "2026-03-28T21:59:00.000Z" }), // 28 марта 23:59
  ]);
  const ms = build(spring, range("2026-03-29", "2026-03-29"));
  const springKeys = new Set(ms.recognitions.map((r) => r.entryKey));
  assert.ok(springKeys.has("s-in"));
  assert.ok(!springKeys.has("s-out"));

  // Fall: переход 25 октября 2026 04:00 (EEST+3 → EET+2). 25 окт 00:00 = 24T21:00Z,
  // 26 окт 00:00 = 25T22:00Z.
  const fall = stateWith([
    entry({ id: "f-in", recognizedAt: "2026-10-24T21:00:00.000Z" }), // 25 окт 00:00
    // 25 окт 23:30 local (после перехода, EET+2). Чувствительно к DST верхней
    // границы: при фиксированных 24 ч попало бы уже в 26 октября и выпало бы.
    entry({ id: "f-late", recognizedAt: "2026-10-25T21:30:00.000Z" }),
    entry({ id: "f-out", recognizedAt: "2026-10-25T22:00:00.000Z" }), // 26 окт 00:00
  ]);
  const mf = build(fall, range("2026-10-25", "2026-10-25"));
  const fallKeys = new Set(mf.recognitions.map((r) => r.entryKey));
  assert.ok(fallKeys.has("f-in"));
  assert.ok(fallKeys.has("f-late"), "25 окт 23:30 остаётся в дне через fall DST");
  assert.ok(!fallKeys.has("f-out"));
});

// 5 --------------------------------------------------------------------------

test("события после asOfIso исключаются и создают integrity issue", () => {
  const st = stateWith([
    entry({ id: "past", recognizedAt: "2026-07-10T10:00:00.000Z" }),
    entry({ id: "future", recognizedAt: "2026-07-20T10:00:00.000Z" }),
  ]);
  const m = build(st, range("2026-07-01", "2026-07-31", "2026-07-15T12:00:00.000Z"));
  const keys = new Set(m.recognitions.map((r) => r.entryKey));
  assert.ok(keys.has("past"));
  assert.ok(!keys.has("future"));
  assert.ok(
    m.issues.some((i) => i.kind === "FUTURE_EVENT_EXCLUDED" && i.entryKey === "future"),
  );
});

// 6 --------------------------------------------------------------------------

test("невалидные recognizedAt/occurredAt: не в totals, issue, без падения", () => {
  const st = stateWith(
    [
      entry({ id: "badRec", recognizedAt: "не-дата" }),
      entry({ id: "ok", recognizedAt: "2026-07-10T10:00:00.000Z" }),
    ],
    [event({ id: "e-bad", accountingEntryId: "ok", occurredAt: "тоже-не-дата" })],
  );
  const m = build(st);
  assert.ok(!m.recognitions.some((r) => r.entryKey === "badRec"));
  assert.equal(m.resolutions.length, 0);
  assert.ok(m.issues.some((i) => i.kind === "INVALID_RECOGNIZED_AT" && i.entryKey === "badRec"));
  assert.ok(m.issues.some((i) => i.kind === "INVALID_RESOLUTION_AT" && i.entryKey === "ok"));
});

// 7 --------------------------------------------------------------------------

test("resolution связывается с entry и берёт сумму только из entry.amountCents", () => {
  const st = stateWith(
    [entry({ id: "c", amountCents: 1234, direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION" })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", note: "готово", externalReference: "BANK-1" })],
  );
  const m = build(st);
  assert.equal(m.resolutions.length, 1);
  const row = m.resolutions[0];
  assert.equal(row.amountCents, 1234);
  assert.equal(row.outcome, "SETTLED");
  assert.equal(row.direction, "RESTAURANT_OWES_DIRECT");
  assert.equal(row.note, "готово");
  assert.equal(row.externalReference, "BANK-1");
});

// 8 --------------------------------------------------------------------------

test("resolution без entry: не в totals, RESOLUTION_ENTRY_NOT_FOUND", () => {
  const st = stateWith(
    [],
    [event({ id: "e", accountingEntryId: "нет-такой" })],
  );
  const m = build(st);
  assert.equal(m.resolutions.length, 0);
  assert.ok(m.issues.some((i) => i.kind === "RESOLUTION_ENTRY_NOT_FOUND" && i.entryKey === "нет-такой"));
  assert.equal(m.summaries.length, 0);
});

// 9 --------------------------------------------------------------------------

test("несовпадение restaurantId event и entry: fail-safe issue, не в totals", () => {
  const st = stateWith(
    [entry({ id: "c", restaurantId: "restaurant-2" })], // entry другого ресторана
    [event({ id: "e", accountingEntryId: "c", restaurantId: RESTAURANT_ID })],
  );
  const m = build(st);
  assert.equal(m.resolutions.length, 0);
  assert.ok(m.issues.some((i) => i.kind === "RESOLUTION_RESTAURANT_MISMATCH" && i.entryKey === "c"));
  assert.equal(m.summaries.length, 0);
});

// 10 -------------------------------------------------------------------------

test("SETTLED и WAIVED агрегируются отдельно", () => {
  const st = stateWith(
    [
      entry({ id: "s", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 500 }),
      entry({ id: "w", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 300 }),
      entry({ id: "p", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 }),
    ],
    [
      event({ id: "es", accountingEntryId: "s", nextStatus: "SETTLED" }),
      event({ id: "ew", accountingEntryId: "w", nextStatus: "WAIVED" }),
      event({ id: "ep", accountingEntryId: "p", nextStatus: "SETTLED" }),
    ],
  );
  const m = build(st);
  const usd = m.summaries.find((s) => s.currencyCode === "USD")!;
  assert.equal(usd.settledRestaurantOwesDirectCents, 500);
  assert.equal(usd.waivedRestaurantOwesDirectCents, 300);
  assert.equal(usd.settledDirectOwesRestaurantCents, 5100);
});

// 11 -------------------------------------------------------------------------

test("две валюты формируют два независимых summary bucket", () => {
  const st = stateWith([
    entry({ id: "usd", currencyCode: "USD", direction: "RESTAURANT_OWES_DIRECT", amountCents: 800 }),
    entry({ id: "eur", currencyCode: "EUR" as CurrencyCode, direction: "RESTAURANT_OWES_DIRECT", amountCents: 700 }),
  ]);
  const m = build(st);
  assert.equal(m.summaries.length, 2);
  const usd = m.summaries.find((s) => s.currencyCode === "USD")!;
  const eur = m.summaries.find((s) => s.currencyCode === ("EUR" as CurrencyCode))!;
  assert.equal(usd.recognizedRestaurantOwesDirectCents, 800);
  assert.equal(eur.recognizedRestaurantOwesDirectCents, 700);
  // Валюты не смешиваются.
  assert.equal(usd.recognizedRestaurantOwesDirectCents + eur.recognizedRestaurantOwesDirectCents, 1500);
});

// 12 -------------------------------------------------------------------------

test("изменение меню, тарифов и комиссии не меняет statement movements", () => {
  const entries = [entry({ id: "c", amountCents: 800 })];
  const before = build(stateWith(entries));

  const st = stateWith(entries);
  const mutated: PrototypeState = {
    ...st,
    menuItems: st.menuItems.map((m) => ({ ...m, priceCents: 99999 })),
    restaurants: st.restaurants.map((r) =>
      r.id === RESTAURANT_ID ? { ...r, commissionRateBps: 9000 } : r,
    ),
  };
  const after = build(mutated);
  assert.deepEqual(after.recognitions, before.recognitions);
  assert.deepEqual(after.summaries, before.summaries);
});

// 13 -------------------------------------------------------------------------

test("orphan order сохраняется с publicNumber=null, без утечки orderId", () => {
  const order: Order = {
    ...createDefaultState().orders[0] ?? ({} as Order),
  };
  // Заказ для linked; orphan ссылается на несуществующий orderId.
  const st = stateWith(
    [
      entry({ id: "orphan", orderId: "удалённый-заказ" }),
    ],
  );
  const m = build(st);
  const row = m.recognitions.find((r) => r.entryKey === "orphan")!;
  assert.equal(row.publicNumber, null);
  assert.equal(row.hasOrder, false);
  assert.ok(!("orderId" in row));
  assert.ok(!JSON.stringify(row).includes("удалённый-заказ"));
  void order;
});

// 14 -------------------------------------------------------------------------

test("сортировка детерминирована: новые сверху, tie-breaker по entryKey", () => {
  const st = stateWith(
    [
      entry({ id: "b", recognizedAt: "2026-07-10T10:00:00.000Z" }),
      entry({ id: "a", recognizedAt: "2026-07-10T10:00:00.000Z" }), // та же дата
      entry({ id: "newer", recognizedAt: "2026-07-12T10:00:00.000Z" }),
    ],
  );
  const m = build(st);
  assert.deepEqual(m.recognitions.map((r) => r.entryKey), ["newer", "a", "b"]);
});

// 15 -------------------------------------------------------------------------

test("полная read-only неизменность state", () => {
  const st = stateWith(
    [entry({ id: "c" })],
    [event({ id: "e", accountingEntryId: "c" })],
  );
  const snapshot = JSON.stringify(st);
  const ordersRef = st.orders;
  const entriesRef = st.restaurantAccountingEntries;
  const eventsRef = st.restaurantAccountingResolutionEvents;
  const settlementsRef = st.settlements;
  const revBefore = st.revision;

  buildRestaurantStatementMovements(st, RESTAURANT_ID, range("2026-07-01", "2026-07-31"));
  buildRestaurantStatementMovements(st, RESTAURANT_ID, range("2026-07-01", "2026-07-31"));

  assert.equal(JSON.stringify(st), snapshot);
  assert.equal(st.orders, ordersRef);
  assert.equal(st.restaurantAccountingEntries, entriesRef);
  assert.equal(st.restaurantAccountingResolutionEvents, eventsRef);
  assert.equal(st.settlements, settlementsRef);
  assert.equal(st.revision, revBefore);
});

// 16 -------------------------------------------------------------------------

test("fail same-result при невалидных входах и отсутствии ресторана", () => {
  const st = stateWith([entry({ id: "c" })]);
  const cases: Array<[string, ReturnType<typeof buildRestaurantStatementMovements>]> = [
    ["нет ресторана", buildRestaurantStatementMovements(st, "restaurant-нет", range("2026-07-01", "2026-07-31"))],
    ["невалидный tz", buildRestaurantStatementMovements(st, RESTAURANT_ID, { startLocalDate: "2026-07-01", endLocalDate: "2026-07-31", timeZone: "Nope/Zone", asOfIso: ASOF_FAR })],
    ["невалидная start", buildRestaurantStatementMovements(st, RESTAURANT_ID, range("2026-13-40", "2026-07-31"))],
    ["невалидная end", buildRestaurantStatementMovements(st, RESTAURANT_ID, range("2026-07-01", "2026-02-30"))],
    ["start > end", buildRestaurantStatementMovements(st, RESTAURANT_ID, range("2026-08-01", "2026-07-01"))],
    ["невалидный asOf", buildRestaurantStatementMovements(st, RESTAURANT_ID, range("2026-07-01", "2026-07-31", "не-дата"))],
  ];
  for (const [label, res] of cases) {
    assert.equal(res.ok, false, label);
    assert.ok(res.error, label);
    assert.equal(res.movements, null, label);
  }
  // Валидный запрос не падает.
  assert.equal(
    buildRestaurantStatementMovements(st, RESTAURANT_ID, range("2026-07-01", "2026-07-31")).ok,
    true,
  );
});
