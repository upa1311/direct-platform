import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ACCOUNTING_RESOLUTION_NOTE_MAX,
  ACCOUNTING_RESOLUTION_REFERENCE_MAX,
  buildAdminAccountingView,
  buildRestaurantAccountingJournal,
  computeCompletedOrderAccountingEntries,
  formatAccountingResolutionMessage,
  getRestaurantOpenPayableCents,
  getRestaurantOpenReceivableCents,
  getRestaurantNetPositionCents,
  migrateLegacySettlementsToAccounting,
  recognizeCompletedOrderAccounting,
  resolveRestaurantAccountingEntry,
} from "./restaurant-accounting.ts";
import { executeSerializedPrototypeMutation } from "./prototype-store.ts";
import {
  addCartItem,
  completePickupWithCode,
  createOrderFromCart,
  markOrderDeliveredByDriverWithResult,
  markOrderDeliveredWithResult,
  setCartFulfillmentChoice,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { parseStoredState } from "./prototype-store.ts";
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

// --- Дедупликация обязательств между источниками ----------------------------

function commissionEntriesFor(
  state: PrototypeState,
  orderId: string,
): RestaurantAccountingEntry[] {
  return state.restaurantAccountingEntries.filter(
    (e) => e.orderId === orderId && e.type === "PLATFORM_COMMISSION",
  );
}

// 16 -------------------------------------------------------------------------

test("PICKUP completion + serialize/parse → ровно одна PLATFORM_COMMISSION", () => {
  const order: Order = {
    ...makeOrder({
      id: "puc",
      status: "READY_FOR_PICKUP",
      deliveryMode: "PICKUP",
      paymentStatus: "DUE_AT_PICKUP",
      paidAt: null,
      fin: RESTAURANT_COLLECTED,
    }),
    paymentMethod: "PAY_AT_RESTAURANT",
    pickupCode: "1234",
    pickupCodeUsed: false,
    pickupPaymentMethodsSnapshot: ["CASH", "CARD"],
  };
  const completed = completePickupWithCode(
    stateWith([order]),
    "puc",
    "1234",
    "CASH",
    "RESTAURANT",
    DELIVERED_AT,
    "COMBINED",
  );
  assert.equal(completed.result.ok, true, completed.result.error ?? "");
  // Действие создало старый SettlementEntry и ровно одну snapshot-комиссию.
  assert.equal(
    completed.state.settlements.filter((s) => s.orderId === "puc").length,
    1,
  );
  assert.equal(commissionEntriesFor(completed.state, "puc").length, 1);

  // serialize → parse: старый settlement повторно НЕ мигрируется в дубль.
  const parsed = parseStoredState(JSON.stringify(completed.state));
  assert.ok(parsed);
  assert.equal(commissionEntriesFor(parsed, "puc").length, 1);
  assert.equal(
    getRestaurantOpenReceivableCents(parsed, RESTAURANT_ID),
    RESTAURANT_COLLECTED.platformCommissionReceivableCents,
  );
});

// 17 -------------------------------------------------------------------------

test("RESTAURANT_DELIVERY completion + serialize/parse → ровно одна комиссия", () => {
  const order = makeOrder({
    id: "rdc",
    status: "ARRIVING",
    deliveryMode: "RESTAURANT_DELIVERY",
    paymentStatus: "DUE_TO_RESTAURANT_COURIER",
    paidAt: null,
    fin: RESTAURANT_COLLECTED,
  });
  const completed = markOrderDeliveredWithResult(
    stateWith([order]),
    "rdc",
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(completed.result.ok, true, completed.result.error ?? "");
  assert.equal(commissionEntriesFor(completed.state, "rdc").length, 1);

  const parsed = parseStoredState(JSON.stringify(completed.state));
  assert.ok(parsed);
  assert.equal(commissionEntriesFor(parsed, "rdc").length, 1);
  assert.equal(
    getRestaurantOpenReceivableCents(parsed, RESTAURANT_ID),
    RESTAURANT_COLLECTED.platformCommissionReceivableCents,
  );
});

// 18 -------------------------------------------------------------------------

test("migration при существующей snapshot-записи не добавляет legacy-дубль", () => {
  const snapshot = entry(
    "snap",
    "RESTAURANT_OWES_DIRECT",
    "PLATFORM_COMMISSION",
    800,
    "OPEN",
  );
  // Snapshot-запись относится к заказу "order-snap"; settlement того же заказа.
  const settlement: SettlementEntry = {
    id: "s-order-snap",
    orderId: "order-snap",
    restaurantId: RESTAURANT_ID,
    type: "PICKUP_COMMISSION",
    amountCents: 800,
    status: "PENDING",
    createdAt: DELIVERED_AT,
  };
  const merged = migrateLegacySettlementsToAccounting([snapshot], [settlement]);
  const commission = merged.filter(
    (e) => e.orderId === "order-snap" && e.type === "PLATFORM_COMMISSION",
  );
  assert.equal(commission.length, 1);
  // Авторитетной осталась snapshot-запись, её не подменили legacy.
  assert.equal(commission[0].source, "ORDER_FINANCIAL_SNAPSHOT");
});

// 19 -------------------------------------------------------------------------

test("recognition после legacy migration не создаёт snapshot-дубль", () => {
  const order = completed("lg", "PICKUP", RESTAURANT_COLLECTED, "PICKED_UP");
  const settlement: SettlementEntry = {
    id: "s-lg",
    orderId: "lg",
    restaurantId: RESTAURANT_ID,
    type: "PICKUP_COMMISSION",
    amountCents: RESTAURANT_COLLECTED.platformCommissionReceivableCents!,
    status: "PENDING",
    createdAt: DELIVERED_AT,
  };
  const legacyEntries = migrateLegacySettlementsToAccounting([], [settlement]);
  const st = stateWith([order], [settlement], legacyEntries);
  const res = recognizeCompletedOrderAccounting(st, "lg", "2026-07-17T12:00:00.000Z");
  assert.equal(res.result.recognizedCount, 0);
  assert.equal(res.state, st, "state тем же объектом");
  assert.equal(commissionEntriesFor(res.state, "lg").length, 1);
});

// 20 -------------------------------------------------------------------------

test("настоящий v7 legacy state: parse создаёт ровно одну legacy-запись", () => {
  const settlement: SettlementEntry = {
    id: "s-v7",
    orderId: "o-v7",
    restaurantId: RESTAURANT_ID,
    type: "RESTAURANT_DELIVERY_COMMISSION",
    amountCents: 640,
    status: "PENDING",
    createdAt: DELIVERED_AT,
  };
  // Сериализуем «настоящий» v7: schemaVersion 7, без поля accounting-журнала.
  const raw = JSON.parse(JSON.stringify(stateWith([], [settlement]))) as Record<
    string,
    unknown
  >;
  raw.schemaVersion = 7;
  delete raw.restaurantAccountingEntries;

  const parsed = parseStoredState(JSON.stringify(raw));
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, 9);
  const migrated = parsed.restaurantAccountingEntries.filter(
    (e) => e.orderId === "o-v7",
  );
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].type, "PLATFORM_COMMISSION");
  assert.equal(migrated[0].source, "LEGACY_COMMISSION_SETTLEMENT");
  assert.equal(migrated[0].legacySettlementId, "s-v7");
  assert.equal(migrated[0].amountCents, 640);
  assert.equal(migrated[0].status, "OPEN");
});

