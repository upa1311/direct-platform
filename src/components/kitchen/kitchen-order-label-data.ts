import type {
  DeliveryMode,
  Order,
  PaymentStatus,
  PrototypeState,
} from "@/prototype/models";
// Импорт относительный: модуль проверяется node:test, где alias «@/» не
// резолвится. Типы стираются при стриппинге, значения — нет.
import { formatClock24 } from "../../prototype/selectors";
import { getVisibleCookingComment } from "./cooking-comment";

/**
 * Безопасная модель данных термонаклейки кухни.
 *
 * Тип намеренно НЕ содержит полей клиента, адреса, кода выдачи, водителя,
 * сумм, комиссий и settlement: то, чего нет в типе, невозможно случайно
 * напечатать. Всё, что печатается, — публичный номер и снимок заказа.
 */
export interface KitchenOrderLabelItem {
  quantity: number;
  name: string;
  /** Название выбранного варианта из снимка заказа; null — варианта нет. */
  variantName: string | null;
  /** Комментарий к приготовлению после trim; null — печатать нечего. */
  comment: string | null;
}

export interface KitchenOrderLabelData {
  brand: string;
  /** Публичный номер (DIR-1042), не внутренний order.id. */
  publicNumber: string;
  /** САМОВЫВОЗ | ДОСТАВКА DIRECT | ДОСТАВКА РЕСТОРАНА — без enum. */
  deliveryLabel: string;
  /** «Готово к 18:45» либо «Время готовности не задано». */
  readyLine: string;
  /** «Принят: 18:23» по реальному переходу в PREPARING; null — перехода нет. */
  acceptedLine: string | null;
  items: KitchenOrderLabelItem[];
  /** «Позиций: 2 · Единиц: 3» — нейтральная форма без склонений. */
  countsLine: string;
  itemsTotal: number;
  unitsTotal: number;
  /** ОПЛАЧЕНО | ОПЛАТА ПРИ ПОЛУЧЕНИИ — без суммы и способа оплаты. */
  paymentLabel: string;
  restaurantName: string;
}

const LABEL_BRAND = "DIRECT";
const DEFAULT_TIME_ZONE = "Europe/Chisinau";

export const LABEL_PAID = "ОПЛАЧЕНО";
export const LABEL_DUE_ON_RECEIPT = "ОПЛАТА ПРИ ПОЛУЧЕНИИ";
export const LABEL_READY_UNKNOWN = "Время готовности не задано";

/** Способ получения крупной строкой. Внутренний enum на наклейку не попадает. */
const DELIVERY_LABELS: Record<DeliveryMode, string> = {
  PICKUP: "САМОВЫВОЗ",
  PLATFORM_DRIVER: "ДОСТАВКА DIRECT",
  RESTAURANT_DELIVERY: "ДОСТАВКА РЕСТОРАНА",
};

/**
 * Статусы, при которых деньги уже получены. Всё остальное печатается как
 * «оплата при получении»: ошибиться в эту сторону безопасно (сотрудник
 * переспросит), а ложное «ОПЛАЧЕНО» стоило бы ресторану денег.
 */
const PAID_STATUSES: readonly PaymentStatus[] = [
  "PAID",
  "PAID_AT_RESTAURANT",
  "PAID_TO_RESTAURANT_COURIER",
];

export function getLabelPaymentLabel(status: PaymentStatus): string {
  return PAID_STATUSES.includes(status) ? LABEL_PAID : LABEL_DUE_ON_RECEIPT;
}

/**
 * Реальный момент принятия заказа — переход в PREPARING в истории. Отдельно от
 * getOrderStatusSince: тот при отсутствии события падает на updatedAt, а на
 * наклейке неверное время принятия хуже отсутствующего, поэтому здесь null.
 * Текущее время браузера не используется никогда.
 */
export function findOrderAcceptedAtIso(order: Order): string | null {
  const event = order.history.find(
    (e) =>
      e.type === "STATUS" &&
      e.toStatus === "PREPARING" &&
      e.fromStatus !== "PREPARING",
  );
  return event?.occurredAt ?? null;
}

function getRestaurantTimeZone(state: PrototypeState, order: Order): string {
  return (
    state.restaurants.find((r) => r.id === order.restaurant.id)?.timeZone ||
    DEFAULT_TIME_ZONE
  );
}

/**
 * Собирает данные наклейки из снимка заказа. Чистая функция: state и order не
 * мутируются, доменных действий нет — печать не является бизнес-мутацией.
 *
 * Позиции берутся ТОЛЬКО из order.items (снимок на момент заказа), поэтому
 * последующее изменение меню не меняет наклейку старого заказа.
 */
export function buildKitchenOrderLabelData(
  state: PrototypeState,
  order: Order,
): KitchenOrderLabelData {
  const timeZone = getRestaurantTimeZone(state, order);
  const acceptedAt = findOrderAcceptedAtIso(order);

  const items: KitchenOrderLabelItem[] = order.items.map((item) => ({
    quantity: item.quantity,
    name: item.name,
    variantName: item.selectedVariantName ?? null,
    comment: getVisibleCookingComment(item.cookingComment),
  }));

  const unitsTotal = items.reduce((sum, item) => sum + item.quantity, 0);

  return {
    brand: LABEL_BRAND,
    publicNumber: order.publicNumber,
    deliveryLabel: DELIVERY_LABELS[order.deliveryMode],
    readyLine: order.expectedReadyAt
      ? `Готово к ${formatClock24(order.expectedReadyAt, timeZone)}`
      : LABEL_READY_UNKNOWN,
    acceptedLine: acceptedAt
      ? `Принят: ${formatClock24(acceptedAt, timeZone)}`
      : null,
    items,
    countsLine: `Позиций: ${items.length} · Единиц: ${unitsTotal}`,
    itemsTotal: items.length,
    unitsTotal,
    paymentLabel: getLabelPaymentLabel(order.paymentStatus),
    restaurantName: order.restaurant.name,
  };
}
