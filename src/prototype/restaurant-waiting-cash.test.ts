import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { reportDriverOrderIncident } from "./driver-order-incidents.ts";
import { markDriverPickedUpOrder } from "./driver-delivery.ts";
import {
  driverCashHandoffReportEventId,
  getPlatformDriverCashHandoffView,
  reportDriverCashHandoffToRestaurant,
  restaurantCashReceiptEventId,
} from "./platform-driver-cash-handoff.ts";
import type { Order, PrototypeState } from "./models.ts";
import {
  getRestaurantWaitingSummary,
  getRestaurantWaitingView,
} from "./restaurant-waiting-analytics.ts";

/**
 * CASH driver waiting status — corrective microbatch. A PLATFORM_DRIVER CASH
 * order must, after the append-only ARRIVED_AT_RESTAURANT event, show the one
 * canonical waiting summary built purely through getRestaurantWaitingView /
 * getRestaurantWaitingSummary — the same read-model and presentation model the
 * ONLINE flow uses — without ever replacing the working cash handoff card.
 *
 * These tests exercise the real fixture and real branching (not TSX text): a
 * genuine CASH order with platformDriverCashEnabled, an accepted+reserve-
 * confirmed cash offer, an immutable platformDriverCash snapshot, an assigned
 * driver and a valid arrival event.
 */

const DRIVER = "driver-1";
const REST = "restaurant-2";
const ORDER = "o-cash-wait";
const T0 = "2026-07-22T10:00:00.000Z"; // created / kitchen start
const T5 = "2026-07-22T10:05:00.000Z"; // driver arrived
const T6 = "2026-07-22T10:06:00.000Z"; // driver reports handoff
const T7 = "2026-07-22T10:07:00.000Z"; // restaurant confirms
const T8 = "2026-07-22T10:08:00.000Z"; // now, before ETA
const T10 = "2026-07-22T10:10:00.000Z"; // expected ready (ETA)
const T12 = "2026-07-22T10:12:00.000Z"; // structured READY
const T15 = "2026-07-22T10:15:00.000Z"; // now, after ETA

const SNAPSHOT = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 700,
  driverEarningCents: 300,
  restaurantOwesDirectCents: 100,
};

interface CashWaitOpts {
  status?: Order["status"];
  paymentMethod?: Order["paymentMethod"];
  paymentStatus?: Order["paymentStatus"];
  arrived?: boolean;
  reported?: boolean;
  confirmed?: boolean;
  ready?: boolean; // append structured PREPARING -> READY history
}

/**
 * A CASH PLATFORM_DRIVER order valid for BOTH the cash handoff domain and the
 * restaurant waiting read-model: real snapshot, accepted+reserved offer,
 * assigned driver, kitchen/ETA timestamps and an immutable arrival event.
 */
