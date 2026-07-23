import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { parseStoredState } from "./prototype-store.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type {
  Order,
  PrototypeState,
  RestaurantOrderWorkflowMode,
} from "./models.ts";
import {
  getPlatformDriverCashHandoffView,
  hasRestaurantConfirmedDriverCashHandoff,
  reportDriverCashHandoffToRestaurant,
  confirmRestaurantDriverCashReceipt,
  driverCashHandoffReportEventId,
  restaurantCashReceiptEventId,
} from "./platform-driver-cash-handoff.ts";
import {
  markDriverPickedUpOrder,
  markDriverDeliveredOrder,
} from "./driver-delivery.ts";
import { canRestaurantWorkspacePerformAction } from "./restaurant-workflow.ts";

/**
 * CASH DIRECT — часть 3: двусторонняя передача наличных ресторану. Домен чистый:
 * события append-only, сумма — только из snapshot, финансы не меняются.
 */

const DRIVER = "driver-1";
const REST = "restaurant-2";
const ORDER = "o-cash";
const T0 = "2026-07-22T10:00:00.000Z";
const T1 = "2026-07-22T10:05:00.000Z";
const T2 = "2026-07-22T10:06:00.000Z";
const T3 = "2026-07-22T10:07:00.000Z";

const SNAPSHOT = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 600,
  driverEarningCents: 300,
  directReceivableFromDriverCents: 100,
};

interface CashStateOpts {
  status?: Order["status"];
  paymentMethod?: Order["paymentMethod"];
  paymentStatus?: Order["paymentStatus"];
  snapshot?: unknown;
  offerStatus?: "ACCEPTED" | "OPEN";
  reserveConfirmedAt?: string | null;
  arrived?: boolean;
  pickedUp?: boolean;
  reported?: boolean;
  confirmed?: boolean;
  workflowMode?: RestaurantOrderWorkflowMode;
  driverStatus?: string;
}

