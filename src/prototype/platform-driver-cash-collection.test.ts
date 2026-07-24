import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { parseStoredState } from "./prototype-store.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type { Order, PrototypeState } from "./models.ts";
import {
  customerCashCollectionEventId,
  getPlatformDriverCustomerCashCollectionView,
  hasValidPlatformDriverCustomerCashCollection,
} from "./platform-driver-cash-collection.ts";
import {
  driverCashHandoffReportEventId,
  restaurantCashReceiptEventId,
} from "./platform-driver-cash-handoff.ts";
import { markDriverDeliveredOrder } from "./driver-delivery.ts";
import {
  applyDriverDeliveredOrder,
  markOrderDeliveredByDriverWithResult,
} from "./actions.ts";

/**
 * CASH DIRECT — часть 4: получение полной суммы наличными от клиента и
 * атомарное завершение доставки. Домен чистый; сумма — только из snapshot.
 */

const DRIVER = "driver-1";
const REST = "restaurant-2";
const ORDER = "o-cash";
const T0 = "2026-07-22T10:00:00.000Z"; // offer / reserve
const T2 = "2026-07-22T10:06:00.000Z"; // driver report
const T3 = "2026-07-22T10:07:00.000Z"; // restaurant confirmation
const T4 = "2026-07-22T10:08:00.000Z"; // picked up
const T5 = "2026-07-22T10:09:00.000Z"; // arriving to customer
const T6 = "2026-07-22T10:10:00.000Z"; // collection / now

const SNAPSHOT = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 600,
  driverEarningCents: 300,
  directReceivableFromDriverCents: 100,
};

interface Opts {
  status?: Order["status"];
  paymentMethod?: Order["paymentMethod"];
  paymentStatus?: Order["paymentStatus"];
  paidAt?: string | null;
  snapshot?: unknown;
  offerStatus?: "ACCEPTED" | "OPEN";
  reserveConfirmedAt?: string | null;
  reported?: boolean;
  confirmed?: boolean;
  confirmedAt?: string;
  pickedUp?: boolean;
  arriving?: boolean;
  arrivingAt?: string;
  delivered?: boolean;
  deliveredAt?: string;
  collected?: boolean;
  collectedAt?: string;
  driverStatus?: string;
}

/** Полностью валидное ARRIVING-состояние наличного заказа (по умолчанию). */
function cashState(opts: Opts = {}): PrototypeState {
  const base = createDefaultState();
  const order = {
    id: ORDER,
    publicNumber: "C-1",
    createdAt: T0,
    updatedAt: T0,
    customer: { id: "customer-1", name: "Клиент", phone: "+373 1" },
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: opts.paymentMethod ?? "CASH",
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
      customerTotalCents: 1000,
      restaurantPayoutBeforeBankFeeCents: 600,
      driverPayoutCents: 300,
      platformGrossRevenueCents: 100,
      platformDriverCash: opts.snapshot === undefined ? SNAPSHOT : opts.snapshot,
    },
  } as unknown as Order;

  const offer = {
    id: "offer-1",
    orderId: ORDER,
    driverId: DRIVER,
    status: opts.offerStatus ?? "ACCEPTED",
    offeredAt: T0,
    expiresAt: "2030-01-01T00:00:00.000Z",
    resolvedAt: T0,
    cashReserveConfirmedAt:
      opts.reserveConfirmedAt === undefined ? T0 : opts.reserveConfirmedAt,
  };

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
      occurredAt: opts.arrivingAt ?? T5,
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
      occurredAt: opts.deliveredAt ?? T6,
      orderStatusBefore: "ARRIVING",
      orderStatusAfter: "DELIVERED",
    });
  }

  const cash: unknown[] = [];
  if (opts.reported !== false) {
    cash.push({
      id: driverCashHandoffReportEventId(ORDER),
      orderId: ORDER,
      driverId: DRIVER,
      restaurantId: REST,
      type: "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF",
      amountCents: 600,
      occurredAt: T2,
      actor: "DRIVER",
      restaurantWorkspaceRole: null,
    });
  }
  if (opts.confirmed !== false) {
    cash.push({
      id: restaurantCashReceiptEventId(ORDER),
      orderId: ORDER,
      driverId: DRIVER,
      restaurantId: REST,
      type: "RESTAURANT_CONFIRMED_CASH_RECEIPT",
      amountCents: 600,
      occurredAt: opts.confirmedAt ?? T3,
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
      occurredAt: opts.collectedAt ?? T6,
      actor: "DRIVER",
      restaurantWorkspaceRole: null,
    });
  }

  return {
    ...base,
    platformSettings: { ...base.platformSettings, platformDriverCashEnabled: true },
    orders: [order],
    driverOffers: [offer as unknown as PrototypeState["driverOffers"][number]],
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
const confirmInput = { cashCollectionConfirmed: true };
const noConfirm = { cashCollectionConfirmed: false };
const complete = (s: PrototypeState, now = T6, input = confirmInput) =>
  markDriverDeliveredOrder(s, DRIVER, ORDER, now, input);

// --- 1–3: schema / defaults ---------------------------------------------------

test("1: схема равна 23", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 23);
});
test("2/3: default cash выключен, событий нет", () => {
  const d = createDefaultState();
  assert.equal(d.platformSettings.platformDriverCashEnabled, false);
  assert.deepEqual(d.platformDriverCashEvents, []);
});

