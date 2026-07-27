import type { Order, PrototypeState } from "./models";

export type RestaurantWaitingStatus =
  | "NOT_APPLICABLE"
  | "NOT_ARRIVED"
  | "WAITING"
  | "READY"
  | "REVIEW_REQUIRED";

export interface RestaurantWaitingView {
  status: RestaurantWaitingStatus;
  orderId: string;
  driverId: string | null;
  arrivedAt: string | null;
  readyAt: string | null;
  expectedReadyAt: string | null;
  waitingDurationMs: number | null;
  restaurantDelayMs: number | null;
  lostDriverTimeMs: number | null;
  readyAtArrival: boolean | null;
}

export interface RestaurantWaitingAnalyticsView {
  restaurantId: string;
  provenArrivalCount: number;
  readyAtArrivalCount: number;
  readinessAtArrivalBps: number | null;
  completedWaitingSampleCount: number;
  activeWaitingSampleCount: number;
  averageCompletedWaitingMs: number | null;
  restaurantDelayCaseCount: number;
  totalLostDriverTimeMs: number | null;
  averageRestaurantDelayMs: number | null;
  activeDelayCount: number;
  incompleteCoverageCount: number;
  reviewRequiredCount: number;
  reviewRequired: boolean;
}

export interface RestaurantDelayAlertView {
  orderId: string;
  publicNumber: string;
  restaurantName: string;
  driverId: string;
  driverName: string;
  expectedReadyAt: string;
  arrivedAt: string;
  waitingDurationMs: number;
  restaurantDelayMs: number;
  driverIncidentExists: boolean;
}

const READY_OR_LATER: ReadonlySet<Order["status"]> = new Set([
  "READY",
  "OUT_FOR_DELIVERY",
  "ARRIVING",
  "DELIVERED",
]);

