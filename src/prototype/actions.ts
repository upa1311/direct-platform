import {
  createDefaultState,
  createDefaultTariffs,
  createEmptyCart,
  TEST_RESTAURANT_ID,
} from "./default-state";
import type {
  DeliveryAddress,
  Order,
  PaymentMethod,
  PrototypeState,
  TariffMatrix,
} from "./models";
import {
  calculateCartPricing,
  detectZoneId,
  getCartItemViews,
  getRestaurant,
  isAddressReady,
} from "./selectors";
import { finalizeMutation } from "./prototype-store";

export interface ActionResult<T> {
  state: PrototypeState;
  result: T;
}

export type AddCartItemResult =
  | "ADDED"
  | "RESTAURANT_CONFLICT"
  | "RESTAURANT_UNAVAILABLE"
  | "NOT_AVAILABLE";

export interface CreateOrderResult {
  orderId: string | null;
  error: string | null;
}

export function addCartItem(
  state: PrototypeState,
  menuItemId: string,
  replaceRestaurant = false,
): ActionResult<AddCartItemResult> {
  const menuItem = state.menuItems.find((item) => item.id === menuItemId);

  if (!menuItem?.available) {
    return { state, result: "NOT_AVAILABLE" };
  }

  const restaurant = getRestaurant(state, menuItem.restaurantId);
  if (
    !restaurant ||
    restaurant.id !== TEST_RESTAURANT_ID ||
    restaurant.status !== "PUBLISHED" ||
    !restaurant.isAcceptingOrders ||
    !restaurant.deliveryModes.includes("PLATFORM_DRIVER") ||
    !restaurant.paymentMethods.includes("ONLINE")
  ) {
    return { state, result: "RESTAURANT_UNAVAILABLE" };
  }

  if (
    state.cart.restaurantId &&
    state.cart.restaurantId !== menuItem.restaurantId &&
    !replaceRestaurant
  ) {
    return { state, result: "RESTAURANT_CONFLICT" };
  }

  const baseCart =
    state.cart.restaurantId && state.cart.restaurantId !== menuItem.restaurantId
      ? createEmptyCart(state.cart.address)
      : state.cart;
  const existingItem = baseCart.items.find(
    (item) => item.menuItemId === menuItemId,
  );
  const items = existingItem
    ? baseCart.items.map((item) =>
        item.menuItemId === menuItemId
          ? { ...item, quantity: item.quantity + 1 }
          : item,
      )
    : [
        ...baseCart.items,
        { menuItemId, quantity: 1, cookingComment: "" },
      ];

  const nextState = finalizeMutation(state, {
    ...state,
    cart: {
      ...baseCart,
      restaurantId: menuItem.restaurantId,
      items,
    },
  });

  return { state: nextState, result: "ADDED" };
}

export function setCartItemQuantity(
  state: PrototypeState,
  menuItemId: string,
  quantity: number,
): PrototypeState {
  const items = state.cart.items
    .map((item) =>
      item.menuItemId === menuItemId
        ? { ...item, quantity: Math.max(0, Math.trunc(quantity)) }
        : item,
    )
    .filter((item) => item.quantity > 0);
  const foodSubtotalCents = items.reduce((total, item) => {
    const menuItem = state.menuItems.find(
      (candidate) => candidate.id === item.menuItemId,
    );
    return total + (menuItem?.priceCents ?? 0) * item.quantity;
  }, 0);
  const paymentMethod =
    state.cart.paymentMethod === "CASH" &&
    (!state.platformSettings.platformDriverCashEnabled ||
      foodSubtotalCents < state.platformSettings.cashMinimumFoodSubtotalCents)
      ? "ONLINE"
      : state.cart.paymentMethod;

  return finalizeMutation(state, {
    ...state,
    cart: {
      ...state.cart,
      restaurantId: items.length > 0 ? state.cart.restaurantId : null,
      items,
      paymentMethod,
    },
  });
}

export function setCartItemComment(
  state: PrototypeState,
  menuItemId: string,
  cookingComment: string,
): PrototypeState {
  return finalizeMutation(state, {
    ...state,
    cart: {
      ...state.cart,
      items: state.cart.items.map((item) =>
        item.menuItemId === menuItemId
          ? { ...item, cookingComment }
          : item,
      ),
    },
  });
}

