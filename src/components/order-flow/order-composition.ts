import type { OrderItemSnapshot } from "@/prototype/models";

/** Позиция для краткой сводки состава (без технических ID). */
type BriefItem = Pick<OrderItemSnapshot, "name" | "quantity">;

export interface BriefOrderComposition {
  /** Первые до двух позиций: «Пицца × 4, Лимонад × 2» либо «—» при пустом. */
  primaryText: string;
  /** Сколько ПОЗИЦИЙ (строк, не единиц) скрыто сверх первых двух. */
  remainingCount: number;
}

/**
 * §2: краткий состав заказа для списка «Мои заказы». Показывает максимум первые
 * две позиции; при 3+ строках остальные сворачиваются в число «Ещё N позиций».
 * Считаются СТРОКИ заказа, а не сумма quantity. Технические ID не выводятся.
 */
export function getBriefOrderComposition(
  items: readonly BriefItem[],
): BriefOrderComposition {
  const rows = items.map((item) => `${item.name} × ${item.quantity}`);
  if (rows.length === 0) {
    return { primaryText: "—", remainingCount: 0 };
  }
  return {
    primaryText: rows.slice(0, 2).join(", "),
    remainingCount: Math.max(0, rows.length - 2),
  };
}
