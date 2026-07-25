import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { parseStoredState } from "./prototype-store.ts";
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
  getDriverPayoutsView,
  getAdminDriverPayoutsView,
  driverPayoutBatchId,
  driverPayoutReceiptEventId,
} from "./driver-payouts.ts";
import { getDriverEarningsView } from "./driver-earnings.ts";
import {
  driverCashHandoffReportEventId,
  restaurantCashReceiptEventId,
} from "./platform-driver-cash-handoff.ts";
import { customerCashCollectionEventId } from "./platform-driver-cash-collection.ts";
import { FINANCIAL_RULES } from "./financial-rule.ts";

/**
 * Driver payouts v1 (v26): строгий двусторонний расчёт Direct с водителем.
 * Batch — административная фиксация факта отправки/передачи; receipt —
 * подтверждение водителем фактического получения. Реального перевода нет.
 */

const DRIVER = "driver-1";
const OTHER = "driver-2";
const ADDR = { street: "Садовый переулок", house: "5", apartment: "12" };
const earningId = (orderId: string) => `driver-earning-${orderId}`;

const A = {
  arrived: "2026-07-22T10:02:00.000Z",
  pickup: "2026-07-22T10:04:00.000Z",
  arriving: "2026-07-22T10:05:00.000Z",
  delivered: "2026-07-22T10:06:00.000Z",
};
const B = {
  arrived: "2026-07-22T11:02:00.000Z",
  pickup: "2026-07-22T11:04:00.000Z",
  arriving: "2026-07-22T11:05:00.000Z",
  delivered: "2026-07-22T11:06:00.000Z",
};
const SENT = "2026-07-23T09:00:00.000Z";
const CONFIRM = "2026-07-23T18:00:00.000Z";

interface Times {
  arrived: string;
  pickup: string;
  arriving: string;
  delivered: string;
}

/** Завершает один ONLINE-заказ водителем driver-1 (driver-1 уже AVAILABLE в zone-2). */
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

/** Состояние с одним завершённым ONLINE DIRECT_PAYOUT_DUE заработком driver-1. */
function oneEarning(): { state: PrototypeState; orderId: string; eId: string } {
  const online = goDriverOnline(createDefaultState(), DRIVER, "zone-2").state;
  const { state, orderId } = onlineOne(online, A);
  return { state, orderId, eId: earningId(orderId) };
}

/** Состояние с двумя завершёнными ONLINE заработками driver-1. */
function twoEarnings(): {
  state: PrototypeState;
  order1: string;
  order2: string;
  e1: string;
  e2: string;
} {
  let s = goDriverOnline(createDefaultState(), DRIVER, "zone-2").state;
  const first = onlineOne(s, A);
  s = confirmDriverZone(first.state, DRIVER, "zone-2", "AVAILABLE").state;
  const second = onlineOne(s, B);
  return {
    state: second.state,
    order1: first.orderId,
    order2: second.orderId,
    e1: earningId(first.orderId),
    e2: earningId(second.orderId),
  };
}

const payoutInput = (
  earningEntryIds: string[],
  method: "BANK_TRANSFER" | "CASH" = "BANK_TRANSFER",
  extra: { externalReference?: string | null; note?: string | null } = {},
) => ({
  driverId: DRIVER,
  earningEntryIds,
  method,
  externalReference: extra.externalReference ?? null,
  note: extra.note ?? null,
});

const payoutAmount = (state: PrototypeState, ids: string[]): number =>
  ids.reduce(
    (sum, id) =>
      sum + (state.driverEarningEntries.find((e) => e.id === id)?.amountCents ?? 0),
    0,
  );

