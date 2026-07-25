import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  driverEarningEntryId,
  buildPreparedDriverEarningEntry,
  buildCompletedDriverEarningEntry,
  hasValidDriverEarningEntry,
  DRIVER_EARNING_REVIEW_ERROR,
} from "./driver-earnings.ts";
import { customerCashCollectionEventId } from "./platform-driver-cash-collection.ts";
import {
  driverCashHandoffReportEventId,
  restaurantCashReceiptEventId,
} from "./platform-driver-cash-handoff.ts";
import { markOrderDeliveredByDriverWithResult } from "./actions.ts";
import { FINANCIAL_RULES } from "./financial-rule.ts";

/**
 * CASH DIRECT — split №2: единый журнал заработка водителя. Заработок — из снимка
 * (ONLINE → DIRECT_PAYOUT_DUE, CASH → CASH_RETAINED); суммы не пересчитываются;
 * старый driver cash ledger новыми завершениями не пишется.
 */

const DRIVER = "driver-1";
const OTHER = "driver-2";
const REST = "restaurant-2";
const REST_ZONE = "zone-2" as const;
const ORDER = "o-cash";
const T0 = "2026-07-22T10:00:00.000Z";
const T2 = "2026-07-22T10:06:00.000Z"; // driver report
const T3 = "2026-07-22T10:07:00.000Z"; // restaurant confirmation
const T4 = "2026-07-22T10:08:00.000Z"; // picked up
const T5 = "2026-07-22T10:09:00.000Z"; // arriving
const T6 = "2026-07-22T10:10:00.000Z"; // collection / delivery / now

const SNAPSHOT = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 700,
  driverEarningCents: 300,
  restaurantOwesDirectCents: 100,
};

const MOVEMENT = {
  customerMoneyRecipient: "RESTAURANT",
  paymentChannel: "CASH_TO_PLATFORM_DRIVER",
  totalBankFeeCents: 0,
  restaurantBankFeeCents: 0,
  directBankFeeCents: 0,
  restaurantOwesDirectCents: 100,
  directOwesRestaurantCents: 0,
  restaurantNetCents: 600,
  directNetRevenueCents: 100,
};

interface CashOpts {
  status?: Order["status"];
  snapshot?: unknown;
  movement?: unknown;
  paymentStatus?: Order["paymentStatus"];
  paidAt?: string | null;
  confirmed?: boolean;
  pickedUp?: boolean;
  arriving?: boolean;
  delivered?: boolean;
  collected?: boolean;
  driverStatus?: string;
}

