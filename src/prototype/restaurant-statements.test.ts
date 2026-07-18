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

// 17 -------------------------------------------------------------------------

test("соседний перевёрнутый диапазон (start = день после end) отклоняется", () => {
  const st = stateWith([entry({ id: "c" })]);
  const res = buildRestaurantStatementMovements(
    st,
    RESTAURANT_ID,
    range("2026-07-02", "2026-07-01"),
  );
  assert.equal(res.ok, false);
  assert.equal(res.movements, null);
  assert.equal(res.error, "Начальная дата позже конечной.");
});

// 18 -------------------------------------------------------------------------

test("одинаковая start/end дата остаётся валидной и включительной", () => {
  const st = stateWith([
    entry({ id: "in", recognizedAt: "2026-07-15T10:00:00.000Z" }),
  ]);
  const res = buildRestaurantStatementMovements(
    st,
    RESTAURANT_ID,
    range("2026-07-15", "2026-07-15"),
  );
  assert.equal(res.ok, true, res.error ?? "");
  assert.ok(res.movements);
  assert.ok(res.movements!.recognitions.some((r) => r.entryKey === "in"));
});

// 19 -------------------------------------------------------------------------

test("mismatch: event выбранного ресторана, entry другого", () => {
  const st = stateWith(
    [entry({ id: "c", restaurantId: "restaurant-2" })],
    [event({ id: "e", accountingEntryId: "c", restaurantId: RESTAURANT_ID })],
  );
  const m = build(st);
  assert.equal(m.resolutions.length, 0);
  assert.equal(m.summaries.length, 0);
  assert.ok(
    m.issues.some((i) => i.kind === "RESOLUTION_RESTAURANT_MISMATCH" && i.entryKey === "c"),
  );
});

// 20 -------------------------------------------------------------------------

test("mismatch: entry выбранного ресторана, event другого (двунаправленно)", () => {
  const st = stateWith(
    [entry({ id: "c", restaurantId: RESTAURANT_ID })],
    [event({ id: "e", accountingEntryId: "c", restaurantId: "restaurant-2" })],
  );
  const m = build(st);
  assert.equal(m.resolutions.length, 0, "повреждённое движение не создаёт строку");
  // Признанная запись выбранного ресторана учитывается, но её resolution — нет.
  assert.ok(m.recognitions.some((r) => r.entryKey === "c"));
  assert.ok(
    m.issues.some((i) => i.kind === "RESOLUTION_RESTAURANT_MISMATCH" && i.entryKey === "c"),
  );
  // Денежных resolution-totals по этой записи нет (settled/waived = 0).
  const usd = m.summaries.find((s) => s.currencyCode === "USD");
  assert.equal(usd?.settledRestaurantOwesDirectCents ?? 0, 0);
  assert.equal(usd?.waivedRestaurantOwesDirectCents ?? 0, 0);
});

// 21 -------------------------------------------------------------------------

test("event и entry относятся другим ресторанам — statement выбранного их игнорирует", () => {
  const st = stateWith(
    [
      // Согласованно чужой (оба restaurant-2).
      entry({ id: "both2", restaurantId: "restaurant-2" }),
      // Рассогласованно чужие (event r2, entry r3) — ни одна сторона не выбрана.
      entry({ id: "cross", restaurantId: "restaurant-3" }),
    ],
    [
      event({ id: "e1", accountingEntryId: "both2", restaurantId: "restaurant-2" }),
      event({ id: "e2", accountingEntryId: "cross", restaurantId: "restaurant-2" }),
    ],
  );
  const m = build(st);
  assert.equal(m.resolutions.length, 0);
  assert.equal(m.recognitions.length, 0);
  assert.equal(m.issues.length, 0, "чужие рестораны не создают issue в нашем statement");
});

// 22 -------------------------------------------------------------------------

test("event и entry корректно относятся выбранному ресторану — движение учитывается", () => {
  const st = stateWith(
    [entry({ id: "c", restaurantId: RESTAURANT_ID, amountCents: 500, direction: "RESTAURANT_OWES_DIRECT" })],
    [event({ id: "e", accountingEntryId: "c", restaurantId: RESTAURANT_ID, nextStatus: "SETTLED" })],
  );
  const m = build(st);
  assert.equal(m.resolutions.length, 1);
  assert.equal(m.resolutions[0].entryKey, "c");
  assert.ok(!m.issues.some((i) => i.kind === "RESOLUTION_RESTAURANT_MISMATCH"));
  const usd = m.summaries.find((s) => s.currencyCode === "USD")!;
  assert.equal(usd.settledRestaurantOwesDirectCents, 500);
});