function validTime(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function review(orderId: string, driverId: string | null): RestaurantWaitingView {
  return {
    status: "REVIEW_REQUIRED",
    orderId,
    driverId,
    arrivedAt: null,
    readyAt: null,
    expectedReadyAt: null,
    waitingDurationMs: null,
    restaurantDelayMs: null,
    lostDriverTimeMs: null,
    readyAtArrival: null,
  };
}

function safeDuration(endMs: number, startMs: number): number | null {
  const duration = Math.max(0, endMs - startMs);
  return Number.isSafeInteger(duration) ? duration : null;
}

/**
 * Pure, fail-closed view of a driver's restaurant wait. Arrival comes only from
 * DriverDeliveryEvent; readiness comes only from the structured PREPARING → READY
 * order-history transition. Human-readable history messages are never parsed.
 */
export function getRestaurantWaitingView(
  state: PrototypeState,
  orderId: string,
  nowIso: string,
): RestaurantWaitingView {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order || order.deliveryMode !== "PLATFORM_DRIVER") {
    return {
      ...review(orderId, order?.assignedDriverId ?? null),
      status: "NOT_APPLICABLE",
    };
  }

  const driverId = order.assignedDriverId;
  if (driverId === null || !state.drivers.some((driver) => driver.id === driverId)) {
    return review(order.id, driverId);
  }

  const nowMs = validTime(nowIso);
  const createdMs = validTime(order.createdAt);
  const kitchenStartedMs = validTime(order.kitchenStartedAt);
  const expectedReadyMs = validTime(order.expectedReadyAt);
  if (
    nowMs === null ||
    createdMs === null ||
    kitchenStartedMs === null ||
    expectedReadyMs === null ||
    kitchenStartedMs < createdMs ||
    expectedReadyMs < kitchenStartedMs
  ) {
    return review(order.id, driverId);
  }

  const arrivals = state.driverDeliveryEvents.filter(
    (event) => event.orderId === order.id && event.type === "ARRIVED_AT_RESTAURANT",
  );
  if (arrivals.some((event) => event.driverId !== driverId) || arrivals.length > 1) {
    return review(order.id, driverId);
  }

  const readyEvents = order.history.filter(
    (event) =>
      event.type === "STATUS" &&
      event.fromStatus === "PREPARING" &&
      event.toStatus === "READY",
  );
  if (readyEvents.length > 1) return review(order.id, driverId);

  const readyEvent = readyEvents[0] ?? null;
  const readyMs = readyEvent === null ? null : validTime(readyEvent.occurredAt);
  if (
    (readyEvent !== null && readyMs === null) ||
    (readyMs !== null && readyMs < kitchenStartedMs) ||
    (order.status === "PREPARING" && readyEvent !== null) ||
    (READY_OR_LATER.has(order.status) && readyEvent === null)
  ) {
    return review(order.id, driverId);
  }

  if (arrivals.length === 0) {
    return {
      status: "NOT_ARRIVED",
      orderId: order.id,
      driverId,
      arrivedAt: null,
      readyAt: readyEvent?.occurredAt ?? null,
      expectedReadyAt: order.expectedReadyAt,
      waitingDurationMs: null,
      restaurantDelayMs: null,
      lostDriverTimeMs: null,
      readyAtArrival: null,
    };
  }

  const arrival = arrivals[0];
  const arrivedMs = validTime(arrival.occurredAt);
  if (
    arrivedMs === null ||
    arrivedMs < createdMs ||
    arrival.orderStatusBefore !== arrival.orderStatusAfter ||
    (arrival.orderStatusBefore !== "PREPARING" && arrival.orderStatusBefore !== "READY")
  ) {
    return review(order.id, driverId);
  }

  if (readyMs === null) {
    if (order.status !== "PREPARING" || nowMs < arrivedMs) {
      return review(order.id, driverId);
    }
    const waitingDurationMs = safeDuration(nowMs, arrivedMs);
    const restaurantDelayMs = safeDuration(nowMs, expectedReadyMs);
    const lostDriverTimeMs = safeDuration(
      nowMs,
      Math.max(arrivedMs, expectedReadyMs),
    );
    if (
      waitingDurationMs === null ||
      restaurantDelayMs === null ||
      lostDriverTimeMs === null
    ) {
      return review(order.id, driverId);
    }
    return {
      status: "WAITING",
      orderId: order.id,
      driverId,
      arrivedAt: arrival.occurredAt,
      readyAt: null,
      expectedReadyAt: order.expectedReadyAt,
      waitingDurationMs,
      restaurantDelayMs,
      lostDriverTimeMs,
      readyAtArrival: false,
    };
  }

  const waitingDurationMs = safeDuration(readyMs, arrivedMs);
  const restaurantDelayMs = safeDuration(readyMs, expectedReadyMs);
  const lostDriverTimeMs = safeDuration(
    readyMs,
    Math.max(arrivedMs, expectedReadyMs),
  );
  if (
    waitingDurationMs === null ||
    restaurantDelayMs === null ||
    lostDriverTimeMs === null
  ) {
    return review(order.id, driverId);
  }
  return {
    status: "READY",
    orderId: order.id,
    driverId,
    arrivedAt: arrival.occurredAt,
    readyAt: readyEvent?.occurredAt ?? null,
    expectedReadyAt: order.expectedReadyAt,
    waitingDurationMs,
    restaurantDelayMs,
    lostDriverTimeMs,
    readyAtArrival: readyMs <= arrivedMs,
  };
}

