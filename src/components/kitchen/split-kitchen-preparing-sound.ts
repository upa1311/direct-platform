import type { Order } from "../../prototype/models";

/**
 * Чистая логика кухонного сигнала о начале приготовления (только SPLIT). React и
 * звука здесь нет — только детерминированное определение, когда должен прозвучать
 * beep: по появлению НОВОГО order.id среди заказов ресторана в статусе PREPARING
 * относительно запомненного baseline. Источник истины — статус заказа, а не
 * способ оплаты/доставки или кнопка. AWAITING_PAYMENT в набор не входит, поэтому
 * онлайн-заказ звучит только когда фактически перейдёт в PREPARING.
 */

/** id заказов выбранного ресторана в статусе PREPARING. */
export function preparingOrderIds(
  orders: readonly Order[],
  restaurantId: string,
): string[] {
  return orders
    .filter(
      (order) =>
        order.restaurant.id === restaurantId && order.status === "PREPARING",
    )
    .map((order) => order.id);
}

/** Запомненный baseline готовящихся заказов (по ресторану). */
export interface PreparingSoundState {
  restaurantId: string | null;
  knownPreparingIds: string[];
}

export function initialPreparingSoundState(): PreparingSoundState {
  return { restaurantId: null, knownPreparingIds: [] };
}

/**
 * Чистый редьюсер сигнала. Инварианты:
 * - первое наблюдение и смена restaurantId → текущие PREPARING становятся baseline
 *   БЕЗ звука (старый backlog не озвучиваем);
 * - сигнал только при появлении хотя бы одного НОВОГО PREPARING id (один раз, даже
 *   если сразу появилось несколько);
 * - baseline двигается к текущему набору ВСЕГДА (в т.ч. при enabled=false), чтобы
 *   после включения старые PREPARING не прозвучали, а «остался PREPARING» не
 *   повторялся;
 * - при enabled=false сигнала нет, но baseline обновляется.
 */
export function reducePreparingSound(
  prev: PreparingSoundState,
  input: {
    restaurantId: string;
    enabled: boolean;
    preparingIds: readonly string[];
  },
): { next: PreparingSoundState; play: boolean } {
  const current = [...input.preparingIds];
  if (prev.restaurantId !== input.restaurantId) {
    return {
      next: { restaurantId: input.restaurantId, knownPreparingIds: current },
      play: false,
    };
  }
  const known = new Set(prev.knownPreparingIds);
  const hasFresh = input.preparingIds.some((id) => !known.has(id));
  return {
    next: { restaurantId: input.restaurantId, knownPreparingIds: current },
    play: input.enabled && hasFresh,
  };
}
