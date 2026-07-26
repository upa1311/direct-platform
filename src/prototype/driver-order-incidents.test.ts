import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptRestaurantOrder,
  addCartItem,
  adminCancelOrder,
  assignDriverToOrder,
  createOrderFromCart,
  goDriverOnline,
  markOrderReady,
  reassignDriverForOrder,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import {
  DRIVER_ORDER_INCIDENT_BLOCK_ERROR,
  driverOrderIncidentId,
  driverOrderIncidentResolutionId,
  getAdminDriverOrderIncidentViews,
  getDriverActiveOrderIncidentView,
  hasBlockingDriverOrderIncident,
  reportDriverOrderIncident,
  resolveDriverOrderIncident,
} from "./driver-order-incidents.ts";
import {
  markDriverArrivedAtRestaurant,
  markDriverArrivingToCustomer,
  markDriverDeliveredOrder,
  markDriverPickedUpOrder,
} from "./driver-delivery.ts";
import type {
  DriverOrderIncident,
  DriverOrderIncidentResolutionEvent,
  PrototypeState,
  ZoneId,
} from "./models.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import {
  PROTOTYPE_STORAGE_KEY,
  normalizePrototypeState,
  parseStoredState,
} from "./prototype-store.ts";

const DRIVER = "driver-1";
const OTHER_DRIVER = "driver-2";
const RESTAURANT_ZONE: ZoneId = "zone-2";
const T0 = "2026-07-25T10:00:00.000Z";
const T1 = "2026-07-25T10:01:00.000Z";
const T2 = "2026-07-25T10:02:00.000Z";

function assignedReadyState(): { state: PrototypeState; orderId: string } {
  let state = goDriverOnline(
    createDefaultState(),
    DRIVER,
    RESTAURANT_ZONE,
  ).state;
  state = goDriverOnline(state, OTHER_DRIVER, RESTAURANT_ZONE).state;
  state = updateCartAddress(state, {
    street: "Садовый переулок",
    house: "5",
  });
  state = addCartItem(
    state,
    "restaurant-2-item-1",
    "size-standard",
  ).state;
  const created = createOrderFromCart(state);
  assert.ok(created.result.orderId);
  const orderId = created.result.orderId;
  state = acceptRestaurantOrder(created.state, orderId, 20);
  state = simulateSuccessfulOnlinePayment(state, orderId);
  state = markOrderReady(state, orderId);
  state = assignDriverToOrder(state, orderId, DRIVER).state;
  return { state, orderId };
}

function withIncident(): {
  state: PrototypeState;
  orderId: string;
  incident: DriverOrderIncident;
} {
  const ready = assignedReadyState();
  const reported = reportDriverOrderIncident(ready.state, {
    driverId: DRIVER,
    orderId: ready.orderId,
    reason: "ORDER_DELAYED",
    details: "  ресторан задерживает выдачу  ",
  });
  assert.equal(reported.result.ok, true);
  const incident = reported.state.driverOrderIncidents[0];
  assert.ok(incident);
  return { state: reported.state, orderId: ready.orderId, incident };
}

function orderSnapshot(state: PrototypeState, orderId: string): string {
  return JSON.stringify(state.orders.find((order) => order.id === orderId));
}

test("report: assigned BUSY driver создаёт детерминированный incident", () => {
  const { state, orderId } = assignedReadyState();
  const nextRevision = state.revision + 1;
  const beforeOrder = orderSnapshot(state, orderId);
  const beforeDriver = JSON.stringify(
    state.drivers.find((driver) => driver.id === DRIVER),
  );
  const beforeMoney = JSON.stringify({
    settlements: state.settlements,
    accounting: state.restaurantAccountingEntries,
    earnings: state.driverEarningEntries,
    payouts: state.driverPayoutBatches,
  });
  const result = reportDriverOrderIncident(state, {
    driverId: DRIVER,
    orderId,
    reason: "ORDER_DELAYED",
    details: "  задержка  ",
  });

  assert.equal(result.result.ok, true);
  assert.equal(result.state.revision, nextRevision);
  assert.equal(result.state.driverOrderIncidents.length, 1);
  const incident = result.state.driverOrderIncidents[0];
  assert.equal(incident.id, driverOrderIncidentId(orderId, nextRevision));
  assert.equal(result.result.incidentId, incident.id);
  assert.equal(incident.reportedAt, result.state.updatedAt);
  assert.equal(incident.details, "задержка");
  assert.equal(orderSnapshot(result.state, orderId), beforeOrder);
  assert.equal(
    JSON.stringify(result.state.drivers.find((driver) => driver.id === DRIVER)),
    beforeDriver,
  );
  assert.equal(
    JSON.stringify({
      settlements: result.state.settlements,
      accounting: result.state.restaurantAccountingEntries,
      earnings: result.state.driverEarningEntries,
      payouts: result.state.driverPayoutBatches,
    }),
    beforeMoney,
  );
  assert.deepEqual(result.state.driverOperationalEvents, state.driverOperationalEvents);
});