// --- 7–21: guards -------------------------------------------------------------

test("7/8/9/10: без подтверждения — точная ошибка, state и revision не меняются", () => {
  const s = cashState();
  const r = complete(s, T6, noConfirm);
  assert.equal(r.result.ok, false);
  assert.equal(
    r.result.error,
    "Перед завершением подтвердите получение полной суммы наличными от клиента.",
  );
  assert.equal(r.state, s);
  assert.equal(r.state.revision, s.revision);
  assert.equal(r.state.platformDriverCashEvents.length, s.platformDriverCashEvents.length);
});

test("11–14: без snapshot / offer / reserve / restaurant confirmation — fail", () => {
  assert.equal(complete(cashState({ snapshot: null })).result.ok, false);
  assert.equal(complete(cashState({ offerStatus: "OPEN" })).result.ok, false);
  assert.equal(complete(cashState({ reserveConfirmedAt: null })).result.ok, false);
  const noConfirmState = cashState({ confirmed: false });
  const r = complete(noConfirmState);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Ресторан ещё не подтвердил получение наличных.");
});

test("15/16/17: без pickup / без arriving / не ARRIVING — fail", () => {
  assert.equal(complete(cashState({ pickedUp: false })).result.ok, false);
  assert.equal(complete(cashState({ arriving: false })).result.ok, false);
  assert.equal(complete(cashState({ status: "OUT_FOR_DELIVERY" })).result.ok, false);
});

test("18/19: чужой водитель и не BUSY_DIRECT — fail", () => {
  const s = cashState();
  assert.equal(
    markDriverDeliveredOrder(s, "driver-2", ORDER, T6, confirmInput).result.ok,
    false,
  );
  assert.equal(complete(cashState({ driverStatus: "AVAILABLE" })).result.ok, false);
});

test("20/21: противоречивые paidAt/paymentStatus — fail", () => {
  assert.equal(complete(cashState({ paidAt: T5 })).result.ok, false);
  assert.equal(complete(cashState({ paymentStatus: "PAID" })).result.ok, false);
});

// --- 22–43: успешное атомарное завершение --------------------------------------

test("22–37: успех — событие, PAID, paidAt, DELIVERED, один рост ревизии", () => {
  const s = cashState();
  const r = complete(s);
  assert.equal(r.result.ok, true, r.result.error ?? "");
  const o = theOrder(r.state);

  const collection = r.state.platformDriverCashEvents.filter(
    (e) => e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
  );
  assert.equal(collection.length, 1);
  const ev = collection[0];
  assert.equal(ev.amountCents, SNAPSHOT.customerCollectionCents); // 23
  assert.equal(ev.actor, "DRIVER"); // 25
  assert.equal(ev.restaurantWorkspaceRole, null); // 26
  assert.equal(ev.driverId, DRIVER); // 27
  assert.equal(ev.occurredAt, T6); // 28
  assert.equal(ev.id, customerCashCollectionEventId(ORDER));
  // 24: событие не хранит прочие суммы snapshot.
  const keys = Object.keys(ev);
  for (const forbidden of [
    "restaurantHandoffCents",
    "driverEarningCents",
    "directReceivableFromDriverCents",
    "changeCents",
  ]) {
    assert.ok(!keys.includes(forbidden), forbidden);
  }

  assert.equal(o.paymentStatus, "PAID"); // 29
  assert.equal(o.paidAt, T6); // 30
  assert.equal(o.status, "DELIVERED"); // 31
  assert.equal(o.paymentMethod, "CASH");

  const delivered = r.state.driverDeliveryEvents.filter(
    (e) => e.type === "ORDER_DELIVERED" && e.driverId === DRIVER,
  );
  assert.equal(delivered.length, 1); // 32
  assert.equal(delivered[0].occurredAt, ev.occurredAt); // 33
  assert.equal(o.history.length, theOrder(s).history.length + 1); // 34

  const driver = r.state.drivers.find((d) => d.id === DRIVER);
  assert.ok(driver);
  assert.equal(driver.status, "ZONE_CONFIRMATION_REQUIRED"); // 35
  assert.equal(driver.suggestedZoneId, "zone-1"); // 36 (customerZoneId)
  assert.equal(r.state.revision, s.revision + 1); // 37
});