/** Завершённый наличный заказ (CASH_RETAINED) для регрессии. */
const CASH_ORDER = "o-cash-payout";
function cashCompleted(): PrototypeState {
  const T0 = "2026-07-22T09:00:00.000Z";
  const T2 = "2026-07-22T09:06:00.000Z";
  const T3 = "2026-07-22T09:07:00.000Z";
  const T4 = "2026-07-22T09:08:00.000Z";
  const T5 = "2026-07-22T09:09:00.000Z";
  const T6 = "2026-07-22T09:10:00.000Z";
  const base = createDefaultState();
  const order = {
    id: CASH_ORDER,
    publicNumber: "C-PAY",
    createdAt: T0,
    updatedAt: T0,
    customer: { id: "customer-1", name: "Клиент", phone: "+1" },
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    paymentStatus: "CASH_ON_DELIVERY",
    paidAt: null,
    status: "ARRIVING",
    assignedDriverId: DRIVER,
    driverAssignedAt: T0,
    restaurant: { id: "restaurant-2", name: "Р2", address: "а", zoneId: "zone-2" },
    address: { street: "ул", house: "1", apartment: "", entrance: "", floor: "", comment: "", zoneId: "zone-2" },
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
      platformDriverCash: {
        customerCollectionCents: 1000,
        restaurantHandoffCents: 700,
        driverEarningCents: 300,
        restaurantOwesDirectCents: 120,
      },
      moneyMovementStatus: "COMPLETE",
      moneyMovement: {
        customerMoneyRecipient: "RESTAURANT",
        paymentChannel: "CASH_TO_PLATFORM_DRIVER",
        totalBankFeeCents: 0,
        restaurantBankFeeCents: 0,
        directBankFeeCents: 0,
        restaurantOwesDirectCents: 120,
        directOwesRestaurantCents: 0,
        restaurantNetCents: 580,
        directNetRevenueCents: 120,
      },
    },
  } as unknown as Order;
  const de = [
    { id: "de-1", orderId: CASH_ORDER, driverId: DRIVER, type: "ARRIVED_AT_RESTAURANT", occurredAt: T2, orderStatusBefore: "READY", orderStatusAfter: "READY" },
    { id: "de-2", orderId: CASH_ORDER, driverId: DRIVER, type: "ORDER_PICKED_UP", occurredAt: T4, orderStatusBefore: "READY", orderStatusAfter: "OUT_FOR_DELIVERY" },
    { id: "de-3", orderId: CASH_ORDER, driverId: DRIVER, type: "ARRIVING_TO_CUSTOMER", occurredAt: T5, orderStatusBefore: "OUT_FOR_DELIVERY", orderStatusAfter: "ARRIVING" },
  ];
  const cash = [
    { id: driverCashHandoffReportEventId(CASH_ORDER), orderId: CASH_ORDER, driverId: DRIVER, restaurantId: "restaurant-2", type: "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF", amountCents: 700, occurredAt: T2, actor: "DRIVER", restaurantWorkspaceRole: null },
    { id: restaurantCashReceiptEventId(CASH_ORDER), orderId: CASH_ORDER, driverId: DRIVER, restaurantId: "restaurant-2", type: "RESTAURANT_CONFIRMED_CASH_RECEIPT", amountCents: 700, occurredAt: T3, actor: "RESTAURANT", restaurantWorkspaceRole: "COMBINED" },
  ];
  const arriving: PrototypeState = {
    ...base,
    platformSettings: { ...base.platformSettings, platformDriverCashEnabled: true },
    orders: [order],
    driverOffers: [
      { id: "offer-1", orderId: CASH_ORDER, driverId: DRIVER, status: "ACCEPTED", offeredAt: T0, expiresAt: "2030-01-01T00:00:00.000Z", resolvedAt: T0, cashReserveConfirmedAt: T0 } as unknown as PrototypeState["driverOffers"][number],
    ],
    driverDeliveryEvents: de as unknown as PrototypeState["driverDeliveryEvents"],
    platformDriverCashEvents: cash as unknown as PrototypeState["platformDriverCashEvents"],
    drivers: base.drivers.map((d) =>
      d.id === DRIVER ? { ...d, status: "BUSY_DIRECT" as const, currentZoneId: "zone-2" } : d,
    ),
  };
  void customerCashCollectionEventId;
  const r = markDriverDeliveredOrder(arriving, DRIVER, CASH_ORDER, T6, {
    cashCollectionConfirmed: true,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  return r.state;
}

// --- §28 модель / дефолты -----------------------------------------------------

test("1/2/3: схема 26, пустые payout-массивы по умолчанию", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 26);
  const d = createDefaultState();
  assert.deepEqual(d.driverPayoutBatches, []);
  assert.deepEqual(d.driverPayoutReceiptEvents, []);
});