export function updateCartAddress(
  state: PrototypeState,
  patch: Partial<Omit<DeliveryAddress, "zoneId">>,
): PrototypeState {
  const addressWithoutZone = { ...state.cart.address, ...patch };
  const address: DeliveryAddress = {
    ...addressWithoutZone,
    zoneId: detectZoneId(
      addressWithoutZone.street,
      state,
      addressWithoutZone.house,
    ),
  };

  return finalizeMutation(state, {
    ...state,
    cart: { ...state.cart, address },
  });
}

export function setCartPaymentMethod(
  state: PrototypeState,
  paymentMethod: PaymentMethod,
): PrototypeState {
  if (paymentMethod === "CASH") {
    return state;
  }

  return finalizeMutation(state, {
    ...state,
    cart: { ...state.cart, paymentMethod },
  });
}

export function saveTariffs(
  state: PrototypeState,
  tariffs: TariffMatrix,
): PrototypeState {
  const defaults = createDefaultTariffs();
  const zoneIds = ["zone-1", "zone-2", "zone-3", "zone-4"] as const;
  const normalizedTariffs = Object.fromEntries(
    zoneIds.map((fromZoneId) => [
      fromZoneId,
      Object.fromEntries(
        zoneIds.map((toZoneId) => {
          const cents = tariffs[fromZoneId]?.[toZoneId];
          return [
            toZoneId,
            Number.isFinite(cents) && cents >= 0
              ? Math.round(cents)
              : defaults[fromZoneId][toZoneId],
          ];
        }),
      ),
    ]),
  ) as TariffMatrix;

  return finalizeMutation(state, { ...state, tariffs: normalizedTariffs });
}

export function restoreDefaultTariffs(state: PrototypeState): PrototypeState {
  return finalizeMutation(state, {
    ...state,
    tariffs: createDefaultTariffs(),
  });
}

