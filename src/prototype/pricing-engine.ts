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