// 21 -------------------------------------------------------------------------

test("два legacy settlement одного orderId/type → одна PLATFORM_COMMISSION", () => {
  const settlements: SettlementEntry[] = [
    { id: "s-a", orderId: "same", restaurantId: RESTAURANT_ID, type: "PICKUP_COMMISSION", amountCents: 300, status: "PENDING", createdAt: DELIVERED_AT },
    { id: "s-b", orderId: "same", restaurantId: RESTAURANT_ID, type: "PICKUP_COMMISSION", amountCents: 300, status: "PENDING", createdAt: DELIVERED_AT },
  ];
  const merged = migrateLegacySettlementsToAccounting([], settlements);
  assert.equal(
    merged.filter((e) => e.orderId === "same" && e.type === "PLATFORM_COMMISSION").length,
    1,
  );
});

// 22 -------------------------------------------------------------------------

test("повторный parse не растит число записей и receivable", () => {
  const order: Order = {
    ...makeOrder({
      id: "rp",
      status: "READY_FOR_PICKUP",
      deliveryMode: "PICKUP",
      paymentStatus: "DUE_AT_PICKUP",
      paidAt: null,
      fin: RESTAURANT_COLLECTED,
    }),
    paymentMethod: "PAY_AT_RESTAURANT",
    pickupCode: "1234",
    pickupCodeUsed: false,
    pickupPaymentMethodsSnapshot: ["CASH", "CARD"],
  };
  const done = completePickupWithCode(
    stateWith([order]),
    "rp",
    "1234",
    "CASH",
    "RESTAURANT",
    DELIVERED_AT,
    "COMBINED",
  ).state;

  const parse1 = parseStoredState(JSON.stringify(done));
  assert.ok(parse1);
  const parse2 = parseStoredState(JSON.stringify(parse1));
  assert.ok(parse2);
  assert.equal(
    parse1.restaurantAccountingEntries.length,
    parse2.restaurantAccountingEntries.length,
  );
  assert.equal(
    getRestaurantOpenReceivableCents(parse1, RESTAURANT_ID),
    getRestaurantOpenReceivableCents(parse2, RESTAURANT_ID),
  );
  assert.equal(
    getRestaurantOpenReceivableCents(parse2, RESTAURANT_ID),
    RESTAURANT_COLLECTED.platformCommissionReceivableCents,
  );
});

// 23 -------------------------------------------------------------------------

test("RESTAURANT_PAYOUT не затрагивается дедупликацией", () => {
  const payout = entry(
    "po",
    "DIRECT_OWES_RESTAURANT",
    "RESTAURANT_PAYOUT",
    5100,
    "OPEN",
  );
  // Комиссионный settlement того же заказа не должен трогать payout.
  const settlement: SettlementEntry = {
    id: "s-po",
    orderId: "order-po",
    restaurantId: RESTAURANT_ID,
    type: "RESTAURANT_DELIVERY_COMMISSION",
    amountCents: 700,
    status: "PENDING",
    createdAt: DELIVERED_AT,
  };
  const merged = migrateLegacySettlementsToAccounting([payout], [settlement]);
  // Payout сохранился, и добавилась ровно одна комиссия (payout ≠ commission).
  assert.equal(
    merged.filter((e) => e.orderId === "order-po" && e.type === "RESTAURANT_PAYOUT").length,
    1,
  );
  assert.equal(
    merged.filter((e) => e.orderId === "order-po" && e.type === "PLATFORM_COMMISSION").length,
    1,
  );
});

// --- Журнал обязательств (read-only selector) -------------------------------

function jentry(
  overrides: Partial<RestaurantAccountingEntry> & { id: string },
): RestaurantAccountingEntry {
  return {
    orderId: `order-${overrides.id}`,
    restaurantId: RESTAURANT_ID,
    direction: "RESTAURANT_OWES_DIRECT",
    type: "PLATFORM_COMMISSION",
    amountCents: 100,
    currencyCode: "USD",
    status: "OPEN",
    recognizedAt: DELIVERED_AT,
    settledAt: null,
    source: "ORDER_FINANCIAL_SNAPSHOT",
    legacySettlementId: null,
    ...overrides,
  };
}

// 24 -------------------------------------------------------------------------

