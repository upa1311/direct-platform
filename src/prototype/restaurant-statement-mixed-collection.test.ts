import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { buildRestaurantStatementMovements } from "./restaurant-statements.ts";
import { buildRestaurantStatementView } from "./restaurant-statement-view.ts";
import type {
  Order,
  PrototypeState,
  RestaurantAccountingEntry,
  RestaurantAccountingResolutionEvent,
} from "./models.ts";

const RESTAURANT_ID = "restaurant-1";
const TZ = "Europe/Chisinau";
const ASOF_FAR = "2030-01-01T00:00:00.000Z";

// Реальный валидный заказ (PLATFORM_DRIVER, restaurant-1) как шаблон: клонируем и
// правим только id и два collected-поля, чтобы конструировать valid/mixed снимки
// без ручной сборки всех полей FinancialSnapshot.
function realOrderTemplate(): Order {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, "DELIVERY");
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  for (let i = 0; i < 6; i += 1) {
    s = addCartItem(s, "restaurant-1-item-1").state;
  }
  const created = createOrderFromCart(s);
  const order = created.state.orders.find((o) => o.id === created.result.orderId);
  assert.ok(order, created.result.error ?? "template order not created");
  return order;
}

const TEMPLATE = realOrderTemplate();

/** Заказ с заданными collected-полями (остальное — из валидного шаблона). */
function orderWith(
  id: string,
  restaurantCollectedCents: number,
  platformCollectedCents: number,
): Order {
  const o = structuredClone(TEMPLATE);
  return {
    ...o,
    id,
    financials: {
      ...o.financials,
      restaurantCollectedFromCustomerCents: restaurantCollectedCents,
      platformCollectedFromCustomerCents: platformCollectedCents,
    },
  };
}