// --- Opening / closing позиции (исторический replay) ------------------------

const PERIOD = () => range("2026-07-10", "2026-07-20"); // start=07-09T21:00Z, endExcl=07-20T21:00Z
const BEFORE = "2026-07-01T10:00:00.000Z";
const INSIDE = "2026-07-15T10:00:00.000Z";
const AFTER = "2026-07-25T10:00:00.000Z";
const START_CUTOFF = "2026-07-09T21:00:00.000Z"; // ровно локальная полночь 10 июля
const END_EXCLUSIVE = "2026-07-20T21:00:00.000Z"; // ровно локальная полночь 21 июля

function usdOf(m: NonNullable<ReturnType<typeof buildRestaurantStatementMovements>["movements"]>) {
  return m.summaries.find((s) => s.currencyCode === "USD")!;
}

// 23 -------------------------------------------------------------------------

test("признано до периода и не закрыто → входит в opening и closing", () => {
  const st = stateWith([entry({ id: "c", recognizedAt: BEFORE, amountCents: 800 })]);
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.equal(s.openingRestaurantOwesDirectCents, 800);
  assert.equal(s.closingRestaurantOwesDirectCents, 800);
  assert.equal(s.recognizedRestaurantOwesDirectCents, 0);
});

// 24 -------------------------------------------------------------------------

test("признано и закрыто до периода → не в opening и не в closing", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: BEFORE, amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: "2026-07-05T10:00:00.000Z" })],
  );
  const s = usdOf(build(st, PERIOD()));
  assert.equal(s.openingRestaurantOwesDirectCents, 0);
  assert.equal(s.closingRestaurantOwesDirectCents, 0);
});

// 25 -------------------------------------------------------------------------

test("признано до периода, закрыто внутри → opening, resolution-движение, не closing", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: BEFORE, amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: INSIDE })],
  );
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.equal(s.openingRestaurantOwesDirectCents, 800);
  assert.equal(s.closingRestaurantOwesDirectCents, 0);
  assert.equal(s.settledRestaurantOwesDirectCents, 800);
  assert.equal(m.resolutions.length, 1);
});

// 26 -------------------------------------------------------------------------

test("признано внутри периода и не закрыто → opening=0, recognized и closing", () => {
  const st = stateWith([entry({ id: "c", recognizedAt: INSIDE, amountCents: 800 })]);
  const s = usdOf(build(st, PERIOD()));
  assert.equal(s.openingRestaurantOwesDirectCents, 0);
  assert.equal(s.recognizedRestaurantOwesDirectCents, 800);
  assert.equal(s.closingRestaurantOwesDirectCents, 800);
});

// 27 -------------------------------------------------------------------------

test("признано и закрыто внутри периода → recognition и resolution, closing=0", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: "2026-07-12T10:00:00.000Z", amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: INSIDE })],
  );
  const s = usdOf(build(st, PERIOD()));
  assert.equal(s.recognizedRestaurantOwesDirectCents, 800);
  assert.equal(s.settledRestaurantOwesDirectCents, 800);
  assert.equal(s.closingRestaurantOwesDirectCents, 0);
});

// 28 -------------------------------------------------------------------------

test("оба направления: opening/closing для receivable и payable", () => {
  const st = stateWith([
    entry({ id: "rod", recognizedAt: BEFORE, direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 }),
    entry({ id: "dor", recognizedAt: BEFORE, direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 }),
  ]);
  const s = usdOf(build(st, PERIOD()));
  assert.equal(s.openingRestaurantOwesDirectCents, 800);
  assert.equal(s.openingDirectOwesRestaurantCents, 5100);
  assert.equal(s.openingNetCents, 5100 - 800);
  assert.equal(s.closingRestaurantOwesDirectCents, 800);
  assert.equal(s.closingDirectOwesRestaurantCents, 5100);
  assert.equal(s.closingNetCents, 5100 - 800);
});

// 29 -------------------------------------------------------------------------

test("WAIVED закрывает только receivable-позицию", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: BEFORE, direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "WAIVED", occurredAt: INSIDE })],
  );
  const s = usdOf(build(st, PERIOD()));
  assert.equal(s.openingRestaurantOwesDirectCents, 800);
  assert.equal(s.waivedRestaurantOwesDirectCents, 800);
  assert.equal(s.closingRestaurantOwesDirectCents, 0);
});

