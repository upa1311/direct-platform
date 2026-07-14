import type {
  AppliedPromotionSnapshot,
  CancellationRequest,
  CartItem,
  CartPricing,
  DeliveryAddress,
  DeliveryMode,
  DriverProfile,
  DriverStatus,
  MenuItem,
  MenuItemVariant,
  Order,
  OrderHistoryEvent,
  OrderStatus,
  PaymentMethod,
  PickupPaymentMethod,
  Promotion,
  PrototypeState,
  PublicationStatus,
  Restaurant,
  SettlementEntry,
  WeekdayId,
  ZoneId,
} from "./models";
import {
  getDefaultRecommendationRank,
  TEST_RESTAURANT_ID,
} from "./default-state";
import {
  computeDirectFinancials,
  computeFreeUnitCount,
  computePaidUnitsBeforeNextFree,
  computeRestaurantDeliveryFinancials,
  computeRestaurantDeliveryQuote,
  computeVariantUnitPriceCents,
  resolveDeliveryMode,
} from "./pricing-engine";

export type CatalogSort =
  | "RECOMMENDED"
  | "DELIVERY"
  | "PREPARATION"
  | "OPEN";

export interface CartItemView {
  cartItem: CartItem;
  menuItem: MenuItem;
  variant: MenuItemVariant | null;
  baseUnitPriceCents: number;
  variantDeltaCents: number;
  finalUnitPriceCents: number;
  quantity: number;
  /** Стоимость строки до скидки по акции, с учётом размера. */
  lineTotalCents: number;
  promotionDiscountCents: number;
}

export const deliveryModeLabels: Record<DeliveryMode, string> = {
  PLATFORM_DRIVER: "Доставка",
  RESTAURANT_DELIVERY: "Доставка ресторана",
  PICKUP: "Самовывоз",
};

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  ONLINE: "Оплата онлайн",
  CASH: "Наличные",
  PAY_AT_RESTAURANT: "Оплата в ресторане при получении",
  CASH_TO_RESTAURANT_COURIER: "Оплата наличными курьеру ресторана",
};

export const pickupPaymentMethodLabels: Record<PickupPaymentMethod, string> = {
  CASH: "Наличными",
  CARD: "Картой",
};

/** Строка способов оплаты на точке самовывоза, либо null. */
export function getPickupPaymentSummary(restaurant: Restaurant): string | null {
  const cash = restaurant.pickupPaymentMethods.includes("CASH");
  const card = restaurant.pickupPaymentMethods.includes("CARD");
  if (cash && card) return "Наличными или картой";
  if (cash) return "Наличными";
  if (card) return "Картой";
  return null;
}

export const orderStatusLabels: Record<OrderStatus, string> = {
  RESTAURANT_REVIEW: "Ресторан проверяет заказ",
  AWAITING_PAYMENT: "Ожидается оплата",
  PREPARING: "Готовится",
  READY: "Готов",
  READY_FOR_PICKUP: "Готов к выдаче",
  PICKED_UP: "Выдан",
  OUT_FOR_DELIVERY: "Курьер ресторана выехал",
  ARRIVING: "Курьер скоро будет",
  DELIVERED: "Доставлен",
  CANCELED: "Отменён",
};

export const paymentStatusLabels: Record<
  Order["paymentStatus"],
  string
> = {
  NOT_STARTED: "Оплата ещё не начата",
  AWAITING_PAYMENT: "Ожидается оплата",
  PAID: "Оплачено",
  CASH_ON_DELIVERY: "Наличные при получении",
  DUE_AT_PICKUP: "Оплата при получении",
  PAID_AT_RESTAURANT: "Оплачено в ресторане",
  DUE_TO_RESTAURANT_COURIER: "Оплата курьеру при получении",
  PAID_TO_RESTAURANT_COURIER: "Оплачено курьеру ресторана",
};

export const orderActorLabels: Record<OrderHistoryEvent["actor"], string> = {
  CLIENT: "Клиент",
  RESTAURANT: "Ресторан",
  SYSTEM: "Система",
  ADMIN: "Администратор Direct",
};

export const driverStatusLabels: Record<DriverStatus, string> = {
  AVAILABLE: "Свободен",
  BUSY: "Занят",
  OFFLINE: "Не на смене",
};

export const publicationStatusLabels: Record<PublicationStatus, string> = {
  DRAFT: "Черновик",
  PENDING_REVIEW: "На проверке",
  PUBLISHED: "Опубликован",
  HIDDEN: "Скрыт",
  ARCHIVED: "Архив",
};

/** Безопасный парсинг «12.50» → 1250 центов. Хранилище всегда целые центы. */
export function parseDollarsToCents(value: string): number {
  const normalized = value.replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.round(parsed * 100);
}

export function getZoneName(
  state: Pick<PrototypeState, "zones">,
  zoneId: ZoneId,
): string {
  return state.zones.find((zone) => zone.id === zoneId)?.name ?? zoneId;
}

export function formatMoney(cents: number, currencyCode = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
  }).format(cents / 100);
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Винительный падеж: «добавьте 1 пиццу / 2 пиццы / 5 пицц». */
export function pluralizePizza(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "пицц";
  if (last === 1) return "пиццу";
  if (last >= 2 && last <= 4) return "пиццы";
  return "пицц";
}

/** Именительный падеж: «1 пицца / 2 пиццы / 5 пицц бесплатно». */
export function pluralizePizzaNominative(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "пицц";
  if (last === 1) return "пицца";
  if (last >= 2 && last <= 4) return "пиццы";
  return "пицц";
}

export function getRestaurant(
  state: PrototypeState,
  restaurantId: string | null,
): Restaurant | null {
  if (!restaurantId) {
    return null;
  }
  return (
    state.restaurants.find((restaurant) => restaurant.id === restaurantId) ??
    null
  );
}

