import type {
  DeliveryMode,
  Order,
  RestaurantWorkspaceRole,
} from "@/prototype/models";
// Импорт относительный: модуль проверяется node:test, где alias «@/» не
// резолвится. Типы стираются при стриппинге, значения — нет.
import { formatMoney } from "../../prototype/selectors";
import {
  formatOperatorAddressAccess,
  formatOperatorAddressMain,
} from "../kitchen/operator-delivery-address";

/**
 * Пакетная наклейка — физический ярлык на ГОТОВЫЙ пакет.
 *
 * Наклейка нужна, чтобы опознать заказ, проверить состав и понять, что делать с
 * оплатой при передаче: курьеру и на выдаче нужны способ получения, номер,
 * состав, имя клиента, адрес доставки и платёжный блок.
 *
 * В модель НЕ входят: телефон клиента, код выдачи, внутренний order.id,
 * cooking comments (они печатаются только на производственном тикете),
 * комментарий к адресу, водитель, enum'ы оплаты, комиссии, выплаты ресторану,
 * выручка Direct, settlement, банковские данные и история заказа. Напечатать их
 * физически нечем — их нет в типе.
 */
export interface OperatorPackageLabelItem {
  quantity: number;
  name: string;
  /** Название выбранного варианта из снимка заказа; null — варианта нет. */
  variantName: string | null;
}

/**
 * Платёжный блок наклейки — размеченное объединение. Строится только из
 * фактического состояния заказа; неизвестную комбинацию не угадываем (см.
 * resolvePackagePaymentBlock → null), чтобы неоплаченный заказ никогда не был
 * помечен как «ОПЛАЧЕНО».
 */
export type PackagePaymentBlock =
  | { kind: "PAID"; title: "ОПЛАЧЕНО" }
  | { kind: "CASH_DUE"; title: "К ОПЛАТЕ НАЛИЧНЫМИ"; amount: string }
  | {
      kind: "PICKUP_DUE";
      title: "К ОПЛАТЕ В РЕСТОРАНЕ";
      amount: string;
      /** «НАЛИЧНЫМИ ИЛИ КАРТОЙ» и т.п.; null — снимок способов пуст. */
      methodsLine: string | null;
    };

export interface OperatorPackageLabelData {
  /** Публичный номер (DIR-1042), не внутренний order.id. */
  publicNumber: string;
  /** САМОВЫВОЗ | ДОСТАВКА DIRECT | ДОСТАВКА РЕСТОРАНА — без enum. */
  deliveryLabel: string;
  restaurantName: string;
  items: OperatorPackageLabelItem[];
  customerName: string;
  /** Адрес клиента — только для доставки; для самовывоза null. */
  addressMain: string | null;
  /** «Подъезд 2 · этаж 6» либо null. */
  addressAccess: string | null;
  paymentBlock: PackagePaymentBlock;
}

/** Путь оптимизированной копии фирменного логотипа для наклейки. */
export const PACKAGE_LABEL_LOGO_SRC = "/print/direct-package-label-logo.png";

/** Ошибка, когда платёжный блок невозможно определить безопасно. */
export const PACKAGE_LABEL_PAYMENT_ERROR =
  "Не удалось определить способ оплаты для наклейки.";

/** Ошибка загрузки логотипа: без него наклейку не печатаем. */
export const PACKAGE_LABEL_LOGO_ERROR =
  "Не удалось загрузить логотип для печати.";

/** Способ получения крупной строкой. Внутренний enum на наклейку не попадает. */
const DELIVERY_LABELS: Record<DeliveryMode, string> = {
  PICKUP: "САМОВЫВОЗ",
  PLATFORM_DRIVER: "ДОСТАВКА DIRECT",
  RESTAURANT_DELIVERY: "ДОСТАВКА РЕСТОРАНА",
};

/**
 * Строка позиции: «2 × Пицца Пепперони · Стандартная». Без варианта висячего
 * разделителя не остаётся: «1 × Лимонад».
 */
export function formatPackageLabelItemLine(
  item: OperatorPackageLabelItem,
): string {
  const base = `${item.quantity} × ${item.name}`;
  const variant = item.variantName?.trim();
  return variant ? `${base} · ${variant}` : base;
}

