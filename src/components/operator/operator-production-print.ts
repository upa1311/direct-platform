import type { Order } from "@/prototype/models";

/**
 * Можно ли оператору напечатать ПРОИЗВОДСТВЕННЫЙ лист по заказу.
 *
 * Приём заказа и печать — два последовательных действия: принятие никогда не
 * печатает автоматически. Лист нужен кухне для приготовления, поэтому он
 * появляется ровно тогда, когда заказ реально готовится:
 *  - ONLINE — только после подтверждённой оплаты (fail-closed: без PAID печати
 *    нет, чтобы не отправить в работу неоплаченный заказ);
 *  - оплата в ресторане и наличные курьеру ресторана — сразу после принятия,
 *    ждать фактической оплаты при выдаче или доставке не нужно. К pickupPaidWith
 *    правило не привязано: при принятии ещё неизвестно, чем клиент заплатит.
 *
 * Чистая функция: решение принимается только по каноническому Order — не по DOM,
 * локальному state, предыдущему клику, тексту статуса, истории или таймеру.
 * Неизвестный способ оплаты — fail-closed.
 *
 * Это НЕ пакетная наклейка: она печатается только для готового заказа
 * (READY/READY_FOR_PICKUP) и живёт по своим правилам.
 */
export function canPrintOperatorProductionTicket(order: Order): boolean {
  if (order.status !== "PREPARING") return false;
  if (order.paymentMethod === "ONLINE") {
    return order.paymentStatus === "PAID";
  }
  if (order.paymentMethod === "PAY_AT_RESTAURANT") return true;
  if (order.paymentMethod === "CASH_TO_RESTAURANT_COURIER") return true;
  return false;
}
