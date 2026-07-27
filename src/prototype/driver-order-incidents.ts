import type { ActionResult } from "./actions";
import type {
  DriverOrderIncident,
  DriverOrderIncidentReason,
  DriverOrderIncidentResolutionEvent,
  DriverOrderIncidentResolutionOutcome,
  DriverProfile,
  Order,
  PrototypeState,
  Restaurant,
} from "./models";
import { finalizeMutation } from "./prototype-store";
import { getRestaurantWaitingView } from "./restaurant-waiting-analytics";

export const DRIVER_ORDER_INCIDENT_REASONS = [
  "RESTAURANT_CLOSED",
  "RESTAURANT_ORDER_MISSING",
  "ORDER_DELAYED",
  "CUSTOMER_UNREACHABLE",
  "WRONG_ADDRESS",
  "CUSTOMER_REFUSED",
  "CASH_PROBLEM",
  "VEHICLE_PROBLEM",
  "OTHER",
] as const satisfies readonly DriverOrderIncidentReason[];

export const DRIVER_ORDER_INCIDENT_OUTCOMES = [
  "CONTINUE_ORDER",
  "ORDER_CANCELED",
  "DRIVER_REASSIGNED",
  "ORDER_COMPLETED",
] as const satisfies readonly DriverOrderIncidentResolutionOutcome[];

export const DRIVER_ORDER_INCIDENT_REASON_LABELS: Readonly<
  Record<DriverOrderIncidentReason, string>
> = {
  RESTAURANT_CLOSED: "Ресторан закрыт",
  RESTAURANT_ORDER_MISSING: "Ресторан не видит заказ",
  ORDER_DELAYED: "Заказ долго не готов",
  CUSTOMER_UNREACHABLE: "Не могу связаться с клиентом",
  WRONG_ADDRESS: "Неверный адрес",
  CUSTOMER_REFUSED: "Клиент отказался принимать заказ",
  CASH_PROBLEM: "Проблема с наличными",
  VEHICLE_PROBLEM: "Поломка машины / не могу продолжить",
  OTHER: "Другое",
};

export const DRIVER_ORDER_INCIDENT_RESOLUTION_LABELS: Readonly<
  Record<DriverOrderIncidentResolutionOutcome, string>
> = {
  CONTINUE_ORDER: "Разрешено продолжить заказ",
  ORDER_CANCELED: "Заказ отменён",
  DRIVER_REASSIGNED: "Водитель переназначен",
  ORDER_COMPLETED: "Заказ завершён",
};

const REPORTABLE_ORDER_STATUSES: ReadonlySet<Order["status"]> = new Set([
  "READY",
  "OUT_FOR_DELIVERY",
  "ARRIVING",
]);

const TERMINAL_ORDER_STATUSES: ReadonlySet<Order["status"]> = new Set([
  "DELIVERED",
  "CANCELED",
]);

export const DRIVER_ORDER_INCIDENT_BLOCK_ERROR =
  "Direct разбирается с проблемой заказа. Дождитесь решения.";

export type DriverOrderIncidentDerivedStatus =
  | "OPEN"
  | "RESOLVED"
  | "REVIEW_REQUIRED";

export interface DriverOrderIncidentActionResult {
  ok: boolean;
  error: string | null;
  incidentId: string | null;
}

export interface DriverActiveOrderIncidentView {
  status: DriverOrderIncidentDerivedStatus | "NONE";
  incident: DriverOrderIncident | null;
  resolution: DriverOrderIncidentResolutionEvent | null;
  reviewRequired: boolean;
}

export interface AdminDriverOrderIncidentView {
  key: string;
  orderId: string;
  incident: DriverOrderIncident | null;
  status: DriverOrderIncidentDerivedStatus;
  resolution: DriverOrderIncidentResolutionEvent | null;
  order: Order | null;
  driver: DriverProfile | null;
  currentAssignedDriver: DriverProfile | null;
  restaurant: Restaurant | null;
  reviewRequired: boolean;
}

export function driverOrderIncidentId(
  orderId: string,
  revision: number,
): string {
  return `driver-order-incident:${orderId}:revision:${revision}`;
}

export function driverOrderIncidentResolutionId(incidentId: string): string {
  return `driver-order-incident-resolution:${incidentId}`;
}

export function isDriverOrderIncidentReason(
  value: unknown,
): value is DriverOrderIncidentReason {
  return (
    typeof value === "string" &&
    (DRIVER_ORDER_INCIDENT_REASONS as readonly string[]).includes(value)
  );
}