test("4/58/59: schema25 мигрирует с пустыми payout-массивами (ничего не синтезируется)", () => {
  const { state } = oneEarning();
  const parsed = parseStoredState(JSON.stringify({ ...state, schemaVersion: 25 }));
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, 26);
  assert.deepEqual(parsed.driverPayoutBatches, []);
  assert.deepEqual(parsed.driverPayoutReceiptEvents, []);
  // Заработок остаётся невыплаченным DIRECT_PAYOUT_DUE.
  const view = getDriverEarningsView(parsed, DRIVER);
  assert.equal(view.dueFromDirectCents, state.driverEarningEntries[0].amountCents);
  assert.equal(view.sentByDirectCents, 0);
  assert.equal(view.receivedFromDirectCents, 0);
});

test("5/68: schema26 round-trip идемпотентен (batch + receipt)", () => {
  const { state, eId } = oneEarning();
  const created = createDriverPayoutBatch(state, payoutInput([eId]), SENT);
  assert.equal(created.result.ok, true, created.result.error ?? "");
  const confirmed = confirmDriverPayoutReceipt(created.state, DRIVER, created.result.payoutBatchId as string, CONFIRM);
  assert.equal(confirmed.result.ok, true);
  const once = parseStoredState(JSON.stringify(confirmed.state));
  assert.ok(once);
  const twice = parseStoredState(JSON.stringify(once));
  assert.ok(twice);
  assert.deepEqual(twice.driverPayoutBatches, once.driverPayoutBatches);
  assert.deepEqual(twice.driverPayoutReceiptEvents, once.driverPayoutReceiptEvents);
  assert.equal(once.driverPayoutBatches.length, 1);
  assert.equal(once.driverPayoutReceiptEvents.length, 1);
});

test("6/7: заработок не меняется после выплаты", () => {
  const { state, eId } = oneEarning();
  const before = JSON.stringify(state.driverEarningEntries);
  const created = createDriverPayoutBatch(state, payoutInput([eId]), SENT);
  assert.equal(created.result.ok, true);
  assert.equal(JSON.stringify(created.state.driverEarningEntries), before);
  const confirmed = confirmDriverPayoutReceipt(created.state, DRIVER, created.result.payoutBatchId as string, CONFIRM);
  assert.equal(JSON.stringify(confirmed.state.driverEarningEntries), before);
});

// --- §29 admin create ---------------------------------------------------------

test("8/12/27/28: один DIRECT_PAYOUT_DUE создаёт batch (BANK_TRANSFER), один bump, без receipt", () => {
  const { state, eId } = oneEarning();
  const r = createDriverPayoutBatch(state, payoutInput([eId], "BANK_TRANSFER"), SENT);
  assert.equal(r.result.ok, true, r.result.error ?? "");
  assert.equal(r.state.driverPayoutBatches.length, 1);
  const b = r.state.driverPayoutBatches[0];
  assert.equal(b.id, driverPayoutBatchId(DRIVER, SENT));
  assert.equal(b.method, "BANK_TRANSFER");
  assert.equal(b.driverId, DRIVER);
  assert.equal(b.createdBy, "ADMIN");
  assert.equal(b.sentAt, SENT);
  assert.equal(r.state.revision, state.revision + 1);
  assert.equal(r.state.driverPayoutReceiptEvents.length, 0);
});

test("9/10/11: несколько earnings одного водителя — один batch, ids отсортированы, amount = сумма", () => {
  const { state, e1, e2 } = twoEarnings();
  // Передаём в «обратном» порядке — batch обязан канонически отсортировать.
  const ids = [e1, e2].sort().reverse();
  const r = createDriverPayoutBatch(state, payoutInput(ids), SENT);
  assert.equal(r.result.ok, true, r.result.error ?? "");
  const b = r.state.driverPayoutBatches[0];
  assert.deepEqual(b.earningEntryIds, [e1, e2].sort());
  assert.equal(b.amountCents, payoutAmount(state, [e1, e2]));
});

test("13: CASH-выплата сохраняется", () => {
  const { state, eId } = oneEarning();
  const r = createDriverPayoutBatch(state, payoutInput([eId], "CASH"), SENT);
  assert.equal(r.result.ok, true, r.result.error ?? "");
  assert.equal(r.state.driverPayoutBatches[0].method, "CASH");
});

