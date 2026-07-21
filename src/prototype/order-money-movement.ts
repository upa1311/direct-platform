import {
  addChecked,
  allocateBankFee,
  isSafeCents,
  subtractChecked,
} from "./bank-fee";
import type {
  BankFeeMoneyCollector,
  BankFeePaymentInstrument,
} from "./bank-fee";
import type { DeliveryMode } from "./pricing-engine";
import {
  validateFinancialRuleSnapshot,
  type FinancialRuleSnapshot,
} from "./financial-rule";
import type { RestaurantFinancialCollectionMode } from "./models";

// Канонический чистый расчёт движения денег по ОДНОМУ заказу.
//
// Модуль не зависит от React, состояния прототипа и localStorage; значения
// импортируются только из таких же чистых модулей, поэтому он запускается
// напрямую через `node --test` без сборки.
//
// Зона ответственности — СВЕДЕНИЕ уже рассчитанных сумм заказа в единый
// результат: кто получил деньги клиента, банковские части (ТОЛЬКО через
// существующий allocateBankFee — формула 1% здесь не дублируется), взаимные
// обязательства ресторана и Direct и чистые итоги сторон. Комиссия Direct,
// small-order fee, стоимость доставки и суммы заказа рассчитываются
// существующим pricing-engine и приходят готовыми; функция ничего в них не
// меняет — клиентская сумма из-за этого расчёта не изменяется.

/** Кто фактически получил деньги клиента. */
export type CustomerMoneyRecipient = "DIRECT" | "RESTAURANT";

/**
 * Фактический канал оплаты заказа. Отдельное понятие: канал не выводится ни из
 * способа получения, ни из получателя денег.
 */
export type OrderPaymentChannel =
  /** Онлайн-карта, деньги получает Direct (MIXED_COLLECTION). */
  | "ONLINE_CARD"
  /** Онлайн-карта, деньги получает ресторан (RESTAURANT_COLLECTS_ALL). */
  | "ONLINE_CARD_TO_RESTAURANT"
  | "CARD_AT_RESTAURANT"
  | "CASH_AT_RESTAURANT"
  | "CASH_TO_RESTAURANT_COURIER";

/** Уже рассчитанные суммы одного заказа (pricing-engine) и канал оплаты. */
export interface OrderMoneyMovementInput {
  deliveryMode: DeliveryMode;
  paymentChannel: OrderPaymentChannel;
  /** Стоимость еды после скидок, целые центы. */
  foodSubtotalCents: number;
  /** Стоимость доставки, целые центы (0 для самовывоза). */
  deliveryFeeCents: number;
  /** Доплата за небольшой заказ (существует только у доставки Direct). */
  smallOrderFeeCents: number;
  /** Полная сумма клиента, целые центы. */
  customerTotalCents: number;
  /** Уже рассчитанная комиссия Direct (15%/7% от еды), целые центы. */
  restaurantCommissionCents: number;
  /**
   * Выплата водителю Direct. Для PLATFORM_DRIVER поле ОБЯЗАТЕЛЬНО и обязано
   * равняться deliveryFeeCents: стоимость доставки водителем Direct полностью
   * получает водитель. Для PICKUP и RESTAURANT_DELIVERY выплаты водителю
   * Direct не существует — поле отсутствует либо явно равно 0 (собственного
   * курьера оплачивает ресторан вне Direct). Контрольный входной инвариант:
   * в формулы чистых итогов не входит и в канонический результат не попадает.
   */
  driverPayoutCents?: number;
  /**
   * Снимок финансового правила ЗАКАЗА: банковские суммы считаются по его
   * ставке. Активное правило внутри чистой функции не подставляется — иначе
   * исторический заказ пересчитался бы по сегодняшним константам.
   */
  financialRule: FinancialRuleSnapshot;
  /**
   * Финансовый режим ЗАКАЗА (v13). Обязателен: функция не читает текущий
   * Restaurant, не выводит режим из канала и не использует fallback.
   */
  financialCollectionMode: RestaurantFinancialCollectionMode;
}

/** Единый канонический результат движения денег по заказу. */
export interface OrderMoneyMovement {
  customerMoneyRecipient: CustomerMoneyRecipient;
  paymentChannel: OrderPaymentChannel;
  totalBankFeeCents: number;
  restaurantBankFeeCents: number;
  directBankFeeCents: number;
  restaurantOwesDirectCents: number;
  directOwesRestaurantCents: number;
  restaurantNetCents: number;
  directNetRevenueCents: number;
}

/** Fail-closed результат: повреждённые данные не маскируются нулями. */
export type OrderMoneyMovementResult =
  | { ok: true; movement: OrderMoneyMovement }
  | { ok: false; error: string };

function fail(error: string): OrderMoneyMovementResult {
  return { ok: false, error };
}