test("report guards и no-op сохраняют исходный state", () => {
  const { state, orderId } = assignedReadyState();
  const pausedState = {
    ...state,
    drivers: state.drivers.map((driver) =>
      driver.id === DRIVER ? { ...driver, status: "PAUSED" as const } : driver,
    ),
  };
  const cases = [
    reportDriverOrderIncident(state, {
      driverId: OTHER_DRIVER,
      orderId,
      reason: "ORDER_DELAYED",
      details: "",
    }),
    reportDriverOrderIncident(
      pausedState,
      { driverId: DRIVER, orderId, reason: "ORDER_DELAYED", details: "" },
    ),
    reportDriverOrderIncident(state, {
      driverId: DRIVER,
      orderId,
      reason: "OTHER",
      details: "   ",
    }),
    reportDriverOrderIncident(state, {
      driverId: DRIVER,
      orderId,
      reason: "OTHER",
      details: "x".repeat(241),
    }),
    reportDriverOrderIncident(state, {
      driverId: DRIVER,
      orderId,
      reason: "CASH_PROBLEM",
      details: "",
    }),
    reportDriverOrderIncident(state, {
      driverId: DRIVER,
      orderId,
      reason: "NOT_A_REASON" as never,
      details: "",
    }),
  ];
  for (const [index, result] of cases.entries()) {
    assert.equal(result.result.ok, false);
    const expectedState = index === 1 ? pausedState : state;
    assert.equal(result.state, expectedState);
    assert.equal(result.state.revision, expectedState.revision);
  }
});

test("report guards: wrong mode, terminal и второй open incident", () => {
  const { state, orderId } = assignedReadyState();
  const wrongMode = {
    ...state,
    orders: state.orders.map((order) =>
      order.id === orderId ? { ...order, deliveryMode: "PICKUP" as const } : order,
    ),
  };
  assert.equal(
    reportDriverOrderIncident(wrongMode, {
      driverId: DRIVER,
      orderId,
      reason: "ORDER_DELAYED",
      details: "",
    }).result.ok,
    false,
  );
  const terminal = {
    ...state,
    orders: state.orders.map((order) =>
      order.id === orderId ? { ...order, status: "CANCELED" as const } : order,
    ),
  };
  assert.equal(
    reportDriverOrderIncident(terminal, {
      driverId: DRIVER,
      orderId,
      reason: "ORDER_DELAYED",
      details: "",
    }).result.error,
    "Заказ уже завершён или отменён.",
  );
  const first = withIncident();
  const second = reportDriverOrderIncident(first.state, {
    driverId: DRIVER,
    orderId: first.orderId,
    reason: "WRONG_ADDRESS",
    details: "",
  });
  assert.equal(second.state, first.state);
  assert.equal(second.result.error, "По этому заказу уже открыта проблема.");
});

test("resolution: CONTINUE append-only, canonical note и snapshots", () => {
  const { state, orderId, incident } = withIncident();
  const beforeOrder = orderSnapshot(state, orderId);
  const beforeDriver = JSON.stringify(state.drivers);
  const result = resolveDriverOrderIncident(state, {
    incidentId: incident.id,
    outcome: "CONTINUE_ORDER",
    note: "  можно продолжать  ",
  });
  assert.equal(result.result.ok, true);
  assert.equal(result.state.revision, state.revision + 1);
  assert.equal(result.state.driverOrderIncidents[0], incident);
  assert.equal(result.state.driverOrderIncidentResolutionEvents.length, 1);
  const event = result.state.driverOrderIncidentResolutionEvents[0];
  assert.equal(event.id, driverOrderIncidentResolutionId(incident.id));
  assert.equal(event.resolvedAt, result.state.updatedAt);
  assert.equal(event.note, "можно продолжать");
  assert.equal(event.orderStatusAtResolution, "READY");
  assert.equal(event.assignedDriverIdAtResolution, DRIVER);
  assert.equal(orderSnapshot(result.state, orderId), beforeOrder);
  assert.equal(JSON.stringify(result.state.drivers), beforeDriver);
});

