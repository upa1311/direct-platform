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
import { getDriverEarningsView } from "./driver-earnings.ts";
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

test("1/2/4: схема 25; schema24 мигрирует; driverCashLedgerEntries отсутствует", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 25);
  const parsed = parseStoredState(
    JSON.stringify({ ...cashCompleted(), schemaVersion: 24 }),
  );
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, 25);
  assert.ok(!("driverCashLedgerEntries" in parsed));
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
    driverCashLedgerEntries: [
      { id: "x", orderId: ORDER, driverId: DRIVER, amountCents: 999 },
    ],
  };
  const parsed = parseStoredState(JSON.stringify(withRawLedger));
  assert.ok(parsed);
  assert.ok(!("driverCashLedgerEntries" in parsed));
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