export function createOrderFromCart(
  state: PrototypeState,
): ActionResult<CreateOrderResult> {
  const restaurant = getRestaurant(state, state.cart.restaurantId);

  if (state.cart.items.length === 0) {
    return {
      state,
      result: { orderId: null, error: "Корзина пуста." },
    };
  }

  if (!restaurant) {
    return {
      state,
      result: {
        orderId: null,
        error:
          "Корзина содержит некорректные позиции. Удалите их и добавьте блюда заново.",
      },
    };
  }

  if (
    restaurant.id !== TEST_RESTAURANT_ID ||
    restaurant.status !== "PUBLISHED" ||
    !restaurant.isAcceptingOrders ||
    !restaurant.deliveryModes.includes("PLATFORM_DRIVER") ||
    !restaurant.paymentMethods.includes("ONLINE")
  ) {
    return {
      state,
      result: {
        orderId: null,
        error:
          "Ресторан сейчас не принимает заказы. Выберите другой ресторан или повторите позже.",
      },
    };
  }

  if (state.cart.paymentMethod === "CASH") {
    return {
      state,
      result: {
        orderId: null,
        error: "Наличные сейчас отключены. Выберите оплату онлайн.",
      },
    };
  }

  if (state.cart.paymentMethod !== "ONLINE") {
    return {
      state,
      result: {
        orderId: null,
        error: "Выберите оплату онлайн.",
      },
    };
  }

  const hasMissingItem = state.cart.items.some(
    (cartItem) =>
      !state.menuItems.some(
        (menuItem) => menuItem.id === cartItem.menuItemId,
      ),
  );
  const hasUnavailableItem = state.cart.items.some((cartItem) => {
    const menuItem = state.menuItems.find(
      (candidate) => candidate.id === cartItem.menuItemId,
    );
    return Boolean(menuItem && !menuItem.available);
  });

  if (hasMissingItem || hasUnavailableItem) {
    return {
      state,
      result: {
        orderId: null,
        error: "Некоторые блюда больше недоступны. Обновите корзину.",
      },
    };
  }

  const hasCorruptedItem = state.cart.items.some((cartItem) => {
    const menuItem = state.menuItems.find(
      (candidate) => candidate.id === cartItem.menuItemId,
    );
    return (
      menuItem?.restaurantId !== restaurant.id ||
      !Number.isInteger(cartItem.quantity) ||
      cartItem.quantity <= 0
    );
  });
  const itemViews = getCartItemViews(state);

  if (hasCorruptedItem || itemViews.length !== state.cart.items.length) {
    return {
      state,
      result: {
        orderId: null,
        error:
          "Корзина содержит некорректные позиции. Удалите их и добавьте блюда заново.",
      },
    };
  }

  const pricing = calculateCartPricing(state);

  const customerZoneId = detectZoneId(
    state.cart.address.street,
    state,
    state.cart.address.house,
  );
  if (
    !isAddressReady(state.cart.address, state) ||
    pricing.deliveryFeeCents === null ||
    !customerZoneId
  ) {
    return {
      state,
      result: {
        orderId: null,
        error: "Укажите улицу из справочника и номер дома.",
      },
    };
  }

  const now = new Date().toISOString();
  const orderId = `order-${state.nextOrderNumber}`;
  const publicNumber = `DIR-${String(state.nextOrderNumber).padStart(4, "0")}`;
  const order: Order = {
    id: orderId,
    publicNumber,
    createdAt: now,
    updatedAt: now,
    customer: {
      id: state.customer.id,
      name: state.customer.name,
      phone: state.customer.phone,
    },
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      address: restaurant.address,
      zoneId: restaurant.zoneId,
    },
    address: { ...state.cart.address, zoneId: customerZoneId },
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "ONLINE",
    paymentStatus: "NOT_STARTED",
    paidAt: null,
    status: "RESTAURANT_REVIEW",
    preparationMinutes: null,
    expectedReadyAt: null,
    cancellationReason: null,
    items: itemViews.map(({ cartItem, menuItem, lineTotalCents }) => ({
      menuItemId: menuItem.id,
      name: menuItem.name,
      description: menuItem.description,
      unitPriceCents: menuItem.priceCents,
      quantity: cartItem.quantity,
      lineTotalCents,
      currencyCode: menuItem.currencyCode,
      cookingComment: cartItem.cookingComment,
    })),
    financials: {
      currencyCode: state.platformSettings.currencyCode,
      deliveryMode: "PLATFORM_DRIVER",
      restaurantCommissionRateBps:
        state.platformSettings.restaurantCommissionRateBps,
      restaurantCommissionCents: pricing.restaurantCommissionCents,
      foodSubtotalCents: pricing.foodSubtotalCents,
      deliveryFeeCents: pricing.deliveryFeeCents,
      smallOrderFeeCents: pricing.smallOrderFeeCents,
      platformGrossRevenueCents: pricing.platformGrossRevenueCents,
      driverPayoutCents: pricing.deliveryFeeCents,
      restaurantPayoutBeforeBankFeeCents:
        pricing.restaurantPayoutBeforeBankFeeCents,
      customerTotalCents: pricing.customerTotalCents ?? 0,
      restaurantZoneId: restaurant.zoneId,
      customerZoneId,
    },
    history: [
      {
        id: `${orderId}-history-1`,
        occurredAt: now,
        actor: "CLIENT",
        type: "STATUS",
        fromStatus: null,
        toStatus: "RESTAURANT_REVIEW",
        message: "Заказ отправлен ресторану на проверку.",
      },
    ],
  };

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      nextOrderNumber: state.nextOrderNumber + 1,
      cart: createEmptyCart(state.cart.address),
      orders: [...state.orders, order],
    },
    now,
  );

  return { state: nextState, result: { orderId, error: null } };
}

function replaceOrder(
  state: PrototypeState,
  orderId: string,
  update: (order: Order) => Order,
  timestamp: string,
): PrototypeState {
  return finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((order) =>
        order.id === orderId ? update(order) : order,
      ),
    },
    timestamp,
  );
}