export function isDriverOrderIncidentResolutionOutcome(
  value: unknown,
): value is DriverOrderIncidentResolutionOutcome {
  return (
    typeof value === "string" &&
    (DRIVER_ORDER_INCIDENT_OUTCOMES as readonly string[]).includes(value)
  );
}

function duplicateValues(values: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([value]) => value),
  );
}

/**
 * Возвращает orderId, чьи incident-данные конфликтуют. Ни одна «первая» запись
 * не выбирается: все затронутые заказы становятся REVIEW_REQUIRED.
 */
function integrityReviewOrderIds(state: PrototypeState): ReadonlySet<string> {
  const review = new Set<string>();
  const reports = state.driverOrderIncidents;
  const resolutions = state.driverOrderIncidentResolutionEvents;
  const duplicateReportIds = duplicateValues(reports.map((item) => item.id));
  const duplicateResolutionIds = duplicateValues(
    resolutions.map((item) => item.id),
  );

  for (const report of reports) {
    if (
      duplicateReportIds.has(report.id) ||
      report.id !== driverOrderIncidentId(report.orderId, report.revision)
    ) {
      review.add(report.orderId);
    }
  }

  for (const resolution of resolutions) {
    const matchingReports = reports.filter(
      (report) => report.id === resolution.incidentId,
    );
    if (
      duplicateResolutionIds.has(resolution.id) ||
      resolution.id !== driverOrderIncidentResolutionId(resolution.incidentId)
    ) {
      review.add(resolution.orderId);
      for (const report of matchingReports) review.add(report.orderId);
    }
    if (matchingReports.length === 0) {
      review.add(resolution.orderId);
      continue;
    }
    if (
      matchingReports.some(
        (report) =>
          report.orderId !== resolution.orderId ||
          report.driverId !== resolution.driverId,
      )
    ) {
      review.add(resolution.orderId);
      for (const report of matchingReports) review.add(report.orderId);
    }
  }

  for (const report of reports) {
    const linked = resolutions.filter(
      (resolution) => resolution.incidentId === report.id,
    );
    if (linked.length > 1) review.add(report.orderId);
  }

  const unresolvedByOrder = new Map<string, number>();
  for (const report of reports) {
    if (
      resolutions.filter((resolution) => resolution.incidentId === report.id)
        .length === 0
    ) {
      unresolvedByOrder.set(
        report.orderId,
        (unresolvedByOrder.get(report.orderId) ?? 0) + 1,
      );
    }
  }
  for (const [orderId, count] of unresolvedByOrder) {
    if (count > 1) review.add(orderId);
  }
  return review;
}

function fail(
  state: PrototypeState,
  error: string,
): ActionResult<DriverOrderIncidentActionResult> {
  return {
    state,
    result: { ok: false, error, incidentId: null },
  };
}

export function reportDriverOrderIncident(
  state: PrototypeState,
  input: {
    driverId: string;
    orderId: string;
    reason: DriverOrderIncidentReason;
    details: string;
  },
): ActionResult<DriverOrderIncidentActionResult> {
  const driver = state.drivers.find((item) => item.id === input.driverId);
  const order = state.orders.find((item) => item.id === input.orderId);
  if (!driver || !order) {
    return fail(
      state,
      "Сообщить о проблеме может только назначенный водитель.",
    );
  }
  if (order.deliveryMode !== "PLATFORM_DRIVER") {
    return fail(state, "Действие недоступно для этого заказа.");
  }
  if (order.assignedDriverId !== input.driverId) {
    return fail(
      state,
      "Сообщить о проблеме может только назначенный водитель.",
    );
  }
  if (driver.status !== "BUSY_DIRECT") {
    return fail(state, "У вас нет этого активного заказа.");
  }
  if (TERMINAL_ORDER_STATUSES.has(order.status)) {
    return fail(state, "Заказ уже завершён или отменён.");
  }
  if (!isDriverOrderIncidentReason(input.reason)) {
    return fail(state, "Выберите причину проблемы.");
  }
  const reportedAt = new Date().toISOString();
  let provenPreparingDelay = false;
  if (order.status === "PREPARING" && input.reason === "ORDER_DELAYED") {
    const waitingView = getRestaurantWaitingView(state, order.id, reportedAt);
    provenPreparingDelay =
      waitingView.status === "WAITING" &&
      waitingView.driverId === input.driverId &&
      waitingView.restaurantDelayMs !== null &&
      waitingView.restaurantDelayMs > 0;
  }
  if (!REPORTABLE_ORDER_STATUSES.has(order.status) && !provenPreparingDelay) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }

  const reviewOrderIds = integrityReviewOrderIds(state);
  if (reviewOrderIds.has(order.id)) {
    return fail(
      state,
      "Данные проблем заказа требуют проверки Direct.",
    );
  }
  const view = getDriverActiveOrderIncidentView(state, order.id, input.driverId);
  if (view.status === "OPEN") {
    return fail(state, "По этому заказу уже открыта проблема.");
  }

  const details = input.details.trim();
  if (details.length > 240) {
    return fail(state, "Описание проблемы слишком длинное.");
  }
  if (input.reason === "OTHER" && details === "") {
    return fail(state, "Опишите проблему.");
  }
  if (input.reason === "CASH_PROBLEM" && order.paymentMethod !== "CASH") {
    return fail(
      state,
      "Этот заказ не предусматривает наличную оплату.",
    );
  }

  const revision = state.revision + 1;
  const incident: DriverOrderIncident = {
    id: driverOrderIncidentId(order.id, revision),
    revision,
    orderId: order.id,
    driverId: driver.id,
    restaurantId: order.restaurant.id,
    reason: input.reason,
    details: details === "" ? null : details,
    reportedAt,
    orderStatusAtReport: order.status,
    paymentMethodAtReport: order.paymentMethod,
  };
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      driverOrderIncidents: [...state.driverOrderIncidents, incident],
    },
    reportedAt,
  );
  return {
    state: nextState,
    result: { ok: true, error: null, incidentId: incident.id },
  };
}