test("14/15: пустые externalReference/note → null; заполненные trimmed", () => {
  const { state, eId } = oneEarning();
  const empty = createDriverPayoutBatch(state, payoutInput([eId], "BANK_TRANSFER", { externalReference: "   ", note: "" }), SENT);
  assert.equal(empty.result.ok, true);
  assert.equal(empty.state.driverPayoutBatches[0].externalReference, null);
  assert.equal(empty.state.driverPayoutBatches[0].note, null);
  const filled = createDriverPayoutBatch(state, payoutInput([eId], "BANK_TRANSFER", { externalReference: "  TX-42 ", note: "  ok " }), SENT);
  assert.equal(filled.state.driverPayoutBatches[0].externalReference, "TX-42");
  assert.equal(filled.state.driverPayoutBatches[0].note, "ok");
});

test("16-24: невалидные входы — fail same-state", () => {
  const { state, eId } = oneEarning();
  const same = (r: { state: PrototypeState }) => assert.equal(r.state, state);
  same(createDriverPayoutBatch(state, payoutInput([eId]), "не-дата")); // 16 invalid nowIso
  same(createDriverPayoutBatch(state, payoutInput([]), SENT)); // 17 empty
  same(createDriverPayoutBatch(state, payoutInput([eId, eId]), SENT)); // 18 duplicate ids
  same(createDriverPayoutBatch(state, payoutInput(["driver-earning-missing"]), SENT)); // 19 unknown
  same(createDriverPayoutBatch(state, { ...payoutInput([eId]), method: "WIRE" as unknown as "CASH" }, SENT)); // method
  // 21 earning другого водителя
  const otherState = { ...state, driverEarningEntries: state.driverEarningEntries.map((e) => ({ ...e, driverId: OTHER })) };
  assert.equal(createDriverPayoutBatch(otherState, payoutInput([eId]), SENT).result.ok, false);
  assert.equal(createDriverPayoutBatch(state, payoutInput([]), SENT).result.error, "Не выбраны доставки для выплаты.");
});

test("20: CASH_RETAINED заработок → fail (не подлежит выплате)", () => {
  const state = cashCompleted();
  const cashEarning = state.driverEarningEntries.find((e) => e.mode === "CASH_RETAINED");
  assert.ok(cashEarning);
  const r = createDriverPayoutBatch(state, payoutInput([cashEarning.id]), SENT);
  assert.equal(r.result.ok, false);
  assert.equal(r.state, state);
});

test("24/25/26: повтор id батча / earning уже в batch → fail", () => {
  const { state, eId } = oneEarning();
  const first = createDriverPayoutBatch(state, payoutInput([eId]), SENT);
  assert.equal(first.result.ok, true);
  // 25: та же earning в новый batch (другое время) → already batched.
  const again = createDriverPayoutBatch(first.state, payoutInput([eId]), "2026-07-24T09:00:00.000Z");
  assert.equal(again.result.ok, false);
  assert.equal(again.result.error, "Одна из доставок уже включена в другую выплату.");
  // 24: повтор id (то же sentAt) с новой earning → fail.
  const dupId = createDriverPayoutBatch(first.state, payoutInput([eId]), SENT);
  assert.equal(dupId.result.ok, false);
});

// --- §30 driver confirmation --------------------------------------------------

function batched(method: "BANK_TRANSFER" | "CASH" = "BANK_TRANSFER"): {
  state: PrototypeState;
  batchId: string;
} {
  const { state, eId } = oneEarning();
  const r = createDriverPayoutBatch(state, payoutInput([eId], method), SENT);
  assert.equal(r.result.ok, true, r.result.error ?? "");
  return { state: r.state, batchId: r.result.payoutBatchId as string };
}

test("29/30/31/32/39: водитель подтверждает получение (bank/cash), детерминированный id, один bump", () => {
  for (const method of ["BANK_TRANSFER", "CASH"] as const) {
    const { state, batchId } = batched(method);
    const r = confirmDriverPayoutReceipt(state, DRIVER, batchId, CONFIRM);
    assert.equal(r.result.ok, true, r.result.error ?? "");
    assert.equal(r.state.driverPayoutReceiptEvents.length, 1);
    const ev = r.state.driverPayoutReceiptEvents[0];
    assert.equal(ev.id, driverPayoutReceiptEventId(batchId));
    assert.equal(ev.occurredAt, CONFIRM);
    assert.equal(ev.driverId, DRIVER);
    assert.equal(ev.actor, "DRIVER");
    assert.equal(r.state.revision, state.revision + 1);
  }
});

