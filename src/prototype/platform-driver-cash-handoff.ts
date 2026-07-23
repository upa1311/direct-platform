import type {
  Order,
  PlatformDriverCashEvent,
  PlatformDriverCashEventType,
  PrototypeState,
  RestaurantWorkspaceRole,
} from "./models";
import type { ActionResult } from "./actions";
import { finalizeMutation } from "./prototype-store";
import { getPlatformDriverCashSnapshot } from "./selectors";
import {
  canRestaurantWorkspacePerformAction,
  resolveRestaurantWorkspaceRole,
} from "./restaurant-workflow";

/**
 * Двусторонняя передача наличных водителя Direct ресторану (v21). Работает
 * только для PLATFORM_DRIVER + CASH и только поверх подтверждённого cash offer.
 *
 * Домен чистый: момент времени — аргумент; события append-only и
 * детерминированы; сумма берётся ТОЛЬКО из immutable cash snapshot заказа
 * (restaurantHandoffCents) и не пересчитывается. Финансы (financials, movement,
 * accounting, settlements, paymentStatus, paidAt) здесь не меняются — только
 * аудит физической передачи.
 */

export type PlatformDriverCashHandoffStatus =
  | "NOT_APPLICABLE"
  | "DRIVER_ACTION_REQUIRED"
  | "RESTAURANT_CONFIRMATION_REQUIRED"
  | "CONFIRMED"
  | "REVIEW_REQUIRED";

export interface PlatformDriverCashHandoffView {
  status: PlatformDriverCashHandoffStatus;
  amountCents: number | null;
  driverReportedAt: string | null;
  restaurantConfirmedAt: string | null;
}

export interface PlatformDriverCashHandoffActionResult {
  ok: boolean;
  error: string | null;
  orderId: string | null;
}

/** Детерминированные id событий передачи наличных (один на тип и заказ). */
export function driverCashHandoffReportEventId(orderId: string): string {
  return `platform-driver-cash-${orderId}-driver-handoff`;
}
export function restaurantCashReceiptEventId(orderId: string): string {
  return `platform-driver-cash-${orderId}-restaurant-confirmation`;
}

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Событие данного типа по заказу (тип уникален на заказ). */
function eventOfType(
  state: PrototypeState,
  orderId: string,
  type: PlatformDriverCashEventType,
): PlatformDriverCashEvent | null {
  return (
    state.platformDriverCashEvents.find(
      (event) => event.orderId === orderId && event.type === type,
    ) ?? null
  );
}

interface CashFoundation {
  driverId: string;
  restaurantId: string;
  amountCents: number;
}

/**
 * Валидное основание наличной передачи: PLATFORM_DRIVER + CASH, валидный
 * snapshot, назначенный водитель, его ACCEPTED cash offer с валидным
 * cashReserveConfirmedAt. Иначе null (fail-closed).
 */
function cashFoundation(state: PrototypeState, order: Order): CashFoundation | null {
  if (order.deliveryMode !== "PLATFORM_DRIVER") return null;
  if (order.paymentMethod !== "CASH") return null;
  const snapshot = getPlatformDriverCashSnapshot(order);
  if (snapshot === null) return null;
  const driverId = order.assignedDriverId;
  if (driverId === null) return null;
  const offer = state.driverOffers.find(
    (o) =>
      o.orderId === order.id &&
      o.driverId === driverId &&
      o.status === "ACCEPTED",
  );
  if (!offer || !isValidIso(offer.cashReserveConfirmedAt)) return null;
  return {
    driverId,
    restaurantId: order.restaurant.id,
    amountCents: snapshot.restaurantHandoffCents,
  };
}

/**
 * Состояние передачи наличных для UI и guard'ов. Чистый селектор: state не
 * мутирует, событий не создаёт, order.history источником истины не считает.
 */