function cashWaitState(opts: CashWaitOpts = {}): PrototypeState {
  const base = createDefaultState();
  const status = opts.status ?? "PREPARING";
  const order = {
    id: ORDER,
    publicNumber: "CW-1",
    createdAt: T0,
    updatedAt: T0,
    kitchenStartedAt: T0,
    expectedReadyAt: T10,
    customer: { id: "customer-1", name: "Клиент", phone: "+373 1" },
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: opts.paymentMethod ?? "CASH",
    paymentStatus: opts.paymentStatus ?? "CASH_ON_DELIVERY",
    status,
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
    history: opts.ready
      ? [
          {
            id: `${ORDER}-ready`,
            occurredAt: T12,
            actor: "RESTAURANT" as const,
            type: "STATUS" as const,
            fromStatus: "PREPARING" as const,
            toStatus: "READY" as const,
            message: "ignored human text",
          },
        ]
      : [],
    financials: {
      currencyCode: "USD",
      customerZoneId: "zone-1",
      customerTotalCents: 1000,
      restaurantPayoutBeforeBankFeeCents: 600,
      driverPayoutCents: 300,
      platformGrossRevenueCents: 100,
      platformDriverCash: SNAPSHOT,
    },
  } as unknown as Order;

  const offer = {
    id: "offer-1",
    orderId: ORDER,
    driverId: DRIVER,
    status: "ACCEPTED",
    offeredAt: T0,
    expiresAt: "2030-01-01T00:00:00.000Z",
    resolvedAt: T0,
    cashReserveConfirmedAt: T0,
  };

  // Immutable arrival: captured while cooking (PREPARING -> PREPARING).
  const deliveryEvents: unknown[] = [];
  if (opts.arrived) {
    deliveryEvents.push({
      id: "de-1",
      orderId: ORDER,
      driverId: DRIVER,
      type: "ARRIVED_AT_RESTAURANT",
      occurredAt: T5,
      orderStatusBefore: "PREPARING",
      orderStatusAfter: "PREPARING",
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
      amountCents: 700,
      occurredAt: T6,
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
      amountCents: 700,
      occurredAt: T7,
      actor: "RESTAURANT",
      restaurantWorkspaceRole: "COMBINED",
    });
  }

  return {
    ...base,
    platformSettings: {
      ...base.platformSettings,
      platformDriverCashEnabled: true,
    },
    orders: [order],
    driverOffers: [offer as unknown as PrototypeState["driverOffers"][number]],
    driverDeliveryEvents:
      deliveryEvents as unknown as PrototypeState["driverDeliveryEvents"],
    platformDriverCashEvents:
      cashEvents as unknown as PrototypeState["platformDriverCashEvents"],
    drivers: base.drivers.map((d) =>
      d.id === DRIVER
        ? { ...d, status: "BUSY_DIRECT" as typeof d.status, currentZoneId: "zone-2" }
        : d,
    ),
  };
}

const theOrder = (state: PrototypeState): Order => state.orders[0];

// --- 1: до прибытия waiting summary не показывается -----------------------------

test("1: CASH до прибытия — NOT_ARRIVED и summary отсутствует", () => {
  const state = cashWaitState({ arrived: false });
  const view = getRestaurantWaitingView(state, ORDER, T8);
  assert.equal(view.status, "NOT_ARRIVED");
  assert.equal(getRestaurantWaitingSummary(view), null);
  // Cash поток при этом активен (передача ещё впереди).
  assert.equal(
    getPlatformDriverCashHandoffView(state, theOrder(state)).status,
    "DRIVER_ACTION_REQUIRED",
  );
});

// --- 2-3: после прибытия до ETA — WAITING, delay 0 ------------------------------

test("2-3: CASH после прибытия до ETA — WAITING, задержка 0", () => {
  const state = cashWaitState({ arrived: true });
  const view = getRestaurantWaitingView(state, ORDER, T8);
  assert.equal(view.status, "WAITING");
  assert.equal(view.waitingDurationMs, 3 * 60_000);
  assert.equal(view.restaurantDelayMs, 0);

  const summary = getRestaurantWaitingSummary(view);
  assert.ok(summary);
  assert.equal(summary.delayed, false);
  assert.equal(summary.restaurantDelayMs, 0);
  assert.equal(summary.canReportDelay, false);
  assert.equal(summary.waitingDurationMs, 3 * 60_000);
});

// --- 4-5: после ETA — задержка ресторана и действие о задержке ------------------

test("4: CASH после ETA — summary показывает опоздание ресторана", () => {
  const state = cashWaitState({ arrived: true });
  const view = getRestaurantWaitingView(state, ORDER, T15);
  const summary = getRestaurantWaitingSummary(view);
  assert.ok(summary);
  assert.equal(summary.delayed, true);
  assert.equal(summary.restaurantDelayMs, 5 * 60_000);
  assert.equal(summary.waitingDurationMs, 10 * 60_000);
});

test("5: CASH после ETA — canReportDelay открывает действие о задержке", () => {
  const state = cashWaitState({ arrived: true });
  const summary = getRestaurantWaitingSummary(
    getRestaurantWaitingView(state, ORDER, T15),
  );
  assert.ok(summary);
  assert.equal(summary.canReportDelay, true);
});

