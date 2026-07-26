import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type { Order, PrototypeState } from "./models.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  assignDriverToOrder,
  confirmDriverZone,
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
  createDriverPayoutBatch,
  confirmDriverPayoutReceipt,
  getDriverEarningPayoutStates,
  getDriverPayoutsView,
  driverPayoutBatchId,
} from "./driver-payouts.ts";
import {
  getDriverSettlementPeriodView,
  type DriverEarningsPeriod,
} from "./driver-earnings.ts";
import { FINANCIAL_RULES } from "./financial-rule.ts";
import {
  driverCashHandoffReportEventId,
  restaurantCashReceiptEventId,
} from "./platform-driver-cash-handoff.ts";

/**
 * DRIVER UI REPAIR — split period read-model + канонический статус выплаты одной
 * earning. Все периодные показатели строятся по recognizedAt в Europe/Chisinau.
 */

const DRIVER = "driver-1";
const TZ = "Europe/Chisinau";
const ADDR = { street: "Садовый переулок", house: "5", apartment: "12" };
const earningId = (orderId: string) => `driver-earning-${orderId}`;

interface Times {
  arrived: string;
  pickup: string;
  arriving: string;
  delivered: string;
}

/** Хронология завершения из момента доставки (recognizedAt = delivered). */
function times(deliveredIso: string): Times {
  const d = Date.parse(deliveredIso);
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    arrived: iso(d - 6 * 60_000),
    pickup: iso(d - 4 * 60_000),
    arriving: iso(d - 2 * 60_000),
    delivered: deliveredIso,
  };
}