/**
 * Денежные validator и checked-арифметика — единые для всего финансового
 * контура (объявлены в bank-fee, чтобы обе функции считали по одним правилам).
 */
function isValidCents(value: number): boolean {
  return isSafeCents(value);
}

const KNOWN_DELIVERY_MODES: readonly DeliveryMode[] = [
  "PLATFORM_DRIVER",
  "RESTAURANT_DELIVERY",
  "PICKUP",
];

const KNOWN_PAYMENT_CHANNELS: readonly OrderPaymentChannel[] = [
  "ONLINE_CARD",
  "ONLINE_CARD_TO_RESTAURANT",
  "CARD_AT_RESTAURANT",
  "CASH_AT_RESTAURANT",
  "CASH_TO_RESTAURANT_COURIER",
];

/**
 * Совместимость режима получения, финансового режима и канала оплаты:
 * - PLATFORM_DRIVER + MIXED_COLLECTION — только ONLINE_CARD (деньги получает
 *   Direct);
 * - PLATFORM_DRIVER + RESTAURANT_COLLECTS_ALL — только
 *   ONLINE_CARD_TO_RESTAURANT (деньги получает ресторан);
 * - PICKUP — карта или наличные на точке в обоих режимах (получает ресторан);
 * - RESTAURANT_DELIVERY — только наличные собственному курьеру в обоих
 *   режимах; карта/онлайн для этого канала не существуют.
 * Любая другая комбинация отклоняется fail-closed.
 */
function resolveChannelContext(
  deliveryMode: DeliveryMode,
  paymentChannel: OrderPaymentChannel,
  financialCollectionMode: RestaurantFinancialCollectionMode,
):
  | {
      recipient: CustomerMoneyRecipient;
      collector: BankFeeMoneyCollector;
      instrument: BankFeePaymentInstrument;
    }
  | string {
  if (deliveryMode === "PLATFORM_DRIVER") {
    if (financialCollectionMode === "RESTAURANT_COLLECTS_ALL") {
      return paymentChannel === "ONLINE_CARD_TO_RESTAURANT"
        ? { recipient: "RESTAURANT", collector: "RESTAURANT", instrument: "CARD" }
        : "В этом режиме онлайн-платёж по доставке Direct получает ресторан.";
    }
    return paymentChannel === "ONLINE_CARD"
      ? { recipient: "DIRECT", collector: "DIRECT", instrument: "CARD" }
      : "Для доставки водителем Direct поддерживается только онлайн-оплата картой.";
  }
  if (deliveryMode === "PICKUP") {
    if (paymentChannel === "CARD_AT_RESTAURANT") {
      return { recipient: "RESTAURANT", collector: "RESTAURANT", instrument: "CARD" };
    }
    if (paymentChannel === "CASH_AT_RESTAURANT") {
      return { recipient: "RESTAURANT", collector: "RESTAURANT", instrument: "CASH" };
    }
    return "Для самовывоза оплата принимается только на точке ресторана.";
  }
  // RESTAURANT_DELIVERY.
  return paymentChannel === "CASH_TO_RESTAURANT_COURIER"
    ? { recipient: "RESTAURANT", collector: "RESTAURANT", instrument: "CASH" }
    : "Для собственного курьера ресторана поддерживаются только наличные при получении.";
}

/**
 * Канонический расчёт движения денег по заказу.
 *
 * Правила текущей модели:
 * - самовывоз (карта/наличные): деньги получает ресторан; он должен Direct
 *   уже рассчитанную комиссию; банковский 1% карты целиком его и НЕ
 *   увеличивает долг перед Direct;
 * - доставка собственным курьером ресторана (только наличные): деньги и
 *   стоимость доставки остаются ресторану; ресторан должен Direct комиссию;
 * - доставка водителем Direct + MIXED_COLLECTION (онлайн-карта Direct): деньги
 *   получает Direct; Direct должен ресторану еду за вычетом комиссии и
 *   банковской части ресторана; стоимость доставки предназначена водителю и НЕ
 *   является доходом Direct; чистый доход Direct — комиссия + small-order fee
 *   минус банковская часть Direct;
 * - доставка водителем Direct + RESTAURANT_COLLECTS_ALL (онлайн-карта
 *   ресторану): деньги получает ресторан и перечисляет Direct комиссию +
 *   стоимость доставки + small-order fee; доставка проходит транзитом к
 *   водителю и в доход Direct не входит; вся банковская комиссия у ресторана.
 *
 * Инварианты: банковские части сходятся с общей комиссией (гарантирует
 * allocateBankFee); у одного обычного заказа не бывают одновременно
 * положительными restaurantOwesDirectCents и directOwesRestaurantCents;
 * все результаты — целые неотрицательные центы. Повреждённые данные
 * (неизвестные enum, дробные/отрицательные суммы, расходящиеся суммы,
 * small-order fee вне доставки Direct, комиссия больше еды, отрицательный
 * чистый результат) отклоняются с доменной ошибкой, а не нулями.
 */