// 30 -------------------------------------------------------------------------

test("resolution после endExclusive не влияет на closing исторического периода", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: BEFORE, amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: AFTER })],
  );
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.equal(s.openingRestaurantOwesDirectCents, 800);
  assert.equal(s.closingRestaurantOwesDirectCents, 800, "всё ещё открыто");
  assert.equal(m.resolutions.length, 0, "resolution вне окна периода");
});

// 31 -------------------------------------------------------------------------

test("resolution после asOfIso не влияет на closing", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: BEFORE, amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: INSIDE })],
  );
  const m = build(st, range("2026-07-10", "2026-07-20", "2026-07-14T00:00:00.000Z"));
  const s = usdOf(m);
  assert.equal(s.closingRestaurantOwesDirectCents, 800, "закрытие после asOf не считается");
  assert.ok(m.issues.some((i) => i.kind === "FUTURE_EVENT_EXCLUDED" && i.entryKey === "c"));
});

// 32 -------------------------------------------------------------------------

test("current entry.status=SETTLED, но event после конца периода → closing открыт", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: BEFORE, status: "SETTLED", settledAt: AFTER, amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: AFTER })],
  );
  const s = usdOf(build(st, PERIOD()));
  // Историческая позиция не зависит от текущего status.
  assert.equal(s.closingRestaurantOwesDirectCents, 800);
});

// 33 -------------------------------------------------------------------------

test("recognition ровно в startCutoff: не в opening, но в period movement", () => {
  const st = stateWith([entry({ id: "c", recognizedAt: START_CUTOFF, amountCents: 800 })]);
  const s = usdOf(build(st, PERIOD()));
  assert.equal(s.openingRestaurantOwesDirectCents, 0, "событие в startCutoff не в opening");
  assert.equal(s.recognizedRestaurantOwesDirectCents, 800, "но входит в движения периода");
  assert.equal(s.closingRestaurantOwesDirectCents, 800);
});

// 34 -------------------------------------------------------------------------

test("resolution ровно в endExclusive: не в period и не закрывает closing", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: BEFORE, amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: END_EXCLUSIVE })],
  );
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.equal(m.resolutions.length, 0);
  assert.equal(s.closingRestaurantOwesDirectCents, 800, "закрытие ровно в endExclusive не считается");
});

// 35 -------------------------------------------------------------------------

test("дубликат resolution: учитывается один раз, DUPLICATE_RESOLUTION_EVENT, closing не отрицателен", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: "2026-07-12T10:00:00.000Z", amountCents: 800 })],
    [
      event({ id: "e2", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: "2026-07-16T10:00:00.000Z" }),
      event({ id: "e1", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: "2026-07-15T10:00:00.000Z" }),
    ],
  );
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.equal(m.resolutions.length, 1, "только canonical (самый ранний)");
  assert.equal(m.resolutions[0].occurredAt, "2026-07-15T10:00:00.000Z");
  assert.equal(s.settledRestaurantOwesDirectCents, 800, "закрытие учтено один раз");
  assert.equal(s.closingRestaurantOwesDirectCents, 0);
  assert.ok(s.closingRestaurantOwesDirectCents >= 0, "closing не отрицателен");
  assert.ok(m.issues.some((i) => i.kind === "DUPLICATE_RESOLUTION_EVENT" && i.entryKey === "c"));
});

// 36 -------------------------------------------------------------------------

test("resolution до recognition: не закрывает, RESOLUTION_BEFORE_RECOGNITION", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: INSIDE, amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: "2026-07-12T10:00:00.000Z" })],
  );
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.equal(m.resolutions.length, 0);
  assert.equal(s.recognizedRestaurantOwesDirectCents, 800);
  assert.equal(s.closingRestaurantOwesDirectCents, 800, "запись остаётся открытой");
  assert.ok(m.issues.some((i) => i.kind === "RESOLUTION_BEFORE_RECOGNITION" && i.entryKey === "c"));
});

// 37 -------------------------------------------------------------------------

test("две валюты дают независимые opening/closing buckets", () => {
  const st = stateWith([
    entry({ id: "usd", recognizedAt: BEFORE, currencyCode: "USD", amountCents: 800 }),
    entry({ id: "eur", recognizedAt: BEFORE, currencyCode: "EUR" as CurrencyCode, amountCents: 700 }),
  ]);
  const m = build(st, PERIOD());
  assert.equal(m.summaries.length, 2);
  assert.equal(usdOf(m).openingRestaurantOwesDirectCents, 800);
  const eur = m.summaries.find((s) => s.currencyCode === ("EUR" as CurrencyCode))!;
  assert.equal(eur.openingRestaurantOwesDirectCents, 700);
  assert.equal(eur.closingRestaurantOwesDirectCents, 700);
});

