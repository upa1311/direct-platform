import type { ZoneId } from "./models";

// Чистые функции коммерческой логики Direct.
//
// Модуль сознательно не зависит от React, состояния прототипа или
// localStorage. Он использует только `import type` (стирается в рантайме),
// поэтому его можно запускать напрямую через `node --test` без сборки.
//
// Здесь сосредоточены правила, зафиксированные в docs/pricing-and-finance.md
// и docs/decision-log.md: выбор фактического режима доставки, доплата за
// размер, структурированная акция «3+1», собственная доставка ресторана и
// два финансовых снимка (DIRECT и RESTAURANT).

/** Клиентский выбор способа получения. Клиент не выбирает исполнителя. */
export type FulfillmentChoice = "DELIVERY" | "PICKUP";

/** Кто фактически доставляет заказ выбранного ресторана. */
export type RestaurantDeliveryProvider = "DIRECT" | "RESTAURANT";

/** Фактический режим заказа, вычисляемый системой. */
export type DeliveryMode =
  | "PLATFORM_DRIVER"
  | "RESTAURANT_DELIVERY"
  | "PICKUP";

/**
 * Правило выбора фактического режима доставки.
 *
 * - PICKUP всегда остаётся PICKUP;
 * - DELIVERY + ресторан с водителями Direct → PLATFORM_DRIVER;
 * - DELIVERY + ресторан со своим курьером → RESTAURANT_DELIVERY.
 *
 * Клиент никогда не выбирает RESTAURANT_DELIVERY напрямую.
 */
export function resolveDeliveryMode(
  deliveryProvider: RestaurantDeliveryProvider,
  fulfillmentChoice: FulfillmentChoice,
): DeliveryMode {
  if (fulfillmentChoice === "PICKUP") {
    return "PICKUP";
  }
  return deliveryProvider === "RESTAURANT"
    ? "RESTAURANT_DELIVERY"
    : "PLATFORM_DRIVER";
}

/** Деньги всегда целые минимальные единицы валюты. */
export function roundMoneyCents(value: number): number {
  return Math.round(value);
}

/** Итоговая цена единицы блюда с учётом доплаты за выбранный размер. */
export function computeVariantUnitPriceCents(
  baseUnitPriceCents: number,
  variantPriceDeltaCents: number,
): number {
  return baseUnitPriceCents + variantPriceDeltaCents;
}

/** Параметры структурированной акции «купи N — получи M дешёвых бесплатно». */
export interface PromotionConfig {
  buyQuantity: number;
  freeQuantity: number;
  repeat: boolean;
}

/**
 * Сколько единиц становятся бесплатными.
 *
 * Размер группы = buyQuantity + freeQuantity. Для «3+1» это 4, поэтому
 * freeCount = floor(total / 4) * 1: 1–3 → 0, 4–7 → 1, 8–11 → 2, 12–15 → 3.
 * При repeat === false акция срабатывает не более одного раза.
 */
export function computeFreeUnitCount(
  totalEligibleUnits: number,
  config: PromotionConfig,
): number {
  const groupSize = config.buyQuantity + config.freeQuantity;
  if (
    groupSize <= 0 ||
    config.freeQuantity <= 0 ||
    totalEligibleUnits < groupSize
  ) {
    return 0;
  }
  const groups = config.repeat ? Math.floor(totalEligibleUnits / groupSize) : 1;
  return groups * config.freeQuantity;
}

/**
 * Сколько ещё ПЛАТНЫХ участвующих единиц нужно добавить до следующей бесплатной.
 * Клиентский показатель прогресса; формулу самой акции (computeFreeUnitCount,
 * распределение скидки) НЕ меняет.
 *
 * Для «3+1» (groupSize = 4, freeQuantity = 1): 1 → 2, 2 → 1, 3 → 0, 4 → 3,
 * 5 → 2, 6 → 1, 7 → 0, 8 → 3. Значение 0 означает «следующая — бесплатная».
 * Возвращает null, если участвующих единиц нет или акция некорректна.
 */
export function computePaidUnitsBeforeNextFree(
  totalEligibleUnits: number,
  config: PromotionConfig,
): number | null {
  const groupSize = config.buyQuantity + config.freeQuantity;
  if (groupSize <= 0 || config.freeQuantity <= 0 || totalEligibleUnits <= 0) {
    return null;
  }
  // Неповторяющаяся акция срабатывает не более одного раза. Как только первая
  // группа набрана, следующего подарка не будет — прогресс не показываем.
  if (!config.repeat && totalEligibleUnits >= groupSize) {
    return null;
  }
  const remainder = totalEligibleUnits % groupSize;
  const unitsToNextGroup = remainder === 0 ? groupSize : groupSize - remainder;
  // Из оставшихся до группы единиц freeQuantity станут бесплатными.
  return Math.max(0, unitsToNextGroup - config.freeQuantity);
}

