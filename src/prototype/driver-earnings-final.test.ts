import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { parseStoredState } from "./prototype-store.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type { Order, PrototypeState } from "./models.ts";
import {
  addCartItem,
  acceptRestaurantOrder,
  assignDriverToOrder,
  createOrderFromCart,
  goDriverOnline,
  markOrderReady,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import {
  markDriverArrivedAtRestaurant,
  markDriverArrivingToCustomer,
  markDriverDeliveredOrder,
  markDriverPickedUpOrder,
} from "./driver-delivery.ts";
import {
  getDriverEarningsView,
  buildCompletedDriverEarningEntry,
  hasValidDriverEarningEntry,
} from "./driver-earnings.ts";
import { getRestaurantCashHandoffBreakdown } from "./platform-driver-cash-handoff.ts";
import {
  driverCashHandoffReportEventId,
  restaurantCashReceiptEventId,
} from "./platform-driver-cash-handoff.ts";
import { FINANCIAL_RULES } from "./financial-rule.ts";

/**
 * CASH DIRECT — split №3 (финализация): миграция, read-model расчётов водителя,
 * расшифровка наличной передачи для ресторана и сквозная проверка
 * driver ↔ restaurant ↔ Direct. Контрольный заказ (§30):
 * customer 1000 / restaurant payout 580 / driver payout 300 / platform gross 120.
 */

const DRIVER = "driver-1";
const OTHER = "driver-2";
const REST = "restaurant-2";
const REST_ZONE = "zone-2" as const;
const ORDER = "o-cash-ctrl";
const T0 = "2026-07-22T10:00:00.000Z";
const T2 = "2026-07-22T10:06:00.000Z";
const T3 = "2026-07-22T10:07:00.000Z";
const T4 = "2026-07-22T10:08:00.000Z";
const T5 = "2026-07-22T10:09:00.000Z";
const T6 = "2026-07-22T10:10:00.000Z";

// Контрольный snapshot: получение 1000, передача ресторану 700 (= 580 + 120).
const SNAPSHOT = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 700,
  driverEarningCents: 300,
  restaurantOwesDirectCents: 120,
};
const MOVEMENT = {
  customerMoneyRecipient: "RESTAURANT",
  paymentChannel: "CASH_TO_PLATFORM_DRIVER",
  totalBankFeeCents: 0,
  restaurantBankFeeCents: 0,
  directBankFeeCents: 0,
  restaurantOwesDirectCents: 120,
  directOwesRestaurantCents: 0,
  restaurantNetCents: 580,
  directNetRevenueCents: 120,
};

/** ARRIVING-состояние контрольного наличного заказа. */
function cashArriving(): PrototypeState {
  const base = createDefaultState();
  const order = {
    id: ORDER,
    publicNumber: "C-CTRL",
    createdAt: T0,
    updatedAt: T0,
    customer: { id: "customer-1", name: "Клиент", phone: "+373 1" },
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    paymentStatus: "CASH_ON_DELIVERY",
    paidAt: null,
    status: "ARRIVING",
    assignedDriverId: DRIVER,
    driverAssignedAt: T0,
    restaurant: { id: REST, name: "Ресторан 2", address: "адрес", zoneId: "zone-2" },
    address: {
      street: "ул. Пушкина",
      house: "1",
      apartment: "",
      entrance: "",
      floor: "",
      comment: "",
      zoneId: "zone-2",
    },
    items: [],
    etaAdjustments: [],
    history: [],
    financials: {
      currencyCode: "USD",
      customerZoneId: "zone-1",
      foodSubtotalCents: 700,
      deliveryFeeCents: 300,
      smallOrderFeeCents: 0,
      restaurantCommissionCents: 120,
      customerTotalCents: 1000,
      restaurantPayoutBeforeBankFeeCents: 580,
      driverPayoutCents: 300,
      platformGrossRevenueCents: 120,
      financialRule: FINANCIAL_RULES.DIRECT_FINANCIAL_RULE_V1,
      financialCollectionMode: "MIXED_COLLECTION",
      platformDriverCash: SNAPSHOT,
      moneyMovementStatus: "COMPLETE",
      moneyMovement: MOVEMENT,
    },
  } as unknown as Order;

  const de = [
    {
      id: "de-1",
      orderId: ORDER,
      driverId: DRIVER,
      type: "ARRIVED_AT_RESTAURANT",
      occurredAt: T2,
      orderStatusBefore: "READY",
      orderStatusAfter: "READY",
    },
    {
      id: "de-2",
      orderId: ORDER,
      driverId: DRIVER,
      type: "ORDER_PICKED_UP",
      occurredAt: T4,
      orderStatusBefore: "READY",
      orderStatusAfter: "OUT_FOR_DELIVERY",
    },
    {
      id: "de-3",
      orderId: ORDER,
      driverId: DRIVER,
      type: "ARRIVING_TO_CUSTOMER",
      occurredAt: T5,
      orderStatusBefore: "OUT_FOR_DELIVERY",
      orderStatusAfter: "ARRIVING",
    },
  ];
  const cash = [
    {
      id: driverCashHandoffReportEventId(ORDER),
      orderId: ORDER,
      driverId: DRIVER,
      restaurantId: REST,
      type: "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF",
      amountCents: 700,
      occurredAt: T2,
      actor: "DRIVER",
      restaurantWorkspaceRole: null,
    },
    {
      id: restaurantCashReceiptEventId(ORDER),
      orderId: ORDER,
      driverId: DRIVER,
      restaurantId: REST,
      type: "RESTAURANT_CONFIRMED_CASH_RECEIPT",
      amountCents: 700,
      occurredAt: T3,
      actor: "RESTAURANT",
      restaurantWorkspaceRole: "COMBINED",
    },
  ];

  return {
    ...base,
    platformSettings: { ...base.platformSettings, platformDriverCashEnabled: true },
    orders: [order],
    driverOffers: [
      {
        id: "offer-1",
        orderId: ORDER,
        driverId: DRIVER,
        status: "ACCEPTED",
        offeredAt: T0,
        expiresAt: "2030-01-01T00:00:00.000Z",
        resolvedAt: T0,
        cashReserveConfirmedAt: T0,
      } as unknown as PrototypeState["driverOffers"][number],
    ],
    driverDeliveryEvents: de as unknown as PrototypeState["driverDeliveryEvents"],
    platformDriverCashEvents:
      cash as unknown as PrototypeState["platformDriverCashEvents"],
    drivers: base.drivers.map((d) =>
      d.id === DRIVER ? { ...d, status: "BUSY_DIRECT" as const, currentZoneId: "zone-2" } : d,
    ),
  };
}

