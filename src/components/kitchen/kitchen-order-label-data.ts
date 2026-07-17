import type { DeliveryMode, Order, PickupPaymentMethod } from "@/prototype/models";
// Импорт относительный: модуль проверяется node:test, где alias «@/» не
// резолвится. Типы стираются при стриппинге, значения — нет.
import { formatMoney } from "../../prototype/selectors";
import { getVisibleCookingComment } from "./cooking-comment";

/**
 * Безопасная модель данных термонаклейки кухни.
 *
 * На наклейке печатаются имя клиента и адрес доставки — это физический ярлык
 * для выдачи и курьера. Телефон, код выдачи, внутренний order.id, водитель,
 * комиссии и settlement на наклейку не попадают: их нет в этом типе, поэтому
 * напечатать их нечем. Экранные карточки кухни это не меняет.
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
  /** САМОВЫВОЗ DIRECT | ДОСТАВКА DIRECT | ДОСТАВКА РЕСТОРАНА — без enum. */
  deliveryLabel: string;
  /** Публичный номер (DIR-1042), не внутренний order.id. */
  publicNumber: string;
  customerName: string;
  /** Адрес только для доставки; null — самовывоз, блок не печатается. */
  addressLine: string | null;
  restaurantName: string;
  items: KitchenOrderLabelItem[];
  /** «Позиций: 2 · Единиц: 3» — нейтральная форма без склонений. */
  countsLine: string;
  itemsTotal: number;
  unitsTotal: number;
  /** ОПЛАЧЕНО либо «К ОПЛАТЕ …: сумма». Без разбивки и комиссий. */
  paymentLine: string;
}

export const LABEL_PAID = "ОПЛАЧЕНО";
export const LABEL_NO_CUSTOMER_NAME = "Клиент не указан";

/** Способ получения крупной строкой. Внутренний enum на наклейку не попадает. */
const DELIVERY_LABELS: Record<DeliveryMode, string> = {
  PICKUP: "САМОВЫВОЗ DIRECT",
  PLATFORM_DRIVER: "ДОСТАВКА DIRECT",
  RESTAURANT_DELIVERY: "ДОСТАВКА РЕСТОРАНА",
};

/** Способы оплаты на точке → хвост строки «К ОПЛАТЕ В РЕСТОРАНЕ …». */
function pickupMethodsSuffix(methods: readonly PickupPaymentMethod[]): string {
  const cash = methods.includes("CASH");
  const card = methods.includes("CARD");
  if (cash && card) return " НАЛИЧНЫМИ ИЛИ КАРТОЙ";
  if (cash) return " НАЛИЧНЫМИ";
  if (card) return " КАРТОЙ";
  return "";
}

/**
 * Строка оплаты. Для оплаченного заказа — только «ОПЛАЧЕНО», без суммы.
 * Для неоплаченного — сколько и где взять; сумма всегда из
 * financials.customerTotalCents, финансовая разбивка не печатается.
 */
export function getLabelPaymentLine(order: Order): string {
  const status = order.paymentStatus;
  if (
    status === "PAID" ||
    status === "PAID_AT_RESTAURANT" ||
    status === "PAID_TO_RESTAURANT_COURIER"
  ) {
    return LABEL_PAID;
  }

  const amount = formatMoney(
    order.financials.customerTotalCents,
    order.financials.currencyCode,
  );

  if (status === "CASH_ON_DELIVERY" || status === "DUE_TO_RESTAURANT_COURIER") {
    return `К ОПЛАТЕ КУРЬЕРУ НАЛИЧНЫМИ: ${amount}`;
  }
  if (status === "DUE_AT_PICKUP") {
    return `К ОПЛАТЕ В РЕСТОРАНЕ${pickupMethodsSuffix(
      order.pickupPaymentMethodsSnapshot,
    )}: ${amount}`;
  }
  // NOT_STARTED и AWAITING_PAYMENT: деньги ещё не получены.
  return `ОПЛАТА ОЖИДАЕТСЯ: ${amount}`;
}

/**
 * Адрес одной строкой — только для доставки. Квартира необязательна, пустой
 * адрес самовывоза даёт null, чтобы блок не оставлял пустую строку.
 */
export function getLabelAddressLine(order: Order): string | null {
  if (order.deliveryMode === "PICKUP") return null;
  const address = order.address;
  if (!address) return null;

  const parts: string[] = [];
  const street = address.street.trim();
  const house = address.house.trim();
  const apartment = address.apartment.trim();
  if (street) parts.push(street);
  if (house) parts.push(`дом ${house}`);
  if (apartment) parts.push(`кв. ${apartment}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Собирает данные наклейки из снимка заказа. Чистая функция: заказ не
 * мутируется, доменных действий нет — печать не является бизнес-мутацией.
 * Общий state не нужен: всё печатаемое лежит в самом снимке заказа.
 *
 * Позиции берутся ТОЛЬКО из order.items (снимок на момент заказа), поэтому
 * последующее изменение меню не меняет наклейку старого заказа.
 */
export function buildKitchenOrderLabelData(order: Order): KitchenOrderLabelData {
  const items: KitchenOrderLabelItem[] = order.items.map((item) => ({
    quantity: item.quantity,
    name: item.name,
    variantName: item.selectedVariantName ?? null,
    comment: getVisibleCookingComment(item.cookingComment),
  }));

  const unitsTotal = items.reduce((sum, item) => sum + item.quantity, 0);

  return {
    deliveryLabel: DELIVERY_LABELS[order.deliveryMode],
    publicNumber: order.publicNumber,
    customerName: order.customer.name.trim() || LABEL_NO_CUSTOMER_NAME,
    addressLine: getLabelAddressLine(order),
    restaurantName: order.restaurant.name,
    items,
    countsLine: `Позиций: ${items.length} · Единиц: ${unitsTotal}`,
    itemsTotal: items.length,
    unitsTotal,
    paymentLine: getLabelPaymentLine(order),
  };
}