/**
 * Сумма скидки по акции.
 *
 * Бесплатной становится только БАЗОВАЯ стоимость самых дешёвых участвующих
 * единиц. Доплата за размер «Большая» в массив не входит и остаётся платной,
 * поэтому акция никогда не обнуляет surcharge большого размера.
 *
 * `eligibleBaseUnitPricesCents` — по одной записи на каждую участвующую
 * единицу (позиция, развёрнутая по количеству), содержащая только базовую цену.
 */
export function computePromotionDiscountCents(
  eligibleBaseUnitPricesCents: number[],
  config: PromotionConfig,
): number {
  const freeCount = computeFreeUnitCount(
    eligibleBaseUnitPricesCents.length,
    config,
  );
  if (freeCount <= 0) {
    return 0;
  }
  const cheapestFirst = [...eligibleBaseUnitPricesCents].sort((a, b) => a - b);
  return cheapestFirst
    .slice(0, freeCount)
    .reduce((total, cents) => total + cents, 0);
}

/** Собственные условия доставки ресторана типа RESTAURANT. */
export interface RestaurantDeliverySettings {
  minimumOrderCents: number;
  freeDeliveryThresholdCents: number | null;
  servedZoneIds: ZoneId[];
  zoneFeesCents: Partial<Record<ZoneId, number>>;
}

export type RestaurantDeliveryQuote =
  | {
      status: "OK";
      deliveryFeeCents: number;
      standardFeeCents: number;
      freeDelivery: boolean;
    }
  | { status: "BELOW_MINIMUM"; missingCents: number }
  | { status: "ZONE_NOT_SERVED" };

/**
 * Расчёт собственной доставки ресторана по зоне клиента.
 *
 * Минимальная сумма и порог бесплатной доставки считаются только от
 * `foodSubtotalCents` (после скидок), без учёта доставки. Минимум применяется
 * только к RESTAURANT_DELIVERY, но не к PICKUP (для самовывоза эту функцию
 * вызывать не нужно).
 */
export function computeRestaurantDeliveryQuote(
  foodSubtotalCents: number,
  settings: RestaurantDeliverySettings,
  customerZoneId: ZoneId | null,
): RestaurantDeliveryQuote {
  const zoneFee =
    customerZoneId && settings.servedZoneIds.includes(customerZoneId)
      ? settings.zoneFeesCents[customerZoneId]
      : undefined;

  if (!customerZoneId || zoneFee === undefined) {
    return { status: "ZONE_NOT_SERVED" };
  }

  if (foodSubtotalCents < settings.minimumOrderCents) {
    return {
      status: "BELOW_MINIMUM",
      missingCents: settings.minimumOrderCents - foodSubtotalCents,
    };
  }

  const freeDelivery =
    settings.freeDeliveryThresholdCents !== null &&
    foodSubtotalCents >= settings.freeDeliveryThresholdCents;

  return {
    status: "OK",
    deliveryFeeCents: freeDelivery ? 0 : zoneFee,
    standardFeeCents: zoneFee,
    freeDelivery,
  };
}

/** Единый результат финансового расчёта заказа. */
export interface FinancialsBreakdown {
  restaurantCommissionCents: number;
  smallOrderFeeCents: number;
  deliveryFeeCents: number;
  platformGrossRevenueCents: number;
  driverPayoutCents: number;
  restaurantPayoutBeforeBankFeeCents: number;
  customerTotalCents: number;
}

export interface DirectFinancialsInput {
  /** Стоимость еды после акции и с учётом доплат за размер. */
  foodSubtotalCents: number;
  commissionRateBps: number;
  minimumPlatformGrossRevenueCents: number;
  /** 0 для PICKUP, тариф матрицы Direct для PLATFORM_DRIVER. */
  deliveryFeeCents: number;
  isPickup: boolean;
}

/**
 * Финансовый снимок ресторана типа DIRECT (Ресторан 1 и Ресторан 2):
 * комиссия Direct, действующая доплата за небольшой заказ, выплата водителю
 * Direct равна стоимости доставки. Для PICKUP доставка и выплата равны нулю.
 */
