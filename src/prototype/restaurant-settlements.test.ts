import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRestaurantSettlementOverview,
  getOrderCanceledAt,
  getOrderCompletedAt,
  type RestaurantSettlementPeriod,
} from "./restaurant-settlements.ts";
import { createDefaultState } from "./default-state.ts";
import {
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
} from "./actions.ts";
import type {
  DeliveryMode,
  FinancialSnapshot,
  Order,
  OrderHistoryEvent,
  OrderStatus,
  PaymentStatus,
  PrototypeState,
  SettlementEntry,
} from "./models.ts";

const RESTAURANT_ID = "restaurant-1";
const TZ = "Europe/Chisinau";

/** Реальный FinancialSnapshot как шаблон — все обязательные поля валидны. */
function templateFinancials(): FinancialSnapshot {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, `${RESTAURANT_ID}-item-1`).state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  const order = created.state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order.financials;
}

const BASE_FIN = templateFinancials();
const TEMPLATE_ORDER = (() => {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, `${RESTAURANT_ID}-item-1`).state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  const order = created.state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
})();

let seq = 0;

function statusEvent(
  from: OrderStatus,
  to: OrderStatus,
  occurredAt: string,
): OrderHistoryEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    occurredAt,
    actor: "SYSTEM",
    type: "STATUS",
    fromStatus: from,
    toStatus: to,
  };
}

function makeOrder(opts: {
  id: string;
  publicNumber?: string;
  status: OrderStatus;
  deliveryMode: DeliveryMode;
  completedAt?: string;
  updatedAt?: string;
  paymentStatus?: PaymentStatus;
  paidAt?: string | null;
  history?: OrderHistoryEvent[];
  fin?: Partial<FinancialSnapshot>;
  restaurantId?: string;
}): Order {
  return {
    ...TEMPLATE_ORDER,
    id: opts.id,
    publicNumber: opts.publicNumber ?? `DIR-${opts.id}`,
    status: opts.status,
    deliveryMode: opts.deliveryMode,
    updatedAt: opts.updatedAt ?? opts.completedAt ?? "2026-07-17T10:00:00.000Z",
    paymentStatus: opts.paymentStatus ?? "PAID",
    paidAt: opts.paidAt === undefined ? "2026-07-17T09:00:00.000Z" : opts.paidAt,
    history: opts.history ?? [],
    financials: { ...BASE_FIN, deliveryMode: opts.deliveryMode, ...opts.fin },
    restaurant: {
      ...TEMPLATE_ORDER.restaurant,
      id: opts.restaurantId ?? RESTAURANT_ID,
    },
  };
}

function stateWith(
  orders: Order[],
  settlements: SettlementEntry[] = [],
): PrototypeState {
  return { ...createDefaultState(), orders, settlements };
}

const NOW = "2026-07-17T12:00:00.000Z";

// 1 --------------------------------------------------------------------------

test("в итоги входят только DELIVERED и PICKED_UP", () => {
  const orders = [
    makeOrder({
      id: "d1",
      status: "DELIVERED",
      deliveryMode: "PLATFORM_DRIVER",
      completedAt: "2026-07-17T10:00:00.000Z",
      history: [
        statusEvent("ARRIVING", "DELIVERED", "2026-07-17T10:00:00.000Z"),
      ],
      fin: { customerTotalCents: 5000 },
    }),
    makeOrder({
      id: "p1",
      status: "PICKED_UP",
      deliveryMode: "PICKUP",
      completedAt: "2026-07-17T11:00:00.000Z",
      history: [
        statusEvent("READY_FOR_PICKUP", "PICKED_UP", "2026-07-17T11:00:00.000Z"),
      ],
      fin: { customerTotalCents: 3000 },
    }),
    makeOrder({
      id: "prep",
      status: "PREPARING",
      deliveryMode: "PICKUP",
      fin: { customerTotalCents: 9999 },
    }),
    makeOrder({
      id: "ready",
      status: "READY",
      deliveryMode: "PLATFORM_DRIVER",
      fin: { customerTotalCents: 8888 },
    }),
  ];
  const ov = buildRestaurantSettlementOverview(
    stateWith(orders),
    RESTAURANT_ID,
    "ALL",
    NOW,
    TZ,
  );
  assert.equal(ov.summary.completedOrderCount, 2);
  assert.equal(ov.summary.customerTotalCents, 8000);
  assert.equal(ov.rows.length, 2);
  assert.ok(ov.rows.every((r) => r.orderId === "d1" || r.orderId === "p1"));
});