test("journal: только записи выбранного ресторана", () => {
  const st = stateWith([], [], [
    jentry({ id: "mine", restaurantId: RESTAURANT_ID }),
    jentry({ id: "other", restaurantId: "restaurant-2" }),
  ]);
  const rows = buildRestaurantAccountingJournal(st, RESTAURANT_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entryId, "mine");
});

// 25 -------------------------------------------------------------------------

test("journal: связывает запись с публичным номером заказа", () => {
  const order = completed("linked", "PICKUP", RESTAURANT_COLLECTED, "PICKED_UP");
  const st = stateWith([order], [], [
    jentry({ id: "e", orderId: "linked" }),
  ]);
  const rows = buildRestaurantAccountingJournal(st, RESTAURANT_ID);
  assert.equal(rows[0].publicNumber, order.publicNumber);
  assert.equal(rows[0].hasOrder, true);
});

// 26 -------------------------------------------------------------------------

test("journal: отсутствующий legacy-заказ сохраняется, publicNumber null, без orderId", () => {
  const st = stateWith([], [], [
    jentry({
      id: "orphan",
      orderId: "удалённый-заказ",
      source: "LEGACY_COMMISSION_SETTLEMENT",
      legacySettlementId: "s-old",
    }),
  ]);
  const rows = buildRestaurantAccountingJournal(st, RESTAURANT_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].publicNumber, null);
  assert.equal(rows[0].hasOrder, false);
  // Внутренний orderId не входит в публичную row-модель.
  assert.ok(!("orderId" in rows[0]));
  assert.ok(!JSON.stringify(rows[0]).includes("удалённый-заказ"));
});

// 27 -------------------------------------------------------------------------

test("journal: сортировка recognizedAt по убыванию", () => {
  const st = stateWith([], [], [
    jentry({ id: "old", recognizedAt: "2026-07-15T10:00:00.000Z" }),
    jentry({ id: "new", recognizedAt: "2026-07-17T10:00:00.000Z" }),
    jentry({ id: "mid", recognizedAt: "2026-07-16T10:00:00.000Z" }),
  ]);
  const rows = buildRestaurantAccountingJournal(st, RESTAURANT_ID);
  assert.deepEqual(rows.map((r) => r.entryId), ["new", "mid", "old"]);
});

// 28 -------------------------------------------------------------------------

test("journal: невалидные даты внизу, стабильный tie-breaker, без падения", () => {
  const st = stateWith([], [], [
    jentry({ id: "b-invalid", recognizedAt: "не-дата" }),
    jentry({ id: "valid", recognizedAt: "2026-07-17T10:00:00.000Z" }),
    jentry({ id: "a-invalid", recognizedAt: "тоже-не-дата" }),
  ]);
  const rows = buildRestaurantAccountingJournal(st, RESTAURANT_ID);
  assert.equal(rows[0].entryId, "valid");
  // Невалидные — внизу, между собой стабильно по entryId (a перед b).
  assert.deepEqual(rows.slice(1).map((r) => r.entryId), ["a-invalid", "b-invalid"]);
});

// 29 -------------------------------------------------------------------------