test("38/39: financials и cash snapshot не изменяются", () => {
  const s = cashState();
  const before = theOrder(s).financials;
  const after = theOrder(complete(s).state).financials;
  assert.deepEqual(after, before);
  assert.deepEqual(after.platformDriverCash, SNAPSHOT);
});

test("40–43: для CASH нет accounting/settlements/records/ledger", () => {
  const s = cashState();
  const r = complete(s);
  assert.deepEqual(r.state.restaurantAccountingEntries, s.restaurantAccountingEntries);
  assert.equal(r.state.restaurantAccountingEntries.length, 0);
  assert.deepEqual(r.state.settlements, s.settlements);
  assert.deepEqual(r.state.restaurantSettlementRecords, s.restaurantSettlementRecords);
  // 43: driver ledger не существует как поле состояния.
  assert.ok(!("driverCashLedger" in r.state));
  assert.ok(!("driverAccountingEntries" in r.state));
});

test("44–46: повторное завершение — idempotent no-op без дублей", () => {
  const first = complete(cashState());
  assert.equal(first.result.ok, true);
  const second = complete(first.state, T6);
  assert.equal(second.result.ok, true);
  assert.equal(second.state, first.state);
  assert.equal(
    second.state.platformDriverCashEvents.filter(
      (e) => e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
    ).length,
    1,
  );
  assert.equal(
    second.state.driverDeliveryEvents.filter((e) => e.type === "ORDER_DELIVERED").length,
    1,
  );
  assert.equal(second.state.revision, first.state.revision);
});

test("47: DELIVERED CASH без collection event — не no-op, а review", () => {
  const broken = cashState({
    status: "DELIVERED",
    paymentStatus: "PAID",
    paidAt: T6,
    delivered: true,
    collected: false,
    driverStatus: "AVAILABLE",
  });
  const r = complete(broken);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Данные наличной доставки требуют проверки Direct.");
  assert.equal(r.state, broken);
});

test("48: compatibility-завершение блокирует CASH-заказ", () => {
  const cash = cashState();
  const rc = markOrderDeliveredByDriverWithResult(cash, ORDER);
  assert.equal(rc.result.ok, false);
  assert.equal(rc.result.error, "Неподдерживаемый способ оплаты для этого завершения.");
  assert.equal(rc.state, cash);
  // CASH-заказ через этот путь не завершается даже частично.
  assert.equal(theOrder(rc.state).status, "ARRIVING");
  assert.equal(theOrder(rc.state).paymentStatus, "CASH_ON_DELIVERY");
});

test("4/5: ONLINE идёт прежним accounting-путём и не создаёт cash event", () => {
  // Полный ONLINE-lifecycle покрыт driver-delivery/driver-availability тестами.
  // Здесь важно, что ONLINE НЕ уходит в наличную ветку: он доходит до признания
  // обязательств ресторана (на синтетическом снимке движения денег нет —
  // fail-closed именно там), и наличного события не появляется.
  const online = cashState({ paymentMethod: "ONLINE", paymentStatus: "PAID", paidAt: T0 });
  const r = markDriverDeliveredOrder(online, DRIVER, ORDER, T6, noConfirm);
  assert.equal(r.result.error, "Неизвестный статус движения денег заказа.");
  assert.equal(
    r.state.platformDriverCashEvents.filter(
      (e) => e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
    ).length,
    0,
  );
  assert.equal(theOrder(r.state).paidAt, T0);
});

// --- 51–60: хронология --------------------------------------------------------

test("51/52: раньше restaurant confirmation или ARRIVING — точная ошибка", () => {
  const early = complete(cashState({ confirmedAt: T6 }), T5);
  assert.equal(early.result.ok, false);
  assert.equal(
    early.result.error,
    "Некорректное время подтверждения получения наличных.",
  );
  const beforeArriving = complete(cashState({ arrivingAt: T6 }), T5);
  assert.equal(beforeArriving.result.ok, false);
  assert.equal(
    beforeArriving.result.error,
    "Некорректное время подтверждения получения наличных.",
  );
});

