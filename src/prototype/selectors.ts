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
): ZoneId | null {
  const normalizedStreet = street.trim().toLocaleLowerCase("ru-RU");

  if (!normalizedStreet) {
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
  const deliveryFeeCents =
    restaurant && state.cart.address.zoneId
      ? state.tariffs[restaurant.zoneId][state.cart.address.zoneId]
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

export function isAddressReady(address: DeliveryAddress): boolean {
  return Boolean(address.street.trim() && address.house.trim() && address.zoneId);
}