// 2 --------------------------------------------------------------------------

test("активные и CANCELED не входят в основные суммы", () => {
  const orders = [
    makeOrder({
      id: "d1",
      status: "DELIVERED",
      deliveryMode: "PLATFORM_DRIVER",
      completedAt: NOW,
      history: [statusEvent("ARRIVING", "DELIVERED", NOW)],
      fin: { customerTotalCents: 5000 },
    }),
    makeOrder({
      id: "c1",
      status: "CANCELED",
      deliveryMode: "PICKUP",
      paymentStatus: "AWAITING_PAYMENT",
      paidAt: null,
      history: [statusEvent("PREPARING", "CANCELED", NOW)],
      fin: { customerTotalCents: 4000 },
    }),
    makeOrder({
      id: "prep",
      status: "PREPARING",
      deliveryMode: "PICKUP",
      fin: { customerTotalCents: 7000 },
    }),
  ];
  const ov = buildRestaurantSettlementOverview(
    stateWith(orders),
    RESTAURANT_ID,
    "ALL",
    NOW,
    TZ,
  );
  assert.equal(ov.summary.completedOrderCount, 1);
  assert.equal(ov.summary.customerTotalCents, 5000);
  assert.equal(ov.paidCanceled.length, 0); // c1 не оплачен
});

// 3 --------------------------------------------------------------------------

test("completedAt из реального перехода; same-status игнор; legacy fallback", () => {
  const real = makeOrder({
    id: "d1",
    status: "DELIVERED",
    deliveryMode: "PLATFORM_DRIVER",
    history: [
      statusEvent("OUT_FOR_DELIVERY", "ARRIVING", "2026-07-17T09:00:00.000Z"),
      statusEvent("ARRIVING", "DELIVERED", "2026-07-17T10:00:00.000Z"),
      // Техническое same-status событие ПОСЛЕ завершения — игнорируется.
      statusEvent("DELIVERED", "DELIVERED", "2026-07-17T10:05:00.000Z"),
    ],
  });
  assert.equal(getOrderCompletedAt(real), "2026-07-17T10:00:00.000Z");

  const legacy = makeOrder({
    id: "d2",
    status: "PICKED_UP",
    deliveryMode: "PICKUP",
    updatedAt: "2026-07-16T08:00:00.000Z",
    history: [], // нет перехода — fallback updatedAt
  });
  assert.equal(getOrderCompletedAt(legacy), "2026-07-16T08:00:00.000Z");

  const canceled = makeOrder({
    id: "c1",
    status: "CANCELED",
    deliveryMode: "PICKUP",
    updatedAt: "2026-07-15T08:00:00.000Z",
    history: [statusEvent("PREPARING", "CANCELED", "2026-07-15T07:00:00.000Z")],
  });
  assert.equal(getOrderCanceledAt(canceled), "2026-07-15T07:00:00.000Z");
});

// 4 --------------------------------------------------------------------------