export function getPublishedRestaurants(state: PrototypeState): Restaurant[] {
  return state.restaurants.filter(
    (restaurant) => restaurant.status === "PUBLISHED",
  );
}

function getRestaurantRank(restaurant: Restaurant): number {
  return Number.isFinite(restaurant.recommendationRank)
    ? Number(restaurant.recommendationRank)
    : getDefaultRecommendationRank(restaurant.id);
}

export function sortPublishedRestaurants(
  state: PrototypeState,
  sort: CatalogSort,
): Restaurant[] {
  const restaurants = getPublishedRestaurants(state);
  const stableOrder = new Map(
    restaurants.map((restaurant, index) => [restaurant.id, index]),
  );
  const compareFallback = (left: Restaurant, right: Restaurant) =>
    getRestaurantRank(left) - getRestaurantRank(right) ||
    (stableOrder.get(left.id) ?? 0) - (stableOrder.get(right.id) ?? 0);

  return [...restaurants].sort((left, right) => {
    if (sort === "DELIVERY") {
      const leftFee = getAvailablePlatformDeliveryFeeCents(state, left);
      const rightFee = getAvailablePlatformDeliveryFeeCents(state, right);
      if (leftFee === null && rightFee !== null) return 1;
      if (leftFee !== null && rightFee === null) return -1;
      if (leftFee !== null && rightFee !== null && leftFee !== rightFee) {
        return leftFee - rightFee;
      }
    }

    if (
      sort === "PREPARATION" &&
      left.defaultPreparationMinutes !== right.defaultPreparationMinutes
    ) {
      return left.defaultPreparationMinutes - right.defaultPreparationMinutes;
    }

    if (sort === "OPEN" && left.isAcceptingOrders !== right.isAcceptingOrders) {
      return left.isAcceptingOrders ? -1 : 1;
    }

    return compareFallback(left, right);
  });
}

/** Публичная подпись фактического исполнителя доставки (для оформления/заказа). */
export function getDeliveryModeProviderLabel(
  deliveryMode: DeliveryMode,
): string | null {
  if (deliveryMode === "PLATFORM_DRIVER") return "Доставит водитель Direct";
  if (deliveryMode === "RESTAURANT_DELIVERY") return "Доставит курьер ресторана";
  return null;
}

export function canPlacePrototypeOrder(restaurant: Restaurant): boolean {
  return (
    restaurant.status === "PUBLISHED" &&
    restaurant.isAcceptingOrders &&
    restaurant.paymentMethods.includes("ONLINE") &&
    (restaurant.deliveryModes.includes("PLATFORM_DRIVER") ||
      restaurant.deliveryModes.includes("RESTAURANT_DELIVERY") ||
      restaurant.deliveryModes.includes("PICKUP"))
  );
}

export function isCustomerNameValid(name: string): boolean {
  return name.trim().length > 0;
}

export function isCustomerPhoneValid(phone: string): boolean {
  return phone.replace(/\D/g, "").length >= 7;
}

export function getRestaurantMenu(
  state: PrototypeState,
  restaurantId: string,
): MenuItem[] {
  return state.menuItems.filter(
    (menuItem) => menuItem.restaurantId === restaurantId,
  );
}

/** Разрешает вариант размера позиции: по id, иначе вариант по умолчанию. */
export function resolveVariant(
  menuItem: MenuItem,
  variantId: string | null,
): MenuItemVariant | null {
  if (!menuItem.variants || menuItem.variants.length === 0) {
    return null;
  }
  const byId = variantId
    ? menuItem.variants.find((variant) => variant.id === variantId)
    : undefined;
  return (
    byId ??
    menuItem.variants.find((variant) => variant.isDefault) ??
    menuItem.variants[0]
  );
}

export function getRestaurantPromotion(
  state: PrototypeState,
  restaurantId: string | null,
): Promotion | null {
  if (!restaurantId) return null;
  return (
    state.promotions.find(
      (promotion) =>
        promotion.restaurantId === restaurantId && promotion.enabled,
    ) ?? null
  );
}

/**
 * Строки корзины с разрешёнными размерами и распределённой по строкам
 * скидкой акции. Бесплатной становится базовая стоимость самых дешёвых
 * участвующих единиц; доплата за размер в скидку не входит.
 */
export function getCartItemViews(state: PrototypeState): CartItemView[] {
  const views: CartItemView[] = state.cart.items.flatMap((cartItem) => {
    const menuItem = state.menuItems.find(
      (candidate) => candidate.id === cartItem.menuItemId,
    );
    if (!menuItem) {
      return [];
    }
    const variant = resolveVariant(menuItem, cartItem.variantId);
    const variantDeltaCents = variant?.priceDeltaCents ?? 0;
    const finalUnitPriceCents = computeVariantUnitPriceCents(
      menuItem.priceCents,
      variantDeltaCents,
    );
    return [
      {
        cartItem,
        menuItem,
        variant,
        baseUnitPriceCents: menuItem.priceCents,
        variantDeltaCents,
        finalUnitPriceCents,
        quantity: cartItem.quantity,
        lineTotalCents: finalUnitPriceCents * cartItem.quantity,
        promotionDiscountCents: 0,
      },
    ];
  });

  const promotion = getRestaurantPromotion(state, state.cart.restaurantId);
  if (!promotion) {
    return views;
  }

  const eligibleUnits: { viewIndex: number; basePriceCents: number }[] = [];
  views.forEach((view, viewIndex) => {
    if (promotion.eligibleMenuItemIds.includes(view.menuItem.id)) {
      for (let unit = 0; unit < view.quantity; unit += 1) {
        eligibleUnits.push({
          viewIndex,
          basePriceCents: view.baseUnitPriceCents,
        });
      }
    }
  });

  const freeCount = computeFreeUnitCount(eligibleUnits.length, promotion);
  if (freeCount <= 0) {
    return views;
  }

  const freedByView = new Map<number, number>();
  [...eligibleUnits]
    .sort((a, b) => a.basePriceCents - b.basePriceCents)
    .slice(0, freeCount)
    .forEach((unit) => {
      freedByView.set(
        unit.viewIndex,
        (freedByView.get(unit.viewIndex) ?? 0) + 1,
      );
    });

  return views.map((view, viewIndex) => {
    const freedUnits = freedByView.get(viewIndex) ?? 0;
    return {
      ...view,
      promotionDiscountCents: freedUnits * view.baseUnitPriceCents,
    };
  });
}