test("resolution outcomes проверяют фактическое состояние заказа", () => {
  const base = withIncident();
  const canceledState = adminCancelOrder(
    base.state,
    base.orderId,
    "невозможно продолжить",
  ).state;
  const canceled = resolveDriverOrderIncident(canceledState, {
    incidentId: base.incident.id,
    outcome: "ORDER_CANCELED",
    note: "заказ отменён",
  });
  assert.equal(canceled.result.ok, true);

  const reassignmentBase = withIncident();
  const reassignedState = reassignDriverForOrder(
    reassignmentBase.state,
    reassignmentBase.orderId,
    OTHER_DRIVER,
    "замена водителя",
  ).state;
  const reassigned = resolveDriverOrderIncident(reassignedState, {
    incidentId: reassignmentBase.incident.id,
    outcome: "DRIVER_REASSIGNED",
    note: "водитель заменён",
  });
  assert.equal(reassigned.result.ok, true);
  assert.equal(
    reassigned.state.driverOrderIncidentResolutionEvents[0]
      .assignedDriverIdAtResolution,
    OTHER_DRIVER,
  );

  const completedBase = withIncident();
  const completedState = {
    ...completedBase.state,
    orders: completedBase.state.orders.map((order) =>
      order.id === completedBase.orderId
        ? { ...order, status: "DELIVERED" as const }
        : order,
    ),
  };
  assert.equal(
    resolveDriverOrderIncident(completedState, {
      incidentId: completedBase.incident.id,
      outcome: "ORDER_COMPLETED",
      note: "заказ завершён",
    }).result.ok,
    true,
  );
});

test("resolution guards: note, outcome и повторное закрытие", () => {
  const base = withIncident();
  for (const note of ["", "x", "x".repeat(301)]) {
    const result = resolveDriverOrderIncident(base.state, {
      incidentId: base.incident.id,
      outcome: "CONTINUE_ORDER",
      note,
    });
    assert.equal(result.result.ok, false);
    assert.equal(result.state, base.state);
  }
  const resolved = resolveDriverOrderIncident(base.state, {
    incidentId: base.incident.id,
    outcome: "CONTINUE_ORDER",
    note: "можно ехать",
  });
  const repeated = resolveDriverOrderIncident(resolved.state, {
    incidentId: base.incident.id,
    outcome: "CONTINUE_ORDER",
    note: "повторное решение",
  });
  assert.equal(repeated.state, resolved.state);
  assert.equal(repeated.result.error, "Проблема уже закрыта.");
});

test("read-model: OPEN/RESOLVED и canonical admin rows", () => {
  const open = withIncident();
  assert.equal(
    getDriverActiveOrderIncidentView(open.state, open.orderId, DRIVER).status,
    "OPEN",
  );
  assert.equal(
    getDriverActiveOrderIncidentView(open.state, open.orderId, OTHER_DRIVER).status,
    "NONE",
  );
  assert.equal(hasBlockingDriverOrderIncident(open.state, open.orderId, DRIVER), true);
  const rows = getAdminDriverOrderIncidentViews(open.state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "OPEN");
  assert.equal(rows[0].driver?.id, DRIVER);
  assert.equal(rows[0].restaurant?.id, "restaurant-2");

  const resolved = resolveDriverOrderIncident(open.state, {
    incidentId: open.incident.id,
    outcome: "CONTINUE_ORDER",
    note: "можно продолжать",
  }).state;
  assert.equal(
    getDriverActiveOrderIncidentView(resolved, open.orderId, DRIVER).status,
    "RESOLVED",
  );
  assert.equal(hasBlockingDriverOrderIncident(resolved, open.orderId, DRIVER), false);
});