test("смешанные типы дают точные суммы из своих FinancialSnapshot", () => {
  const orders = [
    makeOrder({
      id: "pickup",
      status: "PICKED_UP",
      deliveryMode: "PICKUP",
      completedAt: NOW,
      history: [statusEvent("READY_FOR_PICKUP", "PICKED_UP", NOW)],
      fin: {
        customerTotalCents: 2000,
        foodSubtotalCents: 2000,
        restaurantCollectedFromCustomerCents: 2000,
        platformCollectedFromCustomerCents: 0,
        platformCommissionReceivableCents: 300,
        restaurantNetAfterPlatformCommissionCents: 1700,
      },
    }),
    makeOrder({
      id: "platform",
      status: "DELIVERED",
      deliveryMode: "PLATFORM_DRIVER",
      completedAt: NOW,
      history: [statusEvent("ARRIVING", "DELIVERED", NOW)],
      fin: {
        customerTotalCents: 5000,
        foodSubtotalCents: 4000,
        restaurantCollectedFromCustomerCents: 0,
        platformCollectedFromCustomerCents: 5000,
        platformCommissionReceivableCents: 600,
        restaurantNetAfterPlatformCommissionCents: 3400,
      },
    }),
    makeOrder({
      id: "restdelivery",
      status: "DELIVERED",
      deliveryMode: "RESTAURANT_DELIVERY",
      completedAt: NOW,
      history: [statusEvent("ARRIVING", "DELIVERED", NOW)],
      fin: {
        customerTotalCents: 3000,
        foodSubtotalCents: 2500,
        restaurantCollectedFromCustomerCents: 3000,
        platformCollectedFromCustomerCents: 0,
        platformCommissionReceivableCents: 400,
        restaurantNetAfterPlatformCommissionCents: 2600,
      },
    }),
  ];
  const ov = buildRestaurantSettlementOverview(
    stateWith(orders),
    RESTAURANT_ID,
    "ALL",
    NOW,
    TZ,
  );
  assert.equal(ov.summary.completedOrderCount, 3);
  assert.equal(ov.summary.customerTotalCents, 10000);
  assert.equal(ov.summary.foodSubtotalCents, 8500);
  assert.equal(ov.summary.restaurantCollectedFromCustomerCents, 5000);
  assert.equal(ov.summary.platformCollectedFromCustomerCents, 5000);
  assert.equal(ov.summary.platformCommissionReceivableCents, 1300);
  assert.equal(ov.summary.restaurantNetCents, 7700);

  const byId = Object.fromEntries(ov.rows.map((r) => [r.orderId, r]));
  assert.equal(byId.pickup.collector, "RESTAURANT");
  assert.equal(byId.platform.collector, "DIRECT");
  assert.equal(byId.restdelivery.collector, "RESTAURANT");
});

// 5 --------------------------------------------------------------------------

test("snapshot invariant: изменение меню/комиссии/тарифов/настроек не меняет отчёт", () => {
  const orders = [
    makeOrder({
      id: "d1",
      status: "DELIVERED",
      deliveryMode: "PLATFORM_DRIVER",
      completedAt: NOW,
      history: [statusEvent("ARRIVING", "DELIVERED", NOW)],
      fin: { customerTotalCents: 5000, foodSubtotalCents: 4000 },
    }),
  ];
  const base = stateWith(orders);
  const before = buildRestaurantSettlementOverview(base, RESTAURANT_ID, "ALL", NOW, TZ);

  const mutated: PrototypeState = {
    ...base,
    menuItems: base.menuItems.map((m) => ({ ...m, priceCents: 999999, name: "X" })),
    restaurants: base.restaurants.map((r) =>
      r.id === RESTAURANT_ID ? { ...r, commissionRateBps: 9999 } : r,
    ),
    platformSettings: { ...base.platformSettings },
  };
  const after = buildRestaurantSettlementOverview(mutated, RESTAURANT_ID, "ALL", NOW, TZ);

  assert.deepEqual(after.summary, before.summary);
  assert.equal(after.summary.customerTotalCents, 5000);
  assert.equal(after.summary.foodSubtotalCents, 4000);
});

// 6 --------------------------------------------------------------------------