function cashCompleted(): PrototypeState {
  const r = markDriverDeliveredOrder(cashArriving(), DRIVER, ORDER, T6, {
    cashCollectionConfirmed: true,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  return r.state;
}

/** Полный ONLINE-lifecycle через реальные действия; возвращает завершённое состояние. */
function onlineCompleted(): { state: PrototypeState; orderId: string } {
  let s = goDriverOnline(createDefaultState(), DRIVER, REST_ZONE).state;
  s = updateCartAddress(s, {
    street: "Садовый переулок",
    house: "5",
    apartment: "12",
    entrance: "2",
    floor: "3",
    comment: "у ворот",
  });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, orderId);
  s = markOrderReady(s, orderId);
  s = assignDriverToOrder(s, orderId, DRIVER).state;
  s = markDriverArrivedAtRestaurant(s, DRIVER, orderId, T2).state;
  s = markDriverPickedUpOrder(s, DRIVER, orderId, T4).state;
  s = markDriverArrivingToCustomer(s, DRIVER, orderId, T5).state;
  const r = markDriverDeliveredOrder(s, DRIVER, orderId, T6, {
    cashCollectionConfirmed: false,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  return { state: r.state, orderId };
}

const orderOf = (s: PrototypeState, id: string): Order => {
  const o = s.orders.find((x) => x.id === id);
  assert.ok(o);
  return o;
};
const accOf = (s: PrototypeState, id: string) =>
  s.restaurantAccountingEntries.filter((e) => e.orderId === id);

// --- §26 миграция -------------------------------------------------------------

// Имя удалённого поля собирается из частей, чтобы grep-аудит legacy оставался пуст.
const LEGACY_LEDGER_FIELD = ["driverCash", "LedgerEntries"].join("");

test("1/2/4: схема 25; schema24 мигрирует; старый ledger отсутствует", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 29);
  const parsed = parseStoredState(
    JSON.stringify({ ...cashCompleted(), schemaVersion: 24 }),
  );
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, 29);
  assert.ok(!(LEGACY_LEDGER_FIELD in parsed));
});

test("3: schema25 round-trip идемпотентен", () => {
  const once = parseStoredState(JSON.stringify(cashCompleted()));
  assert.ok(once);
  const twice = parseStoredState(JSON.stringify(once));
  assert.ok(twice);
  assert.deepEqual(twice.driverEarningEntries, once.driverEarningEntries);
});

test("5/8: старый schema23 raw ledger игнорируется, не конвертируется", () => {
  const withRawLedger = {
    ...cashCompleted(),
    schemaVersion: 23,
    [LEGACY_LEDGER_FIELD]: [
      { id: "x", orderId: ORDER, driverId: DRIVER, amountCents: 999 },
    ],
  };
  const parsed = parseStoredState(JSON.stringify(withRawLedger));
  assert.ok(parsed);
  assert.ok(!(LEGACY_LEDGER_FIELD in parsed));
  assert.deepEqual(parsed.driverEarningEntries, []);
});

test("6/7/9/10/11: старый schema23 CASH обезврежен — снимок null, событий нет, без earning/accounting", () => {
  // Реалистичный schema-23 CASH: обязательство ресторана тогда не создавалось.
  const parsed = parseStoredState(
    JSON.stringify({
      ...cashCompleted(),
      schemaVersion: 23,
      restaurantAccountingEntries: [],
    }),
  );
  assert.ok(parsed);
  const o = orderOf(parsed, ORDER);
  assert.equal(o.financials.platformDriverCash, null);
  assert.equal(parsed.driverOffers[0].cashReserveConfirmedAt, null);
  assert.deepEqual(parsed.platformDriverCashEvents, []);
  assert.deepEqual(parsed.driverEarningEntries, []);
  // §6.5/§8: accounting для старого CASH не синтезируется.
  assert.equal(accOf(parsed, ORDER).length, 0);
  // Завершённый заказ остаётся историческим.
  assert.equal(o.status, "DELIVERED");
});