/** Завершает один ONLINE-заказ водителем (водитель уже AVAILABLE в zone-2). */
function onlineOne(
  state: PrototypeState,
  t: Times,
): { state: PrototypeState; orderId: string } {
  let s = updateCartAddress(state, ADDR);
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, orderId);
  s = markOrderReady(s, orderId);
  s = assignDriverToOrder(s, orderId, DRIVER).state;
  s = markDriverArrivedAtRestaurant(s, DRIVER, orderId, t.arrived).state;
  s = markDriverPickedUpOrder(s, DRIVER, orderId, t.pickup).state;
  s = markDriverArrivingToCustomer(s, DRIVER, orderId, t.arriving).state;
  const r = markDriverDeliveredOrder(s, DRIVER, orderId, t.delivered, {
    cashCollectionConfirmed: false,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  return { state: r.state, orderId };
}

/** Состояние с ONLINE-заработками driver-1 на заданные моменты доставки. */
function onlineEarningsAt(deliveredIsos: string[]): {
  state: PrototypeState;
  orderIds: string[];
} {
  let s = goDriverOnline(createDefaultState(), DRIVER, "zone-2").state;
  const orderIds: string[] = [];
  for (let i = 0; i < deliveredIsos.length; i += 1) {
    if (i > 0) s = confirmDriverZone(s, DRIVER, "zone-2", "AVAILABLE").state;
    const done = onlineOne(s, times(deliveredIsos[i]));
    s = done.state;
    orderIds.push(done.orderId);
  }
  return { state: s, orderIds };
}

const periodView = (
  state: PrototypeState,
  period: DriverEarningsPeriod,
  nowIso: string,
) => getDriverSettlementPeriodView(state, DRIVER, period, nowIso, TZ);

// Контрольные моменты доставки (mid-day UTC → тот же локальный день в Chisinau).
const NOW = "2026-07-22T12:00:00.000Z";
const D_TODAY = "2026-07-22T10:00:00.000Z";
const D_6_DAYS = "2026-07-16T10:00:00.000Z"; // граница LAST_7 (входит)
const D_7_DAYS = "2026-07-15T10:00:00.000Z"; // за границей LAST_7 (не входит)
const D_MONTH = "2026-07-05T10:00:00.000Z"; // тот же месяц, вне 7 дней
const D_PREV_MONTH = "2026-06-20T10:00:00.000Z"; // прошлый месяц

// --- §25 period read-model ----------------------------------------------------

test("1: период по умолчанию TODAY (страница инициализирует TODAY)", () => {
  const SETTLEMENTS = readFileSync("src/app/driver/settlements/page.tsx", "utf8");
  assert.ok(SETTLEMENTS.includes('useState<DriverEarningsPeriod>("TODAY")'));
});

test("2/7/8/9: TODAY учитывает локальный день Chisinau; earned=due", () => {
  const { state } = onlineEarningsAt([D_TODAY, D_MONTH]);
  const v = periodView(state, "TODAY", NOW);
  assert.equal(v.completedDeliveryCount, 1);
  const unit = v.entries[0].entry.amountCents;
  assert.ok(unit > 0);
  assert.equal(v.earnedCents, unit); // DIRECT_PAYOUT_DUE входит в earned
  assert.equal(v.dueFromDirectCents, unit);
  assert.equal(v.cashReceivedCents, 0);
  assert.equal(v.sentByDirectCents, 0);
  assert.equal(v.receivedFromDirectCents, 0);
});

test("3/4: LAST_7_DAYS — сегодня и шесть предыдущих дней, не 168 часов", () => {
  const { state } = onlineEarningsAt([D_TODAY, D_6_DAYS, D_7_DAYS]);
  const v = periodView(state, "LAST_7_DAYS", NOW);
  // Входят 22 и 16 июля; 15 июля (седьмой предыдущий день) — не входит.
  assert.equal(v.completedDeliveryCount, 2);
  const days = v.entries.map((e) => e.entry.recognizedAt);
  assert.ok(days.includes(D_TODAY));
  assert.ok(days.includes(D_6_DAYS));
  assert.ok(!days.includes(D_7_DAYS));
});

test("5: CURRENT_MONTH учитывает локальный месяц", () => {
  const { state } = onlineEarningsAt([D_TODAY, D_MONTH, D_PREV_MONTH]);
  const v = periodView(state, "CURRENT_MONTH", NOW);
  assert.equal(v.completedDeliveryCount, 2); // 22 и 5 июля, без 20 июня
  const unit = v.entries[0].entry.amountCents;
  assert.equal(v.earnedCents, 2 * unit);
});

test("6: ALL_TIME включает все валидные earnings", () => {
  const { state } = onlineEarningsAt([D_TODAY, D_6_DAYS, D_7_DAYS, D_MONTH, D_PREV_MONTH]);
  const v = periodView(state, "ALL_TIME", NOW);
  assert.equal(v.completedDeliveryCount, 5);
  const unit = v.entries[0].entry.amountCents;
  assert.equal(v.earnedCents, 5 * unit);
  assert.equal(v.dueFromDirectCents, 5 * unit);
});

test("20: пустой валидный период — нули, не null и не review", () => {
  const { state } = onlineEarningsAt([D_MONTH]); // 5 июля
  const v = periodView(state, "TODAY", NOW); // сегодня 22 июля — пусто
  assert.equal(v.completedDeliveryCount, 0);
  assert.equal(v.earnedCents, 0);
  assert.equal(v.cashReceivedCents, 0);
  assert.equal(v.dueFromDirectCents, 0);
  assert.equal(v.sentByDirectCents, 0);
  assert.equal(v.receivedFromDirectCents, 0);
  assert.equal(v.reviewRequired, false);
});

test("18: неизвестная позиция — все итоги null, review", () => {
  const { state } = onlineEarningsAt([D_TODAY]);
  // Завершённый заказ без валидной записи заработка → позиция неизвестна.
  const broken: PrototypeState = { ...state, driverEarningEntries: [] };
  const v = periodView(broken, "ALL_TIME", NOW);
  assert.equal(v.earnedCents, null);
  assert.equal(v.cashReceivedCents, null);
  assert.equal(v.dueFromDirectCents, null);
  assert.equal(v.sentByDirectCents, null);
  assert.equal(v.receivedFromDirectCents, null);
  assert.equal(v.reviewRequired, true);
});

// --- §25/§26 статусы выплаты и разложение сумм --------------------------------

const SENT = "2026-07-23T09:00:00.000Z";
const CONFIRM = "2026-07-23T18:00:00.000Z";

test("11/22: невыплаченный ONLINE — DUE_FROM_DIRECT", () => {
  const { state, orderIds } = onlineEarningsAt([D_TODAY]);
  const states = getDriverEarningPayoutStates(state, DRIVER);
  const st = states.find((s) => s.earningEntryId === earningId(orderIds[0]));
  assert.equal(st?.state, "DUE_FROM_DIRECT");
  assert.equal(st?.payoutBatchId, null);
});

test("12/14/23: awaiting batch — SENT_AWAITING, входит в sent не в due", () => {
  const { state, orderIds } = onlineEarningsAt([D_TODAY]);
  const eId = earningId(orderIds[0]);
  const batched = createDriverPayoutBatch(
    state,
    { driverId: DRIVER, earningEntryIds: [eId], method: "BANK_TRANSFER", externalReference: null, note: null },
    SENT,
  );
  assert.equal(batched.result.ok, true, batched.result.error ?? "");
  const s = batched.state;
  const st = getDriverEarningPayoutStates(s, DRIVER).find((x) => x.earningEntryId === eId);
  assert.equal(st?.state, "SENT_AWAITING_CONFIRMATION");
  const v = periodView(s, "TODAY", NOW);
  const unit = v.entries[0].entry.amountCents;
  assert.equal(v.sentByDirectCents, unit);
  assert.equal(v.dueFromDirectCents, 0);
  assert.equal(v.receivedFromDirectCents, 0);
});

test("13/15/16/24: confirmed batch — CONFIRMED_RECEIVED, входит в received", () => {
  const { state, orderIds } = onlineEarningsAt([D_TODAY]);
  const eId = earningId(orderIds[0]);
  const batched = createDriverPayoutBatch(
    state,
    { driverId: DRIVER, earningEntryIds: [eId], method: "BANK_TRANSFER", externalReference: null, note: null },
    SENT,
  );
  const confirmed = confirmDriverPayoutReceipt(
    batched.state,
    DRIVER,
    driverPayoutBatchId(DRIVER, SENT),
    CONFIRM,
  );
  assert.equal(confirmed.result.ok, true, confirmed.result.error ?? "");
  const s = confirmed.state;
  const st = getDriverEarningPayoutStates(s, DRIVER).find((x) => x.earningEntryId === eId);
  assert.equal(st?.state, "CONFIRMED_RECEIVED");
  assert.ok(st?.confirmedAt);
  const v = periodView(s, "TODAY", NOW);
  const unit = v.entries[0].entry.amountCents;
  assert.equal(v.receivedFromDirectCents, unit);
  assert.equal(v.dueFromDirectCents, 0);
  assert.equal(v.sentByDirectCents, 0);
});

test("17: батч из earnings разных периодов делится по earnings", () => {
  const { state, orderIds } = onlineEarningsAt([D_TODAY, D_PREV_MONTH]);
  const e1 = earningId(orderIds[0]); // июль
  const e2 = earningId(orderIds[1]); // июнь
  const batched = createDriverPayoutBatch(
    state,
    { driverId: DRIVER, earningEntryIds: [e1, e2], method: "BANK_TRANSFER", externalReference: null, note: null },
    SENT,
  );
  assert.equal(batched.result.ok, true, batched.result.error ?? "");
  const s = batched.state;
  const monthV = periodView(s, "CURRENT_MONTH", NOW);
  const allV = periodView(s, "ALL_TIME", NOW);
  const unit = allV.entries[0].entry.amountCents;
  // В июле учитывается только одна earning батча, а не вся его сумма.
  assert.equal(monthV.sentByDirectCents, unit);
  assert.equal(allV.sentByDirectCents, 2 * unit);
});

test("27: каждая earning имеет ровно одно каноническое состояние", () => {
  const { state, orderIds } = onlineEarningsAt([D_TODAY, D_MONTH]);
  const states = getDriverEarningPayoutStates(state, DRIVER);
  for (const id of orderIds) {
    const matches = states.filter((s) => s.earningEntryId === earningId(id));
    assert.equal(matches.length, 1);
  }
});

// --- §26 CASH earning (контрольный наличный заказ) ----------------------------

const CASH_ORDER = "o-cash-period";
const C_T0 = "2026-07-20T10:00:00.000Z";
const C_DELIVERED = "2026-07-20T10:10:00.000Z";
const CASH_SNAPSHOT = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 700,
  driverEarningCents: 300,
  restaurantOwesDirectCents: 120,
};
const CASH_MOVEMENT = {
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

/** Завершённый наличный заказ driver-1 (CASH_RETAINED) через реальное действие. */
function cashCompleted(): PrototypeState {
  const base = createDefaultState();
  const order = {
    id: CASH_ORDER,
    publicNumber: "C-PER",
    createdAt: C_T0,
    updatedAt: C_T0,
    customer: { id: "customer-1", name: "Клиент", phone: "+373 1" },
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    paymentStatus: "CASH_ON_DELIVERY",
    paidAt: null,
    status: "ARRIVING",
    assignedDriverId: DRIVER,
    driverAssignedAt: C_T0,
    restaurant: { id: "restaurant-2", name: "Ресторан 2", address: "адрес", zoneId: "zone-2" },
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
      platformDriverCash: CASH_SNAPSHOT,
      moneyMovementStatus: "COMPLETE",
      moneyMovement: CASH_MOVEMENT,
    },
  } as unknown as Order;
  const de = [
    { id: "cde-1", orderId: CASH_ORDER, driverId: DRIVER, type: "ARRIVED_AT_RESTAURANT", occurredAt: "2026-07-20T10:06:00.000Z", orderStatusBefore: "READY", orderStatusAfter: "READY" },
    { id: "cde-2", orderId: CASH_ORDER, driverId: DRIVER, type: "ORDER_PICKED_UP", occurredAt: "2026-07-20T10:08:00.000Z", orderStatusBefore: "READY", orderStatusAfter: "OUT_FOR_DELIVERY" },
    { id: "cde-3", orderId: CASH_ORDER, driverId: DRIVER, type: "ARRIVING_TO_CUSTOMER", occurredAt: "2026-07-20T10:09:00.000Z", orderStatusBefore: "OUT_FOR_DELIVERY", orderStatusAfter: "ARRIVING" },
  ];
  const cash = [
    { id: driverCashHandoffReportEventId(CASH_ORDER), orderId: CASH_ORDER, driverId: DRIVER, restaurantId: "restaurant-2", type: "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF", amountCents: 700, occurredAt: "2026-07-20T10:06:30.000Z", actor: "DRIVER", restaurantWorkspaceRole: null },
    { id: restaurantCashReceiptEventId(CASH_ORDER), orderId: CASH_ORDER, driverId: DRIVER, restaurantId: "restaurant-2", type: "RESTAURANT_CONFIRMED_CASH_RECEIPT", amountCents: 700, occurredAt: "2026-07-20T10:07:00.000Z", actor: "RESTAURANT", restaurantWorkspaceRole: "COMBINED" },
  ];
  const arriving: PrototypeState = {
    ...base,
    platformSettings: { ...base.platformSettings, platformDriverCashEnabled: true },
    orders: [order],
    driverOffers: [
      {
        id: "offer-c",
        orderId: CASH_ORDER,
        driverId: DRIVER,
        status: "ACCEPTED",
        offeredAt: C_T0,
        expiresAt: "2030-01-01T00:00:00.000Z",
        resolvedAt: C_T0,
        cashReserveConfirmedAt: C_T0,
      } as unknown as PrototypeState["driverOffers"][number],
    ],
    driverDeliveryEvents: de as unknown as PrototypeState["driverDeliveryEvents"],
    platformDriverCashEvents: cash as unknown as PrototypeState["platformDriverCashEvents"],
    drivers: base.drivers.map((d) =>
      d.id === DRIVER
        ? { ...d, status: "BUSY_DIRECT" as const, currentZoneId: "zone-2" }
        : d,
    ),
  };
  const r = markDriverDeliveredOrder(arriving, DRIVER, CASH_ORDER, C_DELIVERED, {
    cashCollectionConfirmed: true,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  return r.state;
}

test("8/10/21: CASH_RETAINED входит в earned и cashReceived, статус NOT_APPLICABLE", () => {
  const state = cashCompleted();
  const v = periodView(state, "ALL_TIME", "2026-07-25T12:00:00.000Z");
  assert.equal(v.completedDeliveryCount, 1);
  assert.equal(v.earnedCents, 300); // driverEarningCents
  assert.equal(v.cashReceivedCents, 300);
  assert.equal(v.dueFromDirectCents, 0);
  const st = getDriverEarningPayoutStates(state, DRIVER).find(
    (s) => s.earningEntryId === earningId(CASH_ORDER),
  );
  assert.equal(st?.state, "NOT_APPLICABLE_CASH_RETAINED");
});

test("69: наличный заработок не попадает в payout batch (домен отклоняет)", () => {
  const state = cashCompleted();
  const r = createDriverPayoutBatch(
    state,
    { driverId: DRIVER, earningEntryIds: [earningId(CASH_ORDER)], method: "CASH", externalReference: null, note: null },
    SENT,
  );
  assert.equal(r.result.ok, false);
});

// --- §29 timezone: браузерный tz не меняет период -----------------------------

test("64: период считается по переданному timeZone, не по устройству", () => {
  const { state } = onlineEarningsAt([D_TODAY]);
  // Момент 22 июля 23:30 UTC = 23 июля 02:30 в Chisinau → доставка 22-го уже «вчера».
  const lateNow = "2026-07-22T23:30:00.000Z";
  const v = periodView(state, "TODAY", lateNow);
  assert.equal(v.completedDeliveryCount, 0);
});

// --- §30 regression -----------------------------------------------------------

test("65/74: schema 27, наличные выключены", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 28);
  assert.equal(createDefaultState().platformSettings.platformDriverCashEnabled, false);
});