export function computeDirectFinancials(
  input: DirectFinancialsInput,
): FinancialsBreakdown {
  const restaurantCommissionCents = roundMoneyCents(
    (input.foodSubtotalCents * input.commissionRateBps) / 10_000,
  );
  const smallOrderFeeCents = Math.max(
    0,
    input.minimumPlatformGrossRevenueCents - restaurantCommissionCents,
  );
  const deliveryFeeCents = input.isPickup ? 0 : input.deliveryFeeCents;
  const platformGrossRevenueCents =
    restaurantCommissionCents + smallOrderFeeCents;

  return {
    restaurantCommissionCents,
    smallOrderFeeCents,
    deliveryFeeCents,
    platformGrossRevenueCents,
    driverPayoutCents: input.isPickup ? 0 : deliveryFeeCents,
    restaurantPayoutBeforeBankFeeCents:
      input.foodSubtotalCents - restaurantCommissionCents,
    customerTotalCents:
      input.foodSubtotalCents + deliveryFeeCents + smallOrderFeeCents,
  };
}

export interface RestaurantDeliveryFinancialsInput {
  /** Стоимость еды после скидок и с учётом доплат за размер. */
  foodSubtotalCents: number;
  commissionRateBps: number;
  /** Уже рассчитанный тариф (0 для PICKUP или при бесплатной доставке). */
  deliveryFeeCents: number;
  isPickup: boolean;
}

/**
 * Финансовый снимок ресторана типа RESTAURANT (Ресторан 3):
 * комиссия Direct 7%, доплата Direct за небольшой заказ не применяется,
 * Direct не выплачивает собственного курьера. Собственная стоимость доставки
 * остаётся ресторану.
 */
export function computeRestaurantDeliveryFinancials(
  input: RestaurantDeliveryFinancialsInput,
): FinancialsBreakdown {
  const restaurantCommissionCents = roundMoneyCents(
    (input.foodSubtotalCents * input.commissionRateBps) / 10_000,
  );
  const deliveryFeeCents = input.isPickup ? 0 : input.deliveryFeeCents;

  return {
    restaurantCommissionCents,
    smallOrderFeeCents: 0,
    deliveryFeeCents,
    platformGrossRevenueCents: restaurantCommissionCents,
    driverPayoutCents: 0,
    restaurantPayoutBeforeBankFeeCents:
      input.foodSubtotalCents - restaurantCommissionCents + deliveryFeeCents,
    customerTotalCents: input.foodSubtotalCents + deliveryFeeCents,
  };
}

export interface PickupSettlementInput {
  /** Стоимость еды после скидок. */
  foodSubtotalCents: number;
  /** Комиссия Direct за самовывоз, bps (по умолчанию 1500 = 15%). */
  commissionRateBps: number;
  /** Действующая доплата за небольшой заказ (текущее поведение PICKUP). */
  smallOrderFeeCents: number;
}

export interface PickupSettlement {
  restaurantCommissionCents: number;
  customerTotalCents: number;
  /** Деньги клиента собирает ресторан на точке. */
  restaurantCollectedFromCustomerCents: number;
  /** Direct не удерживает клиентский платёж при самовывозе. */
  platformCollectedFromCustomerCents: number;
  /** Сколько ресторан должен Direct: комиссия + small-order fee, если есть. */
  platformCommissionReceivableCents: number;
  restaurantNetAfterPlatformCommissionCents: number;
}

/**
 * Финансовая модель самовывоза: клиент платит ресторану на точке, Direct
 * зарабатывает комиссию (и small-order fee, если применяется), которая
 * становится задолженностью ресторана перед Direct только после выдачи.
 */
export function computePickupSettlement(
  input: PickupSettlementInput,
): PickupSettlement {
  const restaurantCommissionCents = roundMoneyCents(
    (input.foodSubtotalCents * input.commissionRateBps) / 10_000,
  );
  // Доставка при самовывозе равна нулю.
  const customerTotalCents = input.foodSubtotalCents + input.smallOrderFeeCents;
  const platformCommissionReceivableCents =
    restaurantCommissionCents + input.smallOrderFeeCents;
  return {
    restaurantCommissionCents,
    customerTotalCents,
    restaurantCollectedFromCustomerCents: customerTotalCents,
    platformCollectedFromCustomerCents: 0,
    platformCommissionReceivableCents,
    restaurantNetAfterPlatformCommissionCents:
      customerTotalCents - platformCommissionReceivableCents,
  };
}

export const PICKUP_PAYMENT_REQUIRED_MESSAGE =
  "Для самовывоза выберите оплату наличными, картой или оба способа.";