// 38 -------------------------------------------------------------------------

test("reconciliation выполняется для обеих сторон", () => {
  const st = stateWith(
    [
      // Receivable: opening (закрыт внутри), in-period recognized (waived внутри).
      entry({ id: "rOpen", recognizedAt: BEFORE, direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 }),
      entry({ id: "rInWaive", recognizedAt: "2026-07-12T10:00:00.000Z", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 300 }),
      // Payable: opening (остаётся), in-period recognized (settled внутри).
      entry({ id: "pOpen", recognizedAt: BEFORE, direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 }),
      entry({ id: "pInSettle", recognizedAt: "2026-07-12T10:00:00.000Z", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 2000 }),
    ],
    [
      event({ id: "eR", accountingEntryId: "rOpen", nextStatus: "SETTLED", occurredAt: INSIDE }),
      event({ id: "eW", accountingEntryId: "rInWaive", nextStatus: "WAIVED", occurredAt: "2026-07-16T10:00:00.000Z" }),
      event({ id: "eP", accountingEntryId: "pInSettle", nextStatus: "SETTLED", occurredAt: "2026-07-16T10:00:00.000Z" }),
    ],
  );
  const s = usdOf(build(st, PERIOD()));
  // closingReceivable = openingR + recognizedR - settledR - waivedR
  assert.equal(
    s.closingRestaurantOwesDirectCents,
    s.openingRestaurantOwesDirectCents +
      s.recognizedRestaurantOwesDirectCents -
      s.settledRestaurantOwesDirectCents -
      s.waivedRestaurantOwesDirectCents,
  );
  // closingPayable = openingP + recognizedP - settledP
  assert.equal(
    s.closingDirectOwesRestaurantCents,
    s.openingDirectOwesRestaurantCents +
      s.recognizedDirectOwesRestaurantCents -
      s.settledDirectOwesRestaurantCents,
  );
});

// --- Admissibility canonical resolution -------------------------------------

// 39 -------------------------------------------------------------------------

test("RESTAURANT_PAYOUT + WAIVED: INVALID_RESOLUTION_OUTCOME, не закрывает payable", () => {
  const st = stateWith(
    [entry({ id: "p", recognizedAt: BEFORE, direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 })],
    [event({ id: "e", accountingEntryId: "p", nextStatus: "WAIVED", occurredAt: INSIDE })],
  );
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.ok(m.issues.some((i) => i.kind === "INVALID_RESOLUTION_OUTCOME" && i.entryKey === "p"));
  assert.equal(m.resolutions.length, 0, "нет resolution row");
  assert.equal(s.waivedRestaurantOwesDirectCents, 0);
  assert.equal(s.settledDirectOwesRestaurantCents, 0);
  assert.equal(s.closingDirectOwesRestaurantCents, 5100, "payable остаётся в closing");
});

// 40 -------------------------------------------------------------------------

test("RESTAURANT_PAYOUT: ранний invalid WAIVED не заслоняет более поздний SETTLED", () => {
  const st = stateWith(
    [entry({ id: "p", recognizedAt: "2026-07-12T10:00:00.000Z", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 })],
    [
      event({ id: "eW", accountingEntryId: "p", nextStatus: "WAIVED", occurredAt: "2026-07-14T10:00:00.000Z" }),
      event({ id: "eS", accountingEntryId: "p", nextStatus: "SETTLED", occurredAt: "2026-07-16T10:00:00.000Z" }),
    ],
  );
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.ok(m.issues.some((i) => i.kind === "INVALID_RESOLUTION_OUTCOME" && i.entryKey === "p"));
  assert.equal(m.resolutions.length, 1, "canonical — допустимый SETTLED");
  assert.equal(m.resolutions[0].outcome, "SETTLED");
  assert.equal(m.resolutions[0].occurredAt, "2026-07-16T10:00:00.000Z");
  assert.equal(s.settledDirectOwesRestaurantCents, 5100);
  assert.equal(s.closingDirectOwesRestaurantCents, 0);
  assert.ok(
    !m.issues.some((i) => i.kind === "DUPLICATE_RESOLUTION_EVENT"),
    "invalid WAIVED не создаёт duplicate",
  );
});

// 41 -------------------------------------------------------------------------