test("53/54: равное и позднее время разрешены", () => {
  const equal = complete(cashState({ arrivingAt: T6 }), T6);
  assert.equal(equal.result.ok, true, equal.result.error ?? "");
  const later = complete(cashState(), T6);
  assert.equal(later.result.ok, true);
});

test("55/56: повреждённые timestamps prerequisite — fail-closed без исключения", () => {
  const badConfirm = complete(cashState({ confirmedAt: "не-дата" }));
  assert.equal(badConfirm.result.ok, false);
  const badArriving = complete(cashState({ arrivingAt: "не-дата" }));
  assert.equal(badArriving.result.ok, false);
  assert.equal(
    badArriving.result.error,
    "Данные наличной доставки требуют проверки Direct.",
  );
});

test("57–60: при chronology fail state, событие, paymentStatus и paidAt не меняются", () => {
  const s = cashState({ arrivingAt: T6 });
  const r = complete(s, T5);
  assert.equal(r.state, s);
  assert.equal(
    r.state.platformDriverCashEvents.filter(
      (e) => e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
    ).length,
    0,
  );
  assert.equal(theOrder(r.state).paymentStatus, "CASH_ON_DELIVERY");
  assert.equal(theOrder(r.state).paidAt, null);
});

// --- collection view ----------------------------------------------------------

test("view: NOT_APPLICABLE / ACTION_REQUIRED / COLLECTED", () => {
  const online = cashState({ paymentMethod: "ONLINE", paymentStatus: "PAID", paidAt: T0 });
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(online, theOrder(online)).status,
    "NOT_APPLICABLE",
  );
  const ready = cashState();
  const v = getPlatformDriverCustomerCashCollectionView(ready, theOrder(ready));
  assert.equal(v.status, "ACTION_REQUIRED");
  assert.equal(v.amountCents, 1000);
  const done = complete(ready).state;
  const dv = getPlatformDriverCustomerCashCollectionView(done, theOrder(done));
  assert.equal(dv.status, "COLLECTED");
  assert.equal(dv.collectedAt, T6);
  assert.equal(hasValidPlatformDriverCustomerCashCollection(done, theOrder(done)), true);
});

test("view: REVIEW при несогласованном завершении", () => {
  const broken = cashState({
    status: "DELIVERED",
    paymentStatus: "PAID",
    paidAt: T6,
    delivered: true,
    collected: false,
  });
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(broken, theOrder(broken)).status,
    "REVIEW_REQUIRED",
  );
});

// --- 61–95: persistence -------------------------------------------------------

/** Завершённое валидное состояние, разобранное из указанной схемы. */
function persistCompleted(schemaVersion: number): PrototypeState {
  const done = complete(cashState()).state;
  const parsed = parseStoredState(JSON.stringify({ ...done, schemaVersion }));
  assert.ok(parsed);
  return parsed;
}

test("61: схемы 7–20 получают пустой cash-журнал", () => {
  for (const v of [7, 15, 20]) {
    assert.deepEqual(persistCompleted(v).platformDriverCashEvents, []);
  }
});

test("62–64: схема 21 хранит два события, но отбрасывает customer collection", () => {
  const parsed = persistCompleted(21);
  const types = parsed.platformDriverCashEvents.map((e) => e.type);
  assert.ok(types.includes("DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF"));
  assert.ok(types.includes("RESTAURANT_CONFIRMED_CASH_RECEIPT"));
  assert.ok(!types.includes("DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION"));
});

test("65/90: схема 22 хранит три события в каноническом порядке", () => {
  const parsed = persistCompleted(22);
  assert.deepEqual(
    parsed.platformDriverCashEvents.map((e) => e.type),
    [
      "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF",
      "RESTAURANT_CONFIRMED_CASH_RECEIPT",
      "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
    ],
  );
});

/** Разбор завершённого состояния с изменённым customer collection событием. */
function parseCollected(
  over: Record<string, unknown> = {},
  orderOver: Record<string, unknown> = {},
  deliveryOver: Record<string, unknown> | null = null,
): PrototypeState {
  const done = complete(cashState()).state;
  const events = done.platformDriverCashEvents.map((e) =>
    e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION" ? { ...e, ...over } : e,
  );
  const de = deliveryOver
    ? done.driverDeliveryEvents.map((e) =>
        e.type === "ORDER_DELIVERED" ? { ...e, ...deliveryOver } : e,
      )
    : done.driverDeliveryEvents;
  const parsed = parseStoredState(
    JSON.stringify({
      ...done,
      schemaVersion: 22,
      platformDriverCashEvents: events,
      driverDeliveryEvents: de,
      orders: done.orders.map((o) => ({ ...o, ...orderOver })),
    }),
  );
  assert.ok(parsed);
  return parsed;
}