/**
 * Доменная проверка: включённый самовывоз обязан иметь хотя бы один способ
 * оплаты на точке. Возвращает текст ошибки или null.
 */
export function validatePickupPayment(
  pickupEnabled: boolean,
  pickupPaymentMethods: readonly string[],
): string | null {
  if (pickupEnabled && pickupPaymentMethods.length === 0) {
    return PICKUP_PAYMENT_REQUIRED_MESSAGE;
  }
  return null;
}

/**
 * Детерминированный 4-значный код выдачи самовывоза из номера заказа.
 * В прототипе достаточно детерминированного значения; реальная система
 * должна использовать криптографически стойкий одноразовый код.
 */
export function generatePickupCode(orderNumber: number): string {
  const code = ((Math.abs(Math.trunc(orderNumber)) * 7919 + 1234) % 9000) + 1000;
  return String(code);
}

/**
 * Нужно ли автоматически подтвердить адрес при открытии ресторана.
 * Только для доставки с валидным (известным) адресом, ещё не подтверждённым.
 * Для самовывоза и невалидного адреса — false.
 */
export function shouldAutoConfirmAddress(params: {
  fulfillmentChoice: FulfillmentChoice;
  isAddressConfirmed: boolean;
  hasValidAddress: boolean;
}): boolean {
  return (
    params.fulfillmentChoice === "DELIVERY" &&
    !params.isAddressConfirmed &&
    params.hasValidAddress
  );
}

/**
 * Миграция клиентского способа получения из schema v4 в v5.
 * Старый `PICKUP` остаётся самовывозом, всё остальное (PLATFORM_DRIVER,
 * null, неизвестное) становится доставкой по умолчанию.
 */
export function migrateFulfillmentChoice(
  oldDeliveryMode: unknown,
): FulfillmentChoice {
  return oldDeliveryMode === "PICKUP" ? "PICKUP" : "DELIVERY";
}

// --- Корректировка ожидаемого времени готовности (Кухня 3) ------------------

/** Минимум будущего ETA: не раньше чем через минуту от текущего момента. */
export const ETA_MIN_AHEAD_MS = 60_000;
/** Максимум будущего ETA: не дальше 180 минут от текущего момента. */
export const ETA_MAX_AHEAD_MS = 180 * 60_000;

/**
 * Новое ETA при задержке: прибавляет минуты к БАЗЕ, где база — максимум из
 * текущего expectedReadyAt и now (если ETA уже в прошлом). Чистая функция.
 */
export function computeDelayedEtaIso(
  currentExpectedReadyAt: string,
  addMinutes: number,
  nowIso: string,
): string {
  const base = Math.max(
    Date.parse(currentExpectedReadyAt),
    Date.parse(nowIso),
  );
  return new Date(base + addMinutes * 60_000).toISOString();
}

/** Новое ETA при более ранней готовности: вычитает минуты из текущего ETA. */
export function computeEarlierEtaIso(
  currentExpectedReadyAt: string,
  subtractMinutes: number,
): string {
  return new Date(
    Date.parse(currentExpectedReadyAt) - subtractMinutes * 60_000,
  ).toISOString();
}

/** ETA «через N минут от текущего момента». */
export function computeEtaFromNowIso(
  nowIso: string,
  minutesFromNow: number,
): string {
  return new Date(Date.parse(nowIso) + minutesFromNow * 60_000).toISOString();
}

/** Разница в минутах между новым и старым ETA (>0 задержка, <0 раньше). */
export function computeEtaDeltaMinutes(
  previousIso: string,
  nextIso: string,
): number {
  return Math.round((Date.parse(nextIso) - Date.parse(previousIso)) / 60_000);
}

/**
 * Валидация кандидата ETA относительно now (§3 п.6–8). Возвращает текст ошибки
 * или null. Единый источник границ и для domain-action, и для UI-предпроверки.
 */
export function validateEtaCandidate(
  candidateIso: string,
  nowIso: string,
): string | null {
  const candidateMs = Date.parse(candidateIso);
  if (Number.isNaN(candidateMs)) {
    return "Некорректная дата.";
  }
  const nowMs = Date.parse(nowIso);
  if (candidateMs <= nowMs) {
    return "Новое время должно быть в будущем.";
  }
  if (candidateMs < nowMs + ETA_MIN_AHEAD_MS) {
    return "Новое время должно быть не раньше чем через минуту.";
  }
  if (candidateMs > nowMs + ETA_MAX_AHEAD_MS) {
    return "Новое время не может быть позже чем через 180 минут.";
  }
  return null;
}