function cashState(opts: CashStateOpts = {}): PrototypeState {
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
    status: opts.status ?? "READY",
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
      platformDriverCash:
        opts.snapshot === undefined ? SNAPSHOT : opts.snapshot,
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

  const deliveryEvents: unknown[] = [];
  if (opts.arrived) {
    deliveryEvents.push({
      id: "de-1",
      orderId: ORDER,
      driverId: DRIVER,
      type: "ARRIVED_AT_RESTAURANT",
      occurredAt: T1,
      orderStatusBefore: order.status,
      orderStatusAfter: order.status,
    });
  }
  if (opts.pickedUp) {
    deliveryEvents.push({
      id: "de-2",
      orderId: ORDER,
      driverId: DRIVER,
      type: "ORDER_PICKED_UP",
      occurredAt: T2,
      orderStatusBefore: "READY",
      orderStatusAfter: "OUT_FOR_DELIVERY",
    });
  }

  const cashEvents: unknown[] = [];
  if (opts.reported) {
    cashEvents.push({
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
  if (opts.confirmed) {
    cashEvents.push({
      id: restaurantCashReceiptEventId(ORDER),
      orderId: ORDER,
      driverId: DRIVER,
      restaurantId: REST,
      type: "RESTAURANT_CONFIRMED_CASH_RECEIPT",
      amountCents: 600,
      occurredAt: T3,
      actor: "RESTAURANT",
      restaurantWorkspaceRole: "COMBINED",
    });
  }

  return {
    ...base,
    platformSettings: { ...base.platformSettings, platformDriverCashEnabled: true },
    orders: [order],
    driverOffers: [offer as unknown as PrototypeState["driverOffers"][number]],
    driverDeliveryEvents:
      deliveryEvents as unknown as PrototypeState["driverDeliveryEvents"],
    platformDriverCashEvents:
      cashEvents as unknown as PrototypeState["platformDriverCashEvents"],
    drivers: base.drivers.map((d) =>
      d.id === DRIVER
        ? {
            ...d,
            status: (opts.driverStatus ?? "BUSY_DIRECT") as typeof d.status,
            currentZoneId: "zone-2",
          }
        : d,
    ),
    restaurants: opts.workflowMode
      ? base.restaurants.map((r) =>
          r.id === REST ? { ...r, orderWorkflowMode: opts.workflowMode! } : r,
        )
      : base.restaurants,
  };
}

const theOrder = (state: PrototypeState): Order => state.orders[0];

// --- 1–3: schema / default ----------------------------------------------------

test("1: схема равна 21", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 21);
});
test("2: default platformDriverCashEvents пуст", () => {
  assert.deepEqual(createDefaultState().platformDriverCashEvents, []);
});
test("3: default cash flag false", () => {
  assert.equal(createDefaultState().platformSettings.platformDriverCashEnabled, false);
});

// --- 4–20: driver report ------------------------------------------------------

test("4: report невозможен для ONLINE", () => {
  const s = cashState({ paymentMethod: "ONLINE", paymentStatus: "PAID", arrived: true });
  assert.equal(reportDriverCashHandoffToRestaurant(s, DRIVER, ORDER, T2).result.ok, false);
});
test("5: report невозможен без valid snapshot", () => {
  const s = cashState({ snapshot: null, arrived: true });
  assert.equal(reportDriverCashHandoffToRestaurant(s, DRIVER, ORDER, T2).result.ok, false);
});
test("6: report невозможен без accepted offer", () => {
  const s = cashState({ offerStatus: "OPEN", arrived: true });
  assert.equal(reportDriverCashHandoffToRestaurant(s, DRIVER, ORDER, T2).result.ok, false);
});
test("7: report невозможен без cashReserveConfirmedAt", () => {
  const s = cashState({ reserveConfirmedAt: null, arrived: true });
  assert.equal(reportDriverCashHandoffToRestaurant(s, DRIVER, ORDER, T2).result.ok, false);
});
test("8: report невозможен чужим водителем", () => {
  const s = cashState({ arrived: true });
  assert.equal(reportDriverCashHandoffToRestaurant(s, "driver-2", ORDER, T2).result.ok, false);
});
test("9: report невозможен до прибытия в ресторан", () => {
  const s = cashState({ arrived: false });
  const r = reportDriverCashHandoffToRestaurant(s, DRIVER, ORDER, T2);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Сначала подтвердите прибытие в ресторан.");
});
test("10: report разрешён после прибытия при PREPARING", () => {
  const s = cashState({ status: "PREPARING", arrived: true });
  assert.equal(reportDriverCashHandoffToRestaurant(s, DRIVER, ORDER, T2).result.ok, true);
});
test("11: report разрешён после прибытия при READY", () => {
  const s = cashState({ status: "READY", arrived: true });
  assert.equal(reportDriverCashHandoffToRestaurant(s, DRIVER, ORDER, T2).result.ok, true);
});
test("12/13/14: amount из snapshot; action не принимает amount; одно событие", () => {
  const s = cashState({ arrived: true });
  const r = reportDriverCashHandoffToRestaurant(s, DRIVER, ORDER, T2);
  assert.equal(r.result.ok, true);
  const events = r.state.platformDriverCashEvents;
  assert.equal(events.length, 1);
  assert.equal(events[0].amountCents, 600);
  assert.equal(events[0].actor, "DRIVER");
  assert.equal(events[0].restaurantWorkspaceRole, null);
});
test("15–18: report не меняет статус/оплату/финансы/paidAt", () => {
  const s = cashState({ arrived: true, status: "READY" });
  const before = theOrder(s);
  const r = reportDriverCashHandoffToRestaurant(s, DRIVER, ORDER, T2);
  const after = theOrder(r.state);
  assert.equal(after.status, before.status);
  assert.equal(after.paymentStatus, "CASH_ON_DELIVERY");
  assert.deepEqual(after.financials, before.financials);
  assert.equal(after.paidAt ?? null, before.paidAt ?? null);
});
test("19/20: повторный report fail-closed, revision не растёт", () => {
  const s = cashState({ arrived: true, reported: true });
  const r = reportDriverCashHandoffToRestaurant(s, DRIVER, ORDER, T3);
  assert.equal(r.result.ok, false);
  assert.equal(r.state, s);
  assert.equal(r.state.revision, s.revision);
});

// --- 21–35: restaurant confirmation -------------------------------------------

test("21: confirm невозможен до driver report", () => {
  const s = cashState({ arrived: true, reported: false });
  assert.equal(
    confirmRestaurantDriverCashReceipt(s, REST, ORDER, "COMBINED", T3).result.ok,
    false,
  );
});
test("22: confirm невозможен чужим restaurantId", () => {
  const s = cashState({ arrived: true, reported: true });
  assert.equal(
    confirmRestaurantDriverCashReceipt(s, "restaurant-1", ORDER, "COMBINED", T3).result.ok,
    false,
  );
});
test("23: COMBINED может подтвердить", () => {
  const s = cashState({ arrived: true, reported: true, workflowMode: "COMBINED" });
  assert.equal(
    confirmRestaurantDriverCashReceipt(s, REST, ORDER, "COMBINED", T3).result.ok,
    true,
  );
});
test("24: OPERATOR может подтвердить (SPLIT)", () => {
  const s = cashState({ arrived: true, reported: true, workflowMode: "SPLIT_OPERATOR_KITCHEN" });
  assert.equal(
    confirmRestaurantDriverCashReceipt(s, REST, ORDER, "OPERATOR", T3).result.ok,
    true,
  );
});
test("25: KITCHEN не может подтвердить (SPLIT)", () => {
  const s = cashState({ arrived: true, reported: true, workflowMode: "SPLIT_OPERATOR_KITCHEN" });
  const r = confirmRestaurantDriverCashReceipt(s, REST, ORDER, "KITCHEN", T3);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Недостаточно прав для подтверждения получения наличных.");
  assert.equal(r.state, s);
});
test("26/27: confirmation фиксирует точную сумму и роль", () => {
  const s = cashState({ arrived: true, reported: true, workflowMode: "SPLIT_OPERATOR_KITCHEN" });
  const r = confirmRestaurantDriverCashReceipt(s, REST, ORDER, "OPERATOR", T3);
  const ev = r.state.platformDriverCashEvents.find(
    (e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT",
  );
  assert.ok(ev);
  assert.equal(ev.amountCents, 600);
  assert.equal(ev.restaurantWorkspaceRole, "OPERATOR");
  assert.equal(ev.actor, "RESTAURANT");
});
test("28–31: confirmation не меняет статус/оплату/accounting/settlements", () => {
  const s = cashState({ arrived: true, reported: true });
  const before = theOrder(s);
  const r = confirmRestaurantDriverCashReceipt(s, REST, ORDER, "COMBINED", T3);
  const after = theOrder(r.state);
  assert.equal(after.status, before.status);
  assert.equal(after.paymentStatus, "CASH_ON_DELIVERY");
  assert.equal(after.paidAt ?? null, null);
  assert.deepEqual(r.state.restaurantAccountingEntries, s.restaurantAccountingEntries);
  assert.deepEqual(r.state.settlements, s.settlements);
});
test("32/33: повторное confirmation fail-closed, второго события нет", () => {
  const s = cashState({ arrived: true, reported: true, confirmed: true });
  const r = confirmRestaurantDriverCashReceipt(s, REST, ORDER, "COMBINED", T3);
  assert.equal(r.result.ok, false);
  assert.equal(r.state, s);
  assert.equal(
    r.state.platformDriverCashEvents.filter(
      (e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT",
    ).length,
    1,
  );
});
test("34: report и confirmation имеют разные event id", () => {
  assert.notEqual(driverCashHandoffReportEventId(ORDER), restaurantCashReceiptEventId(ORDER));
});
// --- 35 + хронология подтверждения (repair) -----------------------------------

/** Состояние с driver report в T2 (10:06) — база для chronology-тестов. */
const reportedState = () => cashState({ arrived: true, reported: true });

test("35a: confirmation раньше report — fail-closed с точной ошибкой", () => {
  const s = reportedState(); // report.occurredAt === T2 (10:06)
  const before = JSON.stringify(s);
  const r = confirmRestaurantDriverCashReceipt(s, REST, ORDER, "COMBINED", T1); // 10:05
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Некорректное время подтверждения получения наличных.");
  assert.equal(r.result.orderId, null);
  // Тот же объект state, revision не растёт, состояние не мутировано.
  assert.equal(r.state, s);
  assert.equal(r.state.revision, s.revision);
  assert.equal(JSON.stringify(s), before);
});

test("35b: при ошибке confirmation нет, driver report остаётся ровно один", () => {
  const s = reportedState();
  const r = confirmRestaurantDriverCashReceipt(s, REST, ORDER, "COMBINED", T1);
  const events = r.state.platformDriverCashEvents;
  assert.equal(
    events.filter((e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT").length,
    0,
  );
  assert.equal(
    events.filter((e) => e.type === "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF").length,
    1,
  );
});

test("35c: при ошибке заказ, financials, paymentStatus, paidAt и учёт не меняются", () => {
  const s = reportedState();
  const beforeOrder = theOrder(s);
  const r = confirmRestaurantDriverCashReceipt(s, REST, ORDER, "COMBINED", T1);
  const afterOrder = theOrder(r.state);
  assert.deepEqual(afterOrder, beforeOrder);
  assert.deepEqual(afterOrder.financials, beforeOrder.financials);
  assert.equal(afterOrder.paymentStatus, "CASH_ON_DELIVERY");
  assert.equal(afterOrder.paidAt ?? null, beforeOrder.paidAt ?? null);
  assert.deepEqual(r.state.restaurantAccountingEntries, s.restaurantAccountingEntries);
  assert.deepEqual(r.state.settlements, s.settlements);
});

test("35d: равное время разрешено (та же миллисекунда) → CONFIRMED", () => {
  const s = reportedState(); // report T2
  const r = confirmRestaurantDriverCashReceipt(s, REST, ORDER, "COMBINED", T2);
  assert.equal(r.result.ok, true);
  const ev = r.state.platformDriverCashEvents.find(
    (e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT",
  );
  assert.ok(ev);
  assert.equal(ev.occurredAt, T2);
  assert.equal(getPlatformDriverCashHandoffView(r.state, theOrder(r.state)).status, "CONFIRMED");
});

test("35e: позднее время разрешено → CONFIRMED без изменений поведения", () => {
  const s = reportedState(); // report T2
  const r = confirmRestaurantDriverCashReceipt(s, REST, ORDER, "COMBINED", T3);
  assert.equal(r.result.ok, true);
  const ev = r.state.platformDriverCashEvents.find(
    (e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT",
  );
  assert.ok(ev);
  assert.equal(ev.occurredAt, T3);
  assert.equal(ev.amountCents, 600);
  assert.equal(getPlatformDriverCashHandoffView(r.state, theOrder(r.state)).status, "CONFIRMED");
});

test("35f: повреждённый report.occurredAt — fail-closed без исключения", () => {
  const base = reportedState();
  // Вручную повреждённый runtime-state (normalizer такой уже удалил бы).
  const broken: PrototypeState = {
    ...base,
    platformDriverCashEvents: base.platformDriverCashEvents.map((e) =>
      e.type === "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF"
        ? { ...e, occurredAt: "не-дата" }
        : e,
    ),
  };
  const r = confirmRestaurantDriverCashReceipt(broken, REST, ORDER, "COMBINED", T3);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Данные передачи наличных требуют проверки Direct.");
  assert.equal(r.state, broken);
  assert.equal(
    r.state.platformDriverCashEvents.filter(
      (e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT",
    ).length,
    0,
  );
});

// --- view / has-confirmed -----------------------------------------------------

test("view: этапы DRIVER_ACTION → RESTAURANT_CONFIRMATION → CONFIRMED", () => {
  const s0 = cashState({ arrived: true });
  assert.equal(getPlatformDriverCashHandoffView(s0, theOrder(s0)).status, "DRIVER_ACTION_REQUIRED");
  assert.equal(getPlatformDriverCashHandoffView(s0, theOrder(s0)).amountCents, 600);
  const s1 = cashState({ arrived: true, reported: true });
  assert.equal(
    getPlatformDriverCashHandoffView(s1, theOrder(s1)).status,
    "RESTAURANT_CONFIRMATION_REQUIRED",
  );
  const s2 = cashState({ arrived: true, reported: true, confirmed: true });
  assert.equal(getPlatformDriverCashHandoffView(s2, theOrder(s2)).status, "CONFIRMED");
  assert.equal(hasRestaurantConfirmedDriverCashHandoff(s2, theOrder(s2)), true);
});
test("view: ONLINE → NOT_APPLICABLE; невалидный snapshot → REVIEW", () => {
  const online = cashState({ paymentMethod: "ONLINE", paymentStatus: "PAID" });
  assert.equal(getPlatformDriverCashHandoffView(online, theOrder(online)).status, "NOT_APPLICABLE");
  const noSnap = cashState({ snapshot: null });
  assert.equal(getPlatformDriverCashHandoffView(noSnap, theOrder(noSnap)).status, "REVIEW_REQUIRED");
});

// --- 36–42: pickup / delivery guards ------------------------------------------

test("37: CASH pickup до report запрещён", () => {
  const s = cashState({ status: "READY", arrived: true });
  const r = markDriverPickedUpOrder(s, DRIVER, ORDER, T2);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Ресторан ещё не подтвердил получение наличных.");
});
test("38: CASH pickup после report, до confirmation запрещён", () => {
  const s = cashState({ status: "READY", arrived: true, reported: true });
  const r = markDriverPickedUpOrder(s, DRIVER, ORDER, T2);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Ресторан ещё не подтвердил получение наличных.");
});
test("39/40: CASH pickup после confirmation успешен и один раз (READY→OUT_FOR_DELIVERY)", () => {
  const s = cashState({ status: "READY", arrived: true, reported: true, confirmed: true });
  const r = markDriverPickedUpOrder(s, DRIVER, ORDER, T3);
  assert.equal(r.result.ok, true);
  assert.equal(theOrder(r.state).status, "OUT_FOR_DELIVERY");
});
test("41: CASH final delivery пока fail-closed", () => {
  const s = cashState({ status: "ARRIVING", arrived: true, reported: true, confirmed: true, pickedUp: true });
  // Добавляем событие ARRIVING_TO_CUSTOMER, чтобы дойти до guard доставки.
  const withArriving: PrototypeState = {
    ...s,
    driverDeliveryEvents: [
      ...s.driverDeliveryEvents,
      {
        id: "de-3",
        orderId: ORDER,
        driverId: DRIVER,
        type: "ARRIVING_TO_CUSTOMER",
        occurredAt: T3,
        orderStatusBefore: "OUT_FOR_DELIVERY",
        orderStatusAfter: "ARRIVING",
      } as unknown as PrototypeState["driverDeliveryEvents"][number],
    ],
  };
  const r = markDriverDeliveredOrder(withArriving, DRIVER, ORDER, T3);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, "Получение наличных от клиента ещё не подтверждено.");
});

// --- permission matrix --------------------------------------------------------

test("permission: COMBINED/OPERATOR разрешено, KITCHEN запрещено", () => {
  const combined = canRestaurantWorkspacePerformAction({
    workflowMode: "COMBINED",
    workspaceRole: "COMBINED",
    action: "CONFIRM_DRIVER_CASH_RECEIPT",
  });
  const operator = canRestaurantWorkspacePerformAction({
    workflowMode: "SPLIT_OPERATOR_KITCHEN",
    workspaceRole: "OPERATOR",
    action: "CONFIRM_DRIVER_CASH_RECEIPT",
  });
  const kitchen = canRestaurantWorkspacePerformAction({
    workflowMode: "SPLIT_OPERATOR_KITCHEN",
    workspaceRole: "KITCHEN",
    action: "CONFIRM_DRIVER_CASH_RECEIPT",
  });
  assert.equal(combined, true);
  assert.equal(operator, true);
  assert.equal(kitchen, false);
});

// --- 44–66: persistence -------------------------------------------------------

function reportRaw(over: Record<string, unknown> = {}) {
  return {
    id: driverCashHandoffReportEventId(ORDER),
    orderId: ORDER,
    driverId: DRIVER,
    restaurantId: REST,
    type: "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF",
    amountCents: 600,
    occurredAt: T2,
    actor: "DRIVER",
    restaurantWorkspaceRole: null,
    ...over,
  };
}
function confirmRaw(over: Record<string, unknown> = {}) {
  return {
    id: restaurantCashReceiptEventId(ORDER),
    orderId: ORDER,
    driverId: DRIVER,
    restaurantId: REST,
    type: "RESTAURANT_CONFIRMED_CASH_RECEIPT",
    amountCents: 600,
    occurredAt: T3,
    actor: "RESTAURANT",
    restaurantWorkspaceRole: "OPERATOR",
    ...over,
  };
}

/** Разбор состояния (schemaVersion) с готовым CASH-заказом+offer и cash events. */
function persist(schemaVersion: number, events: unknown[]): PrototypeState {
  const s = cashState({ arrived: true });
  const parsed = parseStoredState(
    JSON.stringify({ ...s, schemaVersion, platformDriverCashEvents: events }),
  );
  assert.ok(parsed, "состояние должно парситься");
  return parsed;
}

test("44: schema 7–20 получают platformDriverCashEvents []", () => {
  for (const v of [7, 12, 18, 20]) {
    assert.deepEqual(persist(v, [reportRaw()]).platformDriverCashEvents, []);
  }
});
test("45/46: schema <21 не принимает события; 21 сохраняет валидный report", () => {
  assert.deepEqual(persist(20, [reportRaw()]).platformDriverCashEvents, []);
  const kept = persist(21, [reportRaw()]).platformDriverCashEvents;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].type, "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF");
});
test("47: schema 21 сохраняет confirmation после report", () => {
  const kept = persist(21, [reportRaw(), confirmRaw()]).platformDriverCashEvents;
  assert.equal(kept.length, 2);
});
test("48–56: невалидные события удаляются", () => {
  const bad = (over: Record<string, unknown>) =>
    persist(21, [reportRaw(over)]).platformDriverCashEvents.length;
  assert.equal(bad({ type: "ЧТО-ТО" }), 0); // 48 неизвестный тип
  assert.equal(bad({ actor: "RESTAURANT" }), 0); // 49 неправильный actor
  assert.equal(
    persist(21, [confirmRaw({ restaurantWorkspaceRole: "KITCHEN" }), reportRaw()]).platformDriverCashEvents.filter(
      (e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT",
    ).length,
    0,
  ); // 50 KITCHEN confirmation
  assert.equal(bad({ restaurantId: "restaurant-1" }), 0); // 51 неправильный restaurantId
  assert.equal(bad({ orderId: "нет" }), 0); // 52 несуществующий order
  assert.equal(bad({ driverId: "нет" }), 0); // 53 несуществующий driver
  assert.equal(bad({ occurredAt: "не-дата" }), 0); // 54 невалидный ISO
  assert.equal(bad({ amountCents: 600.5 }), 0); // 55 дробная
  assert.equal(bad({ amountCents: 601 }), 0); // 56 отличается на 1 цент
});
test("57: event для ONLINE order удаляется", () => {
  const s = cashState({ paymentMethod: "ONLINE", paymentStatus: "PAID", arrived: true });
  const parsed = parseStoredState(
    JSON.stringify({ ...s, schemaVersion: 21, platformDriverCashEvents: [reportRaw()] }),
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.platformDriverCashEvents, []);
});
test("58: event без valid snapshot удаляется", () => {
  const s = cashState({ snapshot: null, arrived: true });
  const parsed = parseStoredState(
    JSON.stringify({ ...s, schemaVersion: 21, platformDriverCashEvents: [reportRaw()] }),
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.platformDriverCashEvents, []);
});
test("59: event без accepted confirmed cash offer удаляется", () => {
  const s = cashState({ reserveConfirmedAt: null, arrived: true });
  const parsed = parseStoredState(
    JSON.stringify({ ...s, schemaVersion: 21, platformDriverCashEvents: [reportRaw()] }),
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.platformDriverCashEvents, []);
});
test("60: confirmation без report удаляется", () => {
  const kept = persist(21, [confirmRaw()]).platformDriverCashEvents;
  assert.equal(kept.length, 0);
});
test("61: confirmation раньше report удаляется", () => {
  const kept = persist(21, [
    reportRaw({ occurredAt: T3 }),
    confirmRaw({ occurredAt: T2 }),
  ]).platformDriverCashEvents;
  assert.equal(kept.filter((e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT").length, 0);
});
test("61b: равное время confirmation === report сохраняется", () => {
  const kept = persist(21, [
    reportRaw({ occurredAt: T2 }),
    confirmRaw({ occurredAt: T2 }),
  ]).platformDriverCashEvents;
  assert.equal(kept.filter((e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT").length, 1);
});

test("61c: позднее время confirmation > report сохраняется", () => {
  const kept = persist(21, [
    reportRaw({ occurredAt: T2 }),
    confirmRaw({ occurredAt: T3 }),
  ]).platformDriverCashEvents;
  const conf = kept.find((e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT");
  assert.ok(conf);
  assert.equal(conf.occurredAt, T3);
});

test("62/63: дубль report/confirmation — первый валидный сохраняется", () => {
  const kept = persist(21, [
    reportRaw(),
    reportRaw({ id: "other", occurredAt: T3 }),
    confirmRaw(),
    confirmRaw({ id: "other2" }),
  ]).platformDriverCashEvents;
  assert.equal(kept.filter((e) => e.type === "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF").length, 1);
  assert.equal(kept.filter((e) => e.type === "RESTAURANT_CONFIRMED_CASH_RECEIPT").length, 1);
});
test("64: повторный serialize/parse идемпотентен", () => {
  const s1 = persist(21, [reportRaw(), confirmRaw()]);
  const s2 = parseStoredState(JSON.stringify(s1));
  assert.ok(s2);
  assert.deepEqual(s2.platformDriverCashEvents, s1.platformDriverCashEvents);
});
test("65/66: события не реконструируются из delivery events / order.history", () => {
  // Заказ имеет ARRIVED delivery event, но без cash events список пуст.
  const s = cashState({ arrived: true, reported: false });
  const parsed = parseStoredState(JSON.stringify({ ...s, schemaVersion: 21 }));
  assert.ok(parsed);
  assert.deepEqual(parsed.platformDriverCashEvents, []);
});

// --- регрессии ----------------------------------------------------------------

test("94/95: default cash false; checkout ONLINE-only (рестораны без CASH)", () => {
  const st = createDefaultState();
  assert.equal(st.platformSettings.platformDriverCashEnabled, false);
  for (const r of st.restaurants) assert.ok(!r.paymentMethods.includes("CASH"));
});

// --- UI (источники) -----------------------------------------------------------

const WORKSPACE = readFileSync("src/components/driver/driver-workspace.tsx", "utf8");
const REST_PANEL = readFileSync(
  "src/components/restaurant/restaurant-cash-handoff-panel.tsx",
  "utf8",
);
const DRIVER_CSS = readFileSync("src/app/driver/driver.module.css", "utf8");

function cssRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, selector);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

test("ui-67/69: driver показывает сумму и «Я передал ресторану»", () => {
  assert.ok(WORKSPACE.includes("Нужно передать ресторану:"));
  assert.ok(WORKSPACE.includes("Я передал ресторану"));
});
test("ui-70/72/73: sheet «Подтвердите передачу» + «Я передал эту сумму» + «Отмена»", () => {
  assert.ok(WORKSPACE.includes("Подтвердите передачу"));
  assert.ok(WORKSPACE.includes("Я передал эту сумму"));
  assert.ok(WORKSPACE.includes("Отмена"));
  assert.ok(WORKSPACE.includes("DriverControlSheet"));
});
test("ui-71: до подтверждения provider action не вызывается напрямую (через sheet)", () => {
  assert.ok(WORKSPACE.includes("driverReportCashHandoffToRestaurant"));
  assert.ok(WORKSPACE.includes("setReportOpen"));
});
test("ui-74/76: ожидание ресторана и подтверждённая сумма", () => {
  assert.ok(WORKSPACE.includes("Ожидаем подтверждение ресторана"));
  assert.ok(WORKSPACE.includes("Ресторан подтвердил получение"));
});
test("ui-79/80/85/86: restaurant panel — «Наличные водителя», подтверждение, «Деньги получены», «Отмена»", () => {
  assert.ok(REST_PANEL.includes("Наличные водителя"));
  assert.ok(REST_PANEL.includes("Сумма к получению:"));
  assert.ok(REST_PANEL.includes("Подтвердить получение"));
  assert.ok(REST_PANEL.includes("Подтвердите получение наличных"));
  assert.ok(REST_PANEL.includes("Деньги получены"));
  assert.ok(REST_PANEL.includes("Отмена"));
});
test("ui-81: KITCHEN не видит confirmation action (панель возвращает null)", () => {
  assert.ok(REST_PANEL.includes('workspaceRole === "KITCHEN"'));
});
test("ui-84/91: используется существующий DriverControlSheet", () => {
  assert.ok(REST_PANEL.includes("DriverControlSheet"));
});
test("ui-89/90: primary min-height 52px, secondary 44px", () => {
  assert.ok(cssRule(DRIVER_CSS, ".cashConfirmPrimary").includes("min-height: 52px"));
  assert.ok(cssRule(DRIVER_CSS, ".cashConfirmSecondary").includes("min-height: 44px"));
});
test("ui-92/93: нет customer cash collection / debt / ledger UI", () => {
  for (const forbidden of ["Получить от клиента", "Долг водителя", "ledger"]) {
    assert.ok(!WORKSPACE.includes(forbidden));
    assert.ok(!REST_PANEL.includes(forbidden));
  }
});