export function getPlatformDriverCashHandoffView(
  state: PrototypeState,
  order: Order,
): PlatformDriverCashHandoffView {
  if (order.deliveryMode !== "PLATFORM_DRIVER" || order.paymentMethod !== "CASH") {
    return {
      status: "NOT_APPLICABLE",
      amountCents: null,
      driverReportedAt: null,
      restaurantConfirmedAt: null,
    };
  }

  const foundation = cashFoundation(state, order);
  const report = eventOfType(
    state,
    order.id,
    "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF",
  );
  const confirm = eventOfType(
    state,
    order.id,
    "RESTAURANT_CONFIRMED_CASH_RECEIPT",
  );

  const review: PlatformDriverCashHandoffView = {
    status: "REVIEW_REQUIRED",
    amountCents: foundation?.amountCents ?? null,
    driverReportedAt: report?.occurredAt ?? null,
    restaurantConfirmedAt: confirm?.occurredAt ?? null,
  };

  if (foundation === null) return review;
  const amountCents = foundation.amountCents;

  // Противоречия: confirmation без report, неверный порядок, несовпадение сумм
  // или водителя — данные не «чинятся».
  if (confirm !== null && report === null) return review;
  if (report !== null && report.amountCents !== amountCents) return review;
  if (report !== null && report.driverId !== foundation.driverId) return review;
  if (confirm !== null) {
    if (confirm.amountCents !== amountCents) return review;
    if (report !== null && Date.parse(confirm.occurredAt) < Date.parse(report.occurredAt)) {
      return review;
    }
  }

  if (report === null) {
    return {
      status: "DRIVER_ACTION_REQUIRED",
      amountCents,
      driverReportedAt: null,
      restaurantConfirmedAt: null,
    };
  }
  if (confirm === null) {
    return {
      status: "RESTAURANT_CONFIRMATION_REQUIRED",
      amountCents,
      driverReportedAt: report.occurredAt,
      restaurantConfirmedAt: null,
    };
  }
  return {
    status: "CONFIRMED",
    amountCents,
    driverReportedAt: report.occurredAt,
    restaurantConfirmedAt: confirm.occurredAt,
  };
}

/** Подтвердил ли ресторан получение наличных (разблокирует получение заказа). */
export function hasRestaurantConfirmedDriverCashHandoff(
  state: PrototypeState,
  order: Order,
): boolean {
  return getPlatformDriverCashHandoffView(state, order).status === "CONFIRMED";
}

function fail(
  state: PrototypeState,
  error: string,
): ActionResult<PlatformDriverCashHandoffActionResult> {
  return { state, result: { ok: false, error, orderId: null } };
}

/** Прибыл ли водитель в ресторан (существующий driver delivery event). */
function driverArrivedAtRestaurant(
  state: PrototypeState,
  orderId: string,
  driverId: string,
): boolean {
  return state.driverDeliveryEvents.some(
    (e) =>
      e.orderId === orderId &&
      e.driverId === driverId &&
      e.type === "ARRIVED_AT_RESTAURANT",
  );
}

function driverPickedUp(
  state: PrototypeState,
  orderId: string,
  driverId: string,
): boolean {
  return state.driverDeliveryEvents.some(
    (e) =>
      e.orderId === orderId &&
      e.driverId === driverId &&
      e.type === "ORDER_PICKED_UP",
  );
}

/**
 * Водитель сообщает, что передал ресторану точную сумму (одно append-only
 * событие). Сумма берётся из snapshot, не из UI/аргумента. Статус заказа,
 * paymentStatus, paidAt, financials и статус водителя не меняются. Повтор —
 * ошибка без изменения state и revision.
 */