test("integrity: дубли и несколько unresolved дают REVIEW_REQUIRED", () => {
  const base = withIncident();
  const duplicateReport: PrototypeState = {
    ...base.state,
    driverOrderIncidents: [base.incident, { ...base.incident }],
  };
  assert.equal(
    getDriverActiveOrderIncidentView(duplicateReport, base.orderId).status,
    "REVIEW_REQUIRED",
  );

  const second: DriverOrderIncident = {
    ...base.incident,
    revision: base.incident.revision + 1,
    id: driverOrderIncidentId(base.orderId, base.incident.revision + 1),
  };
  const multipleOpen = {
    ...base.state,
    driverOrderIncidents: [base.incident, second],
  };
  assert.equal(getAdminDriverOrderIncidentViews(multipleOpen)[0].status, "REVIEW_REQUIRED");
});

test("integrity: multiple resolutions и orphan не выбираются как первые", () => {
  const base = withIncident();
  const resolved = resolveDriverOrderIncident(base.state, {
    incidentId: base.incident.id,
    outcome: "CONTINUE_ORDER",
    note: "можно продолжать",
  }).state;
  const resolution = resolved.driverOrderIncidentResolutionEvents[0];
  const conflict = {
    ...resolved,
    driverOrderIncidentResolutionEvents: [resolution, { ...resolution }],
  };
  assert.equal(
    getDriverActiveOrderIncidentView(conflict, base.orderId).status,
    "REVIEW_REQUIRED",
  );
  const orphan: DriverOrderIncidentResolutionEvent = {
    ...resolution,
    incidentId: "missing",
    id: driverOrderIncidentResolutionId("missing"),
  };
  assert.equal(
    getAdminDriverOrderIncidentViews({
      ...base.state,
      driverOrderIncidents: [],
      driverOrderIncidentResolutionEvents: [orphan],
    })[0].status,
    "REVIEW_REQUIRED",
  );
});

test("migration schema 28 очищает incidents; schema 29 сохраняет валидные", () => {
  const base = withIncident();
  const legacy = parseStoredState(
    JSON.stringify({ ...base.state, schemaVersion: 28 }),
  );
  assert.ok(legacy);
  assert.deepEqual(legacy.driverOrderIncidents, []);
  assert.deepEqual(legacy.driverOrderIncidentResolutionEvents, []);

  const current = parseStoredState(JSON.stringify(base.state));
  assert.ok(current);
  assert.equal(current.driverOrderIncidents.length, 1);
  assert.equal(current.driverOrderIncidents[0].id, base.incident.id);
  assert.equal(current.schemaVersion, 30);
});

test("normalization отбрасывает invalid id/ISO/orphan и идемпотентна", () => {
  const base = withIncident();
  const resolved = resolveDriverOrderIncident(base.state, {
    incidentId: base.incident.id,
    outcome: "CONTINUE_ORDER",
    note: "можно продолжать",
  }).state;
  const badId = parseStoredState(
    JSON.stringify({
      ...base.state,
      driverOrderIncidents: [{ ...base.incident, id: "bad" }],
    }),
  );
  assert.ok(badId);
  assert.deepEqual(badId.driverOrderIncidents, []);

  const badIso = parseStoredState(
    JSON.stringify({
      ...base.state,
      driverOrderIncidents: [{ ...base.incident, reportedAt: "bad" }],
    }),
  );
  assert.ok(badIso);
  assert.deepEqual(badIso.driverOrderIncidents, []);

  const orphan = parseStoredState(
    JSON.stringify({
      ...resolved,
      driverOrderIncidents: [],
    }),
  );
  assert.ok(orphan);
  assert.deepEqual(orphan.driverOrderIncidentResolutionEvents, []);

  const once = normalizePrototypeState(resolved);
  const twice = normalizePrototypeState(once);
  assert.deepEqual(twice, once);
});