export function getCartDeliveryMode(
  state: PrototypeState,
): DeliveryMode | null {
  const restaurant = getRestaurant(state, state.cart.restaurantId);
  if (!restaurant) {
    return state.cart.fulfillmentChoice === "PICKUP" ? "PICKUP" : null;
  }
  return resolveDeliveryMode(
    restaurant.deliveryProvider,
    state.cart.fulfillmentChoice,
  );
}

export function detectZoneId(
  street: string,
  state: Pick<PrototypeState, "zones">,
  house = "",
): ZoneId | null {
  const normalizedStreet = street.trim().toLocaleLowerCase("ru-RU");
  if (!normalizedStreet || !house.trim()) {
    return null;
  }
  return (
    state.zones.find((zone) =>
      zone.streets.some(
        (candidate) =>
          candidate.trim().toLocaleLowerCase("ru-RU") === normalizedStreet,
      ),
    )?.id ?? null
  );
}

export function getValidatedAddressZoneId(
  address: DeliveryAddress,
  state: Pick<PrototypeState, "zones">,
): ZoneId | null {
  const expectedZoneId = detectZoneId(address.street, state, address.house);
  return expectedZoneId && expectedZoneId === address.zoneId
    ? expectedZoneId
    : null;
}

export function getDeliveryFeeCents(
  state: PrototypeState,
  restaurant: Restaurant,
): number | null {
  const customerZoneId = getValidatedAddressZoneId(state.cart.address, state);
  const cents = customerZoneId
    ? state.tariffs[restaurant.zoneId]?.[customerZoneId]
    : undefined;
  return Number.isInteger(cents) && Number(cents) >= 0 ? Number(cents) : null;
}

/** Тариф Direct для каталога/сортировки. Только рестораны типа DIRECT. */
export function getAvailablePlatformDeliveryFeeCents(
  state: PrototypeState,
  restaurant: Restaurant,
): number | null {
  if (
    restaurant.status !== "PUBLISHED" ||
    !restaurant.isAcceptingOrders ||
    restaurant.deliveryProvider !== "DIRECT" ||
    !restaurant.deliveryModes.includes("PLATFORM_DRIVER") ||
    !restaurant.paymentMethods.includes("ONLINE")
  ) {
    return null;
  }
  return getDeliveryFeeCents(state, restaurant);
}

function emptyPricing(
  deliveryMode: DeliveryMode | null,
  deliveryProvider: Restaurant["deliveryProvider"] | null,
): CartPricing {
  return {
    deliveryMode,
    deliveryProvider,
    foodSubtotalBeforeDiscountsCents: 0,
    variantSurchargeSubtotalCents: 0,
    promotionDiscountCents: 0,
    foodSubtotalCents: 0,
    deliveryFeeCents: deliveryMode === "PICKUP" ? 0 : null,
    standardRestaurantDeliveryFeeCents: null,
    restaurantCommissionCents: 0,
    smallOrderFeeCents: 0,
    platformGrossRevenueCents: 0,
    driverPayoutCents: deliveryMode === null ? null : 0,
    restaurantPayoutBeforeBankFeeCents: 0,
    customerTotalCents: null,
    appliedPromotion: null,
    promotionUnitsToNextFree: null,
    promotionPaidUnitsBeforeNextFree: null,
    promotionFreeUnitCount: 0,
    promotionEligibleUnits: 0,
    restaurantDeliveryStatus: null,
    restaurantDeliveryMissingCents: null,
    freeDeliveryRemainingCents: null,
    minimumOrderCents: null,
    freeDeliveryThresholdCents: null,
  };
}

