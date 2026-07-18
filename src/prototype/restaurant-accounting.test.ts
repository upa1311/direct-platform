import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeCompletedOrderAccountingEntries,
  getRestaurantOpenPayableCents,
  getRestaurantOpenReceivableCents,
  getRestaurantNetPositionCents,
  migrateLegacySettlementsToAccounting,
  recognizeCompletedOrderAccounting,
} from "./restaurant-accounting.ts";
import { markOrderDeliveredByDriverWithResult } from "./actions.ts";
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
  PrototypeState,
  RestaurantAccountingEntry,
  SettlementEntry,
} from "./models.ts";

const RESTAURANT_ID = "restaurant-1";

const TEMPLATE_ORDER = (() => {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, `${RESTAURANT_ID}-item-1`).state;
  const created = createOrderFromCart(s);
  const order = created.state.orders.find(
    (o) => o.id === (created.result.orderId as string),
  );
  assert.ok(order);
  return order;
})();
const BASE_FIN = TEMPLATE_ORDER.financials;

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
  status: OrderStatus;
  deliveryMode: DeliveryMode;
  completedAt?: string;
  updatedAt?: string;
  paymentStatus?: Order["paymentStatus"];
  paidAt?: string | null;
  history?: OrderHistoryEvent[];
  fin?: Partial<FinancialSnapshot>;
}): Order {
  return {
    ...TEMPLATE_ORDER,
    id: opts.id,
    publicNumber: `DIR-${opts.id}`,
    status: opts.status,
    deliveryMode: opts.deliveryMode,
    updatedAt: opts.updatedAt ?? opts.completedAt ?? "2026-07-17T10:00:00.000Z",
    paymentStatus: opts.paymentStatus ?? "PAID",
    paidAt: opts.paidAt === undefined ? "2026-07-17T09:00:00.000Z" : opts.paidAt,
    history: opts.history ?? [],
    financials: { ...BASE_FIN, deliveryMode: opts.deliveryMode, ...opts.fin },
  };
}

function stateWith(
  orders: Order[],
  settlements: SettlementEntry[] = [],
  restaurantAccountingEntries: RestaurantAccountingEntry[] = [],
): PrototypeState {
  return {
    ...createDefaultState(),
    orders,
    settlements,
    restaurantAccountingEntries,
  };
}

/** Финснимок, где деньги собрал ресторан (комиссия ресторана перед Direct). */
const RESTAURANT_COLLECTED: Partial<FinancialSnapshot> = {
  restaurantCollectedFromCustomerCents: 5000,
  platformCollectedFromCustomerCents: 0,
  platformCommissionReceivableCents: 800,
  restaurantNetAfterPlatformCommissionCents: 4200,
};
/** Финснимок, где деньги собрал Direct (выплата Direct ресторану). */
const DIRECT_COLLECTED: Partial<FinancialSnapshot> = {
  restaurantCollectedFromCustomerCents: 0,
  platformCollectedFromCustomerCents: 6000,
  platformCommissionReceivableCents: 900,
  restaurantNetAfterPlatformCommissionCents: 5100,
};

const DELIVERED_AT = "2026-07-17T10:00:00.000Z";
function completed(
  id: string,
  deliveryMode: DeliveryMode,
  fin: Partial<FinancialSnapshot>,
  status: "DELIVERED" | "PICKED_UP" = "DELIVERED",
): Order {
  return makeOrder({
    id,
    status,
    deliveryMode,
    completedAt: DELIVERED_AT,
    history: [
      statusEvent(
        status === "PICKED_UP" ? "READY_FOR_PICKUP" : "ARRIVING",
        status,
        DELIVERED_AT,
      ),
    ],
    fin,
  });
}

// 1 --------------------------------------------------------------------------

test("PICKUP, деньги собрал ресторан → только RESTAURANT_OWES_DIRECT/PLATFORM_COMMISSION", () => {
  const order = completed("p1", "PICKUP", RESTAURANT_COLLECTED, "PICKED_UP");
  const entries = computeCompletedOrderAccountingEntries(order, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].direction, "RESTAURANT_OWES_DIRECT");
  assert.equal(entries[0].type, "PLATFORM_COMMISSION");
  assert.equal(entries[0].amountCents, 800);
  assert.equal(entries[0].status, "OPEN");
  assert.equal(entries[0].source, "ORDER_FINANCIAL_SNAPSHOT");
  assert.equal(entries[0].legacySettlementId, null);
});

// 2 --------------------------------------------------------------------------