/** Строка способов оплаты на точке строго из снимка заказа; null — снимок пуст. */
export function formatPickupMethodsLine(
  methods: readonly ("CASH" | "CARD")[],
): string | null {
  const hasCash = methods.includes("CASH");
  const hasCard = methods.includes("CARD");
  if (hasCash && hasCard) return "НАЛИЧНЫМИ ИЛИ КАРТОЙ";
  if (hasCash) return "НАЛИЧНЫМИ";
  if (hasCard) return "КАРТОЙ";
  return null;
}

/**
 * Платёжный блок из фактического состояния заказа. Полный итог берётся из
 * неизменяемого снимка (financials.customerTotalCents) и форматируется общим
 * formatMoney с валютой снимка. null — комбинация не распознана: наклейку в
 * таком случае не печатаем и показываем ошибку, а не гадаем статус оплаты.
 */
export function resolvePackagePaymentBlock(
  order: Order,
): PackagePaymentBlock | null {
  const status = order.paymentStatus;
  if (
    status === "PAID" ||
    status === "PAID_AT_RESTAURANT" ||
    status === "PAID_TO_RESTAURANT_COURIER"
  ) {
    return { kind: "PAID", title: "ОПЛАЧЕНО" };
  }

  const amount = formatMoney(
    order.financials.customerTotalCents,
    order.financials.currencyCode,
  );

  // Наличные при получении: доставка ресторана своим курьером и будущая
  // валидная комбинация «водитель Direct + наличные».
  if (
    (order.deliveryMode === "RESTAURANT_DELIVERY" &&
      order.paymentMethod === "CASH_TO_RESTAURANT_COURIER") ||
    (order.deliveryMode === "PLATFORM_DRIVER" && order.paymentMethod === "CASH")
  ) {
    return { kind: "CASH_DUE", title: "К ОПЛАТЕ НАЛИЧНЫМИ", amount };
  }

  if (
    order.deliveryMode === "PICKUP" &&
    order.paymentMethod === "PAY_AT_RESTAURANT"
  ) {
    return {
      kind: "PICKUP_DUE",
      title: "К ОПЛАТЕ В РЕСТОРАНЕ",
      amount,
      methodsLine: formatPickupMethodsLine(order.pickupPaymentMethodsSnapshot),
    };
  }

  return null;
}

/**
 * Единый источник видимости пакетной наклейки (presentation-level, не domain:
 * печать не бизнес-мутация). Наклейка — документ ГОТОВОГО пакета, поэтому доступна
 * только для READY / READY_FOR_PICKUP. Роли OPERATOR, COMBINED и KITCHEN печатают
 * её на готовом заказе (в SPLIT наклейку печатает и оператор, и кухня). До
 * готовности (новый заказ, AWAITING_PAYMENT, PREPARING) — недоступна ни одной роли.
 */
export function canPrintOperatorPackageLabel(
  order: Order,
  workspaceRole: RestaurantWorkspaceRole,
): boolean {
  if (
    workspaceRole !== "OPERATOR" &&
    workspaceRole !== "COMBINED" &&
    workspaceRole !== "KITCHEN"
  ) {
    return false;
  }
  return order.status === "READY" || order.status === "READY_FOR_PICKUP";
}

/** Первая буква заглавной: «подъезд 2 · этаж 6» → «Подъезд 2 · этаж 6». */
function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Собирает данные пакетной наклейки из снимка заказа. Чистая функция: заказ не
 * мутируется, доменных действий нет. Позиции берутся ТОЛЬКО из order.items
 * (снимок), без cooking comments — изменение меню не меняет наклейку. Адрес —
 * только для доставки, существующими helper'ами оператора; комментарий к адресу
 * и телефон на наклейку не попадают.
 *
 * null — платёжный блок определить нельзя: печатать наклейку нельзя.
 */
export function buildOperatorPackageLabelData(
  order: Order,
): OperatorPackageLabelData | null {
  const paymentBlock = resolvePackagePaymentBlock(order);
  if (paymentBlock === null) return null;

  const items: OperatorPackageLabelItem[] = order.items.map((item) => ({
    quantity: item.quantity,
    name: item.name,
    variantName: item.selectedVariantName ?? null,
  }));

  const access = formatOperatorAddressAccess(order);

  return {
    publicNumber: order.publicNumber,
    deliveryLabel: DELIVERY_LABELS[order.deliveryMode],
    restaurantName: order.restaurant.name,
    items,
    customerName: order.customer.name,
    addressMain: formatOperatorAddressMain(order),
    addressAccess: access ? capitalizeFirst(access) : null,
    paymentBlock,
  };
}
