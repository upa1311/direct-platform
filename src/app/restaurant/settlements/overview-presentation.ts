import type {
  FinanceNetDirection,
  FinanceRowDataStatus,
  FinanceRowPaymentChannel,
  RestaurantFinanceOrderRow,
} from "@/prototype/restaurant-finance-read-model";

/**
 * Чистая презентация канонического finance read-model для главного экрана
 * «Расчёты с Direct». Только выбор текста по enum — никакой финансовой
 * арифметики: суммы приходят готовыми из model (netAmountCents и стороны
 * gross-разбивки НЕ вычисляются в React повторно).
 */

/** Заголовок и пояснение главной карточки баланса по готовому направлению. */
export function describeFinanceNet(net: {
  netDirection: FinanceNetDirection;
  netAmountCents: number;
}): { title: string; amountCents: number; note: string } {
  if (net.netDirection === "DIRECT_OWES_RESTAURANT") {
    return {
      title: "Direct должен ресторану",
      amountCents: net.netAmountCents,
      note: "Итог после взаимозачёта открытых заказов",
    };
  }
  if (net.netDirection === "RESTAURANT_OWES_DIRECT") {
    return {
      title: "Ресторан должен Direct",
      amountCents: net.netAmountCents,
      note: "Итог после взаимозачёта открытых заказов",
    };
  }
  return {
    title: "Взаиморасчёты закрыты",
    amountCents: net.netAmountCents,
    note: "Открытых обязательств сейчас нет",
  };
}

/** Направление долга строки заказа — с точки зрения ресторана. */
export const FINANCE_DIRECTION_LABELS: Record<
  RestaurantFinanceOrderRow["direction"],
  string
> = {
  DIRECT_OWES_RESTAURANT: "Direct должен вам",
  RESTAURANT_OWES_DIRECT: "Вы должны Direct",
};

/** Способ выполнения заказа. */
export const FINANCE_DELIVERY_LABELS: Record<
  RestaurantFinanceOrderRow["deliveryMode"],
  string
> = {
  PLATFORM_DRIVER: "Доставка Direct",
  RESTAURANT_DELIVERY: "Курьер ресторана",
  PICKUP: "Самовывоз",
};

/** Канал оплаты строки. */
export const FINANCE_CHANNEL_LABELS: Record<FinanceRowPaymentChannel, string> = {
  // v13: онлайн-карта различается по получателю платежа — ресторану важно
  // видеть, пришли деньги ему или Direct.
  ONLINE_CARD: "Онлайн-карта · получает Direct",
  ONLINE_CARD_TO_RESTAURANT: "Онлайн-карта · получает ресторан",
  CARD_AT_RESTAURANT: "Карта в ресторане",
  CASH_AT_RESTAURANT: "Наличные в ресторане",
  CASH_TO_RESTAURANT_COURIER: "Наличные курьеру ресторана",
  CASH_TO_PLATFORM_DRIVER: "Наличные водителю Direct",
  LEGACY_UNKNOWN: "Архивные данные",
};

/** Статус полноты данных строки. */
export const FINANCE_DATA_STATUS_LABELS: Record<FinanceRowDataStatus, string> = {
  COMPLETE: "Данные подтверждены",
  LEGACY: "Архивные данные",
  REVIEW_REQUIRED: "Требует проверки",
};