function entry(
  overrides: Partial<RestaurantAccountingEntry> & { id: string; orderId: string },
): RestaurantAccountingEntry {
  return {
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
  orders: Order[],
  entries: RestaurantAccountingEntry[],
  events: RestaurantAccountingResolutionEvent[] = [],
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

const mixedIssues = (
  m: NonNullable<
    ReturnType<typeof buildRestaurantStatementMovements>["movements"]
  >,
) => m.issues.filter((i) => i.kind === "MIXED_COLLECTION_SNAPSHOT");

// Период для opening/closing: start=07-09T21:00Z, endExcl=07-20T21:00Z.
const PERIOD = () => range("2026-07-10", "2026-07-20");
const BEFORE = "2026-07-01T10:00:00.000Z";

// 1 --------------------------------------------------------------------------

test("три штатных режима (PICKUP/RESTAURANT_DELIVERY/PLATFORM_DRIVER) не получают MIXED issue", () => {
  const total = TEMPLATE.financials.customerTotalCents;
  const st = stateWith(
    [
      orderWith("order-pickup", total, 0), // ресторан собрал
      orderWith("order-rdelivery", total, 0), // ресторан-курьер собрал
      orderWith("order-driver", 0, total), // Direct собрал
    ],
    [
      entry({ id: "e-pickup", orderId: "order-pickup" }),
      entry({ id: "e-rdelivery", orderId: "order-rdelivery" }),
      entry({
        id: "e-driver",
        orderId: "order-driver",
        direction: "DIRECT_OWES_RESTAURANT",
        type: "RESTAURANT_PAYOUT",
        amountCents: 5100,
      }),
    ],
  );
  const m = build(st);
  assert.equal(mixedIssues(m).length, 0, "нет MIXED issue для валидных режимов");
  // Все три валидные записи учитываются.
  assert.equal(m.recognitions.length, 3);
});

// 2 --------------------------------------------------------------------------

test("mixed-заказ с комиссией и payout даёт ровно один issue", () => {
  const st = stateWith(
    [orderWith("order-mixed", 500, 500)],
    [
      entry({
        id: "m-commission",
        orderId: "order-mixed",
        direction: "RESTAURANT_OWES_DIRECT",
        type: "PLATFORM_COMMISSION",
        amountCents: 100,
      }),
      entry({
        id: "m-payout",
        orderId: "order-mixed",
        direction: "DIRECT_OWES_RESTAURANT",
        type: "RESTAURANT_PAYOUT",
        amountCents: 400,
      }),
    ],
  );
  const m = build(st);
  const mixed = mixedIssues(m);
  assert.equal(mixed.length, 1, "ровно один issue на mixed-заказ (не по записям)");
});

// 3 --------------------------------------------------------------------------

test("обе записи mixed-заказа исключены из rows и totals", () => {
  const st = stateWith(
    [orderWith("order-mixed", 500, 500)],
    [
      entry({
        id: "m-commission",
        orderId: "order-mixed",
        direction: "RESTAURANT_OWES_DIRECT",
        type: "PLATFORM_COMMISSION",
        amountCents: 100,
      }),
      entry({
        id: "m-payout",
        orderId: "order-mixed",
        direction: "DIRECT_OWES_RESTAURANT",
        type: "RESTAURANT_PAYOUT",
        amountCents: 400,
      }),
    ],
  );
  const m = build(st);
  assert.equal(m.recognitions.length, 0, "нет recognition rows по mixed-заказу");
  assert.equal(m.summaries.length, 0, "нет валютных totals по mixed-заказу");
  // Никаких частичных сумм по повреждённому заказу.
  assert.ok(!m.recognitions.some((r) => r.entryKey === "m-commission"));
  assert.ok(!m.recognitions.some((r) => r.entryKey === "m-payout"));
});

// 4 --------------------------------------------------------------------------

test("resolutions записей mixed-заказа также исключены и не создают других issue", () => {
  const st = stateWith(
    [orderWith("order-mixed", 500, 500)],
    [
      entry({
        id: "m-commission",
        orderId: "order-mixed",
        direction: "RESTAURANT_OWES_DIRECT",
        type: "PLATFORM_COMMISSION",
        amountCents: 100,
      }),
      entry({
        id: "m-payout",
        orderId: "order-mixed",
        direction: "DIRECT_OWES_RESTAURANT",
        type: "RESTAURANT_PAYOUT",
        amountCents: 400,
      }),
    ],
    [
      event({ id: "r-commission", accountingEntryId: "m-commission", nextStatus: "SETTLED" }),
      event({ id: "r-payout", accountingEntryId: "m-payout", nextStatus: "SETTLED" }),
    ],
  );
  const m = build(st);
  assert.equal(m.resolutions.length, 0, "нет resolution rows по mixed-заказу");
  // Единственный issue — MIXED; исключённые записи не порождают RESOLUTION_* и пр.
  assert.equal(m.issues.length, 1);
  assert.equal(m.issues[0].kind, "MIXED_COLLECTION_SNAPSHOT");
});

// 5 --------------------------------------------------------------------------

test("opening/closing не искажаются: mixed исключён, валидный заказ считается", () => {
  const st = stateWith(
    [
      orderWith("order-mixed", 500, 500),
      orderWith("order-valid", 0, TEMPLATE.financials.customerTotalCents),
    ],
    [
      // Mixed, признан до периода — без исключения попал бы в opening и closing.
      entry({
        id: "m-commission",
        orderId: "order-mixed",
        recognizedAt: BEFORE,
        direction: "RESTAURANT_OWES_DIRECT",
        type: "PLATFORM_COMMISSION",
        amountCents: 100,
      }),
      entry({
        id: "m-payout",
        orderId: "order-mixed",
        recognizedAt: BEFORE,
        direction: "DIRECT_OWES_RESTAURANT",
        type: "RESTAURANT_PAYOUT",
        amountCents: 400,
      }),
      // Валидный, признан до периода — формирует opening/closing.
      entry({
        id: "v-commission",
        orderId: "order-valid",
        recognizedAt: BEFORE,
        direction: "RESTAURANT_OWES_DIRECT",
        type: "PLATFORM_COMMISSION",
        amountCents: 800,
      }),
    ],
  );
  const m = build(st, PERIOD());
  const usd = m.summaries.find((s) => s.currencyCode === "USD");
  assert.ok(usd, "валютный bucket валидного заказа существует");
  // Только валидные 800; mixed 100/400 не попали ни в opening, ни в closing.
  assert.equal(usd.openingRestaurantOwesDirectCents, 800);
  assert.equal(usd.closingRestaurantOwesDirectCents, 800);
  assert.equal(usd.openingDirectOwesRestaurantCents, 0, "mixed payout не в opening");
  assert.equal(usd.closingDirectOwesRestaurantCents, 0, "mixed payout не в closing");
});

// 6 --------------------------------------------------------------------------

test("другой валидный заказ продолжает учитываться рядом с mixed", () => {
  const st = stateWith(
    [
      orderWith("order-mixed", 500, 500),
      orderWith("order-valid", TEMPLATE.financials.customerTotalCents, 0),
    ],
    [
      entry({
        id: "m-commission",
        orderId: "order-mixed",
        direction: "RESTAURANT_OWES_DIRECT",
        type: "PLATFORM_COMMISSION",
        amountCents: 100,
      }),
      entry({
        id: "m-payout",
        orderId: "order-mixed",
        direction: "DIRECT_OWES_RESTAURANT",
        type: "RESTAURANT_PAYOUT",
        amountCents: 400,
      }),
      entry({
        id: "v-commission",
        orderId: "order-valid",
        direction: "RESTAURANT_OWES_DIRECT",
        type: "PLATFORM_COMMISSION",
        amountCents: 900,
      }),
    ],
  );
  const m = build(st);
  assert.equal(m.recognitions.length, 1, "только валидная запись");
  assert.equal(m.recognitions[0].entryKey, "v-commission");
  const usd = m.summaries.find((s) => s.currencyCode === "USD")!;
  assert.equal(usd.recognizedRestaurantOwesDirectCents, 900, "учтена только валидная сумма");
  assert.equal(mixedIssues(m).length, 1);
});

// 7 --------------------------------------------------------------------------

test("presentation-model группирует предупреждение без внутренних ID", () => {
  const st = stateWith(
    [orderWith("order-mixed", 500, 500)],
    [
      entry({
        id: "m-commission",
        orderId: "order-mixed",
        direction: "RESTAURANT_OWES_DIRECT",
        type: "PLATFORM_COMMISSION",
        amountCents: 100,
      }),
      entry({
        id: "m-payout",
        orderId: "order-mixed",
        direction: "DIRECT_OWES_RESTAURANT",
        type: "RESTAURANT_PAYOUT",
        amountCents: 400,
      }),
    ],
  );
  const res = buildRestaurantStatementView(st, RESTAURANT_ID, range("2026-07-01", "2026-07-31"));
  assert.equal(res.ok, true, res.error ?? "");
  assert.ok(res.view);
  const view = res.view;
  assert.equal(view.hasIntegrityWarnings, true);
  const group = view.integritySummary.find(
    (g) => g.message === "Обнаружен заказ с противоречивыми данными о получателе оплаты.",
  );
  assert.ok(group, "есть безопасная группа предупреждения");
  assert.equal(group.count, 1, "один mixed-заказ");
  // Внутренние идентификаторы не утекают в публичную модель.
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes("order-mixed"), "orderId не в публичной модели");
  assert.ok(!serialized.includes("m-commission"), "entryKey не в публичной модели");
  assert.ok(!serialized.includes("m-payout"), "entryKey не в публичной модели");
  assert.ok(!serialized.includes("entryKey"));
  // Повреждённый заказ не создал строк выписки.
  assert.equal(view.recognitionRows.length, 0);
  assert.equal(view.resolutionRows.length, 0);
});

// 8 --------------------------------------------------------------------------

test("read-only: state не мутируется при обработке mixed-заказа", () => {
  const st = stateWith(
    [orderWith("order-mixed", 500, 500), orderWith("order-valid", 900, 0)],
    [
      entry({ id: "m-commission", orderId: "order-mixed", amountCents: 100 }),
      entry({
        id: "m-payout",
        orderId: "order-mixed",
        direction: "DIRECT_OWES_RESTAURANT",
        type: "RESTAURANT_PAYOUT",
        amountCents: 400,
      }),
      entry({ id: "v-commission", orderId: "order-valid", amountCents: 900 }),
    ],
    [event({ id: "r-payout", accountingEntryId: "m-payout" })],
  );
  const snapshot = JSON.stringify(st);
  const ordersRef = st.orders;
  const entriesRef = st.restaurantAccountingEntries;
  const eventsRef = st.restaurantAccountingResolutionEvents;
  const revBefore = st.revision;

  buildRestaurantStatementMovements(st, RESTAURANT_ID, range("2026-07-01", "2026-07-31"));
  buildRestaurantStatementView(st, RESTAURANT_ID, range("2026-07-01", "2026-07-31"));

  assert.equal(JSON.stringify(st), snapshot, "state неизменен");
  assert.equal(st.orders, ordersRef);
  assert.equal(st.restaurantAccountingEntries, entriesRef);
  assert.equal(st.restaurantAccountingResolutionEvents, eventsRef);
  assert.equal(st.revision, revBefore);
});

// 9 --------------------------------------------------------------------------

test("orphan-запись без найденного заказа mixed не считается", () => {
  const st = stateWith(
    [], // заказов нет вообще
    [entry({ id: "orphan", orderId: "удалённый-заказ" })],
  );
  const m = build(st);
  assert.equal(mixedIssues(m).length, 0, "orphan не помечается mixed");
  // Orphan-запись обрабатывается штатно (учитывается как обычная recognition).
  assert.equal(m.recognitions.length, 1);
  assert.equal(m.recognitions[0].entryKey, "orphan");
});