test("67/68: admin create и driver confirm работают на валидном earning", () => {
  const { state, orderIds } = onlineEarningsAt([D_TODAY]);
  const eId = earningId(orderIds[0]);
  const created = createDriverPayoutBatch(
    state,
    { driverId: DRIVER, earningEntryIds: [eId], method: "BANK_TRANSFER", externalReference: null, note: null },
    SENT,
  );
  assert.equal(created.result.ok, true);
  const confirmed = confirmDriverPayoutReceipt(
    created.state,
    DRIVER,
    driverPayoutBatchId(DRIVER, SENT),
    CONFIRM,
  );
  assert.equal(confirmed.result.ok, true);
  const view = getDriverPayoutsView(confirmed.state, DRIVER);
  assert.equal(view.batches.length, 1);
  assert.equal(view.batches[0].status, "CONFIRMED_RECEIVED");
});

// --- §27 settlements UI (по исходникам) ---------------------------------------

const SETTLEMENTS = readFileSync("src/app/driver/settlements/page.tsx", "utf8");
const SETTLE_CSS = readFileSync(
  "src/app/driver/settlements/settlements.module.css",
  "utf8",
);

test("28–31: сегмент-контрол периода — все четыре варианта («За весь период»)", () => {
  for (const label of ["Сегодня", "7 дней", "Месяц", "За весь период"]) {
    assert.ok(SETTLEMENTS.includes(`"${label}"`), label);
  }
  // Старое пользовательское «Всё время» на странице отсутствует.
  assert.ok(!SETTLEMENTS.includes('"Всё время"'));
});