const collectionCount = (s: PrototypeState) =>
  s.platformDriverCashEvents.filter(
    (e) => e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
  ).length;

test("73–87: невалидное customer collection событие удаляется", () => {
  assert.equal(collectionCount(parseCollected({ actor: "RESTAURANT" })), 0); // 74
  assert.equal(
    collectionCount(parseCollected({ restaurantWorkspaceRole: "OPERATOR" })),
    0,
  ); // 75
  assert.equal(collectionCount(parseCollected({ driverId: "driver-2" })), 0); // 76
  assert.equal(collectionCount(parseCollected({ restaurantId: "restaurant-1" })), 0); // 77
  assert.equal(collectionCount(parseCollected({ amountCents: 1000.5 })), 0); // 78
  assert.equal(collectionCount(parseCollected({ amountCents: 1001 })), 0); // 79
  assert.equal(collectionCount(parseCollected({ occurredAt: "не-дата" })), 0); // 80
  // 83: время != paidAt
  assert.equal(collectionCount(parseCollected({ occurredAt: T5 })), 0);
  // 84: время != ORDER_DELIVERED
  assert.equal(collectionCount(parseCollected({}, {}, { occurredAt: T5 })), 0);
  // 85/86/87: заказ не DELIVERED / не PAID / без paidAt
  assert.equal(collectionCount(parseCollected({}, { status: "ARRIVING" })), 0);
  assert.equal(
    collectionCount(parseCollected({}, { paymentStatus: "CASH_ON_DELIVERY" })),
    0,
  );
  assert.equal(collectionCount(parseCollected({}, { paidAt: null })), 0);
});

test("66–72: без предшествующих событий customer collection удаляется", () => {
  const done = complete(cashState()).state;
  const strip = (
    dropCash: string[] = [],
    dropDelivery: string[] = [],
    offerOver: Record<string, unknown> = {},
  ) => {
    const parsed = parseStoredState(
      JSON.stringify({
        ...done,
        schemaVersion: 22,
        platformDriverCashEvents: done.platformDriverCashEvents.filter(
          (e) => !dropCash.includes(e.type),
        ),
        driverDeliveryEvents: done.driverDeliveryEvents.filter(
          (e) => !dropDelivery.includes(e.type),
        ),
        driverOffers: done.driverOffers.map((o) => ({ ...o, ...offerOver })),
      }),
    );
    assert.ok(parsed);
    return collectionCount(parsed);
  };
  assert.equal(strip(["DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF"]), 0); // 66
  assert.equal(strip(["RESTAURANT_CONFIRMED_CASH_RECEIPT"]), 0); // 67
  assert.equal(strip([], [], { status: "OPEN" }), 0); // 68
  assert.equal(strip([], [], { cashReserveConfirmedAt: null }), 0); // 69
  assert.equal(strip([], ["ORDER_PICKED_UP"]), 0); // 70
  assert.equal(strip([], ["ARRIVING_TO_CUSTOMER"]), 0); // 71
  assert.equal(strip([], ["ORDER_DELIVERED"]), 0); // 72
});

test("88: дубликат customer collection — сохраняется первый валидный", () => {
  const done = complete(cashState()).state;
  const ev = done.platformDriverCashEvents.find(
    (e) => e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
  );
  assert.ok(ev);
  const parsed = parseStoredState(
    JSON.stringify({
      ...done,
      schemaVersion: 22,
      platformDriverCashEvents: [
        ...done.platformDriverCashEvents,
        { ...ev, id: "duplicate-id" },
      ],
    }),
  );
  assert.ok(parsed);
  assert.equal(collectionCount(parsed), 1);
});

test("91–95: serialize/parse идемпотентен, завершённый CASH сохраняется", () => {
  const done = complete(cashState()).state;
  const p1 = parseStoredState(JSON.stringify(done));
  assert.ok(p1);
  const p2 = parseStoredState(JSON.stringify(p1));
  assert.ok(p2);
  assert.deepEqual(p2.platformDriverCashEvents, p1.platformDriverCashEvents);
  const o = p2.orders[0];
  assert.equal(o.status, "DELIVERED"); // 92
  assert.equal(o.paymentMethod, "CASH");
  assert.equal(o.paymentStatus, "PAID"); // 93
  assert.equal(o.paidAt, T6); // 94
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(p2, o).status,
    "COLLECTED",
  ); // 95
});

