import type { Order } from "../../prototype/models";

/**
 * Чистая логика кухонного сигнала ожидания подтверждения начала приготовления
 * (только SPLIT). React и звука здесь нет — только детерминированный отбор
 * заказов-кандидатов. Расписание повтора считает общий isKitchenBeepDue
 * (см. selectors), которому передаётся этот набор и KITCHEN_START_REPEAT_INTERVAL_MS.
 *
 * Кандидат — заказ выбранного ресторана в статусе PREPARING, у которого кухня
 * ещё НЕ подтвердила начало (kitchenStartedAt === null). Источник истины —
 * доменное поле заказа, а не кнопка/оплата/deliveryMode. AWAITING_PAYMENT в
 * набор не входит: онлайн-заказ становится кандидатом только после фактического
 * перехода в PREPARING. Как только кухня подтверждает начало, заказ выпадает из
 * набора и сигнал прекращается.
 */

/** Интервал повтора сигнала ожидания подтверждения кухни: 20 секунд. Единый
 * источник истины интервала — без magic number в нескольких местах. */
export const KITCHEN_START_REPEAT_INTERVAL_MS = 20_000;

/**
 * id заказов выбранного ресторана в статусе PREPARING, ожидающих подтверждения
 * начала кухней (kitchenStartedAt === null).
 */
export function preparingAwaitingKitchenStartIds(
  orders: readonly Order[],
  restaurantId: string,
): string[] {
  return orders
    .filter(
      (order) =>
        order.restaurant.id === restaurantId &&
        order.status === "PREPARING" &&
        order.kitchenStartedAt === null,
    )
    .map((order) => order.id);
}