test("PENDING ledger из state.settlements; PAID/NETTED/WAIVED не входят", () => {
  const orders = [
    makeOrder({
      id: "o1",
      status: "PICKED_UP",
      deliveryMode: "PICKUP",
      completedAt: NOW,
      history: [statusEvent("READY_FOR_PICKUP", "PICKED_UP", NOW)],
      fin: { platformCommissionReceivableCents: 300 },
    }),
    makeOrder({
      id: "o2",
      status: "DELIVERED",
      deliveryMode: "RESTAURANT_DELIVERY",
      completedAt: NOW,
      history: [statusEvent("ARRIVING", "DELIVERED", NOW)],
      fin: { platformCommissionReceivableCents: 500 },
    }),
  ];
  const settlements: SettlementEntry[] = [
    { id: "s1", orderId: "o1", restaurantId: RESTAURANT_ID, type: "PICKUP_COMMISSION", amountCents: 300, status: "PENDING", createdAt: NOW },
    { id: "s2", orderId: "o2", restaurantId: RESTAURANT_ID, type: "RESTAURANT_DELIVERY_COMMISSION", amountCents: 500, status: "PAID", createdAt: NOW },
  ];
  const ov = buildRestaurantSettlementOverview(
    stateWith(orders, settlements),
    RESTAURANT_ID,
    "ALL",
    NOW,
    TZ,
  );
  // Только PENDING (o1). PAID (o2) не входит.
  assert.equal(ov.summary.pendingLedgerCents, 300);
  // Snapshot-комиссия отдельно и включает обе.
  assert.equal(ov.summary.platformCommissionReceivableCents, 800);
});

// 7 --------------------------------------------------------------------------

test("строка заказа связывает SettlementEntry по orderId", () => {
  const orders = [
    makeOrder({
      id: "o1",
      status: "PICKED_UP",
      deliveryMode: "PICKUP",
      completedAt: NOW,
      history: [statusEvent("READY_FOR_PICKUP", "PICKED_UP", NOW)],
    }),
    makeOrder({
      id: "o2",
      status: "PICKED_UP",
      deliveryMode: "PICKUP",
      completedAt: NOW,
      history: [statusEvent("READY_FOR_PICKUP", "PICKED_UP", NOW)],
    }),
  ];
  const settlements: SettlementEntry[] = [
    { id: "s1", orderId: "o1", restaurantId: RESTAURANT_ID, type: "PICKUP_COMMISSION", amountCents: 250, status: "PENDING", createdAt: NOW },
  ];
  const ov = buildRestaurantSettlementOverview(
    stateWith(orders, settlements),
    RESTAURANT_ID,
    "ALL",
    NOW,
    TZ,
  );
  const byId = Object.fromEntries(ov.rows.map((r) => [r.orderId, r]));
  assert.ok(byId.o1.ledger);
  assert.equal(byId.o1.ledger.amountCents, 250);
  assert.equal(byId.o1.ledger.type, "PICKUP_COMMISSION");
  assert.equal(byId.o1.ledger.status, "PENDING");
  assert.equal(byId.o2.ledger, null); // «Начисления нет»
});

// 8 --------------------------------------------------------------------------

test("paid canceled: в «Требуют внимания», не в completed totals, refund не выдуман", () => {
  const orders = [
    makeOrder({
      id: "cpaid",
      status: "CANCELED",
      deliveryMode: "PLATFORM_DRIVER",
      paymentStatus: "PAID",
      paidAt: "2026-07-17T08:00:00.000Z",
      history: [statusEvent("PREPARING", "CANCELED", "2026-07-17T09:00:00.000Z")],
      fin: { customerTotalCents: 6000 },
    }),
    makeOrder({
      id: "cunpaid",
      status: "CANCELED",
      deliveryMode: "PICKUP",
      paymentStatus: "AWAITING_PAYMENT",
      paidAt: null,
      history: [statusEvent("PREPARING", "CANCELED", NOW)],
      fin: { customerTotalCents: 4000 },
    }),
  ];
  const ov = buildRestaurantSettlementOverview(
    stateWith(orders),
    RESTAURANT_ID,
    "ALL",
    NOW,
    TZ,
  );
  assert.equal(ov.summary.completedOrderCount, 0);
  assert.equal(ov.summary.customerTotalCents, 0);
  assert.equal(ov.paidCanceled.length, 1);
  assert.equal(ov.paidCanceled[0].orderId, "cpaid");
  assert.equal(ov.paidCanceled[0].paymentStatus, "PAID");
  assert.equal(ov.paidCanceled[0].customerTotalCents, 6000);
  assert.equal(ov.paidCanceled[0].canceledAt, "2026-07-17T09:00:00.000Z");
  // Никаких выдуманных полей resolution/refund.
  assert.ok(!("refund" in ov.paidCanceled[0]));
  assert.ok(!("resolution" in ov.paidCanceled[0]));
});

