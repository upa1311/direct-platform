import type {
  Order,
  PlatformDriverCashEvent,
  PrototypeState,
} from "./models";
import { getPlatformDriverCashSnapshot } from "./selectors";
import { getPlatformDriverCashHandoffView } from "./platform-driver-cash-handoff";

/**
 * Получение полной суммы наличными от клиента водителем Direct (v22).
 *
 * Чистый модуль: без React, provider, localStorage, actions и finalizeMutation.
 * Только читает состояние и объясняет его. Сумма к получению берётся ТОЛЬКО из
 * неизменяемого cash snapshot (customerCollectionCents) и не пересчитывается.
 *
 * COLLECTED признаётся лишь для ПОЛНОСТЬЮ согласованного завершённого заказа:
 * событие получения денег, DELIVERED, PAID, paidAt и ORDER_DELIVERED должны
 * совпадать по времени и сумме. Любое противоречие — REVIEW_REQUIRED, ничего
 * не «чинится» и не достраивается.
 */

export type PlatformDriverCustomerCashCollectionStatus =
  | "NOT_APPLICABLE"
  | "ACTION_REQUIRED"
  | "COLLECTED"
  | "REVIEW_REQUIRED";

export interface PlatformDriverCustomerCashCollectionView {
  status: PlatformDriverCustomerCashCollectionStatus;
  amountCents: number | null;
  collectedAt: string | null;
}

/** Детерминированный id события получения денег от клиента (одно на заказ). */
export function customerCashCollectionEventId(orderId: string): string {
  return `platform-driver-cash-${orderId}-customer-collection`;
}

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Все события получения денег от клиента по заказу (для контроля дублей). */
function collectionEvents(
  state: PrototypeState,
  orderId: string,
): PlatformDriverCashEvent[] {
  return state.platformDriverCashEvents.filter(
    (e) =>
      e.orderId === orderId &&
      e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
  );
}

/** Driver delivery события данного типа этого водителя по заказу. */
function deliveryEvents(
  state: PrototypeState,
  orderId: string,
  driverId: string,
  type: "ORDER_PICKED_UP" | "ARRIVING_TO_CUSTOMER" | "ORDER_DELIVERED",
) {
  return state.driverDeliveryEvents.filter(
    (e) => e.orderId === orderId && e.driverId === driverId && e.type === type,
  );
}

/** Ошибки проверки подготовленного наличного завершения. */
const CASH_REVIEW_ERROR = "Данные наличной доставки требуют проверки Direct.";
const CASH_CHRONOLOGY_ERROR =
  "Некорректное время подтверждения получения наличных.";

export type PreparedCashCompletionValidation =
  | { ok: true; collectionEvent: PlatformDriverCashEvent }
  | { ok: false; error: string };

/**
 * Проверка ПОДГОТОВЛЕННОГО (ещё не финализированного) наличного завершения.
 *
 * Отличается от COLLECTED-селектора: на этом этапе заказ ещё ARRIVING и события
 * ORDER_DELIVERED ещё нет — их добавят канонический завершитель и driver action.
 * Зато уже обязаны существовать все доказательства: валидный snapshot,
 * подтверждённый cash offer, подтверждённая рестораном передача, полный рабочий
 * путь водителя (получение заказа и подъезд), ровно одно событие получения денег
 * с точной суммой и согласованным временем.
 *
 * Ничего не чинит и не реконструирует; исключений не бросает.
 */
export function validatePreparedPlatformDriverCashCompletion(
  state: PrototypeState,
  order: Order,
  nowIso: string,
): PreparedCashCompletionValidation {
  const invalid = { ok: false as const, error: CASH_REVIEW_ERROR };

  if (order.deliveryMode !== "PLATFORM_DRIVER") return invalid;
  if (order.paymentMethod !== "CASH") return invalid;
  if (order.status !== "ARRIVING") return invalid;
  const driverId = order.assignedDriverId;
  if (driverId === null) return invalid;
  if (order.paymentStatus !== "PAID") return invalid;
  if (!isValidIso(order.paidAt)) return invalid;
  if (!isValidIso(nowIso)) return invalid;
  if (order.paidAt !== nowIso) return invalid;

  const snapshot = getPlatformDriverCashSnapshot(order);
  if (snapshot === null) return invalid;

  // Подтверждённый наличный offer этого водителя.
  const offer = state.driverOffers.find(
    (o) =>
      o.orderId === order.id &&
      o.driverId === driverId &&
      o.status === "ACCEPTED",
  );
  if (!offer || !isValidIso(offer.cashReserveConfirmedAt)) return invalid;

  // Подтверждённая рестораном передача наличных.
  const handoff = getPlatformDriverCashHandoffView(state, order);
  if (handoff.status !== "CONFIRMED") return invalid;
  if (!isValidIso(handoff.restaurantConfirmedAt)) return invalid;

  // Ровно одно событие получения денег от клиента.
  const events = collectionEvents(state, order.id);
  if (events.length !== 1) return invalid;
  const event = events[0];
  if (event.id !== customerCashCollectionEventId(order.id)) return invalid;
  if (event.driverId !== driverId) return invalid;
  if (event.restaurantId !== order.restaurant.id) return invalid;
  if (event.actor !== "DRIVER") return invalid;
  if (event.restaurantWorkspaceRole !== null) return invalid;
  if (event.amountCents !== snapshot.customerCollectionCents) return invalid;
  if (!isValidIso(event.occurredAt)) return invalid;
  if (event.occurredAt !== order.paidAt) return invalid;
  if (event.occurredAt !== nowIso) return invalid;

  // Полный рабочий путь водителя; завершения ещё быть не должно.
  const picked = deliveryEvents(state, order.id, driverId, "ORDER_PICKED_UP");
  const arriving = deliveryEvents(state, order.id, driverId, "ARRIVING_TO_CUSTOMER");
  const delivered = deliveryEvents(state, order.id, driverId, "ORDER_DELIVERED");
  if (picked.length !== 1 || arriving.length !== 1) return invalid;
  if (delivered.length !== 0) return invalid;
  if (!isValidIso(picked[0].occurredAt) || !isValidIso(arriving[0].occurredAt)) {
    return invalid;
  }

  // Хронология: получение денег не раньше передачи ресторану, получения заказа
  // и подъезда; получение заказа не позже подъезда. Равное время разрешено.
  const at = Date.parse(event.occurredAt);
  const pickedMs = Date.parse(picked[0].occurredAt);
  const arrivingMs = Date.parse(arriving[0].occurredAt);
  if (pickedMs > arrivingMs) return { ok: false, error: CASH_CHRONOLOGY_ERROR };
  if (
    at < Date.parse(handoff.restaurantConfirmedAt) ||
    at < pickedMs ||
    at < arrivingMs
  ) {
    return { ok: false, error: CASH_CHRONOLOGY_ERROR };
  }

  return { ok: true, collectionEvent: event };
}

