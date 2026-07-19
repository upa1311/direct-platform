import type { Order, OrderStatus } from "../../prototype/models";

/**
 * Чистая логика сигнала «Заказ готов» для операторского экрана (SPLIT). Здесь
 * нет React и звука — только детерминированное определение, когда должен
 * прозвучать сигнал: по появлению НОВОГО order.id среди готовых заказов
 * (READY / READY_FOR_PICKUP) относительно запомненного baseline. Источник истины —
 * статус заказа, а не кнопка/способ доставки/оплата.
 */

/** Статусы «готов»: кухня завершила приготовление. */
export const ORDER_READY_STATUSES: readonly OrderStatus[] = [
  "READY",
  "READY_FOR_PICKUP",
];

/** id заказов выбранного ресторана в статусе готовности (без учёта сортировки). */
export function readyOrderIds(
  orders: readonly Order[],
  restaurantId: string,
): string[] {
  return orders
    .filter(
      (order) =>
        order.restaurant.id === restaurantId &&
        ORDER_READY_STATUSES.includes(order.status),
    )
    .map((order) => order.id);
}

/** Запомненный baseline готовых заказов (по ресторану). */
export interface ReadySoundState {
  restaurantId: string | null;
  knownReadyIds: string[];
}

export function initialReadySoundState(): ReadySoundState {
  return { restaurantId: null, knownReadyIds: [] };
}

/**
 * Чистый редьюсер сигнала. По текущему набору готовых id решает, звучать ли
 * сигнал, и возвращает новый baseline. Инварианты:
 * - первое наблюдение и смена restaurantId → текущие готовые становятся baseline
 *   БЕЗ звука (старый backlog не озвучиваем);
 * - сигнал только при появлении хотя бы одного НОВОГО готового id (один раз, даже
 *   если сразу готовы несколько);
 * - baseline двигается к текущему набору ВСЕГДА (в т.ч. при enabled=false), чтобы
 *   после включения старые готовые не прозвучали, а «остался готов» не повторялся;
 * - при enabled=false сигнала нет, но baseline обновляется.
 */
export function reduceReadySound(
  prev: ReadySoundState,
  input: { restaurantId: string; enabled: boolean; readyIds: readonly string[] },
): { next: ReadySoundState; play: boolean } {
  const current = [...input.readyIds];
  if (prev.restaurantId !== input.restaurantId) {
    return {
      next: { restaurantId: input.restaurantId, knownReadyIds: current },
      play: false,
    };
  }
  const known = new Set(prev.knownReadyIds);
  const hasFresh = input.readyIds.some((id) => !known.has(id));
  return {
    next: { restaurantId: input.restaurantId, knownReadyIds: current },
    play: input.enabled && hasFresh,
  };
}