// 9 --------------------------------------------------------------------------

test("периоды в часовом поясе ресторана, границы около полуночи", () => {
  // Chisinau летом UTC+3. now = 03:30 местного 17 июля.
  const now = "2026-07-17T00:30:00.000Z";
  // 22:00Z 16-го = 01:00 местного 17-го → сегодня.
  const afterMidnight = "2026-07-16T22:00:00.000Z";
  // 20:00Z 16-го = 23:00 местного 16-го → не сегодня.
  const beforeMidnight = "2026-07-16T20:00:00.000Z";
  const orders = [
    makeOrder({
      id: "today",
      status: "DELIVERED",
      deliveryMode: "PLATFORM_DRIVER",
      completedAt: afterMidnight,
      history: [statusEvent("ARRIVING", "DELIVERED", afterMidnight)],
      fin: { customerTotalCents: 1000 },
    }),
    makeOrder({
      id: "yesterday",
      status: "DELIVERED",
      deliveryMode: "PLATFORM_DRIVER",
      completedAt: beforeMidnight,
      history: [statusEvent("ARRIVING", "DELIVERED", beforeMidnight)],
      fin: { customerTotalCents: 2000 },
    }),
  ];
  const st = stateWith(orders);
  const run = (period: RestaurantSettlementPeriod) =>
    buildRestaurantSettlementOverview(st, RESTAURANT_ID, period, now, TZ);

  const today = run("TODAY");
  assert.equal(today.summary.completedOrderCount, 1);
  assert.equal(today.rows[0].orderId, "today");

  for (const p of ["LAST_7_DAYS", "LAST_30_DAYS", "ALL"] as const) {
    assert.equal(run(p).summary.completedOrderCount, 2, p);
  }

  // Невалидный nowIso — fail-safe пустой обзор.
  const bad = buildRestaurantSettlementOverview(st, RESTAURANT_ID, "TODAY", "не-дата", TZ);
  assert.equal(bad.summary.completedOrderCount, 0);
  assert.equal(bad.rows.length, 0);
  assert.equal(bad.paidCanceled.length, 0);
});

// 10 -------------------------------------------------------------------------

test("сортировка completedAt по убыванию (новые сверху)", () => {
  const orders = [
    makeOrder({
      id: "old",
      status: "DELIVERED",
      deliveryMode: "PLATFORM_DRIVER",
      completedAt: "2026-07-17T08:00:00.000Z",
      history: [statusEvent("ARRIVING", "DELIVERED", "2026-07-17T08:00:00.000Z")],
    }),
    makeOrder({
      id: "new",
      status: "DELIVERED",
      deliveryMode: "PLATFORM_DRIVER",
      completedAt: "2026-07-17T11:00:00.000Z",
      history: [statusEvent("ARRIVING", "DELIVERED", "2026-07-17T11:00:00.000Z")],
    }),
    makeOrder({
      id: "mid",
      status: "PICKED_UP",
      deliveryMode: "PICKUP",
      completedAt: "2026-07-17T10:00:00.000Z",
      history: [statusEvent("READY_FOR_PICKUP", "PICKED_UP", "2026-07-17T10:00:00.000Z")],
    }),
  ];
  const ov = buildRestaurantSettlementOverview(
    stateWith(orders),
    RESTAURANT_ID,
    "ALL",
    NOW,
    TZ,
  );
  assert.deepEqual(
    ov.rows.map((r) => r.orderId),
    ["new", "mid", "old"],
  );
});

// 11 -------------------------------------------------------------------------