test("journal: направления, типы, статусы и источники сохраняются для UI-mapping", () => {
  const st = stateWith([], [], [
    jentry({ id: "c1", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", status: "OPEN", source: "ORDER_FINANCIAL_SNAPSHOT", recognizedAt: "2026-07-17T04:00:00.000Z" }),
    jentry({ id: "c2", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", status: "SETTLED", source: "ORDER_FINANCIAL_SNAPSHOT", settledAt: "2026-07-17T05:00:00.000Z", recognizedAt: "2026-07-17T03:00:00.000Z" }),
    jentry({ id: "c3", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", status: "WAIVED", source: "LEGACY_COMMISSION_SETTLEMENT", recognizedAt: "2026-07-17T02:00:00.000Z" }),
  ]);
  const rows = buildRestaurantAccountingJournal(st, RESTAURANT_ID);
  const byId = new Map(rows.map((r) => [r.entryId, r]));
  assert.equal(byId.get("c1")!.direction, "RESTAURANT_OWES_DIRECT");
  assert.equal(byId.get("c1")!.type, "PLATFORM_COMMISSION");
  assert.equal(byId.get("c1")!.status, "OPEN");
  assert.equal(byId.get("c1")!.source, "ORDER_FINANCIAL_SNAPSHOT");
  assert.equal(byId.get("c2")!.direction, "DIRECT_OWES_RESTAURANT");
  assert.equal(byId.get("c2")!.type, "RESTAURANT_PAYOUT");
  assert.equal(byId.get("c2")!.status, "SETTLED");
  assert.equal(byId.get("c2")!.settledAt, "2026-07-17T05:00:00.000Z");
  assert.equal(byId.get("c3")!.status, "WAIVED");
  assert.equal(byId.get("c3")!.source, "LEGACY_COMMISSION_SETTLEMENT");
});

// 30 -------------------------------------------------------------------------

test("journal: OPEN/SETTLED/WAIVED не меняют open balance formulas", () => {
  const st = stateWith([], [], [
    jentry({ id: "o", direction: "RESTAURANT_OWES_DIRECT", amountCents: 800, status: "OPEN" }),
    jentry({ id: "s", direction: "RESTAURANT_OWES_DIRECT", amountCents: 999, status: "SETTLED" }),
    jentry({ id: "w", direction: "DIRECT_OWES_RESTAURANT", amountCents: 777, status: "WAIVED" }),
    jentry({ id: "p", direction: "DIRECT_OWES_RESTAURANT", amountCents: 500, status: "OPEN" }),
  ]);
  // Журнал показывает все 4, но открытый баланс учитывает только OPEN.
  assert.equal(buildRestaurantAccountingJournal(st, RESTAURANT_ID).length, 4);
  assert.equal(getRestaurantOpenReceivableCents(st, RESTAURANT_ID), 800);
  assert.equal(getRestaurantOpenPayableCents(st, RESTAURANT_ID), 500);
  assert.equal(getRestaurantNetPositionCents(st, RESTAURANT_ID), -300);
});

// 31 -------------------------------------------------------------------------

test("journal: один orderId/type остаётся одной строкой после повторного parse", () => {
  const order: Order = {
    ...makeOrder({
      id: "jp",
      status: "READY_FOR_PICKUP",
      deliveryMode: "PICKUP",
      paymentStatus: "DUE_AT_PICKUP",
      paidAt: null,
      fin: RESTAURANT_COLLECTED,
    }),
    paymentMethod: "PAY_AT_RESTAURANT",
    pickupCode: "1234",
    pickupCodeUsed: false,
    pickupPaymentMethodsSnapshot: ["CASH", "CARD"],
  };
  const done = completePickupWithCode(
    stateWith([order]),
    "jp",
    "1234",
    "CASH",
    "RESTAURANT",
    DELIVERED_AT,
    "COMBINED",
  ).state;
  const parsed = parseStoredState(JSON.stringify(done));
  assert.ok(parsed);
  const rows = buildRestaurantAccountingJournal(parsed, RESTAURANT_ID).filter(
    (r) => r.type === "PLATFORM_COMMISSION",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].publicNumber, order.publicNumber);
});

// 32 -------------------------------------------------------------------------

test("journal: read-only, state/orders/accounting/settlements не меняются", () => {
  const order = completed("ro", "PICKUP", RESTAURANT_COLLECTED, "PICKED_UP");
  const settlement: SettlementEntry = {
    id: "s-ro",
    orderId: "ro",
    restaurantId: RESTAURANT_ID,
    type: "PICKUP_COMMISSION",
    amountCents: 800,
    status: "PENDING",
    createdAt: DELIVERED_AT,
  };
  const st = stateWith([order], [settlement], [jentry({ id: "e", orderId: "ro" })]);
  const snapshot = JSON.stringify(st);
  const ordersRef = st.orders;
  const entriesRef = st.restaurantAccountingEntries;
  const settlementsRef = st.settlements;
  const revBefore = st.revision;

  buildRestaurantAccountingJournal(st, RESTAURANT_ID);
  buildRestaurantAccountingJournal(st, RESTAURANT_ID);

  assert.equal(JSON.stringify(st), snapshot);
  assert.equal(st.orders, ordersRef);
  assert.equal(st.restaurantAccountingEntries, entriesRef);
  assert.equal(st.settlements, settlementsRef);
  assert.equal(st.revision, revBefore);
});

// --- Административное закрытие обязательства ---------------------------------

const RES_NOW = "2026-07-18T09:00:00.000Z";

function legacySettlement(orderId: string, amount = 800): SettlementEntry {
  return {
    id: `settlement-${orderId}`,
    orderId,
    restaurantId: RESTAURANT_ID,
    type: "PICKUP_COMMISSION",
    amountCents: amount,
    status: "PENDING",
    createdAt: DELIVERED_AT,
  };
}

// 33 -------------------------------------------------------------------------

test("SETTLED комиссии: запись закрыта, один аудит, legacy SettlementEntry → PAID", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const st = stateWith([], [legacySettlement("o")], [e]);
  const res = resolveRestaurantAccountingEntry(st, "c", "SETTLED", "Сверка №12", "BANK-777", RES_NOW);
  assert.equal(res.result.ok, true, res.result.error ?? "");

  const updated = res.state.restaurantAccountingEntries.find((x) => x.id === "c")!;
  assert.equal(updated.status, "SETTLED");
  assert.equal(updated.settledAt, RES_NOW);
  assert.equal(res.state.restaurantAccountingResolutionEvents.length, 1);
  const ev = res.state.restaurantAccountingResolutionEvents[0];
  assert.equal(ev.accountingEntryId, "c");
  assert.equal(ev.previousStatus, "OPEN");
  assert.equal(ev.nextStatus, "SETTLED");
  assert.equal(ev.actor, "ADMIN");
  assert.equal(ev.externalReference, "BANK-777");
  // Старый журнал комиссий синхронизирован.
  assert.equal(res.state.settlements.find((s) => s.orderId === "o")!.status, "PAID");
  assert.equal(res.state.revision, st.revision + 1);
});

// 34 -------------------------------------------------------------------------

test("SETTLED выплаты ресторану: закрыта, аудит есть, SettlementEntry не создаётся", () => {
  const e = jentry({ id: "p", orderId: "op", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 });
  const st = stateWith([], [], [e]);
  const res = resolveRestaurantAccountingEntry(st, "p", "SETTLED", "Выплата проведена", "TRX-9", RES_NOW);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(res.state.restaurantAccountingEntries.find((x) => x.id === "p")!.status, "SETTLED");
  assert.equal(res.state.restaurantAccountingResolutionEvents.length, 1);
  assert.equal(res.state.settlements.length, 0, "новый SettlementEntry не создан");
});

// 35 -------------------------------------------------------------------------

test("WAIVED комиссии: статус WAIVED, note обязателен, legacy SettlementEntry → WAIVED", () => {
  const e = jentry({ id: "w", orderId: "ow", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const st = stateWith([], [legacySettlement("ow")], [e]);

  // Без основания — отказ.
  const noNote = resolveRestaurantAccountingEntry(st, "w", "WAIVED", "   ", null, RES_NOW);
  assert.equal(noNote.result.ok, false);
  assert.equal(noNote.state, st);

  const res = resolveRestaurantAccountingEntry(st, "w", "WAIVED", "Списано по решению Direct", null, RES_NOW);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(res.state.restaurantAccountingEntries.find((x) => x.id === "w")!.status, "WAIVED");
  assert.equal(res.state.restaurantAccountingResolutionEvents[0].nextStatus, "WAIVED");
  assert.equal(res.state.settlements.find((s) => s.orderId === "ow")!.status, "WAIVED");
});

// 36 -------------------------------------------------------------------------

test("WAIVED выплаты ресторану запрещён (Direct должен ресторану)", () => {
  const e = jentry({ id: "p", orderId: "op", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 });
  const st = stateWith([], [], [e]);
  const res = resolveRestaurantAccountingEntry(st, "p", "WAIVED", "нельзя", null, RES_NOW);
  assert.equal(res.result.ok, false);
  assert.equal(res.state, st, "исходный state тем же объектом");
  assert.equal(res.state.restaurantAccountingResolutionEvents.length, 0);
});

// 37 -------------------------------------------------------------------------

test("повторное закрытие: отказ, нет второго события, revision не растёт", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const first = resolveRestaurantAccountingEntry(stateWith([], [], [e]), "c", "SETTLED", "ok", "R1", RES_NOW);
  assert.equal(first.result.ok, true);

  const second = resolveRestaurantAccountingEntry(first.state, "c", "SETTLED", "again", "R2", "2026-07-18T10:00:00.000Z");
  assert.equal(second.result.ok, false);
  assert.equal(second.state, first.state, "тот же state reference");
  assert.equal(second.state.revision, first.state.revision);
  assert.equal(second.state.restaurantAccountingResolutionEvents.length, 1);
});

// 38 -------------------------------------------------------------------------

test("race двух вкладок после rebase: один event, одна смена статуса", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const base = stateWith([], [], [e]);
  const first = resolveRestaurantAccountingEntry(base, "c", "SETTLED", "первая", "R1", RES_NOW);
  assert.equal(first.result.ok, true);
  // Вторая вкладка после rebase работает на закоммиченном state.
  const second = resolveRestaurantAccountingEntry(first.state, "c", "WAIVED", "вторая", null, "2026-07-18T11:00:00.000Z");
  assert.equal(second.result.ok, false);
  assert.equal(second.state.restaurantAccountingResolutionEvents.length, 1);
  assert.equal(second.state.restaurantAccountingEntries.find((x) => x.id === "c")!.status, "SETTLED");
});

// 39 -------------------------------------------------------------------------

test("невалидные entryId/nowIso/outcome/note/reference → fail same-state", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const st = stateWith([], [], [e]);
  const cases: Array<() => ReturnType<typeof resolveRestaurantAccountingEntry>> = [
    () => resolveRestaurantAccountingEntry(st, "нет", "SETTLED", "x", "r", RES_NOW),
    () => resolveRestaurantAccountingEntry(st, "c", "SETTLED", "x", "r", "не-дата"),
    () => resolveRestaurantAccountingEntry(st, "c", "PAID" as "SETTLED", "x", "r", RES_NOW),
    () => resolveRestaurantAccountingEntry(st, "c", "SETTLED", "n".repeat(ACCOUNTING_RESOLUTION_NOTE_MAX + 1), null, RES_NOW),
    () => resolveRestaurantAccountingEntry(st, "c", "SETTLED", "ok", "r".repeat(ACCOUNTING_RESOLUTION_REFERENCE_MAX + 1), RES_NOW),
    () => resolveRestaurantAccountingEntry(st, "c", "SETTLED", "   ", null, RES_NOW), // ни note, ни ссылки
  ];
  for (const run of cases) {
    const res = run();
    assert.equal(res.result.ok, false);
    assert.equal(res.state, st);
    assert.equal(res.state.revision, st.revision);
    assert.equal(res.state.restaurantAccountingResolutionEvents.length, 0);
  }
});

// 40 -------------------------------------------------------------------------

test("закрытие не меняет сумму, direction, type, source, recognizedAt", () => {
  const e = jentry({
    id: "c",
    orderId: "o",
    direction: "RESTAURANT_OWES_DIRECT",
    type: "PLATFORM_COMMISSION",
    amountCents: 800,
    source: "LEGACY_COMMISSION_SETTLEMENT",
    legacySettlementId: "s-old",
    recognizedAt: DELIVERED_AT,
  });
  const st = stateWith([], [], [e]);
  const res = resolveRestaurantAccountingEntry(st, "c", "SETTLED", "ok", "R", RES_NOW);
  const after = res.state.restaurantAccountingEntries.find((x) => x.id === "c")!;
  assert.equal(after.amountCents, 800);
  assert.equal(after.direction, "RESTAURANT_OWES_DIRECT");
  assert.equal(after.type, "PLATFORM_COMMISSION");
  assert.equal(after.source, "LEGACY_COMMISSION_SETTLEMENT");
  assert.equal(after.recognizedAt, DELIVERED_AT);
  assert.equal(after.legacySettlementId, "s-old");
});

// 41 -------------------------------------------------------------------------

test("после SETTLED: open receivable/payable и net пересчитываются", () => {
  const st = stateWith([], [], [
    jentry({ id: "r1", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 }),
    jentry({ id: "p1", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 }),
  ]);
  assert.equal(getRestaurantOpenReceivableCents(st, RESTAURANT_ID), 800);
  assert.equal(getRestaurantOpenPayableCents(st, RESTAURANT_ID), 5100);

  const res = resolveRestaurantAccountingEntry(st, "p1", "SETTLED", "ok", "R", RES_NOW);
  assert.equal(getRestaurantOpenPayableCents(res.state, RESTAURANT_ID), 0);
  assert.equal(getRestaurantOpenReceivableCents(res.state, RESTAURANT_ID), 800);
  assert.equal(getRestaurantNetPositionCents(res.state, RESTAURANT_ID), -800);
});

// 42 -------------------------------------------------------------------------

test("после WAIVED: комиссия исчезает из open receivable, payout не затронут", () => {
  const st = stateWith([], [], [
    jentry({ id: "r1", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 }),
    jentry({ id: "p1", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 }),
  ]);
  const res = resolveRestaurantAccountingEntry(st, "r1", "WAIVED", "списано", null, RES_NOW);
  assert.equal(getRestaurantOpenReceivableCents(res.state, RESTAURANT_ID), 0);
  assert.equal(getRestaurantOpenPayableCents(res.state, RESTAURANT_ID), 5100);
});

// 43 -------------------------------------------------------------------------

test("journal показывает закрытую запись с settledAt и остаётся в истории", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const res = resolveRestaurantAccountingEntry(stateWith([], [], [e]), "c", "SETTLED", "ok", "R", RES_NOW);
  const rows = buildRestaurantAccountingJournal(res.state, RESTAURANT_ID);
  const row = rows.find((r) => r.entryId === "c")!;
  assert.ok(row, "запись осталась в истории журнала");
  assert.equal(row.status, "SETTLED");
  assert.equal(row.settledAt, RES_NOW);
});

// 44 -------------------------------------------------------------------------

test("миграция schema: старое состояние получает пустой resolutionEvents, без дублей", () => {
  const settlement: SettlementEntry = legacySettlement("o-v8", 640);
  // Состояние прежней версии без поля resolution events.
  const raw = JSON.parse(JSON.stringify(stateWith([], [settlement], [
    jentry({ id: "keep", orderId: "o-v8" }),
  ]))) as Record<string, unknown>;
  raw.schemaVersion = 8;
  delete raw.restaurantAccountingResolutionEvents;

  const parsed = parseStoredState(JSON.stringify(raw));
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, 9);
  assert.deepEqual(parsed.restaurantAccountingResolutionEvents, []);
  // Существующие accounting-записи не потеряны.
  assert.ok(parsed.restaurantAccountingEntries.some((e) => e.id === "keep"));

  // Закрываем и проверяем, что повторный parse не дублирует событие.
  const resolved = resolveRestaurantAccountingEntry(parsed, "keep", "SETTLED", "ok", "R", RES_NOW).state;
  assert.equal(resolved.restaurantAccountingResolutionEvents.length, 1);
  const reparsed = parseStoredState(JSON.stringify(resolved));
  assert.ok(reparsed);
  assert.equal(reparsed.restaurantAccountingResolutionEvents.length, 1);
});

// --- Усиленные audit-инварианты ---------------------------------------------

// 45 -------------------------------------------------------------------------

test("SETTLED с пустым note но валидной ссылкой → fail same-state", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const st = stateWith([], [], [e]);
  const res = resolveRestaurantAccountingEntry(st, "c", "SETTLED", "", "BANK-777", RES_NOW);
  assert.equal(res.result.ok, false);
  assert.equal(res.state, st, "исходный state тем же объектом");
  assert.equal(res.state.revision, st.revision);
  assert.equal(res.state.restaurantAccountingResolutionEvents.length, 0);
  assert.equal(res.state.restaurantAccountingEntries.find((x) => x.id === "c")!.status, "OPEN");
});