// --- 96–117: UI (источники) ---------------------------------------------------

const WORKSPACE = readFileSync("src/components/driver/driver-workspace.tsx", "utf8");
const CSS = readFileSync("src/app/driver/driver.module.css", "utf8");

function cssRule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  assert.notEqual(start, -1, selector);
  const open = CSS.indexOf("{", start);
  return CSS.slice(open + 1, CSS.indexOf("}", open));
}

test("96/97: GO_TO_CUSTOMER показывает сумму, главная кнопка «Я подъезжаю»", () => {
  assert.ok(WORKSPACE.includes("Получить от клиента:"));
  assert.ok(WORKSPACE.includes("Я подъезжаю"));
});

test("99–101: ARRIVING — заголовок, сумма и кнопка получения", () => {
  assert.ok(WORKSPACE.includes("Получите оплату и передайте заказ"));
  assert.ok(WORKSPACE.includes("Получите от клиента ${customerAmount} наличными."));
  assert.ok(WORKSPACE.includes("Получил {customerAmount} и передал заказ"));
});

test("102/103: первое нажатие открывает лист, а не завершает заказ", () => {
  assert.ok(WORKSPACE.includes("onClick={openCollect}"));
  assert.ok(WORKSPACE.includes("setCollectOpen(true)"));
});

test("104–108: лист подтверждения — заголовок, текст, кнопки, confirmed true", () => {
  assert.ok(WORKSPACE.includes("Подтвердите оплату и доставку"));
  assert.ok(
    WORKSPACE.includes(
      "Подтвердите, что вы получили от клиента {customerAmount} наличными и",
    ),
  );
  assert.ok(WORKSPACE.includes("Деньги получены, заказ передан"));
  assert.ok(WORKSPACE.includes("Отмена"));
  assert.ok(WORKSPACE.includes("cashCollectionConfirmed: true"));
});

test("110–112: ONLINE — one-tap «Заказ доставлен» с confirmed false", () => {
  assert.ok(WORKSPACE.includes("cashCollectionConfirmed: false"));
  assert.ok(WORKSPACE.includes("Заказ доставлен"));
});

test("113: нет текстов долга/ledger водителя", () => {
  for (const forbidden of [
    "Вы должны Direct",
    "Ваш долг",
    "Долг водителя",
    "Погасить задолженность",
    "Баланс водителя",
  ]) {
    assert.ok(!WORKSPACE.includes(forbidden), forbidden);
  }
});

test("114–117: sheet-кнопки 52/44px, используется общий DriverControlSheet", () => {
  assert.ok(cssRule(".cashConfirmPrimary").includes("min-height: 52px"));
  assert.ok(cssRule(".cashConfirmSecondary").includes("min-height: 44px"));
  assert.ok(WORKSPACE.includes("DriverControlSheet"));
  // Второго overlay-движка нет: sheetBackdrop живёт только в общем компоненте.
  assert.ok(!WORKSPACE.includes("sheetBackdrop"));
});

// =============================================================================
// REPAIR: prepared-completion validator, pickup в COLLECTED и хронология pickup
// =============================================================================

/** Подготовленное (ещё не финализированное) наличное завершение. */
const preparedState = (over: Opts = {}) =>
  cashState({ paymentStatus: "PAID", paidAt: T6, collected: true, ...over });

/** Добавляет driver delivery событие (для дублей/повреждений). */
function withDeliveryEvent(
  s: PrototypeState,
  ev: Record<string, unknown>,
): PrototypeState {
  return {
    ...s,
    driverDeliveryEvents: [
      ...s.driverDeliveryEvents,
      ev as unknown as PrototypeState["driverDeliveryEvents"][number],
    ],
  };
}

/** Переписывает driver delivery события состояния. */
function mapDelivery(
  s: PrototypeState,
  fn: (e: PrototypeState["driverDeliveryEvents"][number]) => unknown | null,
): PrototypeState {
  return {
    ...s,
    driverDeliveryEvents: s.driverDeliveryEvents
      .map((e) => fn(e))
      .filter((e) => e !== null) as PrototypeState["driverDeliveryEvents"],
  };
}

// --- r1–r8: COLLECTED требует pickup и его хронологию -------------------------

test("r1: завершённый CASH без ORDER_PICKED_UP → REVIEW_REQUIRED", () => {
  const done = complete(cashState()).state;
  const noPickup = mapDelivery(done, (e) =>
    e.type === "ORDER_PICKED_UP" ? null : e,
  );
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(noPickup, theOrder(noPickup)).status,
    "REVIEW_REQUIRED",
  );
});