export function reportDriverCashHandoffToRestaurant(
  state: PrototypeState,
  driverId: string,
  orderId: string,
  nowIso: string,
): ActionResult<PlatformDriverCashHandoffActionResult> {
  if (!isValidIso(nowIso)) return fail(state, "Некорректное время.");
  const driver = state.drivers.find((d) => d.id === driverId);
  if (!driver) return fail(state, "У вас нет этого активного заказа.");
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return fail(state, "У вас нет этого активного заказа.");
  if (order.assignedDriverId !== driverId) {
    return fail(state, "Этот заказ назначен другому водителю.");
  }

  const foundation = cashFoundation(state, order);
  if (foundation === null) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (driver.status !== "BUSY_DIRECT") {
    return fail(state, "У вас нет этого активного заказа.");
  }
  if (order.status !== "PREPARING" && order.status !== "READY") {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (driverPickedUp(state, orderId, driverId)) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (!driverArrivedAtRestaurant(state, orderId, driverId)) {
    return fail(state, "Сначала подтвердите прибытие в ресторан.");
  }
  if (eventOfType(state, orderId, "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF")) {
    return fail(state, "Вы уже сообщили о передаче наличных.");
  }
  if (eventOfType(state, orderId, "RESTAURANT_CONFIRMED_CASH_RECEIPT")) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }

  const event: PlatformDriverCashEvent = {
    id: driverCashHandoffReportEventId(orderId),
    orderId,
    driverId,
    restaurantId: foundation.restaurantId,
    type: "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF",
    amountCents: foundation.amountCents,
    occurredAt: nowIso,
    actor: "DRIVER",
    restaurantWorkspaceRole: null,
  };
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      platformDriverCashEvents: [...state.platformDriverCashEvents, event],
    },
    nowIso,
  );
  return { state: nextState, result: { ok: true, error: null, orderId } };
}

/**
 * Ресторан подтверждает фактическое получение наличных от водителя (одно
 * append-only событие). Требует существующего driver report, права
 * COMBINED/OPERATOR (KITCHEN запрещён) и совпадения суммы со snapshot. Финансы,
 * статусы и расчёты не меняются. Повтор — fail-closed без второго события.
 */
export function confirmRestaurantDriverCashReceipt(
  state: PrototypeState,
  restaurantId: string,
  orderId: string,
  workspaceRole: RestaurantWorkspaceRole | null | undefined,
  nowIso: string,
): ActionResult<PlatformDriverCashHandoffActionResult> {
  if (!isValidIso(nowIso)) return fail(state, "Некорректное время.");
  const restaurant = state.restaurants.find((r) => r.id === restaurantId);
  if (!restaurant) return fail(state, "Ресторан не найден.");
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return fail(state, "Заказ не найден.");
  if (order.restaurant.id !== restaurantId) {
    return fail(state, "Заказ относится к другому ресторану.");
  }

  const foundation = cashFoundation(state, order);
  if (foundation === null) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (order.status !== "PREPARING" && order.status !== "READY") {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (driverPickedUp(state, orderId, foundation.driverId)) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }

  const report = eventOfType(
    state,
    orderId,
    "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF",
  );
  if (report === null) {
    return fail(state, "Водитель ещё не сообщил о передаче наличных.");
  }
  if (report.amountCents !== foundation.amountCents) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (eventOfType(state, orderId, "RESTAURANT_CONFIRMED_CASH_RECEIPT")) {
    return fail(state, "Получение наличных уже подтверждено.");
  }

  // Право подтверждения — доменная проверка (UI не доверяем). KITCHEN запрещён.
  const workflowMode = restaurant.orderWorkflowMode;
  if (
    !canRestaurantWorkspacePerformAction({
      workflowMode,
      workspaceRole,
      action: "CONFIRM_DRIVER_CASH_RECEIPT",
    })
  ) {
    return fail(
      state,
      "Недостаточно прав для подтверждения получения наличных.",
    );
  }
  const role = resolveRestaurantWorkspaceRole(workflowMode, workspaceRole);

  const event: PlatformDriverCashEvent = {
    id: restaurantCashReceiptEventId(orderId),
    orderId,
    driverId: report.driverId,
    restaurantId,
    type: "RESTAURANT_CONFIRMED_CASH_RECEIPT",
    amountCents: foundation.amountCents,
    occurredAt: nowIso,
    actor: "RESTAURANT",
    restaurantWorkspaceRole: role,
  };
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      platformDriverCashEvents: [...state.platformDriverCashEvents, event],
    },
    nowIso,
  );
  return { state: nextState, result: { ok: true, error: null, orderId } };
}
