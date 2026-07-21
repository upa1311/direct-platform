import type { DeliveryMode } from "./pricing-engine";
import type { RestaurantFinancialCollectionMode } from "./models";

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

/**
 * Историческая константа ставки. Оставлена ТОЛЬКО как часть публикации правила
 * V1 (см. financial-rule) и для совместимости существующих ссылок: неявным
 * источником ставки для исторического расчёта она больше не является —
 * allocateBankFee получает ставку явно из снимка правила заказа.
 */
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
  /**
   * Ставка банковской комиссии из снимка финансового правила ЗАКАЗА.
   * Передаётся явно: глобальная константа неявным источником не является,
   * иначе смена ставки переписала бы исторические расчёты.
   */
  bankCardFeeRateBps: number;
  /**
   * Финансовый режим ЗАКАЗА (v13). Передаётся явно: распределение банковской
   * комиссии при доставке водителем Direct зависит от того, кто принял
   * карточный платёж, и косвенно по moneyCollector не выводится.
   */
  financialCollectionMode: RestaurantFinancialCollectionMode;
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

/** Комиссия по ПЕРЕДАННОЙ ставке (базисные пункты), с округлением до цента. */
function bankFeeOfCents(amountCents: number, rateBps: number): number {
  return Math.round((amountCents * rateBps) / 10_000);
}

/** Ставка правила: целые положительные базисные пункты. */
function isValidRateBps(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value > 0
  );
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
 * - PLATFORM_DRIVER: получатель зависит от финансового режима заказа —
 *   MIXED_COLLECTION собирает Direct, RESTAURANT_COLLECTS_ALL — ресторан;
 *   CARD (онлайн) или CASH.
 * - PICKUP: деньги собирает ресторан на точке; CARD или CASH.
 * - RESTAURANT_DELIVERY: только наличные собственному курьеру ресторана;
 *   онлайн-оплата для этого канала НЕ существует и отклоняется.
 */
function validateCombination(input: BankFeeInput): string | null {
  const { deliveryMode, moneyCollector, paymentInstrument } = input;
  if (deliveryMode === "PLATFORM_DRIVER") {
    const expected =
      input.financialCollectionMode === "RESTAURANT_COLLECTS_ALL"
        ? "RESTAURANT"
        : "DIRECT";
    if (moneyCollector !== expected) {
      return expected === "DIRECT"
        ? "При доставке водителем Direct деньги клиента собирает Direct."
        : "В этом режиме платежи по доставке Direct получает ресторан.";
    }
    return null;
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
 * Распределение банковской комиссии карточной транзакции по ставке ЗАКАЗА
 * (bankCardFeeRateBps из снимка его финансового правила).
 *
 * Правила:
 * - наличные (любой допустимый канал): банковской комиссии нет — все суммы 0;
 * - доставка водителем Direct + MIXED_COLLECTION (платёж принимает Direct):
 *   банк удерживает комиссию со всей транзакции; ресторан несёт долю от еды,
 *   Direct — остаток (его доставка, small-order fee и прочие компоненты);
 * - доставка водителем Direct + RESTAURANT_COLLECTS_ALL (платёж принимает
 *   ресторан): всю комиссию несёт ресторан, доля Direct — 0;
 * - самовывоз + карта на точке: всю комиссию несёт ресторан (она уменьшает его
 *   чистый доход и НЕ увеличивает долг перед Direct), Direct — 0.
 *
 * Инвариант: restaurantBankFeeCents + directBankFeeCents === totalBankFeeCents.
 * Входные данные валидируются fail-closed: нецелые/отрицательные/бесконечные
 * суммы, еда больше транзакции и невозможные комбинации режима и оплаты
 * возвращают ошибку, а не правдоподобный ноль.
 */
export function allocateBankFee(input: BankFeeInput): BankFeeResult {
  // Fail-closed по каналу оплаты ДО любого расчёта: повреждённое значение
  // (например, "BONUS") не должно молча обрабатываться как карта. Fallback
  // «всё, что не CASH, — это CARD» запрещён.
  if (
    input.paymentInstrument !== "CARD" &&
    input.paymentInstrument !== "CASH"
  ) {
    return fail("Неизвестный канал оплаты.");
  }
  if (!isValidRateBps(input.bankCardFeeRateBps)) {
    return fail("Некорректная ставка банковской комиссии.");
  }
  if (
    input.financialCollectionMode !== "MIXED_COLLECTION" &&
    input.financialCollectionMode !== "RESTAURANT_COLLECTS_ALL"
  ) {
    return fail("Неизвестный финансовый режим ресторана.");
  }
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

  const totalBankFeeCents = bankFeeOfCents(
    input.customerTotalCents,
    input.bankCardFeeRateBps,
  );

  // Карточный платёж принимает ресторан — вся комиссия его: самовывоз на
  // точке, а также доставка водителем Direct в режиме RESTAURANT_COLLECTS_ALL
  // (банк удерживает комиссию у стороны, принявшей платёж).
  if (
    input.deliveryMode === "PICKUP" ||
    input.financialCollectionMode === "RESTAURANT_COLLECTS_ALL"
  ) {
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
  const restaurantBankFeeCents = bankFeeOfCents(
    input.foodSubtotalCents,
    input.bankCardFeeRateBps,
  );
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