// 46 -------------------------------------------------------------------------

test("SETTLED с непустым note и externalReference=null → успех", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const res = resolveRestaurantAccountingEntry(
    stateWith([], [], [e]),
    "c",
    "SETTLED",
    "Оплата подтверждена по банковской выписке",
    null,
    RES_NOW,
  );
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const ev = res.state.restaurantAccountingResolutionEvents[0];
  assert.equal(ev.note, "Оплата подтверждена по банковской выписке");
  assert.equal(ev.externalReference, null);
});

// 47 -------------------------------------------------------------------------

test("SETTLED: reference из одних пробелов нормализуется в null", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const res = resolveRestaurantAccountingEntry(
    stateWith([], [], [e]),
    "c",
    "SETTLED",
    "Основание есть",
    "   ",
    RES_NOW,
  );
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(res.state.restaurantAccountingResolutionEvents[0].externalReference, null);
});

// 48 -------------------------------------------------------------------------

test("существующее audit-событие блокирует закрытие даже при OPEN-записи", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const settlement = legacySettlement("o");
  // Несогласованное состояние: entry ещё OPEN, но audit-событие уже есть.
  const st: PrototypeState = {
    ...stateWith([], [settlement], [e]),
    restaurantAccountingResolutionEvents: [
      {
        id: "accounting-resolution-c",
        accountingEntryId: "c",
        restaurantId: RESTAURANT_ID,
        previousStatus: "OPEN",
        nextStatus: "SETTLED",
        occurredAt: DELIVERED_AT,
        actor: "ADMIN",
        note: "прежнее решение",
        externalReference: null,
      },
    ],
  };
  const res = resolveRestaurantAccountingEntry(st, "c", "SETTLED", "повтор", "R", RES_NOW);
  assert.equal(res.result.ok, false);
  assert.equal(res.state, st, "тот же state reference");
  assert.equal(res.state.revision, st.revision);
  assert.equal(res.state.restaurantAccountingResolutionEvents.length, 1);
  assert.equal(res.state.settlements.find((s) => s.orderId === "o")!.status, "PENDING");
  assert.equal(res.state.restaurantAccountingEntries.find((x) => x.id === "c")!.status, "OPEN");
});