export function computeOrderMoneyMovement(
  input: OrderMoneyMovementInput,
): OrderMoneyMovementResult {
  if (!KNOWN_DELIVERY_MODES.includes(input.deliveryMode)) {
    return fail("Неизвестный режим получения заказа.");
  }
  if (!KNOWN_PAYMENT_CHANNELS.includes(input.paymentChannel)) {
    return fail("Неизвестный канал оплаты заказа.");
  }
  // Финансовый режим заказа обязателен и не выводится из канала.
  if (
    input.financialCollectionMode !== "MIXED_COLLECTION" &&
    input.financialCollectionMode !== "RESTAURANT_COLLECTS_ALL"
  ) {
    return fail("Неизвестный финансовый режим ресторана.");
  }
  // Правило заказа обязано быть валидным снимком известной версии: без него
  // банковские суммы считать нечем, подстановка активного правила запрещена.
  const ruleResult = validateFinancialRuleSnapshot(input.financialRule);
  if (!ruleResult.ok) {
    return fail(ruleResult.error);
  }

  const sums: readonly [string, number][] = [
    ["стоимость еды", input.foodSubtotalCents],
    ["стоимость доставки", input.deliveryFeeCents],
    ["доплата за небольшой заказ", input.smallOrderFeeCents],
    ["сумма клиента", input.customerTotalCents],
    ["комиссия Direct", input.restaurantCommissionCents],
  ];
  for (const [label, value] of sums) {
    if (!isValidCents(value)) {
      return fail(`Некорректная сумма (${label}): нужны целые неотрицательные центы.`);
    }
  }
  if (input.driverPayoutCents !== undefined && !isValidCents(input.driverPayoutCents)) {
    return fail("Некорректная сумма (выплата водителю): нужны целые неотрицательные центы.");
  }
  // Инвариант выплаты водителю. PLATFORM_DRIVER: стоимость доставки полностью
  // получает водитель Direct — поле обязательно и равно deliveryFeeCents
  // (0 допустим только при бесплатной доставке). PICKUP/RESTAURANT_DELIVERY:
  // водителя Direct в заказе нет — допускается только отсутствие поля или 0.
  if (input.deliveryMode === "PLATFORM_DRIVER") {
    if (input.driverPayoutCents === undefined) {
      return fail("Для доставки водителем Direct выплата водителю обязательна.");
    }
    if (input.driverPayoutCents !== input.deliveryFeeCents) {
      return fail(
        "Выплата водителю Direct должна равняться стоимости доставки.",
      );
    }
  } else if (
    input.driverPayoutCents !== undefined &&
    input.driverPayoutCents !== 0
  ) {
    return fail("В этом заказе не участвует водитель Direct — выплаты быть не должно.");
  }

  if (input.foodSubtotalCents > input.customerTotalCents) {
    return fail("Стоимость еды не может превышать сумму клиента.");
  }
  if (input.restaurantCommissionCents > input.foodSubtotalCents) {
    return fail("Комиссия Direct не может превышать стоимость еды.");
  }
  if (input.deliveryMode !== "PLATFORM_DRIVER" && input.smallOrderFeeCents !== 0) {
    return fail(
      "Доплата за небольшой заказ существует только у доставки водителем Direct.",
    );
  }

  const context = resolveChannelContext(
    input.deliveryMode,
    input.paymentChannel,
    input.financialCollectionMode,
  );
  if (typeof context === "string") {
    return fail(context);
  }

  // Согласованность уже рассчитанных сумм текущей модели: расхождение — это
  // повреждённые данные, а не повод молча выдать правдоподобный результат.
  // Сложение проверенное: выход за безопасный диапазон — отдельная доменная
  // ошибка, а не «суммы не сошлись».
  const expectedTotal =
    input.deliveryMode === "PICKUP"
      ? input.foodSubtotalCents
      : input.deliveryMode === "RESTAURANT_DELIVERY"
        ? addChecked(input.foodSubtotalCents, input.deliveryFeeCents)
        : addChecked(
            addChecked(input.foodSubtotalCents, input.deliveryFeeCents),
            input.smallOrderFeeCents,
          );
  if (input.deliveryMode === "PICKUP" && input.deliveryFeeCents !== 0) {
    return fail("У самовывоза не бывает стоимости доставки.");
  }
  if (expectedTotal === null) {
    return fail("Суммы заказа выходят за безопасный диапазон.");
  }
  if (expectedTotal !== input.customerTotalCents) {
    return fail("Суммы заказа не сходятся с суммой клиента.");
  }

  // Банковская математика — ТОЛЬКО существующий канонический расчёт.
  const bank = allocateBankFee({
    deliveryMode: input.deliveryMode,
    moneyCollector: context.collector,
    paymentInstrument: context.instrument,
    foodSubtotalCents: input.foodSubtotalCents,
    customerTotalCents: input.customerTotalCents,
    // Ставка — из снимка правила заказа, не из глобальной константы.
    bankCardFeeRateBps: ruleResult.rule.bankCardFeeRateBps,
    financialCollectionMode: input.financialCollectionMode,
  });
  if (!bank.ok) {
    return fail(bank.error);
  }
  const { totalBankFeeCents, restaurantBankFeeCents, directBankFeeCents } =
    bank.fee;

  // Все итоги считаются checked-арифметикой: null означает выход за
  // безопасный диапазон ИЛИ отрицательный промежуточный результат.
  let restaurantOwesDirectCents: number | null;
  let directOwesRestaurantCents: number | null;
  let restaurantNetCents: number | null;
  let directNetRevenueCents: number | null;

  if (
    input.deliveryMode === "PLATFORM_DRIVER" &&
    input.financialCollectionMode === "RESTAURANT_COLLECTS_ALL"
  ) {
    // Деньги у ресторана, доставку выполняет водитель Direct: ресторан
    // перечисляет Direct комиссию, стоимость доставки (её Direct выплатит
    // водителю) и доплату за небольшой заказ. Стоимость доставки проходит
    // через Direct транзитом и доходом Direct НЕ является. Вся банковская
    // комиссия у ресторана — карточный платёж принял он.
    const remittance = addChecked(
      addChecked(input.restaurantCommissionCents, input.deliveryFeeCents),
      input.smallOrderFeeCents,
    );
    const revenue = addChecked(
      input.restaurantCommissionCents,
      input.smallOrderFeeCents,
    );
    restaurantOwesDirectCents = remittance;
    directOwesRestaurantCents = 0;
    restaurantNetCents = subtractChecked(
      subtractChecked(input.customerTotalCents, remittance),
      restaurantBankFeeCents,
    );
    directNetRevenueCents = subtractChecked(revenue, directBankFeeCents);
  } else if (input.deliveryMode === "PLATFORM_DRIVER") {
    // Деньги у Direct: он должен ресторану еду за вычетом комиссии и
    // банковской части ресторана; доставка предназначена водителю.
    restaurantOwesDirectCents = 0;
    directOwesRestaurantCents = subtractChecked(
      subtractChecked(
        input.foodSubtotalCents,
        input.restaurantCommissionCents,
      ),
      restaurantBankFeeCents,
    );
    restaurantNetCents = directOwesRestaurantCents;
    directNetRevenueCents = subtractChecked(
      addChecked(input.restaurantCommissionCents, input.smallOrderFeeCents),
      directBankFeeCents,
    );
  } else {
    // Деньги у ресторана (самовывоз или собственный курьер): он должен Direct
    // комиссию; банковская комиссия карты уменьшает ЕГО чистый доход и долг
    // перед Direct не увеличивает; стоимость собственной доставки остаётся
    // ресторану (оплата его курьера — вне Direct).
    restaurantOwesDirectCents = input.restaurantCommissionCents;
    directOwesRestaurantCents = 0;
    restaurantNetCents = subtractChecked(
      subtractChecked(
        input.customerTotalCents,
        input.restaurantCommissionCents,
      ),
      restaurantBankFeeCents,
    );
    directNetRevenueCents = input.restaurantCommissionCents;
  }

  const results: readonly [string, number | null][] = [
    ["restaurantOwesDirectCents", restaurantOwesDirectCents],
    ["directOwesRestaurantCents", directOwesRestaurantCents],
    ["restaurantNetCents", restaurantNetCents],
    ["directNetRevenueCents", directNetRevenueCents],
  ];
  for (const [label, value] of results) {
    if (value === null || !isValidCents(value)) {
      return fail(`Невозможный отрицательный или нецелый результат (${label}).`);
    }
  }
  // После проверки выше каждое значение — безопасные неотрицательные центы.
  const owes = restaurantOwesDirectCents as number;
  const owed = directOwesRestaurantCents as number;
  const restaurantNet = restaurantNetCents as number;
  const directRevenue = directNetRevenueCents as number;
  // Взаимные обязательства одного обычного заказа не бывают встречными.
  if (owes > 0 && owed > 0) {
    return fail("Встречные обязательства по одному заказу невозможны.");
  }

  return {
    ok: true,
    movement: {
      customerMoneyRecipient: context.recipient,
      paymentChannel: input.paymentChannel,
      totalBankFeeCents,
      restaurantBankFeeCents,
      directBankFeeCents,
      restaurantOwesDirectCents: owes,
      directOwesRestaurantCents: owed,
      restaurantNetCents: restaurantNet,
      directNetRevenueCents: directRevenue,
    },
  };
}