test("RESTAURANT_DELIVERY с оплатой ресторану → комиссия ресторана перед Direct", () => {
  const order = completed("rd1", "RESTAURANT_DELIVERY", RESTAURANT_COLLECTED);
  const entries = computeCompletedOrderAccountingEntries(order, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].direction, "RESTAURANT_OWES_DIRECT");
  assert.equal(entries[0].type, "PLATFORM_COMMISSION");
  assert.equal(entries[0].amountCents, 800);
});

// 3 --------------------------------------------------------------------------

test("PLATFORM_DRIVER/онлайн, деньги собрал Direct → DIRECT_OWES_RESTAURANT/RESTAURANT_PAYOUT", () => {
  const order = completed("pd1", "PLATFORM_DRIVER", DIRECT_COLLECTED);
  const entries = computeCompletedOrderAccountingEntries(order, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].direction, "DIRECT_OWES_RESTAURANT");
  assert.equal(entries[0].type, "RESTAURANT_PAYOUT");
  assert.equal(entries[0].amountCents, 5100);
});

// 4 --------------------------------------------------------------------------

test("смешанный snapshot → две записи", () => {
  const order = completed("mix", "RESTAURANT_DELIVERY", {
    restaurantCollectedFromCustomerCents: 3000,
    platformCollectedFromCustomerCents: 3000,
    platformCommissionReceivableCents: 500,
    restaurantNetAfterPlatformCommissionCents: 2500,
  });
  const entries = computeCompletedOrderAccountingEntries(order, []);
  assert.equal(entries.length, 2);
  const byType = new Map(entries.map((e) => [e.type, e]));
  assert.equal(byType.get("PLATFORM_COMMISSION")!.direction, "RESTAURANT_OWES_DIRECT");
  assert.equal(byType.get("PLATFORM_COMMISSION")!.amountCents, 500);
  assert.equal(byType.get("RESTAURANT_PAYOUT")!.direction, "DIRECT_OWES_RESTAURANT");
  assert.equal(byType.get("RESTAURANT_PAYOUT")!.amountCents, 2500);
});

// 5 --------------------------------------------------------------------------

test("суммы строго равны полям order.financials", () => {
  const order = completed("mix2", "RESTAURANT_DELIVERY", {
    restaurantCollectedFromCustomerCents: 1,
    platformCollectedFromCustomerCents: 1,
    platformCommissionReceivableCents: 137,
    restaurantNetAfterPlatformCommissionCents: 9911,
  });
  const entries = computeCompletedOrderAccountingEntries(order, []);
  const commission = entries.find((e) => e.type === "PLATFORM_COMMISSION")!;
  const payout = entries.find((e) => e.type === "RESTAURANT_PAYOUT")!;
  assert.equal(commission.amountCents, order.financials.platformCommissionReceivableCents);
  assert.equal(payout.amountCents, order.financials.restaurantNetAfterPlatformCommissionCents);
});

// 6 --------------------------------------------------------------------------

test("изменение тарифов, меню и комиссии не меняет записи", () => {
  const order = completed("snap", "PICKUP", RESTAURANT_COLLECTED, "PICKED_UP");
  const before = computeCompletedOrderAccountingEntries(order, []);

  // Мутируем текущее меню/тарифы/комиссию — снимок заказа неизменен.
  const st = stateWith([order]);
  const mutated: PrototypeState = {
    ...st,
    menuItems: st.menuItems.map((m) => ({ ...m, priceCents: 999999 })),
    restaurants: st.restaurants.map((r) =>
      r.id === RESTAURANT_ID ? { ...r, commissionRateBps: 9000 } : r,
    ),
  };
  const orderAfter = mutated.orders.find((o) => o.id === "snap")!;
  const after = computeCompletedOrderAccountingEntries(orderAfter, []);
  assert.deepEqual(after, before);
  assert.equal(after[0].amountCents, 800);
});

// 7 --------------------------------------------------------------------------

test("PREPARING/READY/CANCELED не создают записей", () => {
  for (const status of ["PREPARING", "READY", "READY_FOR_PICKUP", "CANCELED"] as const) {
    const order = makeOrder({
      id: `x-${status}`,
      status,
      deliveryMode: "PICKUP",
      fin: RESTAURANT_COLLECTED,
    });
    assert.equal(computeCompletedOrderAccountingEntries(order, []).length, 0, status);
    const res = recognizeCompletedOrderAccounting(
      stateWith([order]),
      `x-${status}`,
      "2026-07-17T12:00:00.000Z",
    );
    assert.equal(res.result.ok, false);
    assert.equal(res.result.recognizedCount, 0);
  }
});

// 8 --------------------------------------------------------------------------