/** Полностью валидное ARRIVING-состояние наличного заказа (по умолчанию). */
function cashState(opts: CashOpts = {}): PrototypeState {
  const base = createDefaultState();
  const order = {
    id: ORDER,
    publicNumber: "C-1",
    createdAt: T0,
    updatedAt: T0,
    customer: { id: "customer-1", name: "Клиент", phone: "+373 1" },
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    paymentStatus: opts.paymentStatus ?? "CASH_ON_DELIVERY",
    paidAt: opts.paidAt === undefined ? null : opts.paidAt,
    status: opts.status ?? "ARRIVING",
    assignedDriverId: DRIVER,
    driverAssignedAt: T0,
    restaurant: { id: REST, name: "Р2", address: "адрес", zoneId: "zone-2" },
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
      // Полный снимок сумм (v24): наличное движение переживает serialize → parse
      // только при подтверждённых суммах и правиле заказа.
      foodSubtotalCents: 700,
      deliveryFeeCents: 300,
      smallOrderFeeCents: 0,
      restaurantCommissionCents: 100,
      customerTotalCents: 1000,
      restaurantPayoutBeforeBankFeeCents: 600,
      driverPayoutCents: 300,
      platformGrossRevenueCents: 100,
      financialRule: FINANCIAL_RULES.DIRECT_FINANCIAL_RULE_V1,
      financialCollectionMode: "MIXED_COLLECTION",
      platformDriverCash: opts.snapshot === undefined ? SNAPSHOT : opts.snapshot,
      moneyMovementStatus: "COMPLETE",
      moneyMovement: opts.movement === undefined ? MOVEMENT : opts.movement,
    },
  } as unknown as Order;

  const de: unknown[] = [
    {
      id: "de-1",
      orderId: ORDER,
      driverId: DRIVER,
      type: "ARRIVED_AT_RESTAURANT",
      occurredAt: T2,
      orderStatusBefore: "READY",
      orderStatusAfter: "READY",
    },
  ];
  if (opts.pickedUp !== false) {
    de.push({
      id: "de-2",
      orderId: ORDER,
      driverId: DRIVER,
      type: "ORDER_PICKED_UP",
      occurredAt: T4,
      orderStatusBefore: "READY",
      orderStatusAfter: "OUT_FOR_DELIVERY",
    });
  }
  if (opts.arriving !== false) {
    de.push({
      id: "de-3",
      orderId: ORDER,
      driverId: DRIVER,
      type: "ARRIVING_TO_CUSTOMER",
      occurredAt: T5,
      orderStatusBefore: "OUT_FOR_DELIVERY",
      orderStatusAfter: "ARRIVING",
    });
  }
  if (opts.delivered) {
    de.push({
      id: "de-4",
      orderId: ORDER,
      driverId: DRIVER,
      type: "ORDER_DELIVERED",
      occurredAt: T6,
      orderStatusBefore: "ARRIVING",
      orderStatusAfter: "DELIVERED",
    });
  }

  const cash: unknown[] = [
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
  ];
  if (opts.confirmed !== false) {
    cash.push({
      id: restaurantCashReceiptEventId(ORDER),
      orderId: ORDER,
      driverId: DRIVER,
      restaurantId: REST,
      type: "RESTAURANT_CONFIRMED_CASH_RECEIPT",
      amountCents: 700,
      occurredAt: T3,
      actor: "RESTAURANT",
      restaurantWorkspaceRole: "COMBINED",
    });
  }
  if (opts.collected) {
    cash.push({
      id: customerCashCollectionEventId(ORDER),
      orderId: ORDER,
      driverId: DRIVER,
      restaurantId: REST,
      type: "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
      amountCents: 1000,
      occurredAt: T6,
      actor: "DRIVER",
      restaurantWorkspaceRole: null,
    });
  }

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
      d.id === DRIVER
        ? {
            ...d,
            status: (opts.driverStatus ?? "BUSY_DIRECT") as typeof d.status,
            currentZoneId: "zone-2",
          }
        : d,
    ),
  };
}

const theOrder = (s: PrototypeState): Order => s.orders[0];