export function calculateCartPricing(state: PrototypeState): CartPricing {
  const restaurant = getRestaurant(state, state.cart.restaurantId);
  const deliveryMode = getCartDeliveryMode(state);
  const provider = restaurant?.deliveryProvider ?? null;

  if (!restaurant) {
    return emptyPricing(deliveryMode, provider);
  }

  const views = getCartItemViews(state);
  const foodSubtotalBeforeDiscountsCents = views.reduce(
    (total, view) => total + view.lineTotalCents,
    0,
  );
  const variantSurchargeSubtotalCents = views.reduce(
    (total, view) => total + view.variantDeltaCents * view.quantity,
    0,
  );
  const promotionDiscountCents = views.reduce(
    (total, view) => total + view.promotionDiscountCents,
    0,
  );
  const foodSubtotalCents =
    foodSubtotalBeforeDiscountsCents - promotionDiscountCents;

  // Снимок применённой акции и прогресс до следующего подарка.
  const promotion = getRestaurantPromotion(state, restaurant.id);
  let appliedPromotion: AppliedPromotionSnapshot | null = null;
  let promotionFreeUnitCount = 0;
  let promotionUnitsToNextFree: number | null = null;
  let promotionPaidUnitsBeforeNextFree: number | null = null;
  let promotionEligibleUnits = 0;
  if (promotion) {
    const eligibleUnits = views.reduce(
      (total, view) =>
        promotion.eligibleMenuItemIds.includes(view.menuItem.id)
          ? total + view.quantity
          : total,
      0,
    );
    promotionEligibleUnits = eligibleUnits;
    promotionFreeUnitCount = computeFreeUnitCount(eligibleUnits, promotion);
    const groupSize = promotion.buyQuantity + promotion.freeQuantity;
    const remainder = eligibleUnits % groupSize;
    promotionUnitsToNextFree =
      remainder === 0 && eligibleUnits > 0 ? groupSize : groupSize - remainder;
    promotionPaidUnitsBeforeNextFree = computePaidUnitsBeforeNextFree(
      eligibleUnits,
      promotion,
    );
    if (promotionFreeUnitCount > 0) {
      appliedPromotion = {
        promotionId: promotion.id,
        title: promotion.title,
        type: promotion.type,
        freeUnitCount: promotionFreeUnitCount,
        discountCents: promotionDiscountCents,
      };
    }
  }

  const isPickup = state.cart.fulfillmentChoice === "PICKUP";
  const customerZoneId = getValidatedAddressZoneId(state.cart.address, state);

  const base = emptyPricing(deliveryMode, provider);
  base.foodSubtotalBeforeDiscountsCents = foodSubtotalBeforeDiscountsCents;
  base.variantSurchargeSubtotalCents = variantSurchargeSubtotalCents;
  base.promotionDiscountCents = promotionDiscountCents;
  base.foodSubtotalCents = foodSubtotalCents;
  base.appliedPromotion = appliedPromotion;
  base.promotionFreeUnitCount = promotionFreeUnitCount;
  base.promotionUnitsToNextFree = promotionUnitsToNextFree;
  base.promotionPaidUnitsBeforeNextFree = promotionPaidUnitsBeforeNextFree;
  base.promotionEligibleUnits = promotionEligibleUnits;

  if (provider === "RESTAURANT") {
    const settings = restaurant.restaurantDeliverySettings;
    if (isPickup || !settings) {
      const financials = computeRestaurantDeliveryFinancials({
        foodSubtotalCents,
        commissionRateBps: restaurant.commissionRateBps,
        deliveryFeeCents: 0,
        isPickup: true,
      });
      return { ...base, ...applyFinancials(base, financials, 0) };
    }

    base.minimumOrderCents = settings.minimumOrderCents;
    base.freeDeliveryThresholdCents = settings.freeDeliveryThresholdCents;

    const quote = computeRestaurantDeliveryQuote(
      foodSubtotalCents,
      settings,
      customerZoneId,
    );
    base.restaurantDeliveryStatus = quote.status;

    if (quote.status !== "OK") {
      base.restaurantDeliveryMissingCents =
        quote.status === "BELOW_MINIMUM" ? quote.missingCents : null;
      const commission = computeRestaurantDeliveryFinancials({
        foodSubtotalCents,
        commissionRateBps: restaurant.commissionRateBps,
        deliveryFeeCents: 0,
        isPickup: false,
      });
      base.restaurantCommissionCents = commission.restaurantCommissionCents;
      base.platformGrossRevenueCents = commission.platformGrossRevenueCents;
      base.restaurantPayoutBeforeBankFeeCents =
        foodSubtotalCents - commission.restaurantCommissionCents;
      base.deliveryFeeCents = null;
      base.driverPayoutCents = 0;
      base.customerTotalCents = null;
      return base;
    }

    base.standardRestaurantDeliveryFeeCents = quote.standardFeeCents;
    base.freeDeliveryRemainingCents =
      settings.freeDeliveryThresholdCents !== null && !quote.freeDelivery
        ? Math.max(0, settings.freeDeliveryThresholdCents - foodSubtotalCents)
        : null;
    const financials = computeRestaurantDeliveryFinancials({
      foodSubtotalCents,
      commissionRateBps: restaurant.commissionRateBps,
      deliveryFeeCents: quote.deliveryFeeCents,
      isPickup: false,
    });
    return { ...base, ...applyFinancials(base, financials, quote.deliveryFeeCents) };
  }

  // provider === "DIRECT"
  const matrixFeeCents = getDeliveryFeeCents(state, restaurant);
  if (!isPickup && matrixFeeCents === null) {
    const financials = computeDirectFinancials({
      foodSubtotalCents,
      commissionRateBps: restaurant.commissionRateBps,
      minimumPlatformGrossRevenueCents:
        state.platformSettings.minimumPlatformGrossRevenueCents,
      deliveryFeeCents: 0,
      isPickup: false,
    });
    base.restaurantCommissionCents = financials.restaurantCommissionCents;
    base.smallOrderFeeCents = financials.smallOrderFeeCents;
    base.platformGrossRevenueCents = financials.platformGrossRevenueCents;
    base.restaurantPayoutBeforeBankFeeCents =
      financials.restaurantPayoutBeforeBankFeeCents;
    base.deliveryFeeCents = null;
    base.driverPayoutCents = null;
    base.customerTotalCents = null;
    return base;
  }

  const financials = computeDirectFinancials({
    foodSubtotalCents,
    commissionRateBps: restaurant.commissionRateBps,
    minimumPlatformGrossRevenueCents:
      state.platformSettings.minimumPlatformGrossRevenueCents,
    deliveryFeeCents: isPickup ? 0 : (matrixFeeCents ?? 0),
    isPickup,
  });
  return {
    ...base,
    ...applyFinancials(base, financials, financials.deliveryFeeCents),
  };
}