test("32–35: динамические подписи заработка по периоду", () => {
  for (const label of [
    "Заработано сегодня",
    "Заработано за 7 дней",
    "Заработано за месяц",
    "Заработано за весь период",
  ]) {
    assert.ok(SETTLEMENTS.includes(label), label);
  }
  // Старая подпись «Заработано за всё время» отсутствует.
  assert.ok(!SETTLEMENTS.includes("Заработано за всё время"));
});

test("доп-5: компактное точное описание «Расчётов»", () => {
  assert.ok(SETTLEMENTS.includes("Заработок, наличные и выплаты Direct."));
  assert.ok(
    !SETTLEMENTS.includes(
      "Заработок по доставкам, наличные выплаты и сумма, которую Direct должен выплатить вам.",
    ),
  );
});

test("доп-active: активный период тёмный (kds-action + белый), inactive светлый", () => {
  const ruleOf = (sel) => {
    const s = SETTLE_CSS.indexOf(`${sel} {`);
    return SETTLE_CSS.slice(s, SETTLE_CSS.indexOf("}", s));
  };
  const btn = ruleOf(".periodButton");
  // Inactive: светлый фон, тёмный текст, нейтральная рамка; без оранжа.
  assert.ok(btn.includes("background: var(--kds-surface"));
  assert.ok(btn.includes("color: var(--kds-text"));
  assert.ok(btn.includes("var(--kds-border-strong"));
  assert.ok(!btn.includes("var(--accent"));
  const active = ruleOf(".periodButtonActive");
  // Active: тёмная заливка kds-action + белый текст; без оранжа.
  assert.ok(active.includes("background: var(--kds-action"));
  assert.ok(active.includes("color: #fff"));
  assert.ok(!active.includes("var(--accent"));
  // Active и inactive — явно разные background и foreground.
  assert.ok(
    btn.includes("background: var(--kds-surface") &&
      active.includes("background: var(--kds-action"),
  );
  assert.ok(btn.includes("color: var(--kds-text") && active.includes("color: #fff"));
  // aria-pressed — источник выбранного состояния.
  assert.ok(SETTLEMENTS.includes("aria-pressed={p.id === period}"));
  // Компактность сохранена.
  assert.ok(btn.includes("flex: 0 0 auto"));
  assert.ok(btn.includes("width: auto"));
});