/**
 * Состояние получения денег от клиента. Ничего не мутирует и не реконструирует.
 */
export function getPlatformDriverCustomerCashCollectionView(
  state: PrototypeState,
  order: Order,
): PlatformDriverCustomerCashCollectionView {
  if (order.deliveryMode !== "PLATFORM_DRIVER" || order.paymentMethod !== "CASH") {
    return { status: "NOT_APPLICABLE", amountCents: null, collectedAt: null };
  }

  const snapshot = getPlatformDriverCashSnapshot(order);
  const events = collectionEvents(state, order.id);
  const event = events[0] ?? null;
  const review: PlatformDriverCustomerCashCollectionView = {
    status: "REVIEW_REQUIRED",
    amountCents: snapshot ? snapshot.customerCollectionCents : null,
    collectedAt: event ? event.occurredAt : null,
  };

  // Основание наличного заказа и подтверждённая передача ресторану обязательны.
  if (snapshot === null) return review;
  if (events.length > 1) return review;
  const driverId = order.assignedDriverId;
  if (driverId === null) return review;
  const handoff = getPlatformDriverCashHandoffView(state, order);
  if (handoff.status !== "CONFIRMED") return review;
  if (!isValidIso(handoff.restaurantConfirmedAt)) return review;

  const amountCents = snapshot.customerCollectionCents;
  const picked = deliveryEvents(state, order.id, driverId, "ORDER_PICKED_UP");
  const arriving = deliveryEvents(state, order.id, driverId, "ARRIVING_TO_CUSTOMER");
  const delivered = deliveryEvents(state, order.id, driverId, "ORDER_DELIVERED");

  if (event === null) {
    // События нет: завершённый заказ без него — противоречие.
    if (order.status === "DELIVERED") return review;
    if (delivered.length > 0) return review;
    if (order.paymentStatus !== "CASH_ON_DELIVERY") return review;
    if (order.paidAt !== null) return review;
    return { status: "ACTION_REQUIRED", amountCents, collectedAt: null };
  }

  // Событие есть — требуем полностью согласованное завершённое состояние.
  if (order.status !== "DELIVERED") return review;
  if (order.paymentStatus !== "PAID") return review;
  if (!isValidIso(order.paidAt)) return review;
  if (event.amountCents !== amountCents) return review;
  if (event.driverId !== driverId) return review;
  if (event.actor !== "DRIVER") return review;
  if (event.restaurantWorkspaceRole !== null) return review;
  if (event.restaurantId !== order.restaurant.id) return review;
  if (!isValidIso(event.occurredAt)) return review;
  if (event.occurredAt !== order.paidAt) return review;
  // Рабочий путь водителя должен быть пройден полностью и без дублей: ровно по
  // одному получению заказа, подъезду и завершению.
  if (picked.length !== 1 || arriving.length !== 1 || delivered.length !== 1) {
    return review;
  }
  if (delivered[0].occurredAt !== event.occurredAt) return review;
  if (
    !isValidIso(picked[0].occurredAt) ||
    !isValidIso(arriving[0].occurredAt) ||
    !isValidIso(delivered[0].occurredAt)
  ) {
    return review;
  }
  // Хронология: получение заказа не позже подъезда; получение денег не раньше
  // подтверждения ресторана, получения заказа и подъезда. Равное время можно.
  const at = Date.parse(event.occurredAt);
  const pickedMs = Date.parse(picked[0].occurredAt);
  const arrivingMs = Date.parse(arriving[0].occurredAt);
  if (pickedMs > arrivingMs) return review;
  if (at < Date.parse(handoff.restaurantConfirmedAt)) return review;
  if (at < pickedMs) return review;
  if (at < arrivingMs) return review;

  return { status: "COLLECTED", amountCents, collectedAt: event.occurredAt };
}

/** Полностью согласованное получение денег от клиента. */
export function hasValidPlatformDriverCustomerCashCollection(
  state: PrototypeState,
  order: Order,
): boolean {
  return (
    getPlatformDriverCustomerCashCollectionView(state, order).status === "COLLECTED"
  );
}