function applyFinancials(
  base: CartPricing,
  financials: {
    restaurantCommissionCents: number;
    smallOrderFeeCents: number;
    deliveryFeeCents: number;
    platformGrossRevenueCents: number;
    driverPayoutCents: number;
    restaurantPayoutBeforeBankFeeCents: number;
    customerTotalCents: number;
  },
  deliveryFeeCents: number,
): CartPricing {
  return {
    ...base,
    restaurantCommissionCents: financials.restaurantCommissionCents,
    smallOrderFeeCents: financials.smallOrderFeeCents,
    deliveryFeeCents,
    platformGrossRevenueCents: financials.platformGrossRevenueCents,
    driverPayoutCents: financials.driverPayoutCents,
    restaurantPayoutBeforeBankFeeCents:
      financials.restaurantPayoutBeforeBankFeeCents,
    customerTotalCents: financials.customerTotalCents,
  };
}

export function getSmallOrderMissingAmountCents(
  state: PrototypeState,
): number {
  const restaurant = getRestaurant(state, state.cart.restaurantId);
  const rateBps =
    restaurant?.commissionRateBps ??
    state.platformSettings.restaurantCommissionRateBps;
  const { foodSubtotalCents } = calculateCartPricing(state);
  const minimumFoodSubtotalCents = Math.ceil(
    (state.platformSettings.minimumPlatformGrossRevenueCents * 10_000) / rateBps,
  );
  return Math.max(0, minimumFoodSubtotalCents - foodSubtotalCents);
}

export function getOrder(
  state: PrototypeState,
  orderId: string,
): Order | null {
  return state.orders.find((order) => order.id === orderId) ?? null;
}

export function getCurrentCustomerOrders(state: PrototypeState): Order[] {
  return state.orders
    .filter((order) => order.customer.id === state.customer.id)
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    );
}

export function getLatestCustomerOrder(state: PrototypeState): Order | null {
  return getCurrentCustomerOrders(state)[0] ?? null;
}

export function getActiveCustomerOrder(state: PrototypeState): Order | null {
  return (
    getCurrentCustomerOrders(state).find(
      (order) =>
        order.status !== "CANCELED" &&
        order.status !== "PICKED_UP" &&
        order.status !== "DELIVERED",
    ) ?? null
  );
}

export function getRestaurantOrders(
  state: PrototypeState,
  restaurantId: string,
  statuses: readonly OrderStatus[],
): Order[] {
  return state.orders.filter(
    (order) =>
      order.restaurant.id === restaurantId && statuses.includes(order.status),
  );
}

/** Заказы для ресторанного кабинета: рабочие рестораны 1–3. */
export const WORKING_RESTAURANT_IDS = [
  "restaurant-1",
  "restaurant-2",
  "restaurant-3",
] as const;

export function getWorkingRestaurantOrders(
  state: PrototypeState,
  statuses: readonly OrderStatus[],
): Order[] {
  return state.orders.filter(
    (order) =>
      (WORKING_RESTAURANT_IDS as readonly string[]).includes(
        order.restaurant.id,
      ) && statuses.includes(order.status),
  );
}

// --- Экран кухни: секции одного ресторана -----------------------------------

function kitchenOrders(
  state: PrototypeState,
  restaurantId: string,
  statuses: readonly OrderStatus[],
): Order[] {
  return state.orders.filter(
    (order) =>
      order.restaurant.id === restaurantId &&
      statuses.includes(order.status),
  );
}

/**
 * Момент входа заказа в указанный статус. Разные секции кухни считают время от
 * РАЗНЫХ точек:
 * - RESTAURANT_REVIEW — от createdAt (ожидание ресторана);
 * - PREPARING/READY/READY_FOR_PICKUP — от последнего НАСТОЯЩЕГО перехода в этот
 *   статус (fromStatus !== toStatus), не от createdAt.
 *
 * Технические события с fromStatus === toStatus (запрос на отмену, отклонение
 * запроса, назначение/переназначение/снятие водителя) НЕ сбрасывают точку
 * входа — иначе «Готовится N мин» и сортировка готовых прыгали бы. События из
 * истории не удаляются (нужны для аудита), лишь игнорируются здесь.
 * Если настоящего перехода нет — fallback updatedAt. Историю не мутирует.
 */
export function getOrderStatusSince(order: Order, status: OrderStatus): string {
  if (status === "RESTAURANT_REVIEW") {
    return order.createdAt;
  }
  const event = [...order.history]
    .reverse()
    .find(
      (e) =>
        e.type === "STATUS" &&
        e.toStatus === status &&
        e.fromStatus !== e.toStatus,
    );
  return event?.occurredAt ?? order.updatedAt;
}

/** Ожидаемое время готовности (HH:MM) в часовом поясе ресторана (§3). */
export function formatExpectedReady(
  expectedReadyAt: string | null,
  timeZone: string,
): string {
  if (!expectedReadyAt) {
    return "Ожидаемая готовность: не задана";
  }
  const time = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(expectedReadyAt));
  return `Ожидаемая готовность: ${time}`;
}

/**
 * Обратный отсчёт до готовности / просрочка (§3, §10). `nowMs === 0` — часы
 * ещё не инициализированы (SSR). Чистая функция.
 */
export function formatKitchenCountdown(
  expectedReadyAt: string | null,
  nowMs: number,
): { text: string; overdue: boolean } {
  if (!expectedReadyAt) {
    return { text: "Время не задано", overdue: false };
  }
  if (nowMs === 0) return { text: "—", overdue: false };
  const diffMs = Date.parse(expectedReadyAt) - nowMs;
  if (diffMs <= 0) {
    const overdueMin = Math.floor(-diffMs / 60_000);
    return { text: `Просрочено на ${overdueMin} мин`, overdue: true };
  }
  const totalSec = Math.ceil(diffMs / 1000);
  if (totalSec >= 60) {
    return { text: `${Math.floor(totalSec / 60)} мин`, overdue: false };
  }
  return {
    text: `0:${String(totalSec % 60).padStart(2, "0")}`,
    overdue: false,
  };
}

/** Момент готовности заказа (READY/READY_FOR_PICKUP), иначе updatedAt. */
export function getOrderReadySince(order: Order): string {
  return getOrderStatusSince(order, order.status);
}