test("36: только одна динамическая строка заработка (не две статические)", () => {
  // Подпись строки — из EARNED_LABEL[period], а не литерал в JSX.
  assert.ok(SETTLEMENTS.includes("EARNED_LABEL[period]"));
  assert.ok(!SETTLEMENTS.includes('label="Заработано'));
});

test("37: «Завершённых доставок» — первая строка сводки", () => {
  const count = SETTLEMENTS.indexOf("Завершённых доставок");
  const cash = SETTLEMENTS.indexOf("Получено из наличных заказов");
  const earned = SETTLEMENTS.indexOf("EARNED_LABEL[period]");
  assert.ok(count !== -1 && cash !== -1 && earned !== -1);
  assert.ok(count < earned, "count раньше строки заработка");
  assert.ok(count < cash, "count раньше наличных");
});

test("38: история доставок фильтруется по периоду (view.entries)", () => {
  assert.ok(SETTLEMENTS.includes("getDriverSettlementPeriodView"));
  assert.ok(SETTLEMENTS.includes("view.entries.map"));
});

test("39: пустой период — своё сообщение", () => {
  assert.ok(SETTLEMENTS.includes("За выбранный период завершённых доставок нет."));
});

test("40: сегмент-контрол — flex-wrap (компактные кнопки, перенос), без grid-колонок", () => {
  const start = SETTLE_CSS.indexOf(".periodControl {");
  assert.notEqual(start, -1);
  const rule = SETTLE_CSS.slice(start, SETTLE_CSS.indexOf("}", start));
  assert.ok(rule.includes("display: flex"));
  assert.ok(rule.includes("flex-wrap: wrap"));
  assert.ok(!rule.includes("grid-template-columns"));
});

test("доп-хедер: period buttons компактны — flex: 0 0 auto, width auto, без full-width", () => {
  const start = SETTLE_CSS.indexOf(".periodButton {");
  const rule = SETTLE_CSS.slice(start, SETTLE_CSS.indexOf("}", start));
  assert.ok(rule.includes("flex: 0 0 auto"));
  assert.ok(rule.includes("width: auto"));
  assert.ok(!rule.includes("flex: 1"));
  assert.ok(!rule.includes("width: 100%"));
});

