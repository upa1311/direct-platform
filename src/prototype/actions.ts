import {
  createDefaultState,
  createDefaultTariffs,
  createEmptyCart,
} from "./default-state";
import type {
  AppliedPromotionSnapshot,
  DeliveryAddress,
  DeliveryMode,
  FulfillmentChoice,
  MenuItemVariant,
  Order,
  OrderItemSnapshot,
  PaymentMethod,
  Promotion,
  PrototypeState,
  Restaurant,
  RestaurantDeliveryProvider,
  RestaurantDeliverySnapshot,
  RestaurantDeliverySettings,
  TariffMatrix,
} from "./models";
import {
  calculateCartPricing,
  canPlacePrototypeOrder,
  detectZoneId,
  getCartDeliveryMode,
  getCartItemViews,
  getRestaurant,
  isAddressReady,
  isCustomerNameValid,
  isCustomerPhoneValid,
  WORKING_RESTAURANT_IDS,
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

export interface CreateOrderOptions {
  isAddressConfirmed: boolean;
}

function sameLine(
  item: { menuItemId: string; variantId: string | null },
  menuItemId: string,
  variantId: string | null,
): boolean {
  return item.menuItemId === menuItemId && item.variantId === variantId;
}

export function addCartItem(
  state: PrototypeState,
  menuItemId: string,
  variantId: string | null = null,
  replaceRestaurant = false,
): ActionResult<AddCartItemResult> {
  const menuItem = state.menuItems.find((item) => item.id === menuItemId);

  if (!menuItem?.available) {
    return { state, result: "NOT_AVAILABLE" };
  }

  const restaurant = getRestaurant(state, menuItem.restaurantId);
  if (!restaurant || !canPlacePrototypeOrder(restaurant)) {
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
  const existingItem = baseCart.items.find((item) =>
    sameLine(item, menuItemId, variantId),
  );
  const items = existingItem
    ? baseCart.items.map((item) =>
        sameLine(item, menuItemId, variantId)
          ? { ...item, quantity: item.quantity + 1 }
          : item,
      )
    : [
        ...baseCart.items,
        { menuItemId, variantId, quantity: 1, cookingComment: "" },
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
  variantId: string | null,
  quantity: number,
): PrototypeState {
  const items = state.cart.items
    .map((item) =>
      sameLine(item, menuItemId, variantId)
        ? { ...item, quantity: Math.max(0, Math.trunc(quantity)) }
        : item,
    )
    .filter((item) => item.quantity > 0);

  if (items.length === 0) {
    return finalizeMutation(state, {
      ...state,
      cart: createEmptyCart(state.cart.address),
    });
  }

  return finalizeMutation(state, {
    ...state,
    cart: { ...state.cart, items },
  });
}

export function setCartItemComment(
  state: PrototypeState,
  menuItemId: string,
  variantId: string | null,
  cookingComment: string,
): PrototypeState {
  return finalizeMutation(state, {
    ...state,
    cart: {
      ...state.cart,
      items: state.cart.items.map((item) =>
        sameLine(item, menuItemId, variantId)
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

export function updateCustomerProfile(
  state: PrototypeState,
  patch: Partial<Pick<PrototypeState["customer"], "name" | "phone">>,
): PrototypeState {
  const phoneChanged =
    patch.phone !== undefined && patch.phone !== state.customer.phone;

  return finalizeMutation(state, {
    ...state,
    customer: {
      ...state.customer,
      ...patch,
      phoneVerified: phoneChanged ? false : state.customer.phoneVerified,
    },
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

export function setCartFulfillmentChoice(
  state: PrototypeState,
  fulfillmentChoice: FulfillmentChoice,
): PrototypeState {
  if (state.cart.fulfillmentChoice === fulfillmentChoice) {
    return state;
  }
  return finalizeMutation(state, {
    ...state,
    cart: {
      ...state.cart,
      fulfillmentChoice,
      paymentMethod: "ONLINE",
    },
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
  options: CreateOrderOptions,
): ActionResult<CreateOrderResult> {
  const restaurant = getRestaurant(state, state.cart.restaurantId);
  const deliveryMode = getCartDeliveryMode(state);
  const fail = (error: string): ActionResult<CreateOrderResult> => ({
    state,
    result: { orderId: null, error },
  });

  if (!isCustomerNameValid(state.customer.name)) {
    return fail("Укажите имя получателя.");
  }
  if (!isCustomerPhoneValid(state.customer.phone)) {
    return fail("Укажите телефон минимум с 7 цифрами.");
  }
  if (state.cart.items.length === 0) {
    return fail("Корзина пуста.");
  }
  if (!restaurant || !deliveryMode) {
    return fail(
      "Корзина содержит некорректные позиции. Удалите их и добавьте блюда заново.",
    );
  }
  if (!canPlacePrototypeOrder(restaurant)) {
    return fail(
      "Ресторан сейчас не принимает заказы. Выберите другой ресторан или повторите позже.",
    );
  }
  if (!restaurant.deliveryModes.includes(deliveryMode)) {
    return fail("Этот способ получения недоступен для ресторана.");
  }
  if (state.cart.paymentMethod !== "ONLINE") {
    return fail("Выберите оплату онлайн.");
  }

  const hasMissingOrUnavailable = state.cart.items.some((cartItem) => {
    const menuItem = state.menuItems.find(
      (candidate) => candidate.id === cartItem.menuItemId,
    );
    return !menuItem || !menuItem.available;
  });
  if (hasMissingOrUnavailable) {
    return fail("Некоторые блюда больше недоступны. Обновите корзину.");
  }

  const itemViews = getCartItemViews(state);
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
  if (hasCorruptedItem || itemViews.length !== state.cart.items.length) {
    return fail(
      "Корзина содержит некорректные позиции. Удалите их и добавьте блюда заново.",
    );
  }

  const isDelivery = deliveryMode !== "PICKUP";
  const customerZoneId = isDelivery
    ? detectZoneId(state.cart.address.street, state, state.cart.address.house)
    : null;

  if (isDelivery && !options.isAddressConfirmed) {
    return fail("Подтвердите адрес доставки.");
  }
  if (
    isDelivery &&
    (!isAddressReady(state.cart.address, state) || !customerZoneId)
  ) {
    return fail("Укажите улицу из справочника и номер дома.");
  }

  const pricing = calculateCartPricing(state);

  if (deliveryMode === "RESTAURANT_DELIVERY") {
    if (pricing.restaurantDeliveryStatus === "ZONE_NOT_SERVED") {
      return fail("Ресторан пока не доставляет по этому адресу.");
    }
    if (pricing.restaurantDeliveryStatus === "BELOW_MINIMUM") {
      return fail("Стоимость еды меньше минимальной суммы заказа.");
    }
  }

  if (
    pricing.deliveryFeeCents === null ||
    pricing.driverPayoutCents === null ||
    pricing.customerTotalCents === null
  ) {
    return fail("Не удалось рассчитать заказ.");
  }

  const settings = restaurant.restaurantDeliverySettings;
  const restaurantDeliverySnapshot: RestaurantDeliverySnapshot | null =
    deliveryMode === "RESTAURANT_DELIVERY" && settings
      ? {
          minimumOrderCents: settings.minimumOrderCents,
          freeDeliveryThresholdCents: settings.freeDeliveryThresholdCents,
          standardDeliveryFeeCents:
            pricing.standardRestaurantDeliveryFeeCents ??
            pricing.deliveryFeeCents,
          appliedDeliveryFeeCents: pricing.deliveryFeeCents,
          freeDeliveryApplied:
            settings.freeDeliveryThresholdCents !== null &&
            pricing.deliveryFeeCents === 0,
        }
      : null;

  const appliedPromotion: AppliedPromotionSnapshot | null =
    pricing.appliedPromotion;

  const items: OrderItemSnapshot[] = itemViews.map((view) => ({
    menuItemId: view.menuItem.id,
    name: view.menuItem.name,
    description: view.menuItem.description,
    quantity: view.quantity,
    baseUnitPriceCents: view.baseUnitPriceCents,
    selectedVariantId: view.variant?.id ?? null,
    selectedVariantName: view.variant?.name ?? null,
    variantPriceDeltaCents: view.variantDeltaCents,
    finalUnitPriceCents: view.finalUnitPriceCents,
    lineSubtotalBeforeDiscountCents: view.lineTotalCents,
    promotionDiscountCents: view.promotionDiscountCents,
    finalLineTotalCents: view.lineTotalCents - view.promotionDiscountCents,
    currencyCode: view.menuItem.currencyCode,
    cookingComment: view.cartItem.cookingComment,
    unitPriceCents: view.finalUnitPriceCents,
    lineTotalCents: view.lineTotalCents - view.promotionDiscountCents,
  }));

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
      name: state.customer.name.trim(),
      phone: state.customer.phone.trim(),
    },
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      address: restaurant.address,
      zoneId: restaurant.zoneId,
    },
    address: isDelivery
      ? { ...state.cart.address, zoneId: customerZoneId }
      : null,
    deliveryMode,
    paymentMethod: "ONLINE",
    paymentStatus: "NOT_STARTED",
    paidAt: null,
    status: "RESTAURANT_REVIEW",
    preparationMinutes: null,
    expectedReadyAt: null,
    cancellationReason: null,
    items,
    financials: {
      currencyCode: state.platformSettings.currencyCode,
      deliveryMode,
      deliveryProvider: restaurant.deliveryProvider,
      restaurantCommissionRateBps: restaurant.commissionRateBps,
      restaurantCommissionCents: pricing.restaurantCommissionCents,
      foodSubtotalBeforeDiscountsCents:
        pricing.foodSubtotalBeforeDiscountsCents,
      variantSurchargeSubtotalCents: pricing.variantSurchargeSubtotalCents,
      promotionDiscountCents: pricing.promotionDiscountCents,
      foodSubtotalCents: pricing.foodSubtotalCents,
      deliveryFeeCents: pricing.deliveryFeeCents,
      standardRestaurantDeliveryFeeCents:
        pricing.standardRestaurantDeliveryFeeCents,
      freeDeliveryThresholdCents: pricing.freeDeliveryThresholdCents,
      minimumOrderCents: pricing.minimumOrderCents,
      smallOrderFeeCents: pricing.smallOrderFeeCents,
      platformGrossRevenueCents: pricing.platformGrossRevenueCents,
      driverPayoutCents: pricing.driverPayoutCents,
      restaurantPayoutBeforeBankFeeCents:
        pricing.restaurantPayoutBeforeBankFeeCents,
      customerTotalCents: pricing.customerTotalCents,
      restaurantZoneId: restaurant.zoneId,
      customerZoneId,
      appliedPromotion,
      restaurantDelivery: restaurantDeliverySnapshot,
    },
    history: [
      {
        id: `${orderId}-history-1`,
        occurredAt: now,
        actor: "CLIENT",
        type: "STATUS",
        fromStatus: null,
        toStatus: "RESTAURANT_REVIEW",
        message:
          deliveryMode === "PICKUP"
            ? "Заказ на самовывоз отправлен ресторану на проверку."
            : "Заказ с доставкой отправлен ресторану на проверку.",
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

function isWorkingRestaurantOrder(order: Order | undefined): boolean {
  return Boolean(
    order &&
      (WORKING_RESTAURANT_IDS as readonly string[]).includes(
        order.restaurant.id,
      ),
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
    !isWorkingRestaurantOrder(targetOrder) ||
    targetOrder.paymentMethod !== "ONLINE"
  ) {
    return state;
  }

  const now = new Date().toISOString();

  return replaceOrder(
    state,
    orderId,
    (order) => ({
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
    }),
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

      const nextStatus =
        order.deliveryMode === "PICKUP" ? "READY_FOR_PICKUP" : "READY";
      const message =
        order.deliveryMode === "PICKUP"
          ? "Заказ готов к выдаче клиенту."
          : order.deliveryMode === "RESTAURANT_DELIVERY"
            ? "Заказ готов, ожидает курьера ресторана."
            : "Ресторан отметил заказ как готовый и упакованный.";

      return {
        ...order,
        status: nextStatus,
        updatedAt: now,
        history: [
          ...order.history,
          {
            id: `${order.id}-history-${order.history.length + 1}`,
            occurredAt: now,
            actor: "RESTAURANT",
            type: "STATUS",
            fromStatus: "PREPARING",
            toStatus: nextStatus,
            message,
          },
        ],
      };
    },
    now,
  );
}

function advanceCourierStatus(
  state: PrototypeState,
  orderId: string,
  fromStatus: Order["status"],
  toStatus: Order["status"],
  message: string,
): PrototypeState {
  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (
    !targetOrder ||
    targetOrder.deliveryMode !== "RESTAURANT_DELIVERY" ||
    targetOrder.status !== fromStatus
  ) {
    return state;
  }
  const now = new Date().toISOString();
  return replaceOrder(
    state,
    orderId,
    (order) => ({
      ...order,
      status: toStatus,
      updatedAt: now,
      history: [
        ...order.history,
        {
          id: `${order.id}-history-${order.history.length + 1}`,
          occurredAt: now,
          actor: "RESTAURANT",
          type: "STATUS",
          fromStatus,
          toStatus,
          message,
        },
      ],
    }),
    now,
  );
}

export function markOrderOutForDelivery(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  return advanceCourierStatus(
    state,
    orderId,
    "READY",
    "OUT_FOR_DELIVERY",
    "Курьер ресторана выехал.",
  );
}

export function markOrderArriving(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  return advanceCourierStatus(
    state,
    orderId,
    "OUT_FOR_DELIVERY",
    "ARRIVING",
    "Курьер ресторана скоро будет.",
  );
}

export function markOrderDelivered(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  return advanceCourierStatus(
    state,
    orderId,
    "ARRIVING",
    "DELIVERED",
    "Заказ доставлен клиенту.",
  );
}

export function markOrderPickedUp(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (
    !targetOrder ||
    targetOrder.deliveryMode !== "PICKUP" ||
    targetOrder.status !== "READY_FOR_PICKUP"
  ) {
    return state;
  }

  const now = new Date().toISOString();
  return replaceOrder(
    state,
    orderId,
    (order) => ({
      ...order,
      status: "PICKED_UP",
      updatedAt: now,
      history: [
        ...order.history,
        {
          id: `${order.id}-history-${order.history.length + 1}`,
          occurredAt: now,
          actor: "RESTAURANT",
          type: "STATUS",
          fromStatus: "READY_FOR_PICKUP",
          toStatus: "PICKED_UP",
          message: "Заказ выдан клиенту",
        },
      ],
    }),
    now,
  );
}

// --- Административные действия ---------------------------------------------

const ZONE_IDS = ["zone-1", "zone-2", "zone-3", "zone-4"] as const;

function defaultRestaurantDeliverySettings(): RestaurantDeliverySettings {
  return {
    minimumOrderCents: 1000,
    freeDeliveryThresholdCents: 2500,
    servedZoneIds: [...ZONE_IDS],
    zoneFeesCents: { "zone-1": 300, "zone-2": 350, "zone-3": 400, "zone-4": 450 },
  };
}

function deliveryModesForProvider(
  provider: RestaurantDeliveryProvider,
  pickupEnabled: boolean,
): DeliveryMode[] {
  const base: DeliveryMode =
    provider === "RESTAURANT" ? "RESTAURANT_DELIVERY" : "PLATFORM_DRIVER";
  return pickupEnabled ? [base, "PICKUP"] : [base];
}

function nextRestaurantId(state: PrototypeState): string {
  const max = state.restaurants.reduce((acc, restaurant) => {
    const match = /^restaurant-(\d+)$/.exec(restaurant.id);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return `restaurant-${max + 1}`;
}

export interface RestaurantFormInput {
  name: string;
  description: string;
  address: string;
  zoneId: Restaurant["zoneId"];
  deliveryProvider: RestaurantDeliveryProvider;
  commissionRateBps: number;
  defaultPreparationMinutes: number;
  pickupEnabled: boolean;
  status: Restaurant["status"];
  isAcceptingOrders: boolean;
  restaurantDeliverySettings: RestaurantDeliverySettings | null;
}

export function createRestaurant(
  state: PrototypeState,
  input: RestaurantFormInput,
): ActionResult<{ restaurantId: string }> {
  const id = nextRestaurantId(state);
  const restaurant: Restaurant = {
    id,
    name: input.name.trim() || id,
    description: input.description,
    address: input.address,
    zoneId: input.zoneId,
    status: input.status,
    isAcceptingOrders: input.isAcceptingOrders,
    deliveryModes: deliveryModesForProvider(
      input.deliveryProvider,
      input.pickupEnabled,
    ),
    paymentMethods: ["ONLINE"],
    defaultPreparationMinutes: input.defaultPreparationMinutes,
    recommendationRank: state.restaurants.length + 1,
    deliveryProvider: input.deliveryProvider,
    pickupEnabled: input.pickupEnabled,
    commissionRateBps: input.commissionRateBps,
    restaurantDeliverySettings:
      input.deliveryProvider === "RESTAURANT"
        ? (input.restaurantDeliverySettings ??
          defaultRestaurantDeliverySettings())
        : input.restaurantDeliverySettings,
  };
  const nextState = finalizeMutation(state, {
    ...state,
    restaurants: [...state.restaurants, restaurant],
  });
  return { state: nextState, result: { restaurantId: id } };
}

export function updateRestaurant(
  state: PrototypeState,
  restaurantId: string,
  patch: Partial<RestaurantFormInput>,
): PrototypeState {
  const target = state.restaurants.find((r) => r.id === restaurantId);
  if (!target) {
    return state;
  }
  const deliveryProvider = patch.deliveryProvider ?? target.deliveryProvider;
  const pickupEnabled = patch.pickupEnabled ?? target.pickupEnabled;
  const settings =
    patch.restaurantDeliverySettings !== undefined
      ? patch.restaurantDeliverySettings
      : target.restaurantDeliverySettings;

  const nextRestaurant: Restaurant = {
    ...target,
    name: patch.name ?? target.name,
    description: patch.description ?? target.description,
    address: patch.address ?? target.address,
    zoneId: patch.zoneId ?? target.zoneId,
    status: patch.status ?? target.status,
    isAcceptingOrders: patch.isAcceptingOrders ?? target.isAcceptingOrders,
    defaultPreparationMinutes:
      patch.defaultPreparationMinutes ?? target.defaultPreparationMinutes,
    commissionRateBps: patch.commissionRateBps ?? target.commissionRateBps,
    deliveryProvider,
    pickupEnabled,
    deliveryModes: deliveryModesForProvider(deliveryProvider, pickupEnabled),
    restaurantDeliverySettings:
      deliveryProvider === "RESTAURANT"
        ? (settings ?? defaultRestaurantDeliverySettings())
        : settings,
  };

  return finalizeMutation(state, {
    ...state,
    restaurants: state.restaurants.map((restaurant) =>
      restaurant.id === restaurantId ? nextRestaurant : restaurant,
    ),
  });
}

export function updateMenuItemVariants(
  state: PrototypeState,
  menuItemId: string,
  variants: MenuItemVariant[] | null,
): PrototypeState {
  const normalized =
    variants && variants.length > 0
      ? variants.map((variant, index) => ({
          ...variant,
          isDefault: variant.isDefault && index === variants.findIndex((v) => v.isDefault),
        }))
      : undefined;
  const withDefault =
    normalized && !normalized.some((v) => v.isDefault) && normalized.length > 0
      ? normalized.map((v, i) => ({ ...v, isDefault: i === 0 }))
      : normalized;

  return finalizeMutation(state, {
    ...state,
    menuItems: state.menuItems.map((menuItem) =>
      menuItem.id === menuItemId
        ? { ...menuItem, variants: withDefault }
        : menuItem,
    ),
  });
}

export function upsertPromotion(
  state: PrototypeState,
  promotion: Promotion,
): PrototypeState {
  // Участвовать могут только блюда того же ресторана.
  const eligibleMenuItemIds = promotion.eligibleMenuItemIds.filter((id) =>
    state.menuItems.some(
      (item) => item.id === id && item.restaurantId === promotion.restaurantId,
    ),
  );
  const now = new Date().toISOString();
  const exists = state.promotions.some((p) => p.id === promotion.id);
  const nextPromotion: Promotion = {
    ...promotion,
    eligibleMenuItemIds,
    updatedAt: now,
  };
  const promotions = exists
    ? state.promotions.map((p) =>
        p.id === promotion.id ? nextPromotion : p,
      )
    : [...state.promotions, { ...nextPromotion, createdAt: now }];

  return finalizeMutation(state, { ...state, promotions });
}

export function setPromotionEnabled(
  state: PrototypeState,
  promotionId: string,
  enabled: boolean,
): PrototypeState {
  return finalizeMutation(state, {
    ...state,
    promotions: state.promotions.map((promotion) =>
      promotion.id === promotionId
        ? { ...promotion, enabled, updatedAt: new Date().toISOString() }
        : promotion,
    ),
  });
}

export function resetPrototypeState(state: PrototypeState): PrototypeState {
  return finalizeMutation(state, createDefaultState());
}
