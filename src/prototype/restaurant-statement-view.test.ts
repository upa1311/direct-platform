import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRestaurantStatementView,
  isCurrencySummaryReconciled,
} from "./restaurant-statement-view.ts";
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
const BEFORE = "2026-07-01T10:00:00.000Z";
const INSIDE = "2026-07-15T10:00:00.000Z";

function entry(
  o: Partial<RestaurantAccountingEntry> & { id: string },
): RestaurantAccountingEntry {
  return {
    orderId: `order-${o.id}`,
    restaurantId: RESTAURANT_ID,
    direction: "RESTAURANT_OWES_DIRECT",
    type: "PLATFORM_COMMISSION",
    amountCents: 800,
    currencyCode: "USD",
    status: "OPEN",
    recognizedAt: INSIDE,
    settledAt: null,
    source: "ORDER_FINANCIAL_SNAPSHOT",
    legacySettlementId: null,
    ...o,
  };
}

function event(
  o: Partial<RestaurantAccountingResolutionEvent> & {
    id: string;
    accountingEntryId: string;
  },
): RestaurantAccountingResolutionEvent {
  return {
    restaurantId: RESTAURANT_ID,
    previousStatus: "OPEN",
    nextStatus: "SETTLED",
    occurredAt: INSIDE,
    actor: "ADMIN",
    note: "основание",
    externalReference: null,
    ...o,
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

const PERIOD = () => ({
  startLocalDate: "2026-07-10",
  endLocalDate: "2026-07-20",
  timeZone: TZ,
  asOfIso: ASOF_FAR,
});

function view(state: PrototypeState, r = PERIOD()) {
  const res = buildRestaurantStatementView(state, RESTAURANT_ID, r);
  assert.equal(res.ok, true, res.error ?? "");
  assert.ok(res.view);
  return res.view;
}

// 1 --------------------------------------------------------------------------

test("делегирует statement core без пересчёта сумм", () => {
  const st = stateWith(
    [
      entry({ id: "a", recognizedAt: BEFORE, amountCents: 800 }),
      entry({ id: "b", recognizedAt: INSIDE, direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 }),
    ],
  );
  const v = view(st);
  const core = buildRestaurantStatementMovements(st, RESTAURANT_ID, PERIOD()).movements!;
  const coreUsd = core.summaries.find((s) => s.currencyCode === "USD")!;
  const viewUsd = v.currencySections.find((s) => s.currencyCode === "USD")!;
  assert.equal(viewUsd.openingRestaurantOwesDirectCents, coreUsd.openingRestaurantOwesDirectCents);
  assert.equal(viewUsd.closingDirectOwesRestaurantCents, coreUsd.closingDirectOwesRestaurantCents);
  assert.equal(viewUsd.recognizedDirectOwesRestaurantCents, coreUsd.recognizedDirectOwesRestaurantCents);
  assert.equal(v.recognitionRows.length, core.recognitions.length);
});

// 2 --------------------------------------------------------------------------

test("название выбранного ресторана", () => {
  const v = view(stateWith([entry({ id: "a" })]));
  assert.equal(v.restaurantName, "Ресторан 1");
});

// 3 --------------------------------------------------------------------------

test("public order number и «Старое начисление»", () => {
  const order = { id: "order-linked", publicNumber: "DIR-777" } as unknown as Order;
  const st = stateWith(
    [
      entry({ id: "linked", orderId: "order-linked", recognizedAt: INSIDE }),
      entry({ id: "orphan", orderId: "нет-заказа", recognizedAt: INSIDE }),
    ],
    [],
    [order],
  );
  const v = view(st);
  const linked = v.recognitionRows.find((r) => r.publicNumber === "DIR-777")!;
  assert.equal(linked.orderLabel, "DIR-777");
  const orphan = v.recognitionRows.find((r) => r.publicNumber === null)!;
  assert.equal(orphan.orderLabel, "Старое начисление");
});

// 4 --------------------------------------------------------------------------

test("direction/type/source/outcome переведены на русский", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: INSIDE, direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", source: "LEGACY_COMMISSION_SETTLEMENT" })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "WAIVED", occurredAt: INSIDE })],
  );
  const v = view(st);
  const rec = v.recognitionRows[0];
  assert.equal(rec.directionLabel, "Ресторан должен Direct");
  assert.equal(rec.typeLabel, "Комиссия Direct");
  assert.equal(rec.sourceLabel, "Перенесённое комиссионное начисление");
  const res = v.resolutionRows[0];
  assert.equal(res.decisionLabel, "Комиссия Direct списана");
  const st2 = stateWith(
    [entry({ id: "c2", recognizedAt: INSIDE })],
    [event({ id: "e2", accountingEntryId: "c2", nextStatus: "SETTLED", occurredAt: INSIDE })],
  );
  assert.equal(view(st2).resolutionRows[0].decisionLabel, "Расчёт подтверждён");
});