// 49 -------------------------------------------------------------------------

test("событие для другой entry не блокирует закрытие текущей", () => {
  const target = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const st: PrototypeState = {
    ...stateWith([], [], [target]),
    restaurantAccountingResolutionEvents: [
      {
        id: "accounting-resolution-other",
        accountingEntryId: "other-entry",
        restaurantId: RESTAURANT_ID,
        previousStatus: "OPEN",
        nextStatus: "WAIVED",
        occurredAt: DELIVERED_AT,
        actor: "ADMIN",
        note: "чужое решение",
        externalReference: null,
      },
    ],
  };
  const res = resolveRestaurantAccountingEntry(st, "c", "SETTLED", "закрываем", "R", RES_NOW);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(res.state.restaurantAccountingEntries.find((x) => x.id === "c")!.status, "SETTLED");
  assert.equal(res.state.restaurantAccountingResolutionEvents.length, 2);
});

// --- Provider serialized путь и admin view-model ----------------------------

function settleMutation(entryId: string, note: string, ref: string | null) {
  return (baseState: PrototypeState) =>
    resolveRestaurantAccountingEntry(baseState, entryId, "SETTLED", note, ref, RES_NOW);
}

// 50 -------------------------------------------------------------------------

test("serialized мутация закрытия: успех коммитит новое состояние", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const st = stateWith([], [legacySettlement("o")], [e]);
  let persisted: PrototypeState | null = null;
  const out = executeSerializedPrototypeMutation({
    localState: st,
    storedState: null,
    mutation: settleMutation("c", "Сверка", "BANK-1"),
    persist: (s) => {
      persisted = s;
    },
  });
  assert.equal(out.committed, true);
  assert.equal(out.result.ok, true, out.result.error ?? "");
  assert.ok(persisted);
  assert.equal(persisted!.restaurantAccountingResolutionEvents.length, 1);
  assert.equal(persisted!.restaurantAccountingEntries.find((x) => x.id === "c")!.status, "SETTLED");
});

