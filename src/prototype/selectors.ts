import type {
  CartItem,
  CartPricing,
  DeliveryAddress,
  DeliveryMode,
  MenuItem,
  Order,
  OrderStatus,
  PaymentMethod,
  PrototypeState,
  Restaurant,
  ZoneId,
} from "./models";
import {
  getDefaultRecommendationRank,
  TEST_RESTAURANT_ID,
} from "./default-state";

export type CatalogSort =
  | "RECOMMENDED"
  | "DELIVERY"
  | "PREPARATION"
  | "OPEN";

export interface CartItemView {
  cartItem: CartItem;
  menuItem: MenuItem;
  lineTotalCents: number;
}

export const deliveryModeLabels: Record<DeliveryMode, string> = {
  PLATFORM_DRIVER: "Доставка Direct",
  RESTAURANT_DELIVERY: "Доставка ресторана",
  PICKUP: "Самовывоз",
};

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  ONLINE: "Оплата онлайн",
  CASH: "Наличные",
};

export const orderStatusLabels: Record<OrderStatus, string> = {
  RESTAURANT_REVIEW: "Ресторан проверяет заказ",
  AWAITING_PAYMENT: "Ожидается оплата",
  PREPARING: "Готовится",
  READY: "Готово и упаковано",
  CANCELED: "Отменён",
};

export function formatMoney(cents: number, currencyCode = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
  }).format(cents / 100);
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
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
      const leftFee = getDeliveryFeeCents(state, left);
      const rightFee = getDeliveryFeeCents(state, right);
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

export function getDeliveryProviderLabel(
  restaurant: Restaurant,
): string | null {
  if (restaurant.deliveryModes.includes("PLATFORM_DRIVER")) {
    return "Доставит водитель Direct";
  }
  if (restaurant.deliveryModes.includes("RESTAURANT_DELIVERY")) {
    return "Доставит курьер ресторана";
  }
  return null;
}

export function canPlacePrototypeOrder(restaurant: Restaurant): boolean {
  return (
    restaurant.id === TEST_RESTAURANT_ID &&
    restaurant.status === "PUBLISHED" &&
    restaurant.isAcceptingOrders &&
    restaurant.deliveryModes.includes("PLATFORM_DRIVER") &&
    restaurant.paymentMethods.includes("ONLINE")
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

export function getCartItemViews(state: PrototypeState): CartItemView[] {
  return state.cart.items.flatMap((cartItem) => {
    const menuItem = state.menuItems.find(
      (candidate) => candidate.id === cartItem.menuItemId,
    );

    if (!menuItem) {
      return [];
    }

    return [
      {
        cartItem,
        menuItem,
        lineTotalCents: menuItem.priceCents * cartItem.quantity,
      },
    ];
  });
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

export function calculateCartPricing(state: PrototypeState): CartPricing {
  const restaurant = getRestaurant(state, state.cart.restaurantId);
  const foodSubtotalCents = getCartItemViews(state).reduce(
    (total, line) => total + line.lineTotalCents,
    0,
  );
  const restaurantCommissionCents = Math.round(
    (foodSubtotalCents *
      state.platformSettings.restaurantCommissionRateBps) /
      10_000,
  );
  const smallOrderFeeCents =
    state.cart.paymentMethod === "ONLINE"
      ? Math.max(
          0,
          state.platformSettings.minimumPlatformGrossRevenueCents -
            restaurantCommissionCents,
        )
      : 0;
  const deliveryFeeCents = restaurant
    ? getDeliveryFeeCents(state, restaurant)
    : null;
  const platformGrossRevenueCents =
    restaurantCommissionCents + smallOrderFeeCents;
  const restaurantPayoutBeforeBankFeeCents =
    foodSubtotalCents - restaurantCommissionCents;

  return {
    foodSubtotalCents,
    deliveryFeeCents,
    restaurantCommissionCents,
    smallOrderFeeCents,
    platformGrossRevenueCents,
    driverPayoutCents: deliveryFeeCents,
    restaurantPayoutBeforeBankFeeCents,
    customerTotalCents:
      deliveryFeeCents === null
        ? null
        : foodSubtotalCents + deliveryFeeCents + smallOrderFeeCents,
  };
}

export function getCashMissingAmountCents(state: PrototypeState): number {
  const { foodSubtotalCents } = calculateCartPricing(state);
  return Math.max(
    0,
    state.platformSettings.cashMinimumFoodSubtotalCents - foodSubtotalCents,
  );
}

export function getSmallOrderMissingAmountCents(
  state: PrototypeState,
): number {
  const { foodSubtotalCents } = calculateCartPricing(state);
  const minimumFoodSubtotalCents = Math.ceil(
    (state.platformSettings.minimumPlatformGrossRevenueCents * 10_000) /
      state.platformSettings.restaurantCommissionRateBps,
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
      (order) => order.status !== "CANCELED",
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

export function isAddressReady(
  address: DeliveryAddress,
  state: Pick<PrototypeState, "zones">,
): boolean {
  return getValidatedAddressZoneId(address, state) !== null;
}