// 5 --------------------------------------------------------------------------

test("сырые enum отсутствуют в публичных строках", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: INSIDE, direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", source: "ORDER_FINANCIAL_SNAPSHOT" })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: INSIDE })],
  );
  const v = view(st);
  const json = JSON.stringify({ recognitionRows: v.recognitionRows, resolutionRows: v.resolutionRows });
  for (const raw of [
    "RESTAURANT_OWES_DIRECT",
    "DIRECT_OWES_RESTAURANT",
    "PLATFORM_COMMISSION",
    "RESTAURANT_PAYOUT",
    "ORDER_FINANCIAL_SNAPSHOT",
    "LEGACY_COMMISSION_SETTLEMENT",
    "SETTLED",
    "WAIVED",
  ]) {
    assert.ok(!json.includes(raw), `сырой enum ${raw} не должен попасть в строки`);
  }
});

// 6 --------------------------------------------------------------------------

test("opening/closing и движения разделены по валютам", () => {
  const st = stateWith([
    entry({ id: "usd", recognizedAt: BEFORE, currencyCode: "USD", amountCents: 800 }),
    entry({ id: "eur", recognizedAt: BEFORE, currencyCode: "EUR" as CurrencyCode, amountCents: 700 }),
  ]);
  const v = view(st);
  assert.equal(v.currencySections.length, 2);
  const usd = v.currencySections.find((s) => s.currencyCode === "USD")!;
  const eur = v.currencySections.find((s) => s.currencyCode === ("EUR" as CurrencyCode))!;
  assert.equal(usd.openingRestaurantOwesDirectCents, 800);
  assert.equal(eur.openingRestaurantOwesDirectCents, 700);
  assert.equal(usd.closingRestaurantOwesDirectCents, 800);
  assert.equal(eur.closingRestaurantOwesDirectCents, 700);
});

// 7 --------------------------------------------------------------------------

test("isReconciled true для корректной секции", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: BEFORE, amountCents: 800 })],
    [event({ id: "e", accountingEntryId: "c", nextStatus: "SETTLED", occurredAt: INSIDE })],
  );
  const v = view(st);
  assert.equal(v.currencySections[0].isReconciled, true);
});

// 8 --------------------------------------------------------------------------

test("isCurrencySummaryReconciled false при несходящемся summary (pure mapper)", () => {
  const good = {
    currencyCode: "USD" as CurrencyCode,
    openingRestaurantOwesDirectCents: 100,
    openingDirectOwesRestaurantCents: 0,
    openingNetCents: -100,
    recognizedRestaurantOwesDirectCents: 50,
    recognizedDirectOwesRestaurantCents: 0,
    settledRestaurantOwesDirectCents: 30,
    settledDirectOwesRestaurantCents: 0,
    waivedRestaurantOwesDirectCents: 0,
    closingRestaurantOwesDirectCents: 120, // 100 + 50 - 30 - 0
    closingDirectOwesRestaurantCents: 0,
    closingNetCents: -120,
  };
  assert.equal(isCurrencySummaryReconciled(good), true);
  const broken = { ...good, closingRestaurantOwesDirectCents: 999 };
  assert.equal(isCurrencySummaryReconciled(broken), false);
});

// 9 --------------------------------------------------------------------------

test("integrity issues сгруппированы по kind с count", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: INSIDE, amountCents: 800 })],
    [
      // Две записи с отсутствующей entry → RESOLUTION_ENTRY_NOT_FOUND ×2.
      event({ id: "e1", accountingEntryId: "нет-1" }),
      event({ id: "e2", accountingEntryId: "нет-2" }),
    ],
  );
  const v = view(st);
  const group = v.integritySummary.find(
    (g) => g.message === "Решение связано с отсутствующим обязательством.",
  );
  assert.ok(group);
  assert.equal(group!.count, 2);
  assert.equal(v.hasIntegrityWarnings, true);
});

// 10 -------------------------------------------------------------------------

test("в integrity summary нет entryKey", () => {
  const st = stateWith(
    [entry({ id: "SENTINEL_ENTRY", recognizedAt: INSIDE })],
    [event({ id: "e", accountingEntryId: "SENTINEL_ENTRY", nextStatus: "WAIVED", occurredAt: INSIDE, restaurantId: "restaurant-2" })],
  );
  const v = view(st);
  const json = JSON.stringify(v.integritySummary);
  assert.ok(!json.includes("SENTINEL_ENTRY"));
  assert.ok(!json.includes("entryKey"));
});

// 11 -------------------------------------------------------------------------