// --- 6: действие использует существующий incident flow и ORDER_DELAYED ----------

test("6: доказанная задержка CASH допускает ORDER_DELAYED через существующий поток", () => {
  const state = cashWaitState({ arrived: true });
  // Домен уже поддерживает ORDER_DELAYED для доказанного позднего ожидания.
  const result = reportDriverOrderIncident(state, {
    driverId: DRIVER,
    orderId: ORDER,
    reason: "ORDER_DELAYED",
    details: "",
  });
  assert.equal(result.result.ok, true);
  // UI CASH-блока переиспользует тот же callback, что и ONLINE StagePanel.
  const workspace = readFileSync(
    "src/components/driver/driver-workspace.tsx",
    "utf8",
  );
  const block = workspace.slice(
    workspace.indexOf("<DriverCashHandoffBlock"),
    workspace.indexOf("/>", workspace.indexOf("<DriverCashHandoffBlock")),
  );
  assert.ok(block.includes('onReportDelay={() => openIncidentSheet("ORDER_DELAYED")}'));
  assert.ok(block.includes("waitingView={waitingView}"));
});

// --- 7: cash handoff действие доступно одновременно с waiting summary ------------

test("7: waiting summary и передача наличных доступны одновременно", () => {
  const state = cashWaitState({ arrived: true });
  const summary = getRestaurantWaitingSummary(
    getRestaurantWaitingView(state, ORDER, T8),
  );
  assert.ok(summary, "waiting summary показан");
  // И при этом действие передачи наличных ресторану остаётся рабочим.
  const handoff = reportDriverCashHandoffToRestaurant(state, DRIVER, ORDER, T6);
  assert.equal(handoff.result.ok, true);
});

// --- 8: ожидание подтверждения ресторана не скрывает waiting summary ------------

test("8: RESTAURANT_CONFIRMATION_REQUIRED не скрывает waiting summary", () => {
  const state = cashWaitState({ arrived: true, reported: true });
  assert.equal(
    getPlatformDriverCashHandoffView(state, theOrder(state)).status,
    "RESTAURANT_CONFIRMATION_REQUIRED",
  );
  assert.ok(
    getRestaurantWaitingSummary(getRestaurantWaitingView(state, ORDER, T8)),
  );
});

// --- 9: после подтверждения денег и до READY summary остаётся -------------------

test("9: деньги подтверждены, заказ ещё готовится — summary остаётся", () => {
  const state = cashWaitState({ arrived: true, reported: true, confirmed: true });
  assert.equal(
    getPlatformDriverCashHandoffView(state, theOrder(state)).status,
    "CONFIRMED",
  );
  const view = getRestaurantWaitingView(state, ORDER, T8);
  assert.equal(view.status, "WAITING");
  assert.ok(getRestaurantWaitingSummary(view));
});

// --- 10: после READY доступно «Заказ получен», summary больше не активен --------

test("10: после READY summary завершён и «Заказ получен» доступен", () => {
  const state = cashWaitState({
    status: "READY",
    ready: true,
    arrived: true,
    reported: true,
    confirmed: true,
  });
  const view = getRestaurantWaitingView(state, ORDER, T15);
  assert.equal(view.status, "READY");
  // Активного ожидания больше нет — верхний блок ожидания не показывается.
  assert.equal(getRestaurantWaitingSummary(view), null);
  // Забор заказа доступен после подтверждённой передачи наличных.
  const pickup = markDriverPickedUpOrder(state, DRIVER, ORDER, T15);
  assert.equal(pickup.result.ok, true);
  assert.equal(theOrder(pickup.state).status, "OUT_FOR_DELIVERY");
});

// --- 11: restaurantHandoffCents не изменяется и не пересчитывается ---------------

test("11: restaurantHandoffCents не меняется чтением read-model/presentation", () => {
  const state = cashWaitState({ arrived: true });
  const before = theOrder(state).financials.platformDriverCash;
  getRestaurantWaitingView(state, ORDER, T15);
  getRestaurantWaitingSummary(getRestaurantWaitingView(state, ORDER, T15));
  getPlatformDriverCashHandoffView(state, theOrder(state));
  const after = theOrder(state).financials.platformDriverCash;
  assert.deepEqual(after, before);
  assert.equal(after.restaurantHandoffCents, 700);
});