test("r2: два runtime ORDER_PICKED_UP → REVIEW_REQUIRED", () => {
  const done = complete(cashState()).state;
  const dup = withDeliveryEvent(done, {
    id: "de-2-dup",
    orderId: ORDER,
    driverId: DRIVER,
    type: "ORDER_PICKED_UP",
    occurredAt: T4,
    orderStatusBefore: "READY",
    orderStatusAfter: "OUT_FOR_DELIVERY",
  });
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(dup, theOrder(dup)).status,
    "REVIEW_REQUIRED",
  );
});

test("r3: получение денег раньше pickup → REVIEW_REQUIRED", () => {
  const done = complete(cashState()).state;
  const late = mapDelivery(done, (e) =>
    e.type === "ORDER_PICKED_UP"
      ? { ...e, occurredAt: "2026-07-22T23:00:00.000Z" }
      : e,
  );
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(late, theOrder(late)).status,
    "REVIEW_REQUIRED",
  );
});

test("r4: pickup позже arriving → REVIEW_REQUIRED", () => {
  const done = complete(cashState()).state;
  const broken = mapDelivery(done, (e) =>
    e.type === "ORDER_PICKED_UP"
      ? { ...e, occurredAt: T5 }
      : e.type === "ARRIVING_TO_CUSTOMER"
        ? { ...e, occurredAt: T4 }
        : e,
  );
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(broken, theOrder(broken)).status,
    "REVIEW_REQUIRED",
  );
});

test("r5/r6: равное время pickup и согласованный state → COLLECTED", () => {
  const equal = complete(cashState({ arrivingAt: T6 })).state;
  const sameMs = mapDelivery(equal, (e) =>
    e.type === "ORDER_PICKED_UP" ? { ...e, occurredAt: T6 } : e,
  );
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(sameMs, theOrder(sameMs)).status,
    "COLLECTED",
  );
  const normal = complete(cashState()).state;
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(normal, theOrder(normal)).status,
    "COLLECTED",
  );
});

test("r7/r8: ACTION_REQUIRED и ONLINE NOT_APPLICABLE не регрессируют", () => {
  const active = cashState();
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(active, theOrder(active)).status,
    "ACTION_REQUIRED",
  );
  // Отсутствие pickup на раннем этапе не превращает заказ в REVIEW.
  const early = mapDelivery(active, (e) =>
    e.type === "ORDER_PICKED_UP" ? null : e,
  );
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(early, theOrder(early)).status,
    "ACTION_REQUIRED",
  );
  const online = cashState({ paymentMethod: "ONLINE", paymentStatus: "PAID", paidAt: T0 });
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(online, theOrder(online)).status,
    "NOT_APPLICABLE",
  );
});

// --- r9–r17: normalizer pickup chronology -------------------------------------

test("r9–r12: schema 22 удаляет collection без/с некорректным pickup", () => {
  const done = complete(cashState()).state;
  const reparse = (
    fn: (e: PrototypeState["driverDeliveryEvents"][number]) => unknown | null,
  ) => {
    const parsed = parseStoredState(
      JSON.stringify({ ...mapDelivery(done, fn), schemaVersion: 22 }),
    );
    assert.ok(parsed);
    return collectionCount(parsed);
  };
  assert.equal(reparse((e) => (e.type === "ORDER_PICKED_UP" ? null : e)), 0); // r9
  assert.equal(
    reparse((e) =>
      e.type === "ORDER_PICKED_UP" ? { ...e, occurredAt: "не-дата" } : e,
    ),
    0,
  ); // r10
  assert.equal(
    reparse((e) =>
      e.type === "ORDER_PICKED_UP"
        ? { ...e, occurredAt: "2026-07-22T23:00:00.000Z" }
        : e,
    ),
    0,
  ); // r11
  assert.equal(
    reparse((e) =>
      e.type === "ORDER_PICKED_UP"
        ? { ...e, occurredAt: T5 }
        : e.type === "ARRIVING_TO_CUSTOMER"
          ? { ...e, occurredAt: T4 }
          : e,
    ),
    0,
  ); // r12
});