test("фиксированный порядок integrity-групп", () => {
  const st = stateWith(
    [
      entry({ id: "future", recognizedAt: INSIDE }),
      entry({ id: "badrec", recognizedAt: "не-дата" }),
    ],
    [
      // FUTURE через resolution после asOf.
      event({ id: "ef", accountingEntryId: "future", nextStatus: "SETTLED", occurredAt: INSIDE }),
      // RESOLUTION_ENTRY_NOT_FOUND.
      event({ id: "enf", accountingEntryId: "нет" }),
    ],
  );
  // asOf между recognition и resolution, чтобы future сработал.
  const v = view(st, {
    startLocalDate: "2026-07-10",
    endLocalDate: "2026-07-20",
    timeZone: TZ,
    asOfIso: "2026-07-14T00:00:00.000Z",
  });
  const order = v.integritySummary.map((g) => g.message);
  const idxRec = order.indexOf("Не удалось прочитать дату признания обязательства.");
  const idxNotFound = order.indexOf("Решение связано с отсутствующим обязательством.");
  const idxFuture = order.indexOf("Событие после момента формирования выписки исключено.");
  assert.ok(idxRec >= 0 && idxNotFound >= 0 && idxFuture >= 0);
  // INVALID_RECOGNIZED_AT < RESOLUTION_ENTRY_NOT_FOUND < FUTURE_EVENT_EXCLUDED.
  assert.ok(idxRec < idxNotFound);
  assert.ok(idxNotFound < idxFuture);
});

// 12 -------------------------------------------------------------------------

test("fail core → view=null и безопасная русская ошибка", () => {
  const st = stateWith([entry({ id: "c" })]);
  const res = buildRestaurantStatementView(st, "restaurant-нет", PERIOD());
  assert.equal(res.ok, false);
  assert.equal(res.view, null);
  assert.equal(res.error, "Ресторан не найден.");
  // Перевёрнутый диапазон.
  const res2 = buildRestaurantStatementView(st, RESTAURANT_ID, {
    startLocalDate: "2026-07-20",
    endLocalDate: "2026-07-10",
    timeZone: TZ,
    asOfIso: ASOF_FAR,
  });
  assert.equal(res2.ok, false);
  assert.equal(res2.view, null);
  assert.ok(res2.error);
});

// 13 -------------------------------------------------------------------------

test("полный privacy JSON check", () => {
  const order = {
    id: "SENTINEL_ORDER_ID",
    publicNumber: "DIR-900",
    customer: { name: "SENTINEL_NAME", phone: "SENTINEL_PHONE" },
    address: { street: "SENTINEL_STREET" },
    pickupCode: "SENTINEL_CODE",
    paymentMethod: "SENTINEL_PAYMENT",
  } as unknown as Order;
  const st = stateWith(
    [
      entry({
        id: "SENTINEL_ENTRY_KEY",
        orderId: "SENTINEL_ORDER_ID",
        legacySettlementId: "SENTINEL_LEGACY",
        recognizedAt: INSIDE,
      }),
    ],
    [
      event({
        id: "SENTINEL_EVENT_ID",
        accountingEntryId: "SENTINEL_ENTRY_KEY",
        nextStatus: "SETTLED",
        occurredAt: INSIDE,
        actor: "ADMIN",
        note: "заметка сверки",
        externalReference: "BANK-1",
      }),
    ],
    [order],
  );
  const v = view(st);
  const json = JSON.stringify(v);
  for (const sentinel of [
    "SENTINEL_ENTRY_KEY",
    "SENTINEL_ORDER_ID",
    "SENTINEL_LEGACY",
    "SENTINEL_EVENT_ID",
    "SENTINEL_NAME",
    "SENTINEL_PHONE",
    "SENTINEL_STREET",
    "SENTINEL_CODE",
    "SENTINEL_PAYMENT",
    "entryKey",
    "accountingEntryId",
    "orderId",
    "ADMIN",
    "restaurant-1",
  ]) {
    assert.ok(!json.includes(sentinel), `утечка: ${sentinel}`);
  }
  // Разрешённое присутствует.
  assert.ok(json.includes("DIR-900"));
  assert.ok(json.includes("заметка сверки"));
  assert.ok(json.includes("BANK-1"));
});

// 14 -------------------------------------------------------------------------

test("полная read-only неизменность state", () => {
  const st = stateWith(
    [entry({ id: "c", recognizedAt: INSIDE })],
    [event({ id: "e", accountingEntryId: "c" })],
  );
  const snapshot = JSON.stringify(st);
  const ordersRef = st.orders;
  const entriesRef = st.restaurantAccountingEntries;
  const eventsRef = st.restaurantAccountingResolutionEvents;
  const settlementsRef = st.settlements;
  const revBefore = st.revision;

  buildRestaurantStatementView(st, RESTAURANT_ID, PERIOD());
  buildRestaurantStatementView(st, RESTAURANT_ID, PERIOD());

  assert.equal(JSON.stringify(st), snapshot);
  assert.equal(st.orders, ordersRef);
  assert.equal(st.restaurantAccountingEntries, entriesRef);
  assert.equal(st.restaurantAccountingResolutionEvents, eventsRef);
  assert.equal(st.settlements, settlementsRef);
  assert.equal(st.revision, revBefore);
});