test("повторное завершение/recognition не создаёт дублей", () => {
  const order = completed("dup", "PICKUP", RESTAURANT_COLLECTED, "PICKED_UP");
  const first = recognizeCompletedOrderAccounting(
    stateWith([order]),
    "dup",
    "2026-07-17T12:00:00.000Z",
  );
  assert.equal(first.result.recognizedCount, 1);
  const entries = first.state.restaurantAccountingEntries;
  // Повторный вызов на уже признанном state — идемпотентный no-op тем же объектом.
  const second = recognizeCompletedOrderAccounting(
    first.state,
    "dup",
    "2026-07-17T13:00:00.000Z",
  );
  assert.equal(second.result.ok, true);
  assert.equal(second.result.recognizedCount, 0);
  assert.equal(second.state, first.state, "state тем же объектом");
  assert.equal(second.state.revision, first.state.revision);
  assert.equal(second.state.restaurantAccountingEntries, entries);
});

// 9 --------------------------------------------------------------------------

test("гонка двух вкладок оставляет одну запись каждого типа", () => {
  const order = completed("race", "RESTAURANT_DELIVERY", {
    restaurantCollectedFromCustomerCents: 3000,
    platformCollectedFromCustomerCents: 3000,
    platformCommissionReceivableCents: 500,
    restaurantNetAfterPlatformCommissionCents: 2500,
  });
  const base = stateWith([order]);
  // Первая вкладка коммитит.
  const first = recognizeCompletedOrderAccounting(base, "race", "2026-07-17T12:00:00.000Z");
  assert.equal(first.result.recognizedCount, 2);
  // Вторая вкладка после rebase выполняется на закоммиченном state.
  const second = recognizeCompletedOrderAccounting(first.state, "race", "2026-07-17T12:00:01.000Z");
  assert.equal(second.result.recognizedCount, 0);
  const forOrder = first.state.restaurantAccountingEntries.filter(
    (e) => e.orderId === "race",
  );
  assert.equal(forOrder.length, 2);
  assert.equal(new Set(forOrder.map((e) => e.type)).size, 2);
});

// 10 -------------------------------------------------------------------------

test("recognizedAt берётся из completedAt заказа, не из nowIso", () => {
  const order = completed("time", "PICKUP", RESTAURANT_COLLECTED, "PICKED_UP");
  const res = recognizeCompletedOrderAccounting(
    stateWith([order]),
    "time",
    "2030-01-01T00:00:00.000Z", // nowIso намеренно далёкий
  );
  assert.equal(res.state.restaurantAccountingEntries[0].recognizedAt, DELIVERED_AT);
});

// 11 -------------------------------------------------------------------------

test("legacy migration: один раз, правильные статусы, идемпотентно", () => {
  const settlements: SettlementEntry[] = [
    { id: "s-pending", orderId: "o1", restaurantId: RESTAURANT_ID, type: "PICKUP_COMMISSION", amountCents: 100, status: "PENDING", createdAt: DELIVERED_AT },
    { id: "s-paid", orderId: "o2", restaurantId: RESTAURANT_ID, type: "RESTAURANT_DELIVERY_COMMISSION", amountCents: 200, status: "PAID", createdAt: DELIVERED_AT },
    { id: "s-netted", orderId: "o3", restaurantId: RESTAURANT_ID, type: "PICKUP_COMMISSION", amountCents: 300, status: "NETTED", createdAt: DELIVERED_AT },
    { id: "s-waived", orderId: "o4", restaurantId: RESTAURANT_ID, type: "PICKUP_COMMISSION", amountCents: 400, status: "WAIVED", createdAt: DELIVERED_AT },
  ];
  const migrated = migrateLegacySettlementsToAccounting([], settlements);
  assert.equal(migrated.length, 4);
  for (const e of migrated) {
    assert.equal(e.direction, "RESTAURANT_OWES_DIRECT");
    assert.equal(e.type, "PLATFORM_COMMISSION");
    assert.equal(e.source, "LEGACY_COMMISSION_SETTLEMENT");
    assert.equal(e.recognizedAt, DELIVERED_AT);
  }
  const byLegacy = new Map(migrated.map((e) => [e.legacySettlementId, e]));
  assert.equal(byLegacy.get("s-pending")!.status, "OPEN");
  assert.equal(byLegacy.get("s-paid")!.status, "SETTLED");
  assert.equal(byLegacy.get("s-netted")!.status, "SETTLED");
  assert.equal(byLegacy.get("s-waived")!.status, "WAIVED");

  // Идемпотентно: повторная миграция не создаёт дублей.
  const again = migrateLegacySettlementsToAccounting(migrated, settlements);
  assert.equal(again.length, 4);
});

// 12 -------------------------------------------------------------------------