test("r13/r14: равное и более позднее время collection сохраняются", () => {
  const equal = complete(cashState({ arrivingAt: T6 })).state;
  const sameMs = mapDelivery(equal, (e) =>
    e.type === "ORDER_PICKED_UP" ? { ...e, occurredAt: T6 } : e,
  );
  const p1 = parseStoredState(JSON.stringify({ ...sameMs, schemaVersion: 22 }));
  assert.ok(p1);
  assert.equal(collectionCount(p1), 1);

  const later = complete(cashState()).state;
  const p2 = parseStoredState(JSON.stringify({ ...later, schemaVersion: 22 }));
  assert.ok(p2);
  assert.equal(collectionCount(p2), 1);
});

test("r15–r17: после parse COLLECTED, канонический порядок, идемпотентность", () => {
  const done = complete(cashState()).state;
  const p1 = parseStoredState(JSON.stringify(done));
  assert.ok(p1);
  assert.equal(
    getPlatformDriverCustomerCashCollectionView(p1, p1.orders[0]).status,
    "COLLECTED",
  );
  assert.deepEqual(
    p1.platformDriverCashEvents.map((e) => e.type),
    [
      "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF",
      "RESTAURANT_CONFIRMED_CASH_RECEIPT",
      "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
    ],
  );
  const p2 = parseStoredState(JSON.stringify(p1));
  assert.ok(p2);
  assert.deepEqual(p2.platformDriverCashEvents, p1.platformDriverCashEvents);
});

// --- r18–r30: прямые вызовы applyDriverDeliveredOrder -------------------------

const applyDirect = (s: PrototypeState, now = T6) =>
  applyDriverDeliveredOrder(s, theOrder(s), now);

test("r18/r26/r27: PAID + paidAt без collection event → fail, ничего не меняется", () => {
  const s = cashState({ paymentStatus: "PAID", paidAt: T6, collected: false });
  const r = applyDirect(s);
  assert.equal(r.ok, false);
  assert.equal(theOrder(s).status, "ARRIVING");
  assert.equal(s.drivers.find((d) => d.id === DRIVER)?.status, "BUSY_DIRECT");
});

test("r19: collection без подтверждения ресторана → fail", () => {
  assert.equal(applyDirect(preparedState({ confirmed: false })).ok, false);
});

test("r20: collection с неправильной суммой → fail", () => {
  const s = preparedState();
  const wrong: PrototypeState = {
    ...s,
    platformDriverCashEvents: s.platformDriverCashEvents.map((e) =>
      e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION"
        ? { ...e, amountCents: 999 }
        : e,
    ),
  };
  assert.equal(applyDirect(wrong).ok, false);
});

test("r21/r22: collection без pickup или без arriving → fail", () => {
  assert.equal(applyDirect(preparedState({ pickedUp: false })).ok, false);
  assert.equal(applyDirect(preparedState({ arriving: false })).ok, false);
});

test("r23: collection раньше pickup → fail с chronology-ошибкой", () => {
  const late = mapDelivery(preparedState(), (e) =>
    e.type === "ORDER_PICKED_UP"
      ? { ...e, occurredAt: "2026-07-22T23:00:00.000Z" }
      : e,
  );
  const r = applyDirect(late);
  assert.equal(r.ok, false);
  assert.equal(
    r.ok === false ? r.error : "",
    "Некорректное время подтверждения получения наличных.",
  );
});

test("r24/r28/r29: валидное prepared состояние → success без accounting/settlements", () => {
  const s = preparedState();
  const r = applyDirect(s);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.state.orders[0].status, "DELIVERED");
  assert.equal(
    r.state.drivers.find((d) => d.id === DRIVER)?.status,
    "ZONE_CONFIRMATION_REQUIRED",
  );
  assert.equal(r.state.restaurantAccountingEntries.length, 0);
  assert.equal(r.state.settlements.length, 0);
  // Helper сам ORDER_DELIVERED не добавляет — это делает driver lifecycle action.
  assert.equal(
    r.state.driverDeliveryEvents.filter((e) => e.type === "ORDER_DELIVERED").length,
    0,
  );
});

test("r25: при fail исходное состояние не мутируется", () => {
  const s = preparedState({ pickedUp: false });
  const before = JSON.stringify(s);
  assert.equal(applyDirect(s).ok, false);
  assert.equal(JSON.stringify(s), before);
});

test("r30: ONLINE прямой helper идёт прежним accounting-путём", () => {
  const online = cashState({ paymentMethod: "ONLINE", paymentStatus: "PAID", paidAt: T0 });
  const r = applyDriverDeliveredOrder(online, theOrder(online), T6);
  assert.equal(r.ok, false);
  assert.equal(
    r.ok === false ? r.error : "",
    "Неизвестный статус движения денег заказа.",
  );
});
