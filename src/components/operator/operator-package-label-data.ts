import type {
  DeliveryMode,
  Order,
  RestaurantWorkspaceRole,
} from "@/prototype/models";

/**
 * Приватная пакетная наклейка оператора — физический ярлык на ГОТОВЫЙ пакет.
 *
 * Наклейка нужна для идентификации заказа и проверки состава при выдаче/передаче
 * курьеру. Адрес и телефон оператор и курьер берут из интерфейса, а не с
 * наклейки, которую могут видеть посторонние. Поэтому в этот тип НЕ входят имя
 * клиента, адрес, телефон, код выдачи, суммы/оплата enum, водитель, внутренний
 * order.id и cooking comments (внутренние инструкции кухни печатаются только на
 * production ticket). Напечатать их физически нечем — их нет в модели.
 */
export interface OperatorPackageLabelItem {
  quantity: number;
  name: string;
  /** Название выбранного варианта из снимка заказа; null — варианта нет. */
  variantName: string | null;
}

export interface OperatorPackageLabelData {
  /** Публичный номер (DIR-1042), не внутренний order.id. */
  publicNumber: string;
  /** САМОВЫВОЗ | ДОСТАВКА DIRECT | ДОСТАВКА РЕСТОРАНА — без enum. */
  deliveryLabel: string;
  restaurantName: string;
  items: OperatorPackageLabelItem[];
  /** «Позиций: 2 · Единиц: 3» — нейтральная форма без склонений. */
  countsLine: string;
  itemsTotal: number;
  unitsTotal: number;
  /** Только «ОПЛАЧЕНО» или «ОПЛАТА ПРИ ПОЛУЧЕНИИ» — без сумм, валюты и enum. */
  paymentLabel: string;
}

export const PACKAGE_PAID = "ОПЛАЧЕНО";
export const PACKAGE_DUE = "ОПЛАТА ПРИ ПОЛУЧЕНИИ";

/** Способ получения крупной строкой. Внутренний enum на наклейку не попадает. */
const DELIVERY_LABELS: Record<DeliveryMode, string> = {
  PICKUP: "САМОВЫВОЗ",
  PLATFORM_DRIVER: "ДОСТАВКА DIRECT",
  RESTAURANT_DELIVERY: "ДОСТАВКА РЕСТОРАНА",
};

/**
 * Безопасный платёжный маркер: только «оплачено» / «оплата при получении».
 * Ни суммы, ни валюты, ни paymentStatus/paymentMethod enum, ни задолженности.
 */
export function getPackagePaymentLabel(order: Order): string {
  const status = order.paymentStatus;
  if (
    status === "PAID" ||
    status === "PAID_AT_RESTAURANT" ||
    status === "PAID_TO_RESTAURANT_COURIER"
  ) {
    return PACKAGE_PAID;
  }
  return PACKAGE_DUE;
}

/**
 * Единый источник видимости пакетной наклейки (presentation-level, не domain:
 * печать не бизнес-мутация). Разрешена только оператору и общему экрану и только
 * для готового заказа. Кухне (в т.ч. SPLIT KITCHEN) — никогда.
 */
export function canPrintOperatorPackageLabel(
  order: Order,
  workspaceRole: RestaurantWorkspaceRole,
): boolean {
  if (workspaceRole !== "OPERATOR" && workspaceRole !== "COMBINED") {
    return false;
  }
  return order.status === "READY" || order.status === "READY_FOR_PICKUP";
}

/**
 * Собирает данные пакетной наклейки из снимка заказа. Чистая функция: заказ не
 * мутируется, доменных действий нет. Позиции берутся ТОЛЬКО из order.items
 * (снимок), без cooking comments — изменение меню не меняет наклейку.
 */
export function buildOperatorPackageLabelData(
  order: Order,
): OperatorPackageLabelData {
  const items: OperatorPackageLabelItem[] = order.items.map((item) => ({
    quantity: item.quantity,
    name: item.name,
    variantName: item.selectedVariantName ?? null,
  }));

  const unitsTotal = items.reduce((sum, item) => sum + item.quantity, 0);

  return {
    publicNumber: order.publicNumber,
    deliveryLabel: DELIVERY_LABELS[order.deliveryMode],
    restaurantName: order.restaurant.name,
    items,
    countsLine: `Позиций: ${items.length} · Единиц: ${unitsTotal}`,
    itemsTotal: items.length,
    unitsTotal,
    paymentLabel: getPackagePaymentLabel(order),
  };
}