test("OPEN receivable/payable/net helpers дают точные суммы", () => {
  const st = stateWith([], [], [
    entry("e1", "RESTAURANT_OWES_DIRECT", "PLATFORM_COMMISSION", 800, "OPEN"),
    entry("e2", "DIRECT_OWES_RESTAURANT", "RESTAURANT_PAYOUT", 5100, "OPEN"),
    entry("e3", "DIRECT_OWES_RESTAURANT", "RESTAURANT_PAYOUT", 900, "OPEN"),
  ]);
  assert.equal(getRestaurantOpenReceivableCents(st, RESTAURANT_ID), 800);
  assert.equal(getRestaurantOpenPayableCents(st, RESTAURANT_ID), 6000);
  assert.equal(getRestaurantNetPositionCents(st, RESTAURANT_ID), 5200); // 6000 - 800
});

// 13 -------------------------------------------------------------------------

test("SETTLED/WAIVED не входят в открытые суммы", () => {
  const st = stateWith([], [], [
    entry("e1", "RESTAURANT_OWES_DIRECT", "PLATFORM_COMMISSION", 800, "SETTLED"),
    entry("e2", "DIRECT_OWES_RESTAURANT", "RESTAURANT_PAYOUT", 5100, "WAIVED"),
    entry("e3", "RESTAURANT_OWES_DIRECT", "PLATFORM_COMMISSION", 200, "OPEN"),
  ]);
  assert.equal(getRestaurantOpenReceivableCents(st, RESTAURANT_ID), 200);
  assert.equal(getRestaurantOpenPayableCents(st, RESTAURANT_ID), 0);
  assert.equal(getRestaurantNetPositionCents(st, RESTAURANT_ID), -200);
});

// 14 -------------------------------------------------------------------------

test("неуспешное действие возвращает исходный state тем же объектом", () => {
  const order = completed("ok", "PICKUP", RESTAURANT_COLLECTED, "PICKED_UP");
  const st = stateWith([order]);
  const missing = recognizeCompletedOrderAccounting(st, "нет-заказа", "2026-07-17T12:00:00.000Z");
  assert.equal(missing.result.ok, false);
  assert.equal(missing.state, st);
  const badTime = recognizeCompletedOrderAccounting(st, "ok", "не-дата");
  assert.equal(badTime.result.ok, false);
  assert.equal(badTime.state, st);
});

// 15 -------------------------------------------------------------------------

test("orders, financials и старые settlements не мутируются; hookup атомарен", () => {
  const settlement: SettlementEntry = {
    id: "keep",
    orderId: "keep-o",
    restaurantId: RESTAURANT_ID,
    type: "PICKUP_COMMISSION",
    amountCents: 111,
    status: "PENDING",
    createdAt: DELIVERED_AT,
  };
  // Заказ в ARRIVING, оплачен онлайн, деньги собрал Direct, водитель назначен.
  const order: Order = {
    ...makeOrder({
      id: "arr",
      status: "ARRIVING",
      deliveryMode: "PLATFORM_DRIVER",
      paymentStatus: "PAID",
      history: [statusEvent("OUT_FOR_DELIVERY", "ARRIVING", "2026-07-17T09:30:00.000Z")],
      fin: DIRECT_COLLECTED,
    }),
    assignedDriverId: "driver-1",
    driverAssignedAt: "2026-07-17T09:00:00.000Z",
  };
  const st = stateWith([order], [settlement]);
  const ordersRef = st.orders;
  const settlementsRef = st.settlements;
  const finRef = order.financials;

  const res = markOrderDeliveredByDriverWithResult(st, "arr");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  // Атомарно создано обязательство выплаты Direct → ресторану.
  const created = res.state.restaurantAccountingEntries.filter((e) => e.orderId === "arr");
  assert.equal(created.length, 1);
  assert.equal(created[0].type, "RESTAURANT_PAYOUT");
  assert.equal(created[0].amountCents, 5100);
  // Исходные orders/settlements/financials не мутированы (новые массивы).
  assert.equal(st.orders, ordersRef);
  assert.equal(st.settlements, settlementsRef);
  assert.equal(order.financials, finRef);
  assert.equal(order.status, "ARRIVING", "исходный заказ не изменён");
  assert.deepEqual(res.state.settlements, [settlement], "старые settlements сохранены");
});

function entry(
  id: string,
  direction: RestaurantAccountingEntry["direction"],
  type: RestaurantAccountingEntry["type"],
  amountCents: number,
  status: RestaurantAccountingEntry["status"],
): RestaurantAccountingEntry {
  return {
    id,
    orderId: `order-${id}`,
    restaurantId: RESTAURANT_ID,
    direction,
    type,
    amountCents,
    currencyCode: "USD",
    status,
    recognizedAt: DELIVERED_AT,
    settledAt: status === "SETTLED" ? DELIVERED_AT : null,
    source: "ORDER_FINANCIAL_SNAPSHOT",
    legacySettlementId: null,
  };
}
