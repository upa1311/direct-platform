import type { DeliveryMode } from "./pricing-engine";

// Канонический чистый расчёт банковской комиссии (1% карточной транзакции).
//
// Модуль сознательно не зависит от React, состояния прототипа и localStorage —
// как pricing-engine, он использует только `import type` и запускается напрямую
// через `node --test` без сборки.
//
// Зона ответственности ТОЛЬКО банковская комиссия: комиссия Direct (15%/7%),
// small-order fee и прочие компоненты заказа считаются существующим
// pricing-engine и сюда не дублируются. Функция получает УЖЕ рассчитанные
// суммы заказа и фактический канал оплаты, ничего в них не меняя: клиентская
// сумма из-за банка не увеличивается.

/** Ставка банковской комиссии карточной транзакции: 1% (в базисных пунктах). */
export const BANK_CARD_FEE_RATE_BPS = 100;

/**
 * Кто фактически собирает деньги клиента. Отдельный enum: получатель денег —
 * не то же самое, что способ получения заказа или канал оплаты.
 */
export type BankFeeMoneyCollector = "DIRECT" | "RESTAURANT";

/** Канал оплаты: карта (несёт банковский 1%) или наличные (банка нет). */
export type BankFeePaymentInstrument = "CARD" | "CASH";

/** Входные данные распределения банковской комиссии. */
export interface BankFeeInput {
  /** Фактический режим получения заказа (существующий доменный enum). */
  deliveryMode: DeliveryMode;
  /** Кто собирает деньги клиента. */
  moneyCollector: BankFeeMoneyCollector;
  /** Канал оплаты. */
  paymentInstrument: BankFeePaymentInstrument;
  /** Стоимость еды (после скидок), целые центы. */
  foodSubtotalCents: number;
  /**
   * Полная сумма, которую платит клиент (карточная транзакция при CARD),
   * целые центы. Включает еду, доставку Direct и small-order fee, если есть.
   */
  customerTotalCents: number;
}

/** Распределение банковской комиссии между рестораном и Direct. */
export interface BankFeeAllocation {
  totalBankFeeCents: number;
  restaurantBankFeeCents: number;
  directBankFeeCents: number;
}

/** Fail-closed результат: некорректная комбинация не маскируется нулями. */
export type BankFeeResult =
  | { ok: true; fee: BankFeeAllocation }
  | { ok: false; error: string };

/** 1% суммы в центах с округлением до цента. */
function bankFeeOfCents(amountCents: number): number {
  return Math.round((amountCents * BANK_CARD_FEE_RATE_BPS) / 10_000);
}

/** Целые неотрицательные конечные центы. */
function isValidCents(value: number): boolean {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function fail(error: string): BankFeeResult {
  return { ok: false, error };
}

/**
 * Допустимые комбинации режима, получателя денег и канала оплаты.
 *
 * - PLATFORM_DRIVER: деньги собирает Direct; CARD (онлайн) или CASH.
 * - PICKUP: деньги собирает ресторан на точке; CARD или CASH.
 * - RESTAURANT_DELIVERY: только наличные собственному курьеру ресторана;
 *   онлайн-оплата для этого канала НЕ существует и отклоняется.
 */
function validateCombination(input: BankFeeInput): string | null {
  const { deliveryMode, moneyCollector, paymentInstrument } = input;
  if (deliveryMode === "PLATFORM_DRIVER") {
    return moneyCollector === "DIRECT"
      ? null
      : "При доставке водителем Direct деньги клиента собирает Direct.";
  }
  if (deliveryMode === "PICKUP") {
    return moneyCollector === "RESTAURANT"
      ? null
      : "При самовывозе деньги клиента собирает ресторан на точке.";
  }
  if (deliveryMode === "RESTAURANT_DELIVERY") {
    if (moneyCollector !== "RESTAURANT") {
      return "При доставке курьером ресторана деньги собирает ресторан.";
    }
    if (paymentInstrument !== "CASH") {
      return "Онлайн-оплата для собственного курьера ресторана не поддерживается.";
    }
    return null;
  }
  return "Неизвестный режим получения заказа.";
}

/**
 * Распределение банковского 1% карточной транзакции.
 *
 * Правила:
 * - наличные (любой допустимый канал): банковской комиссии нет — все суммы 0;
 * - доставка водителем Direct + онлайн-карта: банк удерживает 1% всей
 *   транзакции; ресторан несёт 1% от еды, Direct — остаток (его доставка,
 *   small-order fee и прочие компоненты Direct);
 * - самовывоз + карта на точке: весь 1% несёт ресторан (комиссия уменьшает его
 *   чистый доход и НЕ увеличивает долг перед Direct), Direct — 0.
 *
 * Инвариант: restaurantBankFeeCents + directBankFeeCents === totalBankFeeCents.
 * Входные данные валидируются fail-closed: нецелые/отрицательные/бесконечные
 * суммы, еда больше транзакции и невозможные комбинации режима и оплаты
 * возвращают ошибку, а не правдоподобный ноль.
 */
export function allocateBankFee(input: BankFeeInput): BankFeeResult {
  if (!isValidCents(input.foodSubtotalCents)) {
    return fail("Стоимость еды должна быть целым неотрицательным числом центов.");
  }
  if (!isValidCents(input.customerTotalCents)) {
    return fail("Сумма клиента должна быть целым неотрицательным числом центов.");
  }
  if (input.foodSubtotalCents > input.customerTotalCents) {
    return fail("Стоимость еды не может превышать сумму клиента.");
  }
  const combinationError = validateCombination(input);
  if (combinationError !== null) {
    return fail(combinationError);
  }

  // Наличные: банк в транзакции не участвует.
  if (input.paymentInstrument === "CASH") {
    return {
      ok: true,
      fee: {
        totalBankFeeCents: 0,
        restaurantBankFeeCents: 0,
        directBankFeeCents: 0,
      },
    };
  }

  const totalBankFeeCents = bankFeeOfCents(input.customerTotalCents);

  // Самовывоз картой на точке: платёж принимает ресторан — весь 1% его.
  if (input.deliveryMode === "PICKUP") {
    return {
      ok: true,
      fee: {
        totalBankFeeCents,
        restaurantBankFeeCents: totalBankFeeCents,
        directBankFeeCents: 0,
      },
    };
  }

  // Доставка водителем Direct + онлайн-карта: ресторан несёт банковскую часть
  // от еды, Direct — остаток. Разность (а не второй round) гарантирует
  // инвариант суммы частей.
  const restaurantBankFeeCents = bankFeeOfCents(input.foodSubtotalCents);
  const directBankFeeCents = totalBankFeeCents - restaurantBankFeeCents;
  if (directBankFeeCents < 0) {
    // Возможно только при вырожденном округлении; fail-closed вместо
    // отрицательной доли Direct.
    return fail("Распределение банковской комиссии некорректно.");
  }
  return {
    ok: true,
    fee: {
      totalBankFeeCents,
      restaurantBankFeeCents,
      directBankFeeCents,
    },
  };
}