export function resolveDriverOrderIncident(
  state: PrototypeState,
  input: {
    incidentId: string;
    outcome: DriverOrderIncidentResolutionOutcome;
    note: string;
  },
): ActionResult<DriverOrderIncidentActionResult> {
  const reports = state.driverOrderIncidents.filter(
    (item) => item.id === input.incidentId,
  );
  if (reports.length !== 1) {
    return fail(state, "Данные проблемы требуют проверки Direct.");
  }
  const incident = reports[0];
  if (integrityReviewOrderIds(state).has(incident.orderId)) {
    return fail(state, "Данные проблемы требуют проверки Direct.");
  }
  const existingResolutions = state.driverOrderIncidentResolutionEvents.filter(
    (item) => item.incidentId === incident.id,
  );
  if (existingResolutions.length > 0) {
    return fail(state, "Проблема уже закрыта.");
  }
  if (!isDriverOrderIncidentResolutionOutcome(input.outcome)) {
    return fail(state, "Выберите результат решения.");
  }
  const note = input.note.trim();
  if (note.length < 3) {
    return fail(state, "Укажите решение администратора.");
  }
  if (note.length > 300) {
    return fail(state, "Комментарий решения слишком длинный.");
  }
  const order = state.orders.find((item) => item.id === incident.orderId);
  if (!order) return fail(state, "Заказ не найден.");

  if (
    input.outcome === "CONTINUE_ORDER" &&
    (TERMINAL_ORDER_STATUSES.has(order.status) ||
      order.assignedDriverId !== incident.driverId ||
      !REPORTABLE_ORDER_STATUSES.has(order.status))
  ) {
    return fail(state, "Заказ нельзя продолжить в текущем состоянии.");
  }
  if (input.outcome === "ORDER_CANCELED" && order.status !== "CANCELED") {
    return fail(state, "Сначала отмените заказ.");
  }
  if (
    input.outcome === "DRIVER_REASSIGNED" &&
    (TERMINAL_ORDER_STATUSES.has(order.status) ||
      order.assignedDriverId === null ||
      order.assignedDriverId === incident.driverId)
  ) {
    return fail(state, "Сначала переназначьте водителя.");
  }
  if (input.outcome === "ORDER_COMPLETED" && order.status !== "DELIVERED") {
    return fail(state, "Заказ ещё не завершён.");
  }

  const resolvedAt = new Date().toISOString();
  const resolution: DriverOrderIncidentResolutionEvent = {
    id: driverOrderIncidentResolutionId(incident.id),
    incidentId: incident.id,
    orderId: incident.orderId,
    driverId: incident.driverId,
    resolvedAt,
    actor: "ADMIN",
    outcome: input.outcome,
    note,
    orderStatusAtResolution: order.status,
    assignedDriverIdAtResolution: order.assignedDriverId,
  };
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      driverOrderIncidentResolutionEvents: [
        ...state.driverOrderIncidentResolutionEvents,
        resolution,
      ],
    },
    resolvedAt,
  );
  return {
    state: nextState,
    result: { ok: true, error: null, incidentId: incident.id },
  };
}