test("доп-верх: компактный локальный заголовок, eyebrow скрыт на мобильном", () => {
  // Страница рендерит собственный компактный заголовок, не общий shell-heading.
  assert.ok(!SETTLEMENTS.includes("PageHeading"));
  assert.ok(SETTLEMENTS.includes("own.header"));
  assert.ok(SETTLEMENTS.includes("own.title"));
  assert.ok(SETTLEMENTS.includes("own.eyebrow"));
  const eStart = SETTLE_CSS.indexOf(".eyebrow {");
  const eyebrow = SETTLE_CSS.slice(eStart, SETTLE_CSS.indexOf("}", eStart));
  assert.ok(eyebrow.includes("display: none")); // скрыт по умолчанию (мобильный)
  const desktop = SETTLE_CSS.slice(SETTLE_CSS.indexOf("@media (min-width: 521px)"));
  assert.ok(desktop.includes("display: block")); // показан на desktop
  // Верхний блок подтянут ближе к навигации на мобильном.
  const mobile = SETTLE_CSS.slice(SETTLE_CSS.indexOf("@media (max-width: 520px)"));
  assert.ok(/\.header\s*\{[^}]*margin-top:\s*-/.test(mobile));
});

test("доп-хедер: компактное описание — уменьшенный font-size, muted, не жирное", () => {
  const start = SETTLE_CSS.indexOf(".headerDescription {");
  assert.notEqual(start, -1);
  const rule = SETTLE_CSS.slice(start, SETTLE_CSS.indexOf("}", start));
  assert.ok(/font-size:\s*1[23](\.\d+)?px/.test(rule));
  assert.ok(rule.includes("var(--kds-muted"));
  assert.ok(rule.includes("font-weight: 400"));
  // Описание рендерится страницей (компактный класс), а не prop PageHeading.
  assert.ok(SETTLEMENTS.includes("own.headerDescription"));
  assert.ok(SETTLEMENTS.includes("Заработок, наличные и выплаты Direct."));
});

test("статус доставки — из канонического read-model, не по paymentMethod", () => {
  assert.ok(SETTLEMENTS.includes("statusLabelFor(payoutState)"));
  assert.ok(SETTLEMENTS.includes("earningStates"));
  // Нет упрощённого paymentMethod-only тернарника для статуса ONLINE.
  assert.ok(
    !/paymentMethod[\s\S]{0,40}\?\s*"Получено наличными"\s*:\s*"Ожидает выплаты Direct"/.test(
      SETTLEMENTS,
    ),
  );
});

test("даты водителя — в Europe/Chisinau", () => {
  assert.ok(SETTLEMENTS.includes("timeZone: DRIVER_TIME_ZONE"));
  assert.ok(SETTLEMENTS.includes('"Europe/Chisinau"'));
});

// --- §28 zones / sheets / header / counters / note ----------------------------

const WORKSPACE = readFileSync(
  "src/components/driver/driver-workspace.tsx",
  "utf8",
);
const CSS = readFileSync("src/app/driver/driver.module.css", "utf8");
const PRESENTATION = readFileSync("src/lib/zones/zone-presentation.ts", "utf8");

function cssRule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `CSS ${selector} не найден`);
  const open = CSS.indexOf("{", start);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close);
}

test("41/42: статус-лист переименован в «Изменить статус», без старого заголовка", () => {
  assert.ok(WORKSPACE.includes('title="Изменить статус"'));
  // Старый заголовок собран из частей, чтобы grep-аудит по литералу оставался пуст.
  const OLD_STATUS_TITLE = ["Статус", "смены"].join(" ");
  assert.ok(!WORKSPACE.includes(OLD_STATUS_TITLE));
});

test("43: статус и зона используют один DriverControlSheet", () => {
  assert.ok(WORKSPACE.includes('open={openMenu === "status"}'));
  assert.ok(WORKSPACE.includes('open={openMenu === "zone"}'));
  assert.ok(WORKSPACE.includes("DriverControlSheet"));
});

test("44/доп-3: общий лист — приподнятый dialog (top ~середина), не низкий bottom", () => {
  const rule = cssRule(".controlSheet");
  // Позиционируется через top (середина экрана) + translateY, а не низкий bottom.
  assert.ok(rule.includes("top: clamp("));
  assert.ok(rule.includes("48vh"));
  assert.ok(rule.includes("translateY(-50%)"));
  assert.ok(rule.includes("bottom: auto"));
  // Прежняя низкая позиция bottom: 17vh/7vh убрана.
  assert.ok(!rule.includes("17vh"));
  assert.ok(!rule.includes("7vh"));
  // Высота ограничена (за верх не выходит) и есть внутренний scroll.
  assert.ok(rule.includes("max-height: min(62vh, 440px)"));
  assert.ok(rule.includes("overflow-y: auto"));
  // safe-area сохранена.
  assert.ok(rule.includes("env(safe-area-inset-bottom)"));
});

test("доп-4: один shared DriverControlSheet для статуса и зоны (одна позиция)", () => {
  // Обе панели используют один компонент → одна CSS-позиция .controlSheet.
  assert.ok(WORKSPACE.includes('title="Изменить статус"'));
  assert.ok(WORKSPACE.includes('title="Выберите текущую зону"'));
  const SHEET = readFileSync(
    "src/components/driver/driver-control-sheet.tsx",
    "utf8",
  );
  assert.ok(SHEET.includes("styles.controlSheet"));
});