test("read-only: построение не меняет state/orders/settlements", () => {
  const orders = [
    makeOrder({
      id: "d1",
      status: "DELIVERED",
      deliveryMode: "PLATFORM_DRIVER",
      completedAt: NOW,
      history: [statusEvent("ARRIVING", "DELIVERED", NOW)],
    }),
  ];
  const settlements: SettlementEntry[] = [
    { id: "s1", orderId: "d1", restaurantId: RESTAURANT_ID, type: "RESTAURANT_DELIVERY_COMMISSION", amountCents: 400, status: "PENDING", createdAt: NOW },
  ];
  const st = stateWith(orders, settlements);
  const snapshot = JSON.stringify(st);
  const ordersRef = st.orders;
  const settlementsRef = st.settlements;
  const revBefore = st.revision;

  buildRestaurantSettlementOverview(st, RESTAURANT_ID, "ALL", NOW, TZ);
  buildRestaurantSettlementOverview(st, RESTAURANT_ID, "TODAY", NOW, TZ);

  assert.equal(JSON.stringify(st), snapshot, "state не изменился");
  assert.equal(st.orders, ordersRef, "orders — тот же массив");
  assert.equal(st.settlements, settlementsRef, "settlements — тот же массив");
  assert.equal(st.revision, revBefore);
});

// --- DST и календарные границы ----------------------------------------------

function deliveredAt(id: string, completedAt: string): Order {
  return makeOrder({
    id,
    status: "DELIVERED",
    deliveryMode: "PLATFORM_DRIVER",
    completedAt,
    history: [statusEvent("ARRIVING", "DELIVERED", completedAt)],
    fin: { customerTotalCents: 1000 },
  });
}

// 12 -------------------------------------------------------------------------

test("spring DST Chisinau: LAST_7_DAYS = ровно 24–30 марта, граница точна", () => {
  // Переход на летнее время 29 марта 2026 03:00 (EET+2 → EEST+3).
  // now — 30 марта после перехода (15:00 местного).
  const now = "2026-03-30T12:00:00.000Z";
  // Граница включения: 24 марта 00:00 местного. 24 марта ещё EET+2 → 22:00Z 23-го.
  const includeBoundary = "2026-03-23T22:00:00.000Z"; // 24 марта 00:00 local
  const excludeBoundary = "2026-03-23T21:59:00.000Z"; // 23 марта 23:59 local

  // По одному заказу на каждый локальный день 23–30 марта (12:00Z в пределах дня).
  const dayOrders = [23, 24, 25, 26, 27, 28, 29, 30].map((d) =>
    deliveredAt(`m${d}`, `2026-03-${String(d).padStart(2, "0")}T12:00:00.000Z`),
  );
  const st = stateWith([
    ...dayOrders,
    deliveredAt("edge-in", includeBoundary),
    deliveredAt("edge-out", excludeBoundary),
  ]);

  const ov = buildRestaurantSettlementOverview(st, RESTAURANT_ID, "LAST_7_DAYS", now, TZ);
  const ids = new Set(ov.rows.map((r) => r.orderId));

  // Ровно 7 календарных дат 24–30 марта.
  for (const d of [24, 25, 26, 27, 28, 29, 30]) {
    assert.ok(ids.has(`m${d}`), `должен включать m${d}`);
  }
  assert.ok(!ids.has("m23"), "23 марта вне окна 7 дней");
  // Точная граница полуночи.
  assert.ok(ids.has("edge-in"), "24 марта 00:00 включается");
  assert.ok(!ids.has("edge-out"), "23 марта 23:59 исключается");
});

// 13 -------------------------------------------------------------------------

test("TODAY около перехода DST: начало текущего локального дня корректно", () => {
  // now — 29 марта 2026 (день перехода), 15:00 местного EEST.
  const now = "2026-03-29T12:00:00.000Z";
  // 29 марта 00:00 местного: до скачка в 03:00, ещё EET+2 → 22:00Z 28-го.
  const st = stateWith([
    deliveredAt("in", "2026-03-28T22:00:00.000Z"), // 29 марта 00:00 local
    deliveredAt("out", "2026-03-28T21:59:00.000Z"), // 28 марта 23:59 local
  ]);
  const ov = buildRestaurantSettlementOverview(st, RESTAURANT_ID, "TODAY", now, TZ);
  const ids = new Set(ov.rows.map((r) => r.orderId));
  assert.ok(ids.has("in"), "29 марта 00:00 входит в TODAY");
  assert.ok(!ids.has("out"), "28 марта 23:59 не входит в TODAY");
});

// 14 -------------------------------------------------------------------------