test("33/34/35/36: чужой водитель/unknown batch/invalid time/до sentAt → fail same-state", () => {
  const { state, batchId } = batched();
  assert.equal(confirmDriverPayoutReceipt(state, OTHER, batchId, CONFIRM).state, state); // 33
  assert.equal(confirmDriverPayoutReceipt(state, OTHER, batchId, CONFIRM).result.ok, false);
  assert.equal(confirmDriverPayoutReceipt(state, DRIVER, "unknown-batch", CONFIRM).result.ok, false); // 34
  assert.equal(confirmDriverPayoutReceipt(state, DRIVER, batchId, "не-дата").result.ok, false); // 35
  const early = confirmDriverPayoutReceipt(state, DRIVER, batchId, "2026-07-23T08:00:00.000Z"); // 36 before sentAt
  assert.equal(early.result.ok, false);
  assert.equal(early.state, state);
});

test("38/40: повтор подтверждения — идемпотентный no-op без bump; batch не мутируется", () => {
  const { state, batchId } = batched();
  const first = confirmDriverPayoutReceipt(state, DRIVER, batchId, CONFIRM);
  assert.equal(first.result.ok, true);
  const second = confirmDriverPayoutReceipt(first.state, DRIVER, batchId, "2026-07-24T10:00:00.000Z");
  assert.equal(second.result.ok, true);
  assert.equal(second.state, first.state);
  assert.equal(second.state.revision, first.state.revision);
  assert.equal(second.state.driverPayoutReceiptEvents.length, 1);
});

// --- §31 status / read-model --------------------------------------------------

test("41/42/44/45/46: статус AWAITING → CONFIRMED; итоги сдвигаются", () => {
  const { state, eId } = oneEarning();
  const amount = state.driverEarningEntries[0].amountCents;
  const created = createDriverPayoutBatch(state, payoutInput([eId]), SENT);
  const v1 = getDriverPayoutsView(created.state, DRIVER);
  assert.equal(v1.batches.length, 1);
  assert.equal(v1.batches[0].status, "AWAITING_DRIVER_CONFIRMATION");
  assert.equal(v1.dueFromDirectCents, 0); // 43: batched earning исключён
  assert.equal(v1.sentAwaitingConfirmationCents, amount);
  assert.equal(v1.confirmedReceivedCents, 0);
  const confirmed = confirmDriverPayoutReceipt(created.state, DRIVER, created.result.payoutBatchId as string, CONFIRM);
  const v2 = getDriverPayoutsView(confirmed.state, DRIVER);
  assert.equal(v2.batches[0].status, "CONFIRMED_RECEIVED");
  assert.equal(v2.batches[0].confirmedAt, CONFIRM);
  assert.equal(v2.sentAwaitingConfirmationCents, 0);
  assert.equal(v2.confirmedReceivedCents, amount);
});

test("47/48: CASH-метод закрывает DIRECT_PAYOUT_DUE; CASH_RETAINED не входит в payout totals", () => {
  const { state, eId } = oneEarning();
  const created = createDriverPayoutBatch(state, payoutInput([eId], "CASH"), SENT);
  const view = getDriverPayoutsView(created.state, DRIVER);
  assert.equal(view.dueFromDirectCents, 0);
  assert.equal(view.sentAwaitingConfirmationCents, state.driverEarningEntries[0].amountCents);
  // CASH_RETAINED заработок вообще не eligible → не в unpaid и не в payout.
  const cashState = cashCompleted();
  const cashView = getDriverPayoutsView(cashState, DRIVER);
  assert.equal(cashView.dueFromDirectCents, 0);
  assert.equal(cashView.batches.length, 0);
});

test("49/50/51/52: другой водитель исключён; история новые сверху; first/last; ref/note", () => {
  const { state, e1, e2 } = twoEarnings();
  const b1 = createDriverPayoutBatch(state, payoutInput([e1], "BANK_TRANSFER", { externalReference: "TX-1", note: "первый" }), SENT);
  const b2 = createDriverPayoutBatch(b1.state, payoutInput([e2]), "2026-07-24T09:00:00.000Z");
  const view = getDriverPayoutsView(b2.state, DRIVER);
  assert.equal(view.batches.length, 2);
  // Новые sentAt сверху.
  assert.ok(Date.parse(view.batches[0].sentAt) >= Date.parse(view.batches[1].sentAt));
  const first = view.batches[view.batches.length - 1];
  assert.equal(first.externalReference, "TX-1");
  assert.equal(first.note, "первый");
  assert.equal(first.firstEarningAt, first.lastEarningAt); // один earning в batch
  // Другой водитель ничего не видит.
  assert.equal(getDriverPayoutsView(b2.state, OTHER).batches.length, 0);
});