// 51 -------------------------------------------------------------------------

test("serialized мутация: domain error не коммитит и не считается успехом", () => {
  const st = stateWith([], [], [jentry({ id: "c" })]);
  let persistCalled = false;
  const out = executeSerializedPrototypeMutation({
    localState: st,
    storedState: null,
    mutation: settleMutation("нет-такой", "x", null),
    persist: () => {
      persistCalled = true;
    },
  });
  assert.equal(out.committed, false);
  assert.equal(out.result.ok, false);
  assert.equal(persistCalled, false, "persist не вызывается при ошибке домена");
  assert.equal(out.nextState.restaurantAccountingResolutionEvents.length, 0);
});

// 52 -------------------------------------------------------------------------

test("serialized мутация на самом свежем state; повтор после rebase не даёт 2-е событие", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const st = stateWith([], [], [e]);
  const first = executeSerializedPrototypeMutation({
    localState: st,
    storedState: null,
    mutation: settleMutation("c", "первая", "R1"),
    persist: () => {},
  });
  assert.equal(first.committed, true);
  const committed = first.nextState;

  // Вторая вкладка: её localState устарел (st), но persisted свежее (committed) —
  // мутация выполняется на самом свежем state и не создаёт второе событие.
  const second = executeSerializedPrototypeMutation({
    localState: st,
    storedState: committed,
    mutation: settleMutation("c", "вторая", "R2"),
    persist: () => {},
  });
  assert.equal(second.result.ok, false);
  assert.equal(second.committed, false);
  assert.equal(second.nextState.restaurantAccountingResolutionEvents.length, 1);
});

// 53 -------------------------------------------------------------------------