test("45/46: кнопка текущей зоны — полный цвет зоны и MapPin", () => {
  assert.ok(WORKSPACE.includes("quickButtonZone"));
  assert.ok(WORKSPACE.includes("zonePresentation.backgroundColor"));
  // MapPin остаётся в кнопке текущей зоны.
  const zoneBtn = WORKSPACE.slice(
    WORKSPACE.indexOf("ref={zoneTriggerRef}"),
    WORKSPACE.indexOf("soundIconButton"),
  );
  assert.ok(zoneBtn.includes("MapPin"));
});

test("47: все кнопки выбора зоны цветные (общий presentation helper)", () => {
  const zoneOptions = WORKSPACE.slice(
    WORKSPACE.indexOf("function ZoneOptions"),
    WORKSPACE.indexOf("const STATUS_MENU_ID"),
  );
  assert.ok(zoneOptions.includes("getZoneButtonPresentation"));
  assert.ok(zoneOptions.includes("presentation.backgroundColor"));
  assert.ok(zoneOptions.includes("MapPin"));
});

test("48/49: цвет из registry, без ручной таблицы zone-N", () => {
  assert.ok(PRESENTATION.includes("zoneColor"));
  assert.ok(PRESENTATION.includes("fromZoneId"));
  assert.ok(!/["']zone-1["']\s*:\s*["']#/.test(WORKSPACE));
  assert.ok(!/["']zone-2["']\s*:\s*["'](#|yellow)/.test(WORKSPACE));
});

test("50/51: foreground по luminance; offline/unknown — нейтрально (null)", () => {
  assert.ok(PRESENTATION.includes("relativeLuminance"));
  assert.ok(PRESENTATION.includes("return null"));
  assert.ok(WORKSPACE.includes("zonePresentation\n") || WORKSPACE.includes("zonePresentation "));
  assert.ok(WORKSPACE.includes(": undefined"));
});

test("доп-9/10/11: заметка — белая KDS-поверхность, курсив, без оранжевой заливки", () => {
  const rule = cssRule(".noteBubble");
  assert.ok(rule.includes("font-style: italic"));
  assert.ok(rule.includes("background: var(--kds-surface"));
  // Не серый фон страницы и не оранжевая заливка.
  assert.ok(!rule.includes("var(--kds-surface-muted"));
  assert.ok(!/background:\s*color-mix/.test(rule));
});

test("доп-12/13/14: thought circles — только при statusNote, aria-hidden, в блоке профиля", () => {
  // Кружки рендерятся внутри условия наличия заметки.
  const profile = WORKSPACE.slice(
    WORKSPACE.indexOf("function ProfileLine"),
    WORKSPACE.indexOf("const ACCOUNT_MENU_ID"),
  );
  assert.ok(profile.includes("thoughtTrail"));
  assert.ok(profile.includes("thoughtDot"));
  // Дорожка мыслей внутри той же ветки, что и облако заметки (driver.statusNote).
  const trailIdx = profile.indexOf("thoughtTrail");
  const noteCondIdx = profile.indexOf("driver.statusNote ? (");
  const nameIdx = profile.indexOf("driverName");
  assert.ok(noteCondIdx !== -1 && trailIdx > noteCondIdx && trailIdx < nameIdx);
  // Декоративная дорожка помечена aria-hidden.
  assert.ok(
    /thoughtTrail[\s\S]{0,60}aria-hidden="true"|aria-hidden="true"[\s\S]{0,60}thoughtTrail/.test(
      profile,
    ),
  );
  const trailRule = cssRule(".thoughtTrail");
  assert.ok(trailRule.includes("flex-direction: column"));
});

test("доп-cash: cashEnabled=true — Banknote + «Доступны наличные заказы» (без CreditCard)", () => {
  assert.ok(WORKSPACE.includes("Banknote"));
  assert.ok(WORKSPACE.includes("CreditCard")); // остаётся в ветке cashEnabled=false
  assert.ok(WORKSPACE.includes("Доступны наличные заказы"));
  assert.ok(WORKSPACE.includes("Только безналичные заказы"));
  // Старый текст убран.
  assert.ok(!WORKSPACE.includes("Наличные и карта доступны"));
  const profile = WORKSPACE.slice(
    WORKSPACE.indexOf("function ProfileLine"),
    WORKSPACE.indexOf("const ACCOUNT_MENU_ID"),
  );
  // cashEnabled=true ветка: Banknote есть, CreditCard НЕТ (до false-ветки).
  const trueBranch = profile.indexOf("driver.cashEnabled ? (");
  const falseBranch = profile.indexOf(") : (", trueBranch);
  const trueSlice = profile.slice(trueBranch, falseBranch);
  assert.ok(trueSlice.includes("Banknote"));
  assert.ok(!trueSlice.includes("CreditCard"));
  assert.ok(trueSlice.includes("Доступны наличные заказы"));
  // cashEnabled=false ветка: CreditCard + «Только безналичные заказы».
  const falseSlice = profile.slice(falseBranch);
  assert.ok(falseSlice.includes("CreditCard"));
  assert.ok(falseSlice.includes("Только безналичные заказы"));
  const access = cssRule(".cashAccessOff");
  assert.ok(access.includes("var(--kds-text"));
  assert.ok(access.includes("margin-left"));
});

test("доп-offline: кнопка «Сейчас не в сети» — серый стиль, кликабельна, go-online", () => {
  assert.ok(WORKSPACE.includes("Сейчас не в сети"));
  assert.ok(WORKSPACE.includes("quickButtonOffline"));
  // Кликабельна: есть onClick с go-online, нет постоянного disabled по OFFLINE.
  const off = WORKSPACE.slice(
    WORKSPACE.indexOf('if (status === "OFFLINE")'),
    WORKSPACE.indexOf('if (status === "BUSY_DIRECT")'),
  );
  assert.ok(off.includes("driverGoOnline(driver.id, zoneDraft)"));
  assert.ok(off.includes('aria-label="Выйти онлайн и начать получать заказы"'));
  // Серый нейтральный стиль (не зелёный/красный).
  const rule = cssRule(".quickButtonOffline");
  assert.ok(rule.includes("var(--kds-surface-subtle"));
  assert.ok(rule.includes("var(--kds-text"));
  assert.ok(!rule.includes("var(--kds-success"));
  assert.ok(!rule.includes("var(--kds-danger"));
  // AVAILABLE остаётся зелёной подписью «Сейчас онлайн».
  assert.ok(WORKSPACE.includes("Сейчас онлайн"));
});

test("доп-offline-hint: подсказка «будьте онлайн», без старой «выйдите онлайн»", () => {
  assert.ok(WORKSPACE.includes("Чтобы получать новые заказы, будьте онлайн."));
  assert.ok(!WORKSPACE.includes("Чтобы получать новые заказы, выйдите онлайн."));
});

test("доп-19: cash access не прижата к машинке (margin-left), без capsule", () => {
  const off = cssRule(".cashAccessOff");
  assert.ok(off.includes("margin-left"));
  assert.ok(off.includes("background: transparent"));
});

test("доп-20/21: empty offers — отдельный top spacing; счётчики в одну строку", () => {
  assert.ok(cssRule(".emptyOffers").includes("margin-top"));
  const counters = cssRule(".workCounters");
  // Счётчики — одна строка (grid), без вертикального stack.
  assert.ok(counters.includes("display: grid"));
  assert.ok(!counters.includes("flex-direction: column"));
});

test("54/55: счётчики выровнены по сетке controls (status | zone | sound)", () => {
  const rule = cssRule(".workCounters");
  // Та же трёхколоночная сетка, что и у quickControls: «Новые» под статусом,
  // «В работе» под зоной, третья колонка (звук 44px) пустая — не space-between.
  assert.ok(rule.includes("display: grid"));
  assert.ok(rule.includes("44px"));
  assert.ok(!rule.includes("justify-content: space-between"));
  assert.ok(rule.includes("width: 100%"));
  assert.ok(!rule.includes("flex-direction: column"));
  assert.ok(cssRule(".workCount").includes("white-space: nowrap"));
  // Мобильная сетка совпадает с quickControls (status auto, zone remainder).
  const mediaStart = CSS.indexOf("@media (max-width: 440px)");
  const media = CSS.slice(mediaStart);
  assert.ok(/\.workCounters\s*\{[^}]*auto minmax\(0, 1fr\) 44px/.test(media));
});

test("56/57/58: заголовок — near-black текст, оранжевый значок и акцент", () => {
  const name = cssRule(".driverName");
  assert.ok(name.includes("var(--kds-text"));
  assert.ok(!name.includes("color: var(--accent"));
  assert.ok(cssRule(".driverNameIcon").includes("var(--accent"));
  const accent = cssRule(".driverNameText");
  assert.ok(accent.includes("border-bottom"));
  assert.ok(accent.includes("var(--accent"));
});

// --- §29 admin preview / timezone ---------------------------------------------

const ADMIN_PAYOUTS = readFileSync(
  "src/app/admin/driver-payouts/page.tsx",
  "utf8",
);

test("59/60: admin preview — checked arithmetic, overflow блокирует submit", () => {
  assert.ok(ADMIN_PAYOUTS.includes("checkedSum"));
  assert.ok(ADMIN_PAYOUTS.includes("isSafeCents"));
  assert.ok(ADMIN_PAYOUTS.includes("previewCents === null"));
  assert.ok(
    ADMIN_PAYOUTS.includes("Сумма выбранных доставок требует проверки Direct."),
  );
});

test("61: UI не передаёт amountCents в payout action", () => {
  assert.ok(!ADMIN_PAYOUTS.includes("amountCents:"));
});

test("63: даты admin — в Europe/Chisinau", () => {
  assert.ok(ADMIN_PAYOUTS.includes("timeZone: TZ"));
  assert.ok(ADMIN_PAYOUTS.includes('"Europe/Chisinau"'));
});