test("53/54/55/56: дубликат receipt/перекрытие/дубль id → reviewRequired, totals null", () => {
  const { state, eId } = oneEarning();
  const created = createDriverPayoutBatch(state, payoutInput([eId]), SENT);
  const batchId = created.result.payoutBatchId as string;
  // Дубликат receipt для одного batch → не подтверждён + review.
  const rid = driverPayoutReceiptEventId(batchId);
  const dupReceipt: PrototypeState = {
    ...created.state,
    driverPayoutReceiptEvents: [
      { id: rid, payoutBatchId: batchId, driverId: DRIVER, occurredAt: CONFIRM, actor: "DRIVER" },
      { id: rid + "-x", payoutBatchId: batchId, driverId: DRIVER, occurredAt: CONFIRM, actor: "DRIVER" },
    ] as unknown as PrototypeState["driverPayoutReceiptEvents"],
  };
  const vDup = getDriverPayoutsView(dupReceipt, DRIVER);
  assert.equal(vDup.reviewRequired, true);
  // Перекрывающиеся батчи (одна earning в двух батчах) → review, все три итога null.
  const overlap: PrototypeState = {
    ...created.state,
    driverPayoutBatches: [
      created.state.driverPayoutBatches[0],
      { ...created.state.driverPayoutBatches[0], id: driverPayoutBatchId(DRIVER, "2026-07-25T09:00:00.000Z"), sentAt: "2026-07-25T09:00:00.000Z" },
    ],
  };
  const vOverlap = getDriverPayoutsView(overlap, DRIVER);
  assert.equal(vOverlap.reviewRequired, true);
  assert.equal(vOverlap.dueFromDirectCents, null);
  assert.equal(vOverlap.sentAwaitingConfirmationCents, null);
  assert.equal(vOverlap.confirmedReceivedCents, null);
});

// --- §32 migration ------------------------------------------------------------

test("60/61/62/63/67: schema26 удаляет невалидные, сохраняет валидный batch", () => {
  const { state, eId } = oneEarning();
  const created = createDriverPayoutBatch(state, payoutInput([eId]), SENT);
  const validBatch = created.state.driverPayoutBatches[0];
  const parseWith = (batches: unknown[]) => {
    const parsed = parseStoredState(
      JSON.stringify({ ...created.state, schemaVersion: 26, driverPayoutBatches: batches }),
    );
    assert.ok(parsed);
    return parsed.driverPayoutBatches;
  };
  // 67: валидный сохраняется.
  assert.equal(parseWith([validBatch]).length, 1);
  // 61: неверная сумма удаляется.
  assert.equal(parseWith([{ ...validBatch, amountCents: validBatch.amountCents + 1 }]).length, 0);
  // 63: неизвестная earning удаляется.
  assert.equal(parseWith([{ ...validBatch, earningEntryIds: ["driver-earning-missing"] }]).length, 0);
  // 64: перекрытие удаляет оба.
  assert.equal(
    parseWith([
      validBatch,
      { ...validBatch, id: driverPayoutBatchId(DRIVER, "2026-07-25T09:00:00.000Z"), sentAt: "2026-07-25T09:00:00.000Z" },
    ]).length,
    0,
  );
});

test("62: schema26 CASH_RETAINED batch удаляется", () => {
  const cash = cashCompleted();
  const cashEarning = cash.driverEarningEntries.find((e) => e.mode === "CASH_RETAINED")!;
  const badBatch = {
    id: driverPayoutBatchId(DRIVER, SENT),
    driverId: DRIVER,
    currencyCode: "USD",
    earningEntryIds: [cashEarning.id],
    amountCents: cashEarning.amountCents,
    method: "BANK_TRANSFER",
    sentAt: SENT,
    createdBy: "ADMIN",
    externalReference: null,
    note: null,
  };
  const parsed = parseStoredState(
    JSON.stringify({ ...cash, schemaVersion: 26, driverPayoutBatches: [badBatch] }),
  );
  assert.ok(parsed);
  assert.equal(parsed.driverPayoutBatches.length, 0);
});