function checkedAdd(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

/** Pure restaurant aggregate. Active waits are kept out of completed averages. */
export function getRestaurantWaitingAnalyticsView(
  state: PrototypeState,
  restaurantId: string,
  nowIso: string,
): RestaurantWaitingAnalyticsView {
  let provenArrivalCount = 0;
  let readyAtArrivalCount = 0;
  let completedWaitingSampleCount = 0;
  let activeWaitingSampleCount = 0;
  let completedWaitTotal: number | null = 0;
  let completedDelayTotal: number | null = 0;
  let restaurantDelayCaseCount = 0;
  let activeDelayCount = 0;
  let totalLostDriverTimeMs: number | null = 0;
  let incompleteCoverageCount = 0;
  let reviewRequiredCount = 0;

  const orders = state.orders.filter(
    (order) =>
      order.restaurant.id === restaurantId &&
      order.deliveryMode === "PLATFORM_DRIVER" &&
      (order.assignedDriverId !== null ||
        state.driverDeliveryEvents.some(
          (event) =>
            event.orderId === order.id &&
            event.type === "ARRIVED_AT_RESTAURANT",
        )),
  );
  for (const order of orders) {
    const view = getRestaurantWaitingView(state, order.id, nowIso);
    if (view.status === "REVIEW_REQUIRED") {
      reviewRequiredCount += 1;
      continue;
    }
    if (view.status === "NOT_ARRIVED") {
      incompleteCoverageCount += 1;
      continue;
    }
    if (view.status !== "WAITING" && view.status !== "READY") continue;
    provenArrivalCount += 1;
    if (view.lostDriverTimeMs === null || totalLostDriverTimeMs === null) {
      totalLostDriverTimeMs = null;
    } else {
      totalLostDriverTimeMs = checkedAdd(totalLostDriverTimeMs, view.lostDriverTimeMs);
    }
    if (view.status === "WAITING") {
      activeWaitingSampleCount += 1;
      if ((view.restaurantDelayMs ?? 0) > 0) activeDelayCount += 1;
      continue;
    }
    completedWaitingSampleCount += 1;
    completedWaitTotal =
      completedWaitTotal === null || view.waitingDurationMs === null
        ? null
        : checkedAdd(completedWaitTotal, view.waitingDurationMs);
    completedDelayTotal =
      completedDelayTotal === null || view.restaurantDelayMs === null
        ? null
        : checkedAdd(completedDelayTotal, view.restaurantDelayMs);
    if ((view.restaurantDelayMs ?? 0) > 0) restaurantDelayCaseCount += 1;
    if (view.readyAtArrival) readyAtArrivalCount += 1;
  }

  return {
    restaurantId,
    provenArrivalCount,
    readyAtArrivalCount,
    readinessAtArrivalBps:
      provenArrivalCount === 0
        ? null
        : Math.round((readyAtArrivalCount * 10_000) / provenArrivalCount),
    completedWaitingSampleCount,
    activeWaitingSampleCount,
    averageCompletedWaitingMs:
      completedWaitingSampleCount === 0 || completedWaitTotal === null
        ? null
        : Math.round(completedWaitTotal / completedWaitingSampleCount),
    restaurantDelayCaseCount,
    totalLostDriverTimeMs,
    averageRestaurantDelayMs:
      completedWaitingSampleCount === 0 || completedDelayTotal === null
        ? null
        : Math.round(completedDelayTotal / completedWaitingSampleCount),
    activeDelayCount,
    incompleteCoverageCount,
    reviewRequiredCount,
    reviewRequired:
      reviewRequiredCount > 0 ||
      totalLostDriverTimeMs === null ||
      completedWaitTotal === null ||
      completedDelayTotal === null,
  };
}

/** Derived operational alerts; creates no incident and mutates no state. */
export function getRestaurantDelayAlerts(
  state: PrototypeState,
  nowIso: string,
): RestaurantDelayAlertView[] {
  return state.orders.flatMap((order) => {
    const view = getRestaurantWaitingView(state, order.id, nowIso);
    if (
      view.status !== "WAITING" ||
      view.driverId === null ||
      view.arrivedAt === null ||
      view.expectedReadyAt === null ||
      view.waitingDurationMs === null ||
      view.restaurantDelayMs === null ||
      view.restaurantDelayMs <= 0
    ) {
      return [];
    }
    const driver = state.drivers.find((item) => item.id === view.driverId);
    if (!driver) return [];
    return [{
      orderId: order.id,
      publicNumber: order.publicNumber,
      restaurantName: order.restaurant.name,
      driverId: driver.id,
      driverName: driver.name,
      expectedReadyAt: view.expectedReadyAt,
      arrivedAt: view.arrivedAt,
      waitingDurationMs: view.waitingDurationMs,
      restaurantDelayMs: view.restaurantDelayMs,
      driverIncidentExists: state.driverOrderIncidents.some(
        (incident) => incident.orderId === order.id && incident.driverId === driver.id,
      ),
    }];
  });
}