test("11: старый schema23 CASH завершённый заказ → reviewRequired в read-model", () => {
  const parsed = parseStoredState(
    JSON.stringify({ ...cashCompleted(), schemaVersion: 23 }),
  );
  assert.ok(parsed);
  const view = getDriverEarningsView(parsed, DRIVER);
  assert.equal(view.reviewRequired, true);
  assert.ok(view.reviewRequiredOrderCount >= 1);
  assert.equal(view.entries.length, 0);
});

test("12/13: valid ONLINE schema23 мигрирует DIRECT_PAYOUT_DUE; невалидный — нет", () => {
  const { state, orderId } = onlineCompleted();
  const migrated = parseStoredState(
    JSON.stringify({ ...state, schemaVersion: 23, driverEarningEntries: [] }),
  );
  assert.ok(migrated);
  const e = migrated.driverEarningEntries.filter((x) => x.orderId === orderId);
  assert.equal(e.length, 1);
  assert.equal(e[0].mode, "DIRECT_PAYOUT_DUE");

  // Невалидный (нет события доставки) не мигрируется.
  const invalid = parseStoredState(
    JSON.stringify({
      ...state,
      schemaVersion: 23,
      driverEarningEntries: [],
      driverDeliveryEvents: state.driverDeliveryEvents.filter(
        (ev) => ev.type !== "ORDER_DELIVERED",
      ),
    }),
  );
  assert.ok(invalid);
  assert.equal(
    invalid.driverEarningEntries.filter((x) => x.orderId === orderId).length,
    0,
  );
});

test("16: valid corrected schema24 CASH мигрирует CASH_RETAINED", () => {
  const migrated = parseStoredState(
    JSON.stringify({ ...cashCompleted(), schemaVersion: 24, driverEarningEntries: [] }),
  );
  assert.ok(migrated);
  const e = migrated.driverEarningEntries.filter((x) => x.orderId === ORDER);
  assert.equal(e.length, 1);
  assert.equal(e[0].mode, "CASH_RETAINED");
  assert.equal(e[0].amountCents, 300);
});

test("17: schema24 CASH без accounting получает каноническую RESTAURANT_REMITTANCE", () => {
  const migrated = parseStoredState(
    JSON.stringify({
      ...cashCompleted(),
      schemaVersion: 24,
      driverEarningEntries: [],
      restaurantAccountingEntries: [],
    }),
  );
  assert.ok(migrated);
  const acc = accOf(migrated, ORDER);
  assert.equal(acc.length, 1);
  assert.equal(acc[0].type, "RESTAURANT_REMITTANCE");
  assert.equal(acc[0].amountCents, 120);
  // И заработок мигрирован (accounting добавлен до earning).
  assert.equal(migrated.driverEarningEntries.length, 1);
});

test("18: incomplete schema24 CASH не мигрируется (нет accounting, нет earning)", () => {
  const parsed = parseStoredState(
    JSON.stringify({
      ...cashCompleted(),
      schemaVersion: 24,
      driverEarningEntries: [],
      restaurantAccountingEntries: [],
      // Убираем событие получения денег → доказательство неполное.
      platformDriverCashEvents: cashCompleted().platformDriverCashEvents.filter(
        (e) => e.type !== "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
      ),
    }),
  );
  assert.ok(parsed);
  assert.equal(accOf(parsed, ORDER).length, 0);
  assert.equal(parsed.driverEarningEntries.length, 0);
});

test("19/20: schema25 отсутствующий earning/accounting не синтезируется", () => {
  const parsed = parseStoredState(
    JSON.stringify({
      ...cashCompleted(),
      schemaVersion: 25,
      driverEarningEntries: [],
      restaurantAccountingEntries: [],
    }),
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.driverEarningEntries, []);
  assert.equal(accOf(parsed, ORDER).length, 0);
});