test("65/66: receipt удалённого batch удаляется; дубликаты receipt удаляются все", () => {
  const { state, eId } = oneEarning();
  const created = createDriverPayoutBatch(state, payoutInput([eId]), SENT);
  const batchId = created.result.payoutBatchId as string;
  const rid = driverPayoutReceiptEventId(batchId);
  // 65: receipt без валидного batch (batch удалён неверной суммой).
  const orphan = parseStoredState(
    JSON.stringify({
      ...created.state,
      schemaVersion: 26,
      driverPayoutBatches: [{ ...created.state.driverPayoutBatches[0], amountCents: 1 }],
      driverPayoutReceiptEvents: [{ id: rid, payoutBatchId: batchId, driverId: DRIVER, occurredAt: CONFIRM, actor: "DRIVER" }],
    }),
  );
  assert.ok(orphan);
  assert.equal(orphan.driverPayoutReceiptEvents.length, 0);
  // 66: дубликаты receipt одного batch удаляются все.
  const dup = parseStoredState(
    JSON.stringify({
      ...created.state,
      schemaVersion: 26,
      driverPayoutReceiptEvents: [
        { id: rid, payoutBatchId: batchId, driverId: DRIVER, occurredAt: CONFIRM, actor: "DRIVER" },
        { id: rid + "-2", payoutBatchId: batchId, driverId: DRIVER, occurredAt: CONFIRM, actor: "DRIVER" },
      ],
    }),
  );
  assert.ok(dup);
  assert.equal(dup.driverPayoutReceiptEvents.length, 0);
});

// --- §33 existing earnings regression -----------------------------------------

test("69/70/71: due → awaiting → confirmed по мере действий", () => {
  const { state, eId } = oneEarning();
  const amount = state.driverEarningEntries[0].amountCents;
  // 69: до batch — due.
  assert.equal(getDriverEarningsView(state, DRIVER).dueFromDirectCents, amount);
  assert.equal(getDriverEarningsView(state, DRIVER).sentByDirectCents, 0);
  const created = createDriverPayoutBatch(state, payoutInput([eId]), SENT);
  // 70: после batch — awaiting, due 0.
  const v1 = getDriverEarningsView(created.state, DRIVER);
  assert.equal(v1.dueFromDirectCents, 0);
  assert.equal(v1.sentByDirectCents, amount);
  assert.equal(v1.receivedFromDirectCents, 0);
  const confirmed = confirmDriverPayoutReceipt(created.state, DRIVER, created.result.payoutBatchId as string, CONFIRM);
  // 71: после подтверждения — received.
  const v2 = getDriverEarningsView(confirmed.state, DRIVER);
  assert.equal(v2.sentByDirectCents, 0);
  assert.equal(v2.receivedFromDirectCents, amount);
});

test("72/73: CASH_RETAINED остаётся cashReceived; completion не создаёт payout", () => {
  const cash = cashCompleted();
  const view = getDriverEarningsView(cash, DRIVER);
  assert.equal(view.cashReceivedCents, 300);
  assert.equal(view.dueFromDirectCents, 0);
  assert.equal(view.receivedFromDirectCents, 0);
  assert.equal(cash.driverPayoutBatches.length, 0);
  assert.equal(cash.driverPayoutReceiptEvents.length, 0);
});

// --- admin read-model ---------------------------------------------------------

test("admin: eligible earnings, итоги и сортировка по driver", () => {
  const { state, e1, e2 } = twoEarnings();
  const rows = getAdminDriverPayoutsView(state);
  const row = rows.find((r) => r.driverId === DRIVER);
  assert.ok(row);
  assert.equal(row.eligibleEarnings.length, 2);
  assert.deepEqual(
    row.eligibleEarnings.map((e) => e.id).sort(),
    [e1, e2].sort(),
  );
  assert.equal(row.dueFromDirectCents, payoutAmount(state, [e1, e2]));
  // Водитель с due > 0 стоит выше водителей без выплат.
  assert.equal(rows[0].driverId, DRIVER);
  // eligible содержит публичный номер и ресторан, без внутренних приватных данных.
  assert.ok(row.eligibleEarnings.every((e) => e.orderPublicNumber !== "" && e.restaurantName !== ""));
});
