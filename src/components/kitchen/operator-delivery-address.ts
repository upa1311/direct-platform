import type { Order } from "@/prototype/models";

/**
 * Форматирование адреса доставки для оператора. Чистые функции без React и
 * мутаций — читают только снимок order.address, не текущий профиль клиента и
 * не настройки ресторана. Пустые (в т.ч. из пробелов) поля не выводятся, лишних
 * запятых и разделителей нет.
 *
 * Кухне это недоступно: адрес — операторские данные (см. permission matrix,
 * KITCHEN_VISIBLE). Самовывоз адреса не имеет — все функции возвращают null.
 */

export interface OperatorDeliveryAddressLines {
  /** «Штефан чел Маре, дом 10, кв. 24» — основная строка. */
  main: string;
  /** «Подъезд 2 · этаж 6» либо null, если оба поля пусты. */
  access: string | null;
  /** Комментарий к адресу после trim либо null. */
  comment: string | null;
}

/** true — заказ доставочный и в снимке есть непустой адрес. */
function hasDeliveryAddress(order: Order): boolean {
  if (order.deliveryMode === "PICKUP") return false;
  const address = order.address;
  if (!address) return false;
  return address.street.trim().length > 0 || address.house.trim().length > 0;
}

/** Основная строка адреса: улица, дом, кв. Пустые части пропускаются. */
export function formatOperatorAddressMain(order: Order): string | null {
  if (!hasDeliveryAddress(order)) return null;
  const address = order.address!;
  const parts: string[] = [];
  const street = address.street.trim();
  const house = address.house.trim();
  const apartment = address.apartment.trim();
  if (street) parts.push(street);
  if (house) parts.push(`дом ${house}`);
  if (apartment) parts.push(`кв. ${apartment}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** «Подъезд 2 · этаж 6». Показывается только при непустых полях. */
export function formatOperatorAddressAccess(order: Order): string | null {
  if (!hasDeliveryAddress(order)) return null;
  const address = order.address!;
  const parts: string[] = [];
  const entrance = address.entrance.trim();
  const floor = address.floor.trim();
  if (entrance) parts.push(`подъезд ${entrance}`);
  if (floor) parts.push(`этаж ${floor}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Комментарий клиента к адресу после trim; null — печатать нечего. */
export function formatOperatorAddressComment(order: Order): string | null {
  if (!hasDeliveryAddress(order)) return null;
  const comment = order.address!.comment.trim();
  return comment.length > 0 ? comment : null;
}

/** Собранная модель адреса для оператора; null — самовывоз/нет адреса. */
export function formatOperatorDeliveryAddress(
  order: Order,
): OperatorDeliveryAddressLines | null {
  const main = formatOperatorAddressMain(order);
  if (main === null) return null;
  return {
    main,
    access: formatOperatorAddressAccess(order),
    comment: formatOperatorAddressComment(order),
  };
}