test("PLATFORM_COMMISSION + RESTAURANT_OWES_DIRECT + WAIVED остаётся допустимым", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: BEFORE, direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "WAIVED", occurredAt: INSIDE })],
  );
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.ok(!m.issues.some((i) => i.kind === "INVALID_RESOLUTION_OUTCOME"));
  assert.equal(m.resolutions.length, 1);
  assert.equal(m.resolutions[0].outcome, "WAIVED");
  assert.equal(s.waivedRestaurantOwesDirectCents, 800);
  assert.equal(s.closingRestaurantOwesDirectCents, 0, "receivable закрыт");
});

// 42 -------------------------------------------------------------------------

test("повреждённая комбинация ROD + RESTAURANT_PAYOUT + WAIVED недопустима", () => {
  const st = stateWith(
    [entry({ id: "x", recognizedAt: BEFORE, direction: "RESTAURANT_OWES_DIRECT", type: "RESTAURANT_PAYOUT", amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "x", nextStatus: "WAIVED", occurredAt: INSIDE })],
  );
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.ok(m.issues.some((i) => i.kind === "INVALID_RESOLUTION_OUTCOME" && i.entryKey === "x"));
  assert.equal(m.resolutions.length, 0);
  assert.equal(s.closingRestaurantOwesDirectCents, 800, "позиция не закрыта");
});

// 43 -------------------------------------------------------------------------

test("два допустимых SETTLED: canonical самый ранний, DUPLICATE_RESOLUTION_EVENT", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: "2026-07-12T10:00:00.000Z", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 2000 })],
    [
      event({ id: "eLate", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: "2026-07-17T10:00:00.000Z" }),
      event({ id: "eEarly", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: "2026-07-15T10:00:00.000Z" }),
    ],
  );
  const m = build(st, PERIOD());
  assert.equal(m.resolutions.length, 1);
  assert.equal(m.resolutions[0].occurredAt, "2026-07-15T10:00:00.000Z");
  assert.ok(m.issues.some((i) => i.kind === "DUPLICATE_RESOLUTION_EVENT" && i.entryKey === "c"));
});

// 44 -------------------------------------------------------------------------

test("одинаковый occurredAt: canonical — меньший event.id (tie-breaker)", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: "2026-07-12T10:00:00.000Z", amountCents: 800 })],
    [
      event({ id: "e-b", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: INSIDE, note: "from-b" }),
      event({ id: "e-a", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: INSIDE, note: "from-a" }),
    ],
  );
  const m = build(st, PERIOD());
  assert.equal(m.resolutions.length, 1);
  // e-a < e-b по id → canonical e-a, его note.
  assert.equal(m.resolutions[0].note, "from-a");
  assert.ok(m.issues.some((i) => i.kind === "DUPLICATE_RESOLUTION_EVENT" && i.entryKey === "c"));
});

// 45 -------------------------------------------------------------------------

test("invalid outcome не влияет на opening/closing reconciliation", () => {
  const st = stateWith(
    [
      // Payout с недопустимым WAIVED — остаётся открытым, участвует в reconciliation.
      entry({ id: "pBad", recognizedAt: "2026-07-12T10:00:00.000Z", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 2000 }),
      // Валидная receivable, закрытая внутри периода.
      entry({ id: "rOk", recognizedAt: BEFORE, direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 }),
    ],
    [
      event({ id: "eBad", accountingEntryId: "pBad", nextStatus: "WAIVED", occurredAt: INSIDE }),
      event({ id: "eOk", accountingEntryId: "rOk", nextStatus: "SETTLED", occurredAt: INSIDE }),
    ],
  );
  const m = build(st, PERIOD());
  const s = usdOf(m);
  assert.ok(m.issues.some((i) => i.kind === "INVALID_RESOLUTION_OUTCOME" && i.entryKey === "pBad"));
  assert.equal(
    s.closingRestaurantOwesDirectCents,
    s.openingRestaurantOwesDirectCents +
      s.recognizedRestaurantOwesDirectCents -
      s.settledRestaurantOwesDirectCents -
      s.waivedRestaurantOwesDirectCents,
  );
  assert.equal(
    s.closingDirectOwesRestaurantCents,
    s.openingDirectOwesRestaurantCents +
      s.recognizedDirectOwesRestaurantCents -
      s.settledDirectOwesRestaurantCents,
  );
  // Недопустимый WAIVED не закрыл payout: он остаётся в closing.
  assert.equal(s.closingDirectOwesRestaurantCents, 2000);
});