export function acceptRestaurantOrder(
  state: PrototypeState,
  orderId: string,
  preparationMinutes: number,
): PrototypeState {
  const allowedMinutes = [10, 15, 20, 25, 30, 40];
  if (!allowedMinutes.includes(preparationMinutes)) {
    return state;
  }

  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (
    !targetOrder ||
    targetOrder.status !== "RESTAURANT_REVIEW" ||
    targetOrder.restaurant.id !== TEST_RESTAURANT_ID ||
    targetOrder.paymentMethod !== "ONLINE"
  ) {
    return state;
  }

  const now = new Date().toISOString();

  return replaceOrder(
    state,
    orderId,
    (order) => {
      return {
        ...order,
        status: "AWAITING_PAYMENT",
        paymentStatus: "AWAITING_PAYMENT",
        preparationMinutes,
        expectedReadyAt: null,
        updatedAt: now,
        history: [
          ...order.history,
          {
            id: `${order.id}-history-${order.history.length + 1}`,
            occurredAt: now,
            actor: "RESTAURANT",
            type: "STATUS",
            fromStatus: "RESTAURANT_REVIEW",
            toStatus: "AWAITING_PAYMENT",
            message: `Ресторан принял заказ. Время приготовления — ${preparationMinutes} минут. Ожидается онлайн-оплата.`,
          },
        ],
      };
    },
    now,
  );
}

export function rejectRestaurantOrder(
  state: PrototypeState,
  orderId: string,
  reason: string,
): PrototypeState {
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return state;
  }

  const now = new Date().toISOString();

  return replaceOrder(
    state,
    orderId,
    (order) => {
      if (order.status !== "RESTAURANT_REVIEW") {
        return order;
      }

      return {
        ...order,
        status: "CANCELED",
        cancellationReason: normalizedReason,
        updatedAt: now,
        history: [
          ...order.history,
          {
            id: `${order.id}-history-${order.history.length + 1}`,
            occurredAt: now,
            actor: "RESTAURANT",
            type: "STATUS",
            fromStatus: "RESTAURANT_REVIEW",
            toStatus: "CANCELED",
            message: `Ресторан отклонил заказ. Причина: ${normalizedReason}`,
          },
        ],
      };
    },
    now,
  );
}

export function simulateSuccessfulOnlinePayment(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  const now = new Date().toISOString();

  return replaceOrder(
    state,
    orderId,
    (order) => {
      if (
        order.status !== "AWAITING_PAYMENT" ||
        order.paymentMethod !== "ONLINE" ||
        order.paymentStatus === "PAID"
      ) {
        return order;
      }

      const preparationMinutes = order.preparationMinutes ?? 25;
      const expectedReadyAt = new Date(
        new Date(now).getTime() + preparationMinutes * 60_000,
      ).toISOString();
      const nextHistoryNumber = order.history.length + 1;

      return {
        ...order,
        paymentStatus: "PAID",
        paidAt: now,
        status: "PREPARING",
        expectedReadyAt,
        updatedAt: now,
        history: [
          ...order.history,
          {
            id: `${order.id}-history-${nextHistoryNumber}`,
            occurredAt: now,
            actor: "SYSTEM",
            type: "PAYMENT",
            fromStatus: "AWAITING_PAYMENT",
            toStatus: "AWAITING_PAYMENT",
            message: "Тестовая онлайн-оплата успешно подтверждена.",
          },
          {
            id: `${order.id}-history-${nextHistoryNumber + 1}`,
            occurredAt: now,
            actor: "SYSTEM",
            type: "STATUS",
            fromStatus: "AWAITING_PAYMENT",
            toStatus: "PREPARING",
            message: "Заказ передан ресторану в приготовление.",
          },
        ],
      };
    },
    now,
  );
}

export function markOrderReady(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  const now = new Date().toISOString();

  return replaceOrder(
    state,
    orderId,
    (order) => {
      if (order.status !== "PREPARING") {
        return order;
      }

      return {
        ...order,
        status: "READY",
        updatedAt: now,
        history: [
          ...order.history,
          {
            id: `${order.id}-history-${order.history.length + 1}`,
            occurredAt: now,
            actor: "RESTAURANT",
            type: "STATUS",
            fromStatus: "PREPARING",
            toStatus: "READY",
            message: "Ресторан отметил заказ как готовый и упакованный.",
          },
        ],
      };
    },
    now,
  );
}

export function resetPrototypeState(state: PrototypeState): PrototypeState {
  return finalizeMutation(state, createDefaultState());
}