test("LAST_30_DAYS через DST: первый допустимый день включён, предыдущий нет", () => {
  const now = "2026-03-30T12:00:00.000Z";
  // Сдвиг календарной даты 30 марта на -29 → 1 марта. 1 марта ещё EET+2.
  const st = stateWith([
    deliveredAt("in", "2026-02-28T22:00:00.000Z"), // 1 марта 00:00 local
    deliveredAt("out", "2026-02-28T21:59:00.000Z"), // 28 февраля 23:59 local
  ]);
  const ov = buildRestaurantSettlementOverview(st, RESTAURANT_ID, "LAST_30_DAYS", now, TZ);
  const ids = new Set(ov.rows.map((r) => r.orderId));
  assert.ok(ids.has("in"), "1 марта 00:00 включён в 30 дней");
  assert.ok(!ids.has("out"), "28 февраля 23:59 исключён");
});

// 15 -------------------------------------------------------------------------

test("будущий completed заказ исключён из всех периодов, включая ALL", () => {
  const future = "2026-07-17T12:00:00.001Z"; // now + 1 мс
  const st = stateWith([
    deliveredAt("future", future),
    deliveredAt("past", "2026-07-17T09:00:00.000Z"),
  ]);
  for (const p of ["TODAY", "LAST_7_DAYS", "LAST_30_DAYS", "ALL"] as const) {
    const ov = buildRestaurantSettlementOverview(st, RESTAURANT_ID, p, NOW, TZ);
    const ids = new Set(ov.rows.map((r) => r.orderId));
    assert.ok(!ids.has("future"), `future не в ${p}`);
    assert.ok(ids.has("past"), `past в ${p}`);
  }
});

// 16 -------------------------------------------------------------------------

test("будущий paid-canceled исключён из «Требуют внимания» во всех периодах", () => {
  const future = "2026-07-17T12:00:00.001Z";
  const st = stateWith([
    makeOrder({
      id: "cfuture",
      status: "CANCELED",
      deliveryMode: "PLATFORM_DRIVER",
      paymentStatus: "PAID",
      paidAt: "2026-07-17T08:00:00.000Z",
      history: [statusEvent("PREPARING", "CANCELED", future)],
      fin: { customerTotalCents: 5000 },
    }),
    makeOrder({
      id: "cpast",
      status: "CANCELED",
      deliveryMode: "PLATFORM_DRIVER",
      paymentStatus: "PAID",
      paidAt: "2026-07-17T08:00:00.000Z",
      history: [statusEvent("PREPARING", "CANCELED", "2026-07-17T09:00:00.000Z")],
      fin: { customerTotalCents: 6000 },
    }),
  ]);
  for (const p of ["TODAY", "LAST_7_DAYS", "LAST_30_DAYS", "ALL"] as const) {
    const ov = buildRestaurantSettlementOverview(st, RESTAURANT_ID, p, NOW, TZ);
    const ids = new Set(ov.paidCanceled.map((r) => r.orderId));
    assert.ok(!ids.has("cfuture"), `cfuture не в ${p}`);
    assert.ok(ids.has("cpast"), `cpast в ${p}`);
  }
});

// 17 -------------------------------------------------------------------------

test("невалидный completedAt/canceledAt не попадает даже в ALL и не падает", () => {
  const st = stateWith([
    makeOrder({
      id: "badcompleted",
      status: "DELIVERED",
      deliveryMode: "PLATFORM_DRIVER",
      updatedAt: "не-дата", // history пуст → completedAt = updatedAt (невалидна)
      history: [],
      fin: { customerTotalCents: 1000 },
    }),
    makeOrder({
      id: "badcanceled",
      status: "CANCELED",
      deliveryMode: "PLATFORM_DRIVER",
      paymentStatus: "PAID",
      paidAt: "2026-07-17T08:00:00.000Z",
      updatedAt: "тоже-не-дата",
      history: [],
      fin: { customerTotalCents: 2000 },
    }),
  ]);
  const ov = buildRestaurantSettlementOverview(st, RESTAURANT_ID, "ALL", NOW, TZ);
  assert.equal(ov.rows.length, 0);
  assert.equal(ov.paidCanceled.length, 0);
  assert.equal(ov.summary.completedOrderCount, 0);
});