export function getDriverActiveOrderIncidentView(
  state: PrototypeState,
  orderId: string,
  driverId?: string,
): DriverActiveOrderIncidentView {
  const order = state.orders.find((item) => item.id === orderId);
  if (driverId !== undefined && order?.assignedDriverId !== driverId) {
    return {
      status: "NONE",
      incident: null,
      resolution: null,
      reviewRequired: false,
    };
  }
  if (integrityReviewOrderIds(state).has(orderId)) {
    return {
      status: "REVIEW_REQUIRED",
      incident: null,
      resolution: null,
      reviewRequired: true,
    };
  }
  const reports = state.driverOrderIncidents.filter(
    (item) => item.orderId === orderId,
  );
  const open = reports.filter(
    (report) =>
      !state.driverOrderIncidentResolutionEvents.some(
        (resolution) => resolution.incidentId === report.id,
      ),
  );
  if (open.length === 1) {
    return {
      status: "OPEN",
      incident: open[0],
      resolution: null,
      reviewRequired: false,
    };
  }
  const resolved = reports
    .map((incident) => ({
      incident,
      resolution:
        state.driverOrderIncidentResolutionEvents.find(
          (item) => item.incidentId === incident.id,
        ) ?? null,
    }))
    .filter(
      (item): item is {
        incident: DriverOrderIncident;
        resolution: DriverOrderIncidentResolutionEvent;
      } => item.resolution !== null,
    )
    .sort(
      (a, b) =>
        Date.parse(b.resolution.resolvedAt) -
          Date.parse(a.resolution.resolvedAt) ||
        a.incident.id.localeCompare(b.incident.id),
    );
  if (resolved.length > 0) {
    return {
      status: "RESOLVED",
      incident: resolved[0].incident,
      resolution: resolved[0].resolution,
      reviewRequired: false,
    };
  }
  return {
    status: "NONE",
    incident: null,
    resolution: null,
    reviewRequired: false,
  };
}

export function hasBlockingDriverOrderIncident(
  state: PrototypeState,
  orderId: string,
  driverId: string,
): boolean {
  const order = state.orders.find((item) => item.id === orderId);
  if (!order || order.assignedDriverId !== driverId) return false;
  const view = getDriverActiveOrderIncidentView(state, orderId, driverId);
  return view.status === "OPEN" || view.status === "REVIEW_REQUIRED";
}

export function getAdminDriverOrderIncidentViews(
  state: PrototypeState,
): AdminDriverOrderIncidentView[] {
  const reviewOrderIds = integrityReviewOrderIds(state);
  const rows: AdminDriverOrderIncidentView[] = [];

  for (const orderId of [...reviewOrderIds].sort()) {
    const order = state.orders.find((item) => item.id === orderId) ?? null;
    rows.push({
      key: `review:${orderId}`,
      orderId,
      incident: null,
      status: "REVIEW_REQUIRED",
      resolution: null,
      order,
      driver: null,
      currentAssignedDriver:
        state.drivers.find((item) => item.id === order?.assignedDriverId) ?? null,
      restaurant:
        state.restaurants.find((item) => item.id === order?.restaurant.id) ?? null,
      reviewRequired: true,
    });
  }

  for (const incident of state.driverOrderIncidents) {
    if (reviewOrderIds.has(incident.orderId)) continue;
    const resolution =
      state.driverOrderIncidentResolutionEvents.find(
        (item) => item.incidentId === incident.id,
      ) ?? null;
    const order =
      state.orders.find((item) => item.id === incident.orderId) ?? null;
    rows.push({
      key: incident.id,
      orderId: incident.orderId,
      incident,
      status: resolution ? "RESOLVED" : "OPEN",
      resolution,
      order,
      driver:
        state.drivers.find((item) => item.id === incident.driverId) ?? null,
      currentAssignedDriver:
        state.drivers.find((item) => item.id === order?.assignedDriverId) ?? null,
      restaurant:
        state.restaurants.find((item) => item.id === incident.restaurantId) ??
        null,
      reviewRequired: false,
    });
  }

  const rank: Record<DriverOrderIncidentDerivedStatus, number> = {
    REVIEW_REQUIRED: 0,
    OPEN: 1,
    RESOLVED: 2,
  };
  return rows.sort((a, b) => {
    const status = rank[a.status] - rank[b.status];
    if (status !== 0) return status;
    if (a.status === "OPEN" && b.status === "OPEN") {
      const time =
        Date.parse(a.incident?.reportedAt ?? "") -
        Date.parse(b.incident?.reportedAt ?? "");
      if (time !== 0) return time;
    }
    if (a.status === "RESOLVED" && b.status === "RESOLVED") {
      const time =
        Date.parse(b.resolution?.resolvedAt ?? "") -
        Date.parse(a.resolution?.resolvedAt ?? "");
      if (time !== 0) return time;
    }
    return a.key.localeCompare(b.key);
  });
}
