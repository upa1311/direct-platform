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
  if (delivered.length !== 1) return review;
  if (delivered[0].occurredAt !== event.occurredAt) return review;
  if (arriving.length < 1) return review;
  if (!isValidIso(arriving[0].occurredAt)) return review;
  // Хронология: получение денег не раньше подтверждения ресторана и подъезда.
  const at = Date.parse(event.occurredAt);
  if (at < Date.parse(handoff.restaurantConfirmedAt)) return review;
  if (at < Date.parse(arriving[0].occurredAt)) return review;

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