test("admin view-model: только выбранный ресторан, publicNumber, orphan, audit, без внутренних id", () => {
  const order = completed("linked", "PICKUP", RESTAURANT_COLLECTED, "PICKED_UP");
  const st = stateWith([order], [], [
    jentry({ id: "mine", orderId: "linked", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION" }),
    jentry({ id: "orphan", orderId: "нет-заказа", source: "LEGACY_COMMISSION_SETTLEMENT", legacySettlementId: "s-x" }),
    jentry({ id: "other", restaurantId: "restaurant-2" }),
  ]);
  const view = buildAdminAccountingView(st, RESTAURANT_ID);

  assert.equal(view.rows.length, 2, "только записи выбранного ресторана");
  const mine = view.rows.find((r) => r.entryId === "mine")!;
  assert.equal(mine.publicNumber, order.publicNumber);
  assert.equal(mine.restaurantName, "Ресторан 1");
  const orphan = view.rows.find((r) => r.entryId === "orphan")!;
  assert.equal(orphan.publicNumber, null);
  assert.equal(orphan.hasOrder, false);
  // Внутренние идентификаторы не входят в публичную view-model.
  for (const row of view.rows) {
    assert.ok(!("orderId" in row));
    assert.ok(!("restaurantId" in row));
    assert.ok(!("legacySettlementId" in row));
  }

  // Audit связывается по entryId и не содержит служебных полей события.
  const resolved = resolveRestaurantAccountingEntry(st, "mine", "SETTLED", "готово", "R", RES_NOW).state;
  const resolvedView = buildAdminAccountingView(resolved, RESTAURANT_ID);
  const closed = resolvedView.rows.find((r) => r.entryId === "mine")!;
  assert.ok(closed.resolution);
  assert.equal(closed.resolution!.outcome, "SETTLED");
  assert.equal(closed.resolution!.note, "готово");
  assert.ok(!("id" in closed.resolution!));
  assert.ok(!("accountingEntryId" in closed.resolution!));
  assert.ok(!("actor" in closed.resolution!));
});

// 54 -------------------------------------------------------------------------

test("admin view-model: canSettle для обоих типов; canWaive только для комиссии Direct", () => {
  const st = stateWith([], [], [
    jentry({ id: "com", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION" }),
    jentry({ id: "pay", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT" }),
  ]);
  const view = buildAdminAccountingView(st, RESTAURANT_ID);
  const com = view.rows.find((r) => r.entryId === "com")!;
  const pay = view.rows.find((r) => r.entryId === "pay")!;
  assert.equal(com.canSettle, true);
  assert.equal(pay.canSettle, true);
  assert.equal(com.canWaive, true);
  assert.equal(pay.canWaive, false, "выплату ресторану списать нельзя");

  // Закрытая запись больше не предлагает действий.
  const resolved = resolveRestaurantAccountingEntry(st, "com", "SETTLED", "ok", "R", RES_NOW).state;
  const closed = buildAdminAccountingView(resolved, RESTAURANT_ID).rows.find((r) => r.entryId === "com")!;
  assert.equal(closed.canSettle, false);
  assert.equal(closed.canWaive, false);
});

// 55 -------------------------------------------------------------------------

test("admin view-model после SETTLED: закрыто, событие, позиция уменьшилась, legacy синхронизирован", () => {
  const e = jentry({ id: "c", orderId: "o", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 });
  const st = stateWith([], [legacySettlement("o")], [e]);
  const before = buildAdminAccountingView(st, RESTAURANT_ID);
  assert.equal(before.openReceivableCents, 800);
  assert.equal(before.openCount, 1);

  const resolved = resolveRestaurantAccountingEntry(st, "c", "SETTLED", "ok", "R", RES_NOW).state;
  const after = buildAdminAccountingView(resolved, RESTAURANT_ID);
  assert.equal(after.openReceivableCents, 0);
  assert.equal(after.closedCount, 1);
  const row = after.rows.find((r) => r.entryId === "c")!;
  assert.equal(row.status, "SETTLED");
  assert.ok(row.resolution);
  assert.equal(resolved.settlements.find((s) => s.orderId === "o")!.status, "PAID");
});

// 56 -------------------------------------------------------------------------

test("admin view-model после WAIVED: комиссия списана, payout не затронут", () => {
  const st = stateWith([], [], [
    jentry({ id: "com", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION", amountCents: 800 }),
    jentry({ id: "pay", direction: "DIRECT_OWES_RESTAURANT", type: "RESTAURANT_PAYOUT", amountCents: 5100 }),
  ]);
  const resolved = resolveRestaurantAccountingEntry(st, "com", "WAIVED", "списано", null, RES_NOW).state;
  const view = buildAdminAccountingView(resolved, RESTAURANT_ID);
  assert.equal(view.openReceivableCents, 0);
  assert.equal(view.openPayableCents, 5100, "выплата не затронута");
  const com = view.rows.find((r) => r.entryId === "com")!;
  assert.equal(com.status, "WAIVED");
  assert.equal(com.resolution!.outcome, "WAIVED");
});

// 57 -------------------------------------------------------------------------

test("note/reference передаются trimmed через domain result", () => {
  const e = jentry({ id: "c", direction: "RESTAURANT_OWES_DIRECT", type: "PLATFORM_COMMISSION" });
  const resolved = resolveRestaurantAccountingEntry(
    stateWith([], [], [e]),
    "c",
    "SETTLED",
    "   основание   ",
    "  BANK-9  ",
    RES_NOW,
  ).state;
  const ev = resolved.restaurantAccountingResolutionEvents[0];
  assert.equal(ev.note, "основание");
  assert.equal(ev.externalReference, "BANK-9");
});

// 58 -------------------------------------------------------------------------

test("построение admin view-model не мутирует state", () => {
  const st = stateWith([], [legacySettlement("o")], [
    jentry({ id: "c", orderId: "o" }),
  ]);
  const snapshot = JSON.stringify(st);
  const ordersRef = st.orders;
  const entriesRef = st.restaurantAccountingEntries;
  const settlementsRef = st.settlements;
  const revBefore = st.revision;

  buildAdminAccountingView(st, RESTAURANT_ID);
  buildAdminAccountingView(st, RESTAURANT_ID);

  assert.equal(JSON.stringify(st), snapshot);
  assert.equal(st.orders, ordersRef);
  assert.equal(st.restaurantAccountingEntries, entriesRef);
  assert.equal(st.settlements, settlementsRef);
  assert.equal(st.revision, revBefore);
});

// --- Текст подтверждения закрытия -------------------------------------------

// 59 -------------------------------------------------------------------------

test("подтверждение SETTLED: номер, сумма, отметка об отсутствии перевода", () => {
  const msg = formatAccountingResolutionMessage({
    outcome: "SETTLED",
    publicNumber: "DIR-1042",
    amountText: "$8.00",
  });
  assert.ok(msg.includes("DIR-1042"));
  assert.ok(msg.includes("$8.00"));
  assert.ok(msg.includes("зафиксирован"));
  assert.ok(msg.includes("Денежный перевод системой не выполнялся"));
});

// 60 -------------------------------------------------------------------------

test("подтверждение WAIVED: списание, не возврат и не выплата", () => {
  const msg = formatAccountingResolutionMessage({
    outcome: "WAIVED",
    publicNumber: "DIR-1042",
    amountText: "$8.00",
  });
  assert.ok(msg.includes("DIR-1042"));
  assert.ok(msg.includes("$8.00"));
  assert.ok(msg.includes("списана"));
  assert.ok(msg.includes("не возврат и не выплата ресторану"));
  assert.ok(!msg.includes("зафиксирован"));
});

// 61 -------------------------------------------------------------------------

test("подтверждение orphan: «Старое начисление», без внутренних id", () => {
  const settled = formatAccountingResolutionMessage({
    outcome: "SETTLED",
    publicNumber: null,
    amountText: "$3.00",
  });
  assert.ok(settled.includes("Старое начисление"));
  assert.ok(!settled.includes("null"));
  // Внутренние идентификаторы недоступны формуле — она принимает только
  // publicNumber/amountText/outcome, поэтому entryId/orderId попасть не могут.
  const waived = formatAccountingResolutionMessage({
    outcome: "WAIVED",
    publicNumber: null,
    amountText: "$3.00",
  });
  assert.ok(waived.includes("Старое начисление"));
});

// 62 -------------------------------------------------------------------------

test("подтверждение: SETTLED и WAIVED дают разный текст", () => {
  const base = { publicNumber: "DIR-1", amountText: "$1.00" } as const;
  const settled = formatAccountingResolutionMessage({ ...base, outcome: "SETTLED" });
  const waived = formatAccountingResolutionMessage({ ...base, outcome: "WAIVED" });
  assert.notEqual(settled, waived);
});