/** «Новые» — RESTAURANT_REVIEW, самые старые сверху (ждут дольше всех). */
export function getKitchenNewOrders(
  state: PrototypeState,
  restaurantId: string,
): Order[] {
  return kitchenOrders(state, restaurantId, ["RESTAURANT_REVIEW"]).sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

/** «Ожидают оплаты» — AWAITING_PAYMENT (отдельная полоса, без действий кухни). */
export function getKitchenAwaitingPaymentOrders(
  state: PrototypeState,
  restaurantId: string,
): Order[] {
  return kitchenOrders(state, restaurantId, ["AWAITING_PAYMENT"]).sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

/**
 * «Готовятся» — PREPARING. Сортировка по expectedReadyAt по возрастанию:
 * просроченные (наименьшее время) первыми, затем ближайшие; заказы без
 * expectedReadyAt — в конце.
 */
export function getKitchenPreparingOrders(
  state: PrototypeState,
  restaurantId: string,
): Order[] {
  return kitchenOrders(state, restaurantId, ["PREPARING"]).sort((a, b) => {
    const ta = a.expectedReadyAt
      ? Date.parse(a.expectedReadyAt)
      : Number.POSITIVE_INFINITY;
    const tb = b.expectedReadyAt
      ? Date.parse(b.expectedReadyAt)
      : Number.POSITIVE_INFINITY;
    return ta - tb;
  });
}

/** «Готовы» — READY и READY_FOR_PICKUP, самые давно готовые сверху. */
export function getKitchenReadyOrders(
  state: PrototypeState,
  restaurantId: string,
): Order[] {
  return kitchenOrders(state, restaurantId, [
    "READY",
    "READY_FOR_PICKUP",
  ]).sort(
    (a, b) =>
      Date.parse(getOrderReadySince(a)) - Date.parse(getOrderReadySince(b)),
  );
}

// --- Отмена и запросы на отмену ----------------------------------------------

/** Может ли клиент бесплатно и сразу отменить заказ (§6): до приготовления. */
export function canClientCancelDirectly(order: Order): boolean {
  return (
    order.status === "RESTAURANT_REVIEW" || order.status === "AWAITING_PAYMENT"
  );
}

/** Может ли клиент отправить ЗАПРОС на отмену (§10): активное приготовление/доставка. */
export function canClientRequestCancellation(order: Order): boolean {
  return (
    order.status === "PREPARING" ||
    order.status === "READY" ||
    order.status === "READY_FOR_PICKUP" ||
    order.status === "OUT_FOR_DELIVERY" ||
    order.status === "ARRIVING"
  );
}

/** Запрос на отмену для заказа, либо null. */
export function getCancellationRequestForOrder(
  state: PrototypeState,
  orderId: string,
): CancellationRequest | null {
  return (
    state.cancellationRequests.find((r) => r.orderId === orderId) ?? null
  );
}

/** Все ожидающие (PENDING) запросы на отмену. */
export function getPendingCancellationRequests(
  state: PrototypeState,
): CancellationRequest[] {
  return state.cancellationRequests.filter((r) => r.status === "PENDING");
}

/** Ожидающие запросы на отмену конкретного ресторана. */
export function getPendingCancellationRequestsForRestaurant(
  state: PrototypeState,
  restaurantId: string,
): CancellationRequest[] {
  return state.cancellationRequests.filter(
    (r) => r.status === "PENDING" && r.restaurantId === restaurantId,
  );
}

/** Крупное предупреждение после начала приготовления (§8), по способу оплаты. */
export function getPostPreparationWarning(order: Order): string {
  if (order.paymentMethod === "CASH_TO_RESTAURANT_COURIER") {
    return "Ресторан уже начал готовить заказ. Для отмены отправьте запрос администратору Direct. Если приготовленный заказ не будет получен, это сохранится в истории и может ограничить будущие заказы без предоплаты.";
  }
  if (order.paymentMethod === "PAY_AT_RESTAURANT") {
    return "Ресторан уже начал готовить заказ. Для отмены отправьте запрос администратору Direct. Неявка после приготовления сохранится в истории и может ограничить будущие заказы без предоплаты.";
  }
  // ONLINE (оплачен) и прочее.
  return "Ресторан уже начал готовить заказ. Самостоятельная отмена недоступна. Вы можете отправить запрос администратору Direct. Возврат оплаты не гарантируется.";
}

/** Причина, которую проставляет автозакрытие неотвеченного заказа (§4). */
export const AUTO_CANCEL_REASON = "Ресторан не ответил в течение 7 минут";

/** Дружелюбное сообщение клиенту при автоотмене из-за молчания ресторана (§5). */
export function getClientAutoCancelMessage(order: Order): string | null {
  return order.status === "CANCELED" &&
    order.cancellationReason === AUTO_CANCEL_REASON
    ? "Ресторан не ответил вовремя. Попробуйте оформить заказ позже или выберите другой ресторан."
    : null;
}

/** Статусное сообщение клиенту по его запросу на отмену (§13), либо null. */
export function getClientCancellationMessage(
  request: CancellationRequest | null,
): string | null {
  if (!request) return null;
  if (request.status === "PENDING") return "Запрос на отмену рассматривается";
  if (request.status === "APPROVED") return "Отмена одобрена администратором";
  return `Запрос на отмену отклонён: ${request.resolutionNote ?? "решение администратора"}`;
}

/**
 * Таймаут ответа ресторана для звукового расписания — ровно 7 минут. Должен
 * совпадать с RESTAURANT_RESPONSE_TIMEOUT_MS в actions (авто-отмена).
 */
export const KITCHEN_REVIEW_TIMEOUT_MS = 7 * 60 * 1000;

/**
 * Новые заказы выбранного ресторана, которые ЕЩЁ должны звучать (§2): только
 * RESTAURANT_REVIEW моложе 7 минут. На отметке 7:00 и позже заказ выпадает из
 * звукового расписания даже до provider-sweep (визуально может показывать 0:00).
 * Чистая функция.
 */
export function getAudibleKitchenReviewOrders(
  state: PrototypeState,
  restaurantId: string,
  nowMs: number,
): Order[] {
  return state.orders.filter(
    (order) =>
      order.restaurant.id === restaurantId &&
      order.status === "RESTAURANT_REVIEW" &&
      nowMs - Date.parse(order.createdAt) < KITCHEN_REVIEW_TIMEOUT_MS,
  );
}

/**
 * Нужен ли сейчас звуковой сигнал кухни (§2, §19). Чистая функция расписания:
 * сигнал нужен, если есть новые заказы и либо появился ещё не объявленный заказ,
 * либо прошёл интервал (по умолчанию 20с) с прошлого сигнала. В reviewOrderIds
 * передаются только «звучащие» заказы (моложе 7 минут, выбранного ресторана).
 */
export function isKitchenBeepDue(params: {
  reviewOrderIds: readonly string[];
  announcedOrderIds: readonly string[];
  lastBeepAtMs: number | null;
  nowMs: number;
  intervalMs?: number;
}): boolean {
  const interval = params.intervalMs ?? 20_000;
  if (params.reviewOrderIds.length === 0) {
    return false;
  }
  const hasUnannounced = params.reviewOrderIds.some(
    (id) => !params.announcedOrderIds.includes(id),
  );
  if (hasUnannounced) {
    return true;
  }
  if (params.lastBeepAtMs === null) {
    return true;
  }
  return params.nowMs - params.lastBeepAtMs >= interval;
}

export function isAddressReady(
  address: DeliveryAddress,
  state: Pick<PrototypeState, "zones">,
): boolean {
  return getValidatedAddressZoneId(address, state) !== null;
}

// --- Самовывоз: ledger и статистика ----------------------------------------

export function getSettlementForOrder(
  state: PrototypeState,
  orderId: string,
): SettlementEntry | null {
  return (
    state.settlements.find((entry) => entry.orderId === orderId) ?? null
  );
}

/** Сумма ожидающих (PENDING) начислений ресторана, опционально по типу. */
export function getRestaurantSettlementDebtCents(
  state: PrototypeState,
  restaurantId: string,
  type?: SettlementEntry["type"],
): number {
  return state.settlements
    .filter(
      (entry) =>
        entry.restaurantId === restaurantId &&
        entry.status === "PENDING" &&
        (type ? entry.type === type : true),
    )
    .reduce((total, entry) => total + entry.amountCents, 0);
}

/** Задолженность ресторана перед Direct по комиссии самовывоза (PENDING). */
export function getRestaurantPickupDebtCents(
  state: PrototypeState,
  restaurantId: string,
): number {
  return getRestaurantSettlementDebtCents(
    state,
    restaurantId,
    "PICKUP_COMMISSION",
  );
}

/** Задолженность ресторана перед Direct по комиссии собственной доставки (PENDING). */
export function getRestaurantDeliveryCommissionDebtCents(
  state: PrototypeState,
  restaurantId: string,
): number {
  return getRestaurantSettlementDebtCents(
    state,
    restaurantId,
    "RESTAURANT_DELIVERY_COMMISSION",
  );
}

export interface PickupStats {
  issued: number;
  noShow: number;
  noShowPercent: number;
  suspiciousAfterReady: number;
}

function wasCancelledAfterReady(order: Order): boolean {
  return (
    order.status === "CANCELED" &&
    order.deliveryMode === "PICKUP" &&
    order.history.some(
      (event) =>
        event.fromStatus === "READY_FOR_PICKUP" &&
        event.toStatus === "CANCELED",
    )
  );
}

export function getPickupStats(
  state: PrototypeState,
  restaurantId?: string,
): PickupStats {
  const pickupOrders = state.orders.filter(
    (order) =>
      order.deliveryMode === "PICKUP" &&
      (restaurantId ? order.restaurant.id === restaurantId : true),
  );
  const issued = pickupOrders.filter(
    (order) => order.status === "PICKED_UP",
  ).length;
  const noShow = pickupOrders.filter(wasCancelledAfterReady).length;
  const total = issued + noShow;
  return {
    issued,
    noShow,
    noShowPercent: total > 0 ? Math.round((noShow / total) * 100) : 0,
    suspiciousAfterReady: noShow,
  };
}

// --- Водители и операционные показатели админки -----------------------------

export function getAvailableDrivers(state: PrototypeState): DriverProfile[] {
  return state.drivers.filter((driver) => driver.status === "AVAILABLE");
}

export function getDriverById(
  state: PrototypeState,
  driverId: string | null,
): DriverProfile | null {
  if (!driverId) return null;
  return state.drivers.find((driver) => driver.id === driverId) ?? null;
}

/** Активные курьерские статусы, в которых заказ уже «в пути» у водителя. */
const DRIVER_ACTIVE_STATUSES: readonly OrderStatus[] = [
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "ARRIVING",
];

/**
 * Показывать ли в админке блок назначения водителя Direct (§3). Только для
 * PLATFORM_DRIVER и либо когда заказ оплачен и готовится/готов (первичное
 * назначение), либо когда водитель уже назначен и заказ в активном курьерском
 * статусе. Исключает RESTAURANT_REVIEW, AWAITING_PAYMENT, неоплаченные и
 * завершённые/отменённые заказы. UI-гейт дублирует доменную проверку назначения.
 */
export function shouldShowDriverAssignment(order: Order): boolean {
  if (order.deliveryMode !== "PLATFORM_DRIVER") {
    return false;
  }
  const eligibleForFirstAssignment =
    order.paymentStatus === "PAID" &&
    (order.status === "PREPARING" || order.status === "READY");
  const alreadyAssignedActive =
    order.assignedDriverId !== null &&
    DRIVER_ACTIVE_STATUSES.includes(order.status);
  return eligibleForFirstAssignment || alreadyAssignedActive;
}

/** Активные (не завершённые) статусы заказа. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  "RESTAURANT_REVIEW",
  "AWAITING_PAYMENT",
  "PREPARING",
  "READY",
  "READY_FOR_PICKUP",
  "OUT_FOR_DELIVERY",
  "ARRIVING",
];

/** Заказ клиента считается текущим (не завершённым)? */
export function isActiveOrderStatus(status: OrderStatus): boolean {
  return ACTIVE_ORDER_STATUSES.includes(status);
}

/** Текущие заказы клиента (активные статусы), новые сверху. */
export function getCurrentCustomerActiveOrders(state: PrototypeState): Order[] {
  return getCurrentCustomerOrders(state).filter((order) =>
    isActiveOrderStatus(order.status),
  );
}

/** Завершённые заказы клиента (DELIVERED/PICKED_UP/CANCELED), новые сверху. */
export function getCurrentCustomerCompletedOrders(
  state: PrototypeState,
): Order[] {
  return getCurrentCustomerOrders(state).filter(
    (order) => !isActiveOrderStatus(order.status),
  );
}

export function getRestaurantActiveOrderCount(
  state: PrototypeState,
  restaurantId: string,
): number {
  return state.orders.filter(
    (order) =>
      order.restaurant.id === restaurantId &&
      ACTIVE_ORDER_STATUSES.includes(order.status),
  ).length;
}

/**
 * Действующие настройки собственной доставки (§8). deliveryProvider — источник
 * истины: у ресторана с водителями Direct собственные зоны/тарифы/минимум НЕ
 * действуют (возвращается null), даже если они сохранены для возможного возврата.
 */
export function getEffectiveDeliverySettings(
  restaurant: Restaurant,
): Restaurant["restaurantDeliverySettings"] {
  return restaurant.deliveryProvider === "RESTAURANT"
    ? restaurant.restaurantDeliverySettings
    : null;
}

/** Совокупная задолженность ресторана перед Direct (самовывоз + доставка). */
export function getRestaurantTotalDebtCents(
  state: PrototypeState,
  restaurantId: string,
): number {
  return (
    getRestaurantPickupDebtCents(state, restaurantId) +
    getRestaurantDeliveryCommissionDebtCents(state, restaurantId)
  );
}

const WEEKDAY_BY_JS_DAY: WeekdayId[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const WEEKDAY_BY_SHORT: Record<string, WeekdayId> = {
  Sun: "sunday",
  Mon: "monday",
  Tue: "tuesday",
  Wed: "wednesday",
  Thu: "thursday",
  Fri: "friday",
  Sat: "saturday",
};

/** Идентификатор дня недели по объекту Date (0=вс..6=сб), локальное время. */
export function getWeekdayId(date: Date): WeekdayId {
  return WEEKDAY_BY_JS_DAY[date.getDay()];
}

function previousWeekday(weekdayId: WeekdayId): WeekdayId {
  const index = WEEKDAY_BY_JS_DAY.indexOf(weekdayId);
  return WEEKDAY_BY_JS_DAY[(index + 6) % 7];
}

function timeToMinutes(hhmm: string): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map((x) => Number(x));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * Локальные для ресторана день недели и минуты суток, вычисленные через
 * Intl.DateTimeFormat в часовом поясе ресторана (§5) — не по времени компьютера.
 */
export function getRestaurantLocalNow(
  restaurant: Restaurant,
  date: Date,
): { weekdayId: WeekdayId; minutes: number } {
  const timeZone = restaurant.timeZone || "Europe/Chisinau";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  }
  const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return {
    weekdayId: WEEKDAY_BY_SHORT[weekdayShort] ?? "monday",
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 +
      (Number.isFinite(minute) ? minute : 0),
  };
}

/** Строка часов работы на указанный день, либо «Закрыто». */
export function getScheduleLabel(
  restaurant: Restaurant,
  weekdayId: WeekdayId,
): string {
  const day = restaurant.weeklySchedule[weekdayId];
  if (!day || !day.enabled) return "Закрыто";
  return `${day.openTime || "—"}–${day.closeTime || "—"}`;
}

/**
 * Открыт ли ресторан по графику прямо сейчас (§5). Расчёт в часовом поясе
 * ресторана через Intl. Поддерживает ночные интервалы (например 18:00–02:00):
 * после полуночи ресторан считается открытым по графику предыдущего дня.
 */
export function isRestaurantOpenNow(
  restaurant: Restaurant,
  date: Date,
): boolean {
  const { weekdayId, minutes } = getRestaurantLocalNow(restaurant, date);

  const today = restaurant.weeklySchedule[weekdayId];
  if (today?.enabled) {
    const open = timeToMinutes(today.openTime);
    const close = timeToMinutes(today.closeTime);
    if (open !== null && close !== null) {
      if (close > open && minutes >= open && minutes <= close) return true;
      // Ночной интервал (пересекает полночь): открыт с open до конца суток.
      if (close < open && minutes >= open) return true;
    }
  }

  // Ночной интервал предыдущего дня, продолжающийся после полуночи.
  const prev = restaurant.weeklySchedule[previousWeekday(weekdayId)];
  if (prev?.enabled) {
    const open = timeToMinutes(prev.openTime);
    const close = timeToMinutes(prev.closeTime);
    if (open !== null && close !== null && close < open && minutes <= close) {
      return true;
    }
  }

  return false;
}

export { TEST_RESTAURANT_ID };