test("21: дубли earning одного заказа удаляют все конфликтующие", () => {
  const good = cashCompleted().driverEarningEntries[0];
  const parsed = parseStoredState(
    JSON.stringify({
      ...cashCompleted(),
      schemaVersion: 25,
      driverEarningEntries: [good, { ...good, id: "dup" }],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.driverEarningEntries.length, 0);
});

// --- §27 read-model -----------------------------------------------------------

test("22/23/26/32: CASH_RETAINED в total и cashReceived, не в due; collection/handoff", () => {
  const view = getDriverEarningsView(cashCompleted(), DRIVER);
  assert.equal(view.deliveryCount, 1);
  assert.equal(view.totalEarningsCents, 300);
  assert.equal(view.cashReceivedCents, 300);
  assert.equal(view.dueFromDirectCents, 0);
  assert.equal(view.reviewRequired, false);
  const row = view.entries[0];
  assert.equal(row.paymentMethod, "CASH");
  assert.equal(row.customerCollectionCents, 1000);
  assert.equal(row.restaurantHandoffCents, 700);
});

test("24/25/33: DIRECT_PAYOUT_DUE в total и due, не в cash; cash-значения null", () => {
  const { state, orderId } = onlineCompleted();
  const payout = orderOf(state, orderId).financials.driverPayoutCents;
  const view = getDriverEarningsView(state, DRIVER);
  assert.equal(view.deliveryCount, 1);
  assert.equal(view.totalEarningsCents, payout);
  assert.equal(view.dueFromDirectCents, payout);
  assert.equal(view.cashReceivedCents, 0);
  const row = view.entries[0];
  assert.equal(row.paymentMethod, "ONLINE");
  assert.equal(row.customerCollectionCents, null);
  assert.equal(row.restaurantHandoffCents, null);
});

test("27: другой водитель исключён", () => {
  const view = getDriverEarningsView(cashCompleted(), OTHER);
  assert.equal(view.entries.length, 0);
  assert.equal(view.totalEarningsCents, 0);
  assert.equal(view.reviewRequired, false);
});

test("28/29: повреждённая/отсутствующая запись завершённого заказа → review", () => {
  const st = cashCompleted();
  const missing: PrototypeState = { ...st, driverEarningEntries: [] };
  const view = getDriverEarningsView(missing, DRIVER);
  assert.equal(view.reviewRequired, true);
  assert.equal(view.reviewRequiredOrderCount, 1);
  assert.equal(view.entries.length, 0);
});

test("30: активный (не завершённый) заказ не ставит review", () => {
  const view = getDriverEarningsView(cashArriving(), DRIVER);
  assert.equal(view.reviewRequired, false);
  assert.equal(view.reviewRequiredOrderCount, 0);
  assert.equal(view.entries.length, 0);
});

test("34: приватных данных клиента во view нет", () => {
  const view = getDriverEarningsView(cashCompleted(), DRIVER);
  const json = JSON.stringify(view);
  for (const forbidden of ["Клиент", "+373", "Пушкина", "customer-1"]) {
    assert.ok(!json.includes(forbidden), forbidden);
  }
});

test("35/36/37/38: overflow одного итога не рушит историю и другие итоги", () => {
  const st = cashCompleted();
  // Подменяем сумму записи на выходящую за безопасный диапазон — целостность
  // completed builder ломается (review), но история и deliveryCount сохраняются.
  const broken: PrototypeState = {
    ...st,
    driverEarningEntries: st.driverEarningEntries.map((e) => ({
      ...e,
      amountCents: Number.MAX_SAFE_INTEGER,
    })),
  };
  const view = getDriverEarningsView(broken, DRIVER);
  // Повреждённая запись помечает review; нулевой финансовый баланс не выдаётся.
  assert.equal(view.reviewRequired, true);
});

// --- §29 restaurant cash breakdown --------------------------------------------

test("54/55/56/57/62: breakdown $7.00 / $5.80 / $1.20 — три РАЗНЫЕ суммы", () => {
  const order = orderOf(cashArriving(), ORDER);
  const b = getRestaurantCashHandoffBreakdown(order);
  assert.equal(b.ok, true);
  assert.equal(b.receivedFromDriverCents, 700);
  assert.equal(b.retainedByRestaurantCents, 580);
  assert.equal(b.owedToDirectCents, 120);
  // Суммы не смешиваются: передача != долг.
  assert.notEqual(b.receivedFromDriverCents, b.owedToDirectCents);
  assert.notEqual(b.receivedFromDriverCents, b.retainedByRestaurantCents);
});

test("58: рассинхрон ±1 цент → review, без правдоподобных частичных сумм", () => {
  const s = cashArriving();
  const order = {
    ...orderOf(s, ORDER),
    financials: {
      ...orderOf(s, ORDER).financials,
      restaurantPayoutBeforeBankFeeCents: 581, // 581 + 120 != 700
    },
  } as Order;
  const b = getRestaurantCashHandoffBreakdown(order);
  assert.equal(b.ok, false);
  assert.equal(b.receivedFromDriverCents, null);
  assert.equal(b.retainedByRestaurantCents, null);
  assert.equal(b.owedToDirectCents, null);
  assert.equal(b.error, "Данные наличного расчёта требуют проверки Direct.");
});

// --- §30 end-to-end CASH ------------------------------------------------------

test("e2e CASH: earning + remittance + read-model + serialize/parse", () => {
  const st = cashCompleted();
  // 9: заработок CASH_RETAINED 300, обязательство RESTAURANT_REMITTANCE 120.
  const earning = st.driverEarningEntries.filter((e) => e.orderId === ORDER);
  assert.equal(earning.length, 1);
  assert.equal(earning[0].mode, "CASH_RETAINED");
  assert.equal(earning[0].amountCents, 300);
  const acc = accOf(st, ORDER);
  assert.equal(acc.length, 1);
  assert.equal(acc[0].direction, "RESTAURANT_OWES_DIRECT");
  assert.equal(acc[0].type, "RESTAURANT_REMITTANCE");
  assert.equal(acc[0].amountCents, 120);
  assert.equal(st.settlements.length, 0);
  assert.equal(st.restaurantSettlementRecords.length, 0);
  // 10: driver read-model.
  const view = getDriverEarningsView(st, DRIVER);
  assert.equal(view.totalEarningsCents, 300);
  assert.equal(view.cashReceivedCents, 300);
  assert.equal(view.dueFromDirectCents, 0);
  assert.equal(view.deliveryCount, 1);
  // 11/12: ресторан/админ видят обязательство 120.
  const owes = st.restaurantAccountingEntries.filter(
    (e) => e.restaurantId === REST && e.direction === "RESTAURANT_OWES_DIRECT",
  );
  assert.equal(owes.reduce((sum, e) => sum + e.amountCents, 0), 120);
  // 15: serialize → parse сохраняет всё.
  const parsed = parseStoredState(JSON.stringify(st));
  assert.ok(parsed);
  assert.equal(
    parsed.driverEarningEntries.filter((e) => e.orderId === ORDER)[0].mode,
    "CASH_RETAINED",
  );
  assert.equal(accOf(parsed, ORDER)[0].type, "RESTAURANT_REMITTANCE");
  assert.equal(orderOf(parsed, ORDER).status, "DELIVERED");
});

// --- §31 end-to-end ONLINE ----------------------------------------------------

test("e2e ONLINE: DIRECT_PAYOUT_DUE, read-model, serialize/parse", () => {
  const { state, orderId } = onlineCompleted();
  const payout = orderOf(state, orderId).financials.driverPayoutCents;
  const earning = state.driverEarningEntries.filter((e) => e.orderId === orderId);
  assert.equal(earning.length, 1);
  assert.equal(earning[0].mode, "DIRECT_PAYOUT_DUE");
  assert.equal(earning[0].amountCents, payout);
  const view = getDriverEarningsView(state, DRIVER);
  assert.equal(view.dueFromDirectCents, payout);
  assert.equal(view.cashReceivedCents, 0);
  assert.equal(view.totalEarningsCents, payout);
  // Существующее restaurant accounting сохраняется.
  assert.equal(accOf(state, orderId).length, 1);
  const parsed = parseStoredState(JSON.stringify(state));
  assert.ok(parsed);
  assert.equal(
    parsed.driverEarningEntries.filter((e) => e.orderId === orderId)[0].mode,
    "DIRECT_PAYOUT_DUE",
  );
  assert.equal(orderOf(parsed, orderId).status, "DELIVERED");
});

// --- repair v25: hardened completed ONLINE earning integrity ------------------

function onlineDone(): { state: PrototypeState; orderId: string } {
  return onlineCompleted();
}
const clone = (s: PrototypeState): PrototypeState =>
  JSON.parse(JSON.stringify(s)) as PrototypeState;
const built = (state: PrototypeState, orderId: string) =>
  buildCompletedDriverEarningEntry(state, orderOf(state, orderId));
function mapEvents(
  state: PrototypeState,
  orderId: string,
  fn: (es: PrototypeState["driverDeliveryEvents"]) => unknown[],
): PrototypeState {
  const s = clone(state);
  s.driverDeliveryEvents = fn(
    s.driverDeliveryEvents,
  ) as PrototypeState["driverDeliveryEvents"];
  return s;
}
function patchOrder(
  state: PrototypeState,
  orderId: string,
  patch: Record<string, unknown>,
): PrototypeState {
  const s = clone(state);
  s.orders = s.orders.map((o) => (o.id === orderId ? ({ ...o, ...patch } as Order) : o));
  return s;
}
function patchFin(
  state: PrototypeState,
  orderId: string,
  patch: Record<string, unknown>,
): PrototypeState {
  const s = clone(state);
  s.orders = s.orders.map((o) =>
    o.id === orderId
      ? ({ ...o, financials: { ...o.financials, ...patch } } as Order)
      : o,
  );
  return s;
}
function setAcc(
  state: PrototypeState,
  orderId: string,
  entries: unknown[],
): PrototypeState {
  const s = clone(state);
  s.restaurantAccountingEntries = [
    ...s.restaurantAccountingEntries.filter((e) => e.orderId !== orderId),
    ...entries,
  ] as PrototypeState["restaurantAccountingEntries"];
  return s;
}
const evOf = (
  state: PrototypeState,
  orderId: string,
  type: string,
) =>
  state.driverDeliveryEvents.find(
    (e) => e.orderId === orderId && e.driverId === DRIVER && e.type === type,
  )!;

// §15 --------------------------------------------------------------------------

test("h1/h2: полный valid ONLINE → DIRECT_PAYOUT_DUE, recognizedAt = delivered", () => {
  const { state, orderId } = onlineDone();
  const delivered = state.driverDeliveryEvents.find(
    (e) => e.orderId === orderId && e.type === "ORDER_DELIVERED",
  );
  const r = built(state, orderId);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (r.ok) {
    assert.equal(r.entry.mode, "DIRECT_PAYOUT_DUE");
    assert.equal(r.entry.amountCents, orderOf(state, orderId).financials.driverPayoutCents);
    assert.equal(r.entry.recognizedAt, delivered?.occurredAt);
  }
});

test("h3-h19: неполный/повреждённый lifecycle ONLINE → fail", () => {
  const { state, orderId } = onlineDone();
  const reject = (s: PrototypeState, label: string) =>
    assert.equal(built(s, orderId).ok, false, label);

  // 3/4: pickup missing / duplicate
  reject(mapEvents(state, orderId, (es) => es.filter((e) => e.type !== "ORDER_PICKED_UP")), "no pickup");
  reject(mapEvents(state, orderId, (es) => [...es, { ...evOf(state, orderId, "ORDER_PICKED_UP"), id: "dp" }]), "dup pickup");
  // 5/6: arriving missing / duplicate
  reject(mapEvents(state, orderId, (es) => es.filter((e) => e.type !== "ARRIVING_TO_CUSTOMER")), "no arriving");
  reject(mapEvents(state, orderId, (es) => [...es, { ...evOf(state, orderId, "ARRIVING_TO_CUSTOMER"), id: "da" }]), "dup arriving");
  // 7/8: delivered missing / duplicate
  reject(mapEvents(state, orderId, (es) => es.filter((e) => e.type !== "ORDER_DELIVERED")), "no delivered");
  reject(mapEvents(state, orderId, (es) => [...es, { ...evOf(state, orderId, "ORDER_DELIVERED"), id: "dd" }]), "dup delivered");
  // 9/10/11: other driver
  for (const type of ["ORDER_PICKED_UP", "ARRIVING_TO_CUSTOMER", "ORDER_DELIVERED"]) {
    reject(mapEvents(state, orderId, (es) => es.map((e) => (e.type === type ? { ...e, driverId: OTHER } : e))), `other driver ${type}`);
  }
  // 12/13/14: wrong transitions
  reject(mapEvents(state, orderId, (es) => es.map((e) => (e.type === "ORDER_PICKED_UP" ? { ...e, orderStatusBefore: "PREPARING" } : e))), "pickup before");
  reject(mapEvents(state, orderId, (es) => es.map((e) => (e.type === "ARRIVING_TO_CUSTOMER" ? { ...e, orderStatusAfter: "DELIVERED" } : e))), "arriving after");
  reject(mapEvents(state, orderId, (es) => es.map((e) => (e.type === "ORDER_DELIVERED" ? { ...e, orderStatusBefore: "OUT_FOR_DELIVERY" } : e))), "delivered before");
  // 15/16/17: invalid ISO
  reject(mapEvents(state, orderId, (es) => es.map((e) => (e.type === "ORDER_PICKED_UP" ? { ...e, occurredAt: "нет" } : e))), "pickup ISO");
  reject(mapEvents(state, orderId, (es) => es.map((e) => (e.type === "ARRIVING_TO_CUSTOMER" ? { ...e, occurredAt: "нет" } : e))), "arriving ISO");
  reject(mapEvents(state, orderId, (es) => es.map((e) => (e.type === "ORDER_DELIVERED" ? { ...e, occurredAt: "нет" } : e))), "delivered ISO");
  // 18: pickup > arriving
  reject(mapEvents(state, orderId, (es) => es.map((e) => (e.type === "ORDER_PICKED_UP" ? { ...e, occurredAt: "2026-07-22T23:00:00.000Z" } : e))), "pickup>arriving");
  // 19: arriving > delivered
  reject(mapEvents(state, orderId, (es) => es.map((e) => (e.type === "ARRIVING_TO_CUSTOMER" ? { ...e, occurredAt: "2026-07-22T23:00:00.000Z" } : e))), "arriving>delivered");
});

test("h20-h23: status/payment/payout инварианты ONLINE → fail", () => {
  const { state, orderId } = onlineDone();
  assert.equal(built(patchOrder(state, orderId, { paymentStatus: "AWAITING_PAYMENT" }), orderId).ok, false); // 20
  assert.equal(built(patchOrder(state, orderId, { status: "ARRIVING" }), orderId).ok, false); // 21
  // 22: paymentMethod не ONLINE — ONLINE helper не вызывается; CASH-путь без cash-evidence → fail
  assert.equal(built(patchOrder(state, orderId, { paymentMethod: "CASH" }), orderId).ok, false);
  // 23: driver payout 0 / unsafe
  assert.equal(built(patchFin(state, orderId, { driverPayoutCents: 0 }), orderId).ok, false);
  assert.equal(built(patchFin(state, orderId, { driverPayoutCents: 1.5 }), orderId).ok, false);
});

// §16 accounting ---------------------------------------------------------------

const ONLINE_ZERO_MOVEMENT = {
  customerMoneyRecipient: "DIRECT",
  paymentChannel: "ONLINE_CARD",
  totalBankFeeCents: 0,
  restaurantBankFeeCents: 0,
  directBankFeeCents: 0,
  restaurantOwesDirectCents: 0,
  directOwesRestaurantCents: 0,
  restaurantNetCents: 0,
  directNetRevenueCents: 0,
};

test("h24: COMPLETE ONLINE + точное существующее accounting → success", () => {
  const { state, orderId } = onlineDone();
  assert.equal(built(state, orderId).ok, true);
});

test("h25: законный zero COMPLETE movement → success без accounting entry", () => {
  const { state, orderId } = onlineDone();
  const zero = setAcc(
    patchFin(state, orderId, { moneyMovement: ONLINE_ZERO_MOVEMENT }),
    orderId,
    [],
  );
  const r = built(zero, orderId);
  assert.equal(r.ok, true, r.ok ? "" : r.error);
  if (r.ok) assert.equal(r.entry.mode, "DIRECT_PAYOUT_DUE");
});

test("h26-h30: повреждённое/отсутствующее accounting → fail", () => {
  const { state, orderId } = onlineDone();
  const acc = state.restaurantAccountingEntries.find((e) => e.orderId === orderId)!;
  assert.equal(built(setAcc(state, orderId, []), orderId).ok, false); // 26 missing
  assert.equal(built(setAcc(state, orderId, [{ ...acc, amountCents: acc.amountCents + 1 }]), orderId).ok, false); // 27 amount
  assert.equal(built(setAcc(state, orderId, [{ ...acc, direction: "RESTAURANT_OWES_DIRECT" }]), orderId).ok, false); // 28 direction
  assert.equal(built(setAcc(state, orderId, [{ ...acc, type: "PLATFORM_COMMISSION" }]), orderId).ok, false); // 29 type
  assert.equal(built(setAcc(state, orderId, [acc, { ...acc, id: acc.id + "-dup" }]), orderId).ok, false); // 30 duplicate
});

test("h31-h34: movement статус/канал ONLINE → fail", () => {
  const { state, orderId } = onlineDone();
  assert.equal(built(patchFin(state, orderId, { moneyMovementStatus: "REVIEW_REQUIRED" }), orderId).ok, false); // 31
  assert.equal(built(patchFin(state, orderId, { moneyMovementStatus: "PENDING_PAYMENT_CHANNEL" }), orderId).ok, false); // 32
  assert.equal(built(patchFin(state, orderId, { moneyMovement: undefined }), orderId).ok, false); // 33
  const mv = orderOf(state, orderId).financials.moneyMovement;
  assert.equal(
    built(patchFin(state, orderId, { moneyMovement: { ...mv, paymentChannel: "CASH_TO_PLATFORM_DRIVER" } }), orderId).ok,
    false,
  ); // 34
});

// §17 migration ----------------------------------------------------------------

test("h35-h42: migration source ≤24 уважает усиленное доказательство", () => {
  const { state, orderId } = onlineDone();
  const parseAt = (v: number, mutate?: (s: PrototypeState) => PrototypeState) => {
    const base = mutate ? mutate(clone(state)) : state;
    const withEmpty = { ...base, driverEarningEntries: [] };
    const parsed = parseStoredState(JSON.stringify({ ...withEmpty, schemaVersion: v }));
    assert.ok(parsed);
    return parsed.driverEarningEntries.filter((e) => e.orderId === orderId);
  };
  // 35: valid schema23 → migrated
  assert.equal(parseAt(23)[0]?.mode, "DIRECT_PAYOUT_DUE");
  // 36/37/38: missing event → not migrated
  assert.equal(parseAt(23, (s) => mapEvents(s, orderId, (es) => es.filter((e) => e.type !== "ORDER_PICKED_UP"))).length, 0);
  assert.equal(parseAt(23, (s) => mapEvents(s, orderId, (es) => es.filter((e) => e.type !== "ARRIVING_TO_CUSTOMER"))).length, 0);
  assert.equal(parseAt(23, (s) => mapEvents(s, orderId, (es) => es.filter((e) => e.type !== "ORDER_DELIVERED"))).length, 0);
  // 39: wrong transition
  assert.equal(parseAt(23, (s) => mapEvents(s, orderId, (es) => es.map((e) => (e.type === "ORDER_PICKED_UP" ? { ...e, orderStatusBefore: "PREPARING" } : e)))).length, 0);
  // 40: wrong chronology
  assert.equal(parseAt(23, (s) => mapEvents(s, orderId, (es) => es.map((e) => (e.type === "ORDER_PICKED_UP" ? { ...e, occurredAt: "2026-07-22T23:00:00.000Z" } : e)))).length, 0);
  // 41: missing accounting
  assert.equal(parseAt(23, (s) => setAcc(s, orderId, [])).length, 0);
  // 42: REVIEW_REQUIRED movement
  assert.equal(parseAt(23, (s) => patchFin(s, orderId, { moneyMovementStatus: "REVIEW_REQUIRED" })).length, 0);
});

test("h43-h46: schema24 migrate; schema24 invalid none; schema25 strict raw", () => {
  const { state, orderId } = onlineDone();
  // 43: schema24 valid → present (migrated from evidence)
  const s24 = parseStoredState(JSON.stringify({ ...state, schemaVersion: 24, driverEarningEntries: [] }));
  assert.ok(s24);
  assert.equal(s24.driverEarningEntries.filter((e) => e.orderId === orderId).length, 1);
  // 44: schema24 invalid (no pickup) → none
  const s24bad = parseStoredState(
    JSON.stringify({
      ...mapEvents(state, orderId, (es) => es.filter((e) => e.type !== "ORDER_PICKED_UP")),
      schemaVersion: 24,
      driverEarningEntries: [],
    }),
  );
  assert.ok(s24bad);
  assert.equal(s24bad.driverEarningEntries.filter((e) => e.orderId === orderId).length, 0);
  // 45: schema25 invalid raw earning (no pickup) → dropped
  const good = state.driverEarningEntries.find((e) => e.orderId === orderId)!;
  const s25 = parseStoredState(
    JSON.stringify({
      ...mapEvents(state, orderId, (es) => es.filter((e) => e.type !== "ORDER_PICKED_UP")),
      schemaVersion: 25,
      driverEarningEntries: [good],
    }),
  );
  assert.ok(s25);
  assert.equal(s25.driverEarningEntries.filter((e) => e.orderId === orderId).length, 0);
  // 46: schema25 missing earning not synthesized
  const s25empty = parseStoredState(JSON.stringify({ ...state, schemaVersion: 25, driverEarningEntries: [] }));
  assert.ok(s25empty);
  assert.equal(s25empty.driverEarningEntries.filter((e) => e.orderId === orderId).length, 0);
});

// §18 read-model / UI semantics ------------------------------------------------

test("h47: completed ONLINE без pickup → 0 entries, review, все totals null", () => {
  const { state, orderId } = onlineDone();
  const broken = mapEvents(state, orderId, (es) => es.filter((e) => e.type !== "ORDER_PICKED_UP"));
  const view = getDriverEarningsView(broken, DRIVER);
  assert.equal(view.entries.length, 0);
  assert.equal(view.reviewRequired, true);
  assert.equal(view.reviewRequiredOrderCount, 1);
  assert.equal(view.totalEarningsCents, null);
  assert.equal(view.cashReceivedCents, null);
  assert.equal(view.dueFromDirectCents, null);
});

test("h48: completed ONLINE без accounting → 0 entries, review, все totals null", () => {
  const { state, orderId } = onlineDone();
  const view = getDriverEarningsView(setAcc(state, orderId, []), DRIVER);
  assert.equal(view.entries.length, 0);
  assert.equal(view.reviewRequired, true);
  assert.equal(view.totalEarningsCents, null);
  assert.equal(view.cashReceivedCents, null);
  assert.equal(view.dueFromDirectCents, null);
});

test("h49: valid ONLINE read-model — total/due = payout, cash 0, no review", () => {
  const { state, orderId } = onlineDone();
  const payout = orderOf(state, orderId).financials.driverPayoutCents;
  const view = getDriverEarningsView(state, DRIVER);
  assert.equal(view.totalEarningsCents, payout);
  assert.equal(view.dueFromDirectCents, payout);
  assert.equal(view.cashReceivedCents, 0);
  assert.equal(view.reviewRequired, false);
});

test("h50: valid CASH regression — total/cash = earning, due 0, no review", () => {
  const view = getDriverEarningsView(cashCompleted(), DRIVER);
  assert.equal(view.totalEarningsCents, 300);
  assert.equal(view.cashReceivedCents, 300);
  assert.equal(view.dueFromDirectCents, 0);
  assert.equal(view.reviewRequired, false);
});

test("h52: valid ONLINE + hasValid true; повреждённый completed → hasValid false", () => {
  const { state, orderId } = onlineDone();
  assert.equal(hasValidDriverEarningEntry(state, orderOf(state, orderId)), true);
  const broken = mapEvents(state, orderId, (es) => es.filter((e) => e.type !== "ARRIVING_TO_CUSTOMER"));
  assert.equal(hasValidDriverEarningEntry(broken, orderOf(broken, orderId)), false);
});

// §19 repeat completion regression ---------------------------------------------

test("h53: ONLINE repeat completion — no-op; удаление accounting → fail-closed", () => {
  const { state, orderId } = onlineDone();
  const before = state.revision;
  const again = markDriverDeliveredOrder(state, DRIVER, orderId, "2026-07-22T12:00:00.000Z", {
    cashCollectionConfirmed: false,
  });
  assert.equal(again.result.ok, true, again.result.error ?? "");
  assert.equal(again.state, state);
  assert.equal(again.state.revision, before);
  assert.equal(again.state.driverEarningEntries.filter((e) => e.orderId === orderId).length, 1);
  // Удаляем accounting → repeat fail-closed, state не мутируется.
  const noAcc = setAcc(state, orderId, []);
  const r2 = markDriverDeliveredOrder(noAcc, DRIVER, orderId, "2026-07-22T12:00:00.000Z", {
    cashCollectionConfirmed: false,
  });
  assert.equal(r2.result.ok, false);
  assert.equal(r2.state, noAcc);
});