// --- 12: ONLINE waiting presentation не ломается --------------------------------

test("12: ONLINE waiting summary строится тем же способом", () => {
  const state = cashWaitState({
    arrived: true,
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
  });
  // ONLINE-заказ — cash поток неприменим, но waiting summary работает.
  assert.equal(
    getPlatformDriverCashHandoffView(state, theOrder(state)).status,
    "NOT_APPLICABLE",
  );
  const view = getRestaurantWaitingView(state, ORDER, T8);
  assert.equal(view.status, "WAITING");
  assert.ok(getRestaurantWaitingSummary(view));
});

// --- 13: read-model общий для ONLINE и CASH ------------------------------------

test("13: один read-model даёт WAITING и для ONLINE, и для CASH", () => {
  const cash = cashWaitState({ arrived: true });
  const online = cashWaitState({
    arrived: true,
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
  });
  assert.equal(getRestaurantWaitingView(cash, ORDER, T8).status, "WAITING");
  assert.equal(getRestaurantWaitingView(online, ORDER, T8).status, "WAITING");
});

// --- 14: финансы, зоны, тарифы и dispatch waves не меняются ---------------------

test("14: read-model не меняет финансы, зоны, тарифы, payouts и dispatch waves", () => {
  const state = cashWaitState({ arrived: true, reported: true, confirmed: true });
  const protectedBefore = JSON.stringify({
    zones: state.zones,
    tariffs: state.tariffs,
    settlements: state.settlements,
    earnings: state.driverEarningEntries,
    payouts: state.driverPayoutBatches,
    waves: state.driverDispatchWaves,
    cashEvents: state.platformDriverCashEvents,
  });
  getRestaurantWaitingView(state, ORDER, T15);
  getRestaurantWaitingSummary(getRestaurantWaitingView(state, ORDER, T15));
  getPlatformDriverCashHandoffView(state, theOrder(state));
  assert.equal(
    JSON.stringify({
      zones: state.zones,
      tariffs: state.tariffs,
      settlements: state.settlements,
      earnings: state.driverEarningEntries,
      payouts: state.driverPayoutBatches,
      waves: state.driverDispatchWaves,
      cashEvents: state.platformDriverCashEvents,
    }),
    protectedBefore,
  );
});

// --- 15: чтение read-model/presentation не мутирует state -----------------------

test("15: no-op — getRestaurantWaitingView/Summary не мутируют state", () => {
  const state = cashWaitState({ arrived: true });
  const before = JSON.stringify(state);
  getRestaurantWaitingView(state, ORDER, T15);
  getRestaurantWaitingSummary(getRestaurantWaitingView(state, ORDER, T15));
  assert.equal(JSON.stringify(state), before);
});

// --- источник: CASH-блок переиспользует общий waiting presentation --------------

test("presentation: DriverCashHandoffBlock переиспользует RestaurantWaitingSummary", () => {
  const workspace = readFileSync(
    "src/components/driver/driver-workspace.tsx",
    "utf8",
  );
  // Единый presentation-компонент, а не второй расчёт ожидания в CASH-блоке.
  assert.equal(
    (workspace.match(/function RestaurantWaitingSummary/g) ?? []).length,
    1,
  );
  const cashFn = workspace.slice(
    workspace.indexOf("function DriverCashHandoffBlock"),
    workspace.indexOf("function StagePanel"),
  );
  assert.ok(cashFn.includes("getRestaurantWaitingSummary(waitingView)"));
  assert.ok(cashFn.includes("<RestaurantWaitingSummary"));
  // CASH-блок не считает ожидание/опоздание сам.
  assert.ok(!cashFn.includes("restaurantDelayMs"));
  assert.ok(!cashFn.includes("formatWaitingClock"));
});