/** Успешно завершённый CASH-заказ (после единой атомарной мутации). */
function cashCompleted(): PrototypeState {
  const r = markDriverDeliveredOrder(cashState(), DRIVER, ORDER, T6, {
    cashCollectionConfirmed: true,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  return r.state;
}

/** READY онлайн-заказ ресторана-2, назначенный driver-1 (BUSY_DIRECT). */
function onlineAssigned(): { state: PrototypeState; orderId: string } {
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
  return { state: s, orderId };
}

/** Онлайн-заказ в OUT_FOR_DELIVERY (получен, но подъезд ещё не отмечен). */
function onlineOutForDelivery(): { state: PrototypeState; orderId: string } {
  const { state, orderId } = onlineAssigned();
  let s = markDriverArrivedAtRestaurant(state, DRIVER, orderId, T2).state;
  s = markDriverPickedUpOrder(s, DRIVER, orderId, T4).state;
  return { state: s, orderId };
}

/** Онлайн-заказ, доведённый до ARRIVING полным рабочим путём водителя. */
function onlineArriving(): { state: PrototypeState; orderId: string } {
  const { state, orderId } = onlineOutForDelivery();
  const s = markDriverArrivingToCustomer(state, DRIVER, orderId, T5).state;
  return { state: s, orderId };
}

function findOrder(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

/** Успешно завершённый онлайн-заказ. */
function onlineCompleted(): { state: PrototypeState; orderId: string } {
  const { state, orderId } = onlineArriving();
  const r = markDriverDeliveredOrder(state, DRIVER, orderId, T6, {
    cashCollectionConfirmed: false,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  return { state: r.state, orderId };
}

// --- 1–3: модель и дефолты ----------------------------------------------------

test("1/2/3: схема 24, пустой журнал заработка, наличные выключены", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 26);
  const d = createDefaultState();
  assert.deepEqual(d.driverEarningEntries, []);
  assert.equal(d.platformSettings.platformDriverCashEnabled, false);
});

test("4: детерминированный id заработка", () => {
  assert.equal(driverEarningEntryId("order-42"), "driver-earning-order-42");
});

// --- ONLINE completion --------------------------------------------------------

test("20–24: ONLINE completion создаёт один DIRECT_PAYOUT_DUE из driverPayout", () => {
  const { state, orderId } = onlineArriving();
  const before = state.revision;
  const r = markDriverDeliveredOrder(state, DRIVER, orderId, T6, {
    cashCollectionConfirmed: false,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  const forOrder = r.state.driverEarningEntries.filter((e) => e.orderId === orderId);
  assert.equal(forOrder.length, 1);
  const e = forOrder[0];
  assert.equal(e.mode, "DIRECT_PAYOUT_DUE");
  const order = r.state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  assert.equal(e.amountCents, order.financials.driverPayoutCents);
  assert.equal(e.driverId, DRIVER);
  assert.equal(e.source, "PLATFORM_DRIVER_ORDER");
  assert.equal(e.id, driverEarningEntryId(orderId));
  // recognizedAt = момент события ORDER_DELIVERED.
  const delivered = r.state.driverDeliveryEvents.find(
    (ev) => ev.orderId === orderId && ev.type === "ORDER_DELIVERED",
  );
  assert.equal(e.recognizedAt, delivered?.occurredAt);
  // Один рост ревизии, водитель освобождён на подтверждение зоны.
  assert.equal(r.state.revision, before + 1);
  assert.equal(r.state.drivers.find((d) => d.id === DRIVER)?.status, "ZONE_CONFIRMATION_REQUIRED");
  // Старый ledger не пишется.
});

test("29–31: ONLINE повтор — no-op без дубля, ревизия не растёт", () => {
  const { state, orderId } = onlineCompleted();
  const again = markDriverDeliveredOrder(state, DRIVER, orderId, "2026-07-22T12:00:00.000Z", {
    cashCollectionConfirmed: false,
  });
  assert.equal(again.result.ok, true, again.result.error ?? "");
  assert.equal(again.state, state);
  assert.equal(
    again.state.driverEarningEntries.filter((e) => e.orderId === orderId).length,
    1,
  );
  assert.equal(again.state.revision, state.revision);
});

test("32/33: ONLINE delivered без заработка или с чужим режимом → fail", () => {
  const { state, orderId } = onlineCompleted();
  const missing: PrototypeState = { ...state, driverEarningEntries: [] };
  const r1 = markDriverDeliveredOrder(missing, DRIVER, orderId, T6, {
    cashCollectionConfirmed: false,
  });
  assert.equal(r1.result.ok, false);
  assert.equal(r1.result.error, DRIVER_EARNING_REVIEW_ERROR);

  const wrongMode: PrototypeState = {
    ...state,
    driverEarningEntries: state.driverEarningEntries.map((e) =>
      e.orderId === orderId ? { ...e, mode: "CASH_RETAINED" as const } : e,
    ),
  };
  const r2 = markDriverDeliveredOrder(wrongMode, DRIVER, orderId, T6, {
    cashCollectionConfirmed: false,
  });
  assert.equal(r2.result.ok, false);
});

// --- CASH completion ----------------------------------------------------------

test("36–39: CASH completion создаёт один CASH_RETAINED, старый ledger не растёт", () => {
  const s = cashState();
  const r = markDriverDeliveredOrder(s, DRIVER, ORDER, T6, {
    cashCollectionConfirmed: true,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  assert.equal(r.state.driverEarningEntries.length, 1);
  const e = r.state.driverEarningEntries[0];
  assert.equal(e.mode, "CASH_RETAINED");
  assert.equal(e.amountCents, SNAPSHOT.driverEarningCents);
});

test("40–43: CASH создаёт RESTAURANT_REMITTANCE = долг без стоимости доставки", () => {
  const st = cashCompleted();
  const acc = st.restaurantAccountingEntries;
  assert.equal(acc.length, 1);
  assert.equal(acc[0].direction, "RESTAURANT_OWES_DIRECT");
  assert.equal(acc[0].type, "RESTAURANT_REMITTANCE");
  assert.equal(acc[0].amountCents, SNAPSHOT.restaurantOwesDirectCents);
  // Долг = 100 (комиссия + small), НЕ включает стоимость доставки 300.
  assert.notEqual(acc[0].amountCents, SNAPSHOT.restaurantOwesDirectCents + 300);
  assert.equal(st.settlements.length, 0);
  assert.equal(st.restaurantSettlementRecords.length, 0);
});

test("44–48: CASH завершение — PAID, DELIVERED, водитель освобождён, один bump", () => {
  const s = cashState();
  const r = markDriverDeliveredOrder(s, DRIVER, ORDER, T6, {
    cashCollectionConfirmed: true,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  const o = theOrder(r.state);
  assert.equal(o.paymentStatus, "PAID");
  assert.equal(o.status, "DELIVERED");
  assert.equal(r.state.drivers.find((d) => d.id === DRIVER)?.status, "ZONE_CONFIRMATION_REQUIRED");
  assert.equal(r.state.revision, s.revision + 1);
});

test("52/53: CASH повтор — no-op без дубля заработка/обязательства", () => {
  const st = cashCompleted();
  const again = markDriverDeliveredOrder(st, DRIVER, ORDER, "2026-07-22T12:00:00.000Z", {
    cashCollectionConfirmed: true,
  });
  assert.equal(again.result.ok, true, again.result.error ?? "");
  assert.equal(again.state, st);
  assert.equal(again.state.driverEarningEntries.length, 1);
  assert.equal(again.state.restaurantAccountingEntries.length, 1);
});

test("58: нулевой долг ресторана — CASH завершение без обязательства", () => {
  // Согласованный нулевой долг: platformGross=0, handoff=payoutBeforeBankFee=700,
  // customerTotal=1000=handoff+driverEarning(300).
  const zeroSnapshot = {
    customerCollectionCents: 1000,
    restaurantHandoffCents: 700,
    driverEarningCents: 300,
    restaurantOwesDirectCents: 0,
  };
  const zeroMovement = {
    ...MOVEMENT,
    restaurantOwesDirectCents: 0,
    restaurantNetCents: 700,
    directNetRevenueCents: 0,
  };
  const s = cashState({ snapshot: zeroSnapshot, movement: zeroMovement });
  const consistent: PrototypeState = {
    ...s,
    orders: s.orders.map((o) => ({
      ...o,
      financials: {
        ...o.financials,
        platformGrossRevenueCents: 0,
        restaurantPayoutBeforeBankFeeCents: 700,
      },
    })),
  };
  const r = markDriverDeliveredOrder(consistent, DRIVER, ORDER, T6, {
    cashCollectionConfirmed: true,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  assert.equal(r.state.restaurantAccountingEntries.length, 0);
  assert.equal(r.state.driverEarningEntries.length, 1);
  assert.equal(r.state.driverEarningEntries[0].mode, "CASH_RETAINED");
});

// --- Failure atomicity --------------------------------------------------------

test("59: существующий заработок до завершения → fail, state неизменен", () => {
  const s: PrototypeState = {
    ...cashState(),
    driverEarningEntries: [
      {
        id: driverEarningEntryId(ORDER),
        orderId: ORDER,
        driverId: DRIVER,
        restaurantId: REST,
        currencyCode: "USD",
        amountCents: 300,
        mode: "CASH_RETAINED",
        recognizedAt: T0,
        source: "PLATFORM_DRIVER_ORDER",
      },
    ] as unknown as PrototypeState["driverEarningEntries"],
  };
  const r = markDriverDeliveredOrder(s, DRIVER, ORDER, T6, {
    cashCollectionConfirmed: true,
  });
  assert.equal(r.result.ok, false);
  assert.equal(r.state, s);
  assert.equal(r.state.driverEarningEntries.length, 1);
});

test("60/73/74: невалидная выплата → fail; CASH state, paymentStatus и paidAt неизменны", () => {
  const s = cashState({ snapshot: { ...SNAPSHOT, driverEarningCents: 0 } });
  const withZeroPayout: PrototypeState = {
    ...s,
    orders: s.orders.map((o) => ({
      ...o,
      financials: { ...o.financials, driverPayoutCents: 0 },
    })),
  };
  const r = markDriverDeliveredOrder(withZeroPayout, DRIVER, ORDER, T6, {
    cashCollectionConfirmed: true,
  });
  assert.equal(r.result.ok, false);
  assert.equal(r.state, withZeroPayout);
  assert.equal(theOrder(r.state).paymentStatus, "CASH_ON_DELIVERY");
  assert.equal(theOrder(r.state).paidAt, null);
  assert.equal(
    r.state.driverDeliveryEvents.filter((e) => e.type === "ORDER_DELIVERED").length,
    0,
  );
});

// --- builders (pure) ----------------------------------------------------------

test("prepared: валидный CASH состояние строит CASH_RETAINED; завершённый запрещён", () => {
  // Подготовленное наличное завершение: деньги уже получены (PAID, paidAt=nowIso,
  // событие получения), заказ ещё ARRIVING.
  const s = cashState({ paymentStatus: "PAID", paidAt: T6, collected: true });
  const prepared = buildPreparedDriverEarningEntry(s, theOrder(s), T6);
  assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.error);
  if (prepared.ok) {
    assert.equal(prepared.entry.mode, "CASH_RETAINED");
    assert.equal(prepared.entry.amountCents, 300);
  }
  const done = cashCompleted();
  assert.equal(buildPreparedDriverEarningEntry(done, theOrder(done), T6).ok, false);
});

test("completed: строит ожидаемую CASH_RETAINED и hasValid = true", () => {
  const st = cashCompleted();
  const built = buildCompletedDriverEarningEntry(st, theOrder(st));
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.equal(built.entry.mode, "CASH_RETAINED");
    assert.equal(built.entry.recognizedAt, T6);
  }
  assert.equal(hasValidDriverEarningEntry(st, theOrder(st)), true);
});

// --- нормализация schema 24 ---------------------------------------------------

test("5: схемы <= 23 получают пустой журнал заработка", () => {
  const st = cashCompleted();
  for (const v of [7, 20, 22, 23]) {
    const parsed = parseStoredState(JSON.stringify({ ...st, schemaVersion: v }));
    assert.ok(parsed, `схема ${v}`);
    assert.deepEqual(parsed.driverEarningEntries, []);
  }
});

test("6/7/8: схема 24 сохраняет валидный ONLINE earning, но не синтезирует отсутствующий", () => {
  const { state } = onlineCompleted();
  const kept = parseStoredState(JSON.stringify({ ...state, schemaVersion: 25 }));
  assert.ok(kept);
  assert.equal(kept.driverEarningEntries.length, 1);
  assert.equal(kept.driverEarningEntries[0].mode, "DIRECT_PAYOUT_DUE");
  // Отсутствующая запись не достраивается по завершённому заказу.
  const dropped = parseStoredState(
    JSON.stringify({ ...state, schemaVersion: 25, driverEarningEntries: [] }),
  );
  assert.ok(dropped);
  assert.deepEqual(dropped.driverEarningEntries, []);
});

test("9–16: схема 24 удаляет повреждённые записи", () => {
  const { state } = onlineCompleted();
  const good = state.driverEarningEntries[0];
  // Контроль: неповреждённая запись сохраняется.
  const keep = parseStoredState(
    JSON.stringify({ ...state, schemaVersion: 25, driverEarningEntries: [good] }),
  );
  assert.ok(keep);
  assert.equal(keep.driverEarningEntries.length, 1);
  const bad = (over: Record<string, unknown>) => {
    const parsed = parseStoredState(
      JSON.stringify({
        ...state,
        schemaVersion: 25,
        driverEarningEntries: [{ ...good, ...over }],
      }),
    );
    assert.ok(parsed);
    return parsed.driverEarningEntries.length;
  };
  assert.equal(bad({ id: "wrong" }), 0); // id
  assert.equal(bad({ orderId: "нет" }), 0); // order
  assert.equal(bad({ driverId: OTHER }), 0); // driver
  assert.equal(bad({ restaurantId: "restaurant-1" }), 0); // restaurant
  assert.equal(bad({ amountCents: good.amountCents + 1 }), 0); // amount
  assert.equal(bad({ mode: "OTHER" }), 0); // mode
  assert.equal(bad({ recognizedAt: "не-дата" }), 0); // recognizedAt
  assert.equal(bad({ source: "OTHER" }), 0); // source
  assert.equal(bad({ amountCents: 0 }), 0); // не положительная
});

test("17/18: дубли по заказу и по id удаляют все конфликтующие записи", () => {
  const { state } = onlineCompleted();
  const good = state.driverEarningEntries[0];
  const dupOrder = parseStoredState(
    JSON.stringify({
      ...state,
      schemaVersion: 25,
      driverEarningEntries: [good, { ...good, id: "second" }],
    }),
  );
  assert.ok(dupOrder);
  assert.equal(dupOrder.driverEarningEntries.length, 0);
});

test("19: parse → serialize → parse идемпотентен", () => {
  const { state } = onlineCompleted();
  const once = parseStoredState(JSON.stringify({ ...state, schemaVersion: 25 }));
  assert.ok(once);
  const twice = parseStoredState(JSON.stringify(once));
  assert.ok(twice);
  assert.deepEqual(twice.driverEarningEntries, once.driverEarningEntries);
  assert.equal(twice.driverEarningEntries.length, 1);
});

// --- регрессии ----------------------------------------------------------------

test("75–90: чистый домен, без payout-событий и выплаты", () => {
  const src = readFileSync("src/prototype/driver-earnings.ts", "utf8");
  // Проверяем фактическое ИСПОЛЬЗОВАНИЕ (упоминание в doc-комментарии допустимо).
  for (const forbidden of [
    'from "react"',
    "localStorage.",
    "finalizeMutation(",
    "Date.now(",
    "new Date(",
  ]) {
    assert.ok(!src.includes(forbidden), forbidden);
  }
  // Ни в состоянии, ни в домене нет события выплаты водителю (сборка имени из
  // частей, чтобы grep-аудит удалённого понятия оставался пустым).
  const payoutEventType = ["Driver", "Payout", "Event"].join("");
  for (const source of [src, readFileSync("src/prototype/models.ts", "utf8")]) {
    assert.ok(!source.includes(payoutEventType));
  }
});

// --- repair split №2: закрытый compatibility-обход ----------------------------

test("bypass: compat-action fail-closed для ONLINE OUT_FOR_DELIVERY", () => {
  const { state, orderId } = onlineOutForDelivery();
  const r = markOrderDeliveredByDriverWithResult(state, orderId);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Этот этап отмечает назначенный водитель Direct.");
  assert.equal(r.state, state);
  assert.equal(r.state.revision, state.revision);
  assert.equal(findOrder(r.state, orderId).status, "OUT_FOR_DELIVERY");
  assert.equal(
    r.state.driverDeliveryEvents.filter(
      (e) => e.orderId === orderId && e.type === "ORDER_DELIVERED",
    ).length,
    0,
  );
  assert.equal(r.state.driverEarningEntries.length, 0);
  assert.equal(
    r.state.restaurantAccountingEntries.filter((e) => e.orderId === orderId).length,
    0,
  );
  assert.equal(r.state.drivers.find((d) => d.id === DRIVER)?.status, "BUSY_DIRECT");
});

test("bypass: compat-action fail-closed даже для валидного ONLINE ARRIVING", () => {
  const { state, orderId } = onlineArriving();
  const r = markOrderDeliveredByDriverWithResult(state, orderId);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Этот этап отмечает назначенный водитель Direct.");
  assert.equal(r.state, state);
  assert.equal(r.state.revision, state.revision);
  assert.equal(findOrder(r.state, orderId).status, "ARRIVING");
  assert.equal(
    r.state.driverDeliveryEvents.filter(
      (e) => e.orderId === orderId && e.type === "ORDER_DELIVERED",
    ).length,
    0,
  );
  assert.equal(r.state.driverEarningEntries.length, 0);
  assert.equal(
    r.state.restaurantAccountingEntries.filter((e) => e.orderId === orderId).length,
    0,
  );
  assert.equal(r.state.drivers.find((d) => d.id === DRIVER)?.status, "BUSY_DIRECT");
});

// --- §12: prepared ONLINE отклоняет неполноценный lifecycle -------------------

test("prepared ONLINE: полный набор негативных проверок lifecycle", () => {
  const NOW = "2026-07-22T10:11:00.000Z";
  const { state: s0, orderId: oid } = onlineArriving();
  const ok = buildPreparedDriverEarningEntry(s0, findOrder(s0, oid), NOW);
  assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
  if (ok.ok) assert.equal(ok.entry.mode, "DIRECT_PAYOUT_DUE");

  const setOrder = (patch: Partial<Order>): PrototypeState => ({
    ...s0,
    orders: s0.orders.map((o) => (o.id === oid ? { ...o, ...patch } : o)),
  });
  const mapEvents = (
    fn: (es: PrototypeState["driverDeliveryEvents"]) => unknown[],
  ): PrototypeState =>
    ({
      ...s0,
      driverDeliveryEvents: fn(
        s0.driverDeliveryEvents,
      ) as PrototypeState["driverDeliveryEvents"],
    }) as PrototypeState;
  const ev = (type: string) =>
    s0.driverDeliveryEvents.find(
      (e) => e.orderId === oid && e.driverId === DRIVER && e.type === type,
    )!;
  const reject = (state: PrototypeState, label: string, nowIso = NOW) =>
    assert.equal(
      buildPreparedDriverEarningEntry(state, findOrder(state, oid), nowIso).ok,
      false,
      label,
    );

  reject(setOrder({ status: "OUT_FOR_DELIVERY" }), "OUT_FOR_DELIVERY");
  reject(setOrder({ status: "PREPARING" }), "PREPARING");
  reject(
    mapEvents((es) => es.filter((e) => e.type !== "ORDER_PICKED_UP")),
    "нет pickup",
  );
  reject(
    mapEvents((es) => [...es, { ...ev("ORDER_PICKED_UP"), id: "dup-pick" }]),
    "два pickup",
  );
  reject(
    mapEvents((es) => es.filter((e) => e.type !== "ARRIVING_TO_CUSTOMER")),
    "нет arriving",
  );
  reject(
    mapEvents((es) => [...es, { ...ev("ARRIVING_TO_CUSTOMER"), id: "dup-arr" }]),
    "два arriving",
  );
  reject(
    mapEvents((es) => [
      ...es,
      {
        ...ev("ARRIVING_TO_CUSTOMER"),
        id: "deliv",
        type: "ORDER_DELIVERED",
        orderStatusBefore: "ARRIVING",
        orderStatusAfter: "DELIVERED",
      },
    ]),
    "уже есть delivered",
  );
  reject(
    mapEvents((es) =>
      es.map((e) =>
        e.type === "ORDER_PICKED_UP" || e.type === "ARRIVING_TO_CUSTOMER"
          ? { ...e, driverId: OTHER }
          : e,
      ),
    ),
    "события другого водителя",
  );
  reject(
    mapEvents((es) =>
      es.map((e) =>
        e.type === "ORDER_PICKED_UP" ? { ...e, orderStatusBefore: "PREPARING" } : e,
      ),
    ),
    "pickup неверный before",
  );
  reject(
    mapEvents((es) =>
      es.map((e) =>
        e.type === "ARRIVING_TO_CUSTOMER" ? { ...e, orderStatusAfter: "DELIVERED" } : e,
      ),
    ),
    "arriving неверный after",
  );
  reject(
    mapEvents((es) =>
      es.map((e) => (e.type === "ORDER_PICKED_UP" ? { ...e, occurredAt: "не-дата" } : e)),
    ),
    "pickup невалидный ISO",
  );
  reject(
    mapEvents((es) =>
      es.map((e) =>
        e.type === "ARRIVING_TO_CUSTOMER" ? { ...e, occurredAt: "не-дата" } : e,
      ),
    ),
    "arriving невалидный ISO",
  );
  reject(
    mapEvents((es) =>
      es.map((e) =>
        e.type === "ORDER_PICKED_UP"
          ? { ...e, occurredAt: "2026-07-22T10:30:00.000Z" }
          : e,
      ),
    ),
    "pickup позже arriving",
  );
  reject(
    { ...s0, drivers: s0.drivers.map((d) => (d.id === DRIVER ? { ...d, status: "AVAILABLE" } : d)) },
    "водитель не BUSY_DIRECT",
  );
  reject(
    {
      ...s0,
      orders: [
        { ...findOrder(s0, oid), id: "other-active", status: "OUT_FOR_DELIVERY" },
        ...s0.orders,
      ],
    },
    "активный заказ водителя другой",
  );
  reject(s0, "nowIso раньше arriving", "2026-07-22T10:08:00.000Z");
});

// --- §13: позитивный ONLINE ---------------------------------------------------

test("prepared ONLINE позитив: DIRECT_PAYOUT_DUE, сумма и recognizedAt", () => {
  const NOW = "2026-07-22T10:11:00.000Z";
  const { state, orderId } = onlineArriving();
  const order = findOrder(state, orderId);
  const built = buildPreparedDriverEarningEntry(state, order, NOW);
  assert.equal(built.ok, true, built.ok ? "" : built.error);
  if (!built.ok) return;
  assert.equal(built.entry.mode, "DIRECT_PAYOUT_DUE");
  assert.equal(built.entry.amountCents, order.financials.driverPayoutCents);
  assert.equal(built.entry.recognizedAt, NOW);
});

// --- §10: round-trip integrity ------------------------------------------------

test("round-trip ONLINE: earning + accounting + ORDER_DELIVERED переживают parse", () => {
  const { state, orderId } = onlineCompleted();
  const parsed = parseStoredState(JSON.stringify(state));
  assert.ok(parsed);
  const o = findOrder(parsed, orderId);
  assert.equal(o.status, "DELIVERED");
  const delivered = parsed.driverDeliveryEvents.filter(
    (e) => e.orderId === orderId && e.type === "ORDER_DELIVERED",
  );
  assert.equal(delivered.length, 1);
  const earnings = parsed.driverEarningEntries.filter((e) => e.orderId === orderId);
  assert.equal(earnings.length, 1);
  assert.equal(earnings[0].mode, "DIRECT_PAYOUT_DUE");
  assert.equal(earnings[0].amountCents, o.financials.driverPayoutCents);
  assert.equal(earnings[0].recognizedAt, delivered[0].occurredAt);
  assert.equal(
    parsed.restaurantAccountingEntries.filter((e) => e.orderId === orderId).length,
    1,
  );
});

test("round-trip CASH: CASH_RETAINED + RESTAURANT_REMITTANCE + ORDER_DELIVERED переживают parse", () => {
  const state = cashCompleted();
  const parsed = parseStoredState(JSON.stringify(state));
  assert.ok(parsed);
  const o = findOrder(parsed, ORDER);
  assert.equal(o.status, "DELIVERED");
  assert.equal(
    parsed.driverDeliveryEvents.filter(
      (e) => e.orderId === ORDER && e.type === "ORDER_DELIVERED",
    ).length,
    1,
  );
  const earnings = parsed.driverEarningEntries.filter((e) => e.orderId === ORDER);
  assert.equal(earnings.length, 1);
  assert.equal(earnings[0].mode, "CASH_RETAINED");
  assert.equal(earnings[0].amountCents, SNAPSHOT.driverEarningCents);
  const acc = parsed.restaurantAccountingEntries.filter((e) => e.orderId === ORDER);
  assert.equal(acc.length, 1);
  assert.equal(acc[0].type, "RESTAURANT_REMITTANCE");
  assert.equal(acc[0].amountCents, SNAPSHOT.restaurantOwesDirectCents);
});