test("lifecycle: OPEN блокирует четыре driver actions, CONTINUE разблокирует", () => {
  const ready = assignedReadyState();
  const arrivedState = markDriverArrivedAtRestaurant(
    ready.state,
    DRIVER,
    ready.orderId,
    T0,
  ).state;
  const openReady = reportDriverOrderIncident(arrivedState, {
    driverId: DRIVER,
    orderId: ready.orderId,
    reason: "ORDER_DELAYED",
    details: "",
  }).state;
  const pickup = markDriverPickedUpOrder(openReady, DRIVER, ready.orderId, T1);
  assert.equal(pickup.result.error, DRIVER_ORDER_INCIDENT_BLOCK_ERROR);
  assert.equal(pickup.state, openReady);

  const continued = resolveDriverOrderIncident(openReady, {
    incidentId: openReady.driverOrderIncidents[0].id,
    outcome: "CONTINUE_ORDER",
    note: "можно продолжать",
  }).state;
  assert.equal(
    markDriverPickedUpOrder(continued, DRIVER, ready.orderId, T1).result.ok,
    true,
  );

  let arrivingBase = markDriverPickedUpOrder(
    arrivedState,
    DRIVER,
    ready.orderId,
    T1,
  ).state;
  arrivingBase = reportDriverOrderIncident(arrivingBase, {
    driverId: DRIVER,
    orderId: ready.orderId,
    reason: "WRONG_ADDRESS",
    details: "",
  }).state;
  assert.equal(
    markDriverArrivingToCustomer(arrivingBase, DRIVER, ready.orderId, T2).result
      .error,
    DRIVER_ORDER_INCIDENT_BLOCK_ERROR,
  );

  const readyAgain = assignedReadyState();
  const openForArrival = reportDriverOrderIncident(readyAgain.state, {
    driverId: DRIVER,
    orderId: readyAgain.orderId,
    reason: "ORDER_DELAYED",
    details: "",
  }).state;
  assert.equal(
    markDriverArrivedAtRestaurant(openForArrival, DRIVER, readyAgain.orderId, T0)
      .result.error,
    DRIVER_ORDER_INCIDENT_BLOCK_ERROR,
  );
});

test("lifecycle: OPEN блокирует delivered; admin cancel/reassign не блокируются", () => {
  const ready = assignedReadyState();
  let state = markDriverArrivedAtRestaurant(ready.state, DRIVER, ready.orderId, T0)
    .state;
  state = markDriverPickedUpOrder(state, DRIVER, ready.orderId, T1).state;
  state = markDriverArrivingToCustomer(state, DRIVER, ready.orderId, T2).state;
  state = reportDriverOrderIncident(state, {
    driverId: DRIVER,
    orderId: ready.orderId,
    reason: "CUSTOMER_UNREACHABLE",
    details: "",
  }).state;
  assert.equal(
    markDriverDeliveredOrder(state, DRIVER, ready.orderId, T2, {
      cashCollectionConfirmed: false,
    }).result.error,
    DRIVER_ORDER_INCIDENT_BLOCK_ERROR,
  );

  const cancelBase = withIncident();
  assert.equal(
    adminCancelOrder(cancelBase.state, cancelBase.orderId, "incident").result.ok,
    true,
  );
  const reassignBase = withIncident();
  assert.equal(
    reassignDriverForOrder(
      reassignBase.state,
      reassignBase.orderId,
      OTHER_DRIVER,
      "incident",
    ).result.ok,
    true,
  );
});

test("lifecycle: REVIEW_REQUIRED блокирует те же четыре driver actions", () => {
  const base = withIncident();
  const original = base.incident;
  const reviewState: PrototypeState = {
    ...base.state,
    driverOrderIncidents: [
      original,
      {
        ...original,
        id: driverOrderIncidentId(base.orderId, original.revision + 1),
        revision: original.revision + 1,
      },
    ],
  };
  assert.equal(
    getDriverActiveOrderIncidentView(reviewState, base.orderId, DRIVER).status,
    "REVIEW_REQUIRED",
  );
  for (const result of [
    markDriverArrivedAtRestaurant(reviewState, DRIVER, base.orderId, T2),
    markDriverPickedUpOrder(reviewState, DRIVER, base.orderId, T2),
    markDriverArrivingToCustomer(reviewState, DRIVER, base.orderId, T2),
    markDriverDeliveredOrder(reviewState, DRIVER, base.orderId, T2, {
      cashCollectionConfirmed: false,
    }),
  ]) {
    assert.equal(result.result.ok, false);
    assert.equal(result.result.error, DRIVER_ORDER_INCIDENT_BLOCK_ERROR);
    assert.equal(result.state, reviewState);
  }
});

test("schema/storage contract", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 30);
  assert.equal(PROTOTYPE_STORAGE_KEY, "direct-prototype-state-v7");
});
