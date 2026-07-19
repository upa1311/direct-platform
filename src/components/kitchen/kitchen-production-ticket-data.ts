import type { DeliveryMode, Order } from "@/prototype/models";
// Импорт относительный: модуль проверяется node:test, где alias «@/» не
// резолвится. Типы стираются при стриппинге, значения — нет.
import { formatClock24 } from "../../prototype/selectors";
import { getVisibleCookingComment } from "./cooking-comment";

/**
 * Производственный кухонный тикет — БЕЗ персональных и финансовых данных.
 *
 * Тикет предназначен только для кухни: он содержит номер заказа, способ
 * получения, состав и время готовности. Имя клиента, адрес, телефон, код
 * выдачи, оплата, суммы, комиссии, settlement, водитель и внутренний order.id
 * в этот тип НЕ входят — напечатать их с /restaurant/kitchen физически нечем,
 * в том числе в SPLIT, где экран эти данные и так скрывает.
 *
 * Пакетная наклейка с адресом/оплатой для выдачи — отдельная зона оператора и
 * отдельный будущий этап; в кухонной печати её нет.
 */
export interface KitchenProductionTicketItem {
  quantity: number;
  name: string;
  /** Название выбранного варианта из снимка заказа; null — варианта нет. */
  variantName: string | null;
  /** Комментарий к приготовлению после trim; null — печатать нечего. */
  cookingComment: string | null;
}

export interface KitchenProductionTicketData {
  /** Публичный номер (DIR-1042), не внутренний order.id. */
  publicNumber: string;
  /** САМОВЫВОЗ DIRECT | ДОСТАВКА DIRECT | ДОСТАВКА РЕСТОРАНА — без enum. */
  deliveryLabel: string;
  restaurantName: string;
  /** «Ожидаемая готовность: 18:40» / «…: не задана» / «ЗАКАЗ ГОТОВ». */
  readyLine: string;
  /** Первоначальная оценка приготовления в минутах; null — не задана. */
  preparationMinutes: number | null;
  items: KitchenProductionTicketItem[];
  /** «Позиций: 2 · Единиц: 3» — нейтральная форма без склонений. */
  countsLine: string;
  itemsTotal: number;
  unitsTotal: number;
}

export const TICKET_READY = "ЗАКАЗ ГОТОВ";
const DEFAULT_TIME_ZONE = "Europe/Chisinau";

/** Способ получения крупной строкой. Внутренний enum на тикет не попадает. */
const DELIVERY_LABELS: Record<DeliveryMode, string> = {
  PICKUP: "САМОВЫВОЗ DIRECT",
  PLATFORM_DRIVER: "ДОСТАВКА DIRECT",
  RESTAURANT_DELIVERY: "ДОСТАВКА РЕСТОРАНА",
};

/**
 * Содержимое нижней рамки готовности. Порядок:
 * - READY / READY_FOR_PICKUP → «ЗАКАЗ ГОТОВ»;
 * - есть канонический expectedReadyAt → «ОЖИДАЕМАЯ ГОТОВНОСТЬ: К HH:MM» в часовом
 *   поясе ресторана;
 * - иначе (напр. AWAITING_PAYMENT после принятия, время ещё не задано), но есть
 *   первоначальная оценка → «ПРИГОТОВЛЕНИЕ ПОСЛЕ ОПЛАТЫ · N МИН».
 * Никогда не выводим «не задана»: рамка всегда содержательна.
 */
export function getTicketReadyLine(order: Order, timeZone: string): string {
  if (order.status === "READY" || order.status === "READY_FOR_PICKUP") {
    return TICKET_READY;
  }
  if (order.expectedReadyAt) {
    return `ОЖИДАЕМАЯ ГОТОВНОСТЬ: К ${formatClock24(
      order.expectedReadyAt,
      timeZone || DEFAULT_TIME_ZONE,
    )}`;
  }
  if (order.preparationMinutes != null) {
    return `ПРИГОТОВЛЕНИЕ ПОСЛЕ ОПЛАТЫ · ${order.preparationMinutes} МИН`;
  }
  return "ПРИГОТОВЛЕНИЕ ПОСЛЕ ОПЛАТЫ";
}

/**
 * Собирает данные производственного тикета из снимка заказа. Чистая функция:
 * заказ не мутируется, доменных действий нет — печать не бизнес-мутация. Общий
 * state не нужен, часовой пояс передаётся отдельным аргументом.
 *
 * Позиции берутся ТОЛЬКО из order.items (снимок на момент заказа), поэтому
 * последующее изменение меню не меняет тикет старого заказа.
 */
export function buildKitchenProductionTicketData(
  order: Order,
  timeZone: string,
): KitchenProductionTicketData {
  const items: KitchenProductionTicketItem[] = order.items.map((item) => ({
    quantity: item.quantity,
    name: item.name,
    variantName: item.selectedVariantName ?? null,
    cookingComment: getVisibleCookingComment(item.cookingComment),
  }));

  const unitsTotal = items.reduce((sum, item) => sum + item.quantity, 0);

  return {
    publicNumber: order.publicNumber,
    deliveryLabel: DELIVERY_LABELS[order.deliveryMode],
    restaurantName: order.restaurant.name,
    readyLine: getTicketReadyLine(order, timeZone),
    preparationMinutes: order.preparationMinutes,
    items,
    countsLine: `Позиций: ${items.length} · Единиц: ${unitsTotal}`,
    itemsTotal: items.length,
    unitsTotal,
  };
}
