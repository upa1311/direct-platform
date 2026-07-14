import {
  cloneWeeklySchedule,
  createDefaultState,
  createDefaultTariffs,
  createEmptyCart,
  createRestaurantExtras,
} from "./default-state";
import type {
  AppliedPromotionSnapshot,
  CartItem,
  DeliveryAddress,
  DeliveryMode,
  DriverProfile,
  DriverStatus,
  FulfillmentChoice,
  MenuItemVariant,
  Order,
  OrderHistoryEvent,
  OrderItemSnapshot,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PickupPaymentMethod,
  Promotion,
  PrototypeState,
  Restaurant,
  RestaurantDeliveryProvider,
  RestaurantDeliverySnapshot,
  RestaurantDeliverySettings,
  SettlementEntry,
  TariffMatrix,
  WeeklySchedule,
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
import {
  computePickupSettlement,
  generatePickupCode,
  validatePickupPayment,
} from "./pricing-engine";
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

  // Единственный источник истины для доставки — корректно выбранная улица и
  // заполненный дом (isAddressReady). Отдельное sessionStorage-подтверждение
  // адреса больше не требуется (см. §3): заказ не блокируется молча.
  if (
    isDelivery &&
    (!isAddressReady(state.cart.address, state) || !customerZoneId)
  ) {
    return fail("Введите адрес доставки");
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

  const isPickup = deliveryMode === "PICKUP";
  const isRestaurantDelivery = deliveryMode === "RESTAURANT_DELIVERY";
  // Самовывоз: отдельная финансовая модель (клиент платит ресторану на точке).
  const pickup = isPickup
    ? computePickupSettlement({
        foodSubtotalCents: pricing.foodSubtotalCents,
        commissionRateBps: restaurant.pickupCommissionRateBps,
        smallOrderFeeCents: pricing.smallOrderFeeCents,
      })
    : null;
  // Способ и статус оплаты определяются фактическим режимом:
  // PICKUP — оплата в ресторане; RESTAURANT_DELIVERY — наличные курьеру
  // ресторана (Direct деньги клиента не удерживает); PLATFORM_DRIVER — онлайн.
  const paymentMethod: PaymentMethod = isPickup
    ? "PAY_AT_RESTAURANT"
    : isRestaurantDelivery
      ? "CASH_TO_RESTAURANT_COURIER"
      : "ONLINE";
  const paymentStatus: PaymentStatus = isPickup
    ? "DUE_AT_PICKUP"
    : isRestaurantDelivery
      ? "DUE_TO_RESTAURANT_COURIER"
      : "NOT_STARTED";
  const pickupCode = isPickup
    ? generatePickupCode(state.nextOrderNumber)
    : null;
  const restaurantCommissionRateBps = isPickup
    ? restaurant.pickupCommissionRateBps
    : restaurant.commissionRateBps;
  const restaurantCommissionCents = pickup
    ? pickup.restaurantCommissionCents
    : pricing.restaurantCommissionCents;
  const platformGrossRevenueCents = pickup
    ? pickup.platformCommissionReceivableCents
    : pricing.platformGrossRevenueCents;

  // Кто собирает деньги клиента, выплаты и причитающаяся Direct комиссия.
  // RESTAURANT_DELIVERY (§9–10): клиент платит наличными курьеру ресторана —
  // всю сумму получает ресторан (platformCollected = 0), Direct удерживает
  // расчётную комиссию 7% (platformCommissionReceivable). Доставка не входит
  // в комиссионную базу, small-order fee не применяется, driverPayout = 0.
  // Фактическое начисление комиссии — только после доставки (settlement).
  const customerTotalCents = pricing.customerTotalCents;
  const driverPayoutCents = isPickup ? 0 : pricing.driverPayoutCents;
  const restaurantPayoutBeforeBankFeeCents = isPickup
    ? 0
    : pricing.restaurantPayoutBeforeBankFeeCents;
  const restaurantCollectedFromCustomerCents = pickup
    ? pickup.restaurantCollectedFromCustomerCents
    : isRestaurantDelivery
      ? customerTotalCents
      : 0;
  const platformCollectedFromCustomerCents =
    pickup || isRestaurantDelivery ? 0 : customerTotalCents;
  const platformCommissionReceivableCents = pickup
    ? pickup.platformCommissionReceivableCents
    : isRestaurantDelivery
      ? pricing.restaurantCommissionCents
      : 0;
  const restaurantNetAfterPlatformCommissionCents = pickup
    ? pickup.restaurantNetAfterPlatformCommissionCents
    : isRestaurantDelivery
      ? customerTotalCents - pricing.restaurantCommissionCents
      : pricing.restaurantPayoutBeforeBankFeeCents;

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
    paymentMethod,
    paymentStatus,
    paidAt: null,
    status: "RESTAURANT_REVIEW",
    preparationMinutes: null,
    expectedReadyAt: null,
    cancellationReason: null,
    pickupCode,
    pickupCodeUsed: false,
    assignedDriverId: null,
    driverAssignedAt: null,
    items,
    financials: {
      currencyCode: state.platformSettings.currencyCode,
      deliveryMode,
      deliveryProvider: restaurant.deliveryProvider,
      restaurantCommissionRateBps,
      restaurantCommissionCents,
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
      platformGrossRevenueCents,
      driverPayoutCents,
      restaurantPayoutBeforeBankFeeCents,
      customerTotalCents,
      restaurantZoneId: restaurant.zoneId,
      customerZoneId,
      appliedPromotion,
      restaurantDelivery: restaurantDeliverySnapshot,
      restaurantCollectedFromCustomerCents,
      platformCollectedFromCustomerCents,
      platformCommissionReceivableCents,
      restaurantNetAfterPlatformCommissionCents,
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

/** Тип автора действия над заказом. */
export type OrderActionActor = "RESTAURANT" | "ADMIN";

/**
 * Общий transition над заказом с явным автором. Кабинет ресторана вызывает те
 * же actions с actor="RESTAURANT" (по умолчанию), а `/admin/orders` — c "ADMIN".
 * Финансовая и статусная логика едина; расходится только автор и текст истории.
 */
export function acceptRestaurantOrder(
  state: PrototypeState,
  orderId: string,
  preparationMinutes: number,
  actor: OrderActionActor = "RESTAURANT",
): PrototypeState {
  const allowedMinutes = [10, 15, 20, 25, 30, 40];
  if (!allowedMinutes.includes(preparationMinutes)) {
    return state;
  }

  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (
    !targetOrder ||
    targetOrder.status !== "RESTAURANT_REVIEW" ||
    !isWorkingRestaurantOrder(targetOrder)
  ) {
    return state;
  }

  const now = new Date().toISOString();
  const acceptedBy =
    actor === "ADMIN"
      ? "Администратор Direct принял заказ от имени ресторана"
      : "Ресторан принял заказ";

  // Оплата не онлайн (самовывоз в ресторане либо наличные курьеру ресторана):
  // онлайн-оплата не запускается, AWAITING_PAYMENT не используется — заказ
  // сразу переходит в приготовление.
  if (
    targetOrder.paymentMethod === "PAY_AT_RESTAURANT" ||
    targetOrder.paymentMethod === "CASH_TO_RESTAURANT_COURIER"
  ) {
    const isCourierCash =
      targetOrder.paymentMethod === "CASH_TO_RESTAURANT_COURIER";
    const expectedReadyAt = new Date(
      new Date(now).getTime() + preparationMinutes * 60_000,
    ).toISOString();
    return replaceOrder(
      state,
      orderId,
      (order) => ({
        ...order,
        status: "PREPARING",
        preparationMinutes,
        expectedReadyAt,
        updatedAt: now,
        history: [
          ...order.history,
          {
            id: `${order.id}-history-${order.history.length + 1}`,
            occurredAt: now,
            actor,
            type: "STATUS",
            fromStatus: "RESTAURANT_REVIEW",
            toStatus: "PREPARING",
            message: isCourierCash
              ? `${acceptedBy}. Время приготовления — ${preparationMinutes} минут. Оплата наличными курьеру ресторана при получении.`
              : `${acceptedBy}. Время приготовления — ${preparationMinutes} минут. Оплата в ресторане при получении.`,
          },
        ],
      }),
      now,
    );
  }

  if (targetOrder.paymentMethod !== "ONLINE") {
    return state;
  }

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
          actor,
          type: "STATUS",
          fromStatus: "RESTAURANT_REVIEW",
          toStatus: "AWAITING_PAYMENT",
          message: `${acceptedBy}. Время приготовления — ${preparationMinutes} минут. Ожидается онлайн-оплата.`,
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
  actor: OrderActionActor = "RESTAURANT",
): PrototypeState {
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return state;
  }

  const now = new Date().toISOString();
  const rejectedBy =
    actor === "ADMIN"
      ? "Администратор Direct отклонил заказ от имени ресторана"
      : "Ресторан отклонил заказ";

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
            actor,
            type: "STATUS",
            fromStatus: "RESTAURANT_REVIEW",
            toStatus: "CANCELED",
            message: `${rejectedBy}. Причина: ${normalizedReason}`,
          },
        ],
      };
    },
    now,
  );
}

export interface ClientCancelResult {
  ok: boolean;
  error: string | null;
}

/**
 * Клиентская отмена заказа (§10–14). Разрешена ТОЛЬКО пока ресторан ещё не
 * принял заказ (status === RESTAURANT_REVIEW). Проверка статуса выполняется в
 * самом action — защита от гонки, даже если UI успел показать кнопку. Причина
 * обязательна, actor = CLIENT. Не меняет financial snapshot, цены, корзину,
 * settlements; settlement НЕ создаётся. Повторный вызов после отмены вернёт
 * ошибку (статус уже CANCELED) — второе событие не добавляется.
 */
export function cancelOrderByClient(
  state: PrototypeState,
  orderId: string,
  reason: string,
): ActionResult<ClientCancelResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const fail = (error: string): ActionResult<ClientCancelResult> => ({
    state,
    result: { ok: false, error },
  });
  if (!order) {
    return fail("Заказ не найден.");
  }
  if (order.status !== "RESTAURANT_REVIEW") {
    return fail(
      "Ресторан уже принял заказ. Для отмены свяжитесь с рестораном или поддержкой.",
    );
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return fail("Укажите причину отмены.");
  }

  const now = new Date().toISOString();
  const nextState = replaceOrder(
    state,
    orderId,
    (o) => ({
      ...o,
      status: "CANCELED",
      cancellationReason: normalizedReason,
      updatedAt: now,
      history: [
        ...o.history,
        {
          id: `${o.id}-history-${o.history.length + 1}`,
          occurredAt: now,
          actor: "CLIENT",
          type: "STATUS",
          fromStatus: "RESTAURANT_REVIEW",
          toStatus: "CANCELED",
          message: `Клиент отменил заказ. Причина: ${normalizedReason}`,
        },
      ],
    }),
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

export interface RepeatOrderResult {
  ok: boolean;
  error: string | null;
  /** Названия/сообщения о недоступных позициях (пусто при успехе). */
  unavailableItems: string[];
  /** Хотя бы одна актуальная цена отличается от снимка заказа. */
  pricesChanged: boolean;
  /** Прежний способ получения недоступен — выбран другой безопасный. */
  fulfillmentChanged: boolean;
}

/**
 * Повтор завершённого заказа: формирует НОВУЮ корзину из АКТУАЛЬНЫХ данных
 * (§3–9). Не копирует старые цены/скидки/финансовые снимки — итог пересчитает
 * обычный pricing engine в корзине. Атомарно: сначала проверяет ресторан и все
 * позиции (наличие, тот же ресторан, доступность, доступность размера), и лишь
 * при полной валидности заменяет корзину. При любой недоступной позиции корзина
 * НЕ меняется и возвращается полный список недоступных позиций.
 */
export function repeatOrderToCart(
  state: PrototypeState,
  orderId: string,
): ActionResult<RepeatOrderResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const fail = (
    error: string,
    unavailableItems: string[] = [],
  ): ActionResult<RepeatOrderResult> => ({
    state,
    result: {
      ok: false,
      error,
      unavailableItems,
      pricesChanged: false,
      fulfillmentChanged: false,
    },
  });

  if (!order) {
    return fail("Заказ не найден.");
  }

  const restaurant = getRestaurant(state, order.restaurant.id);
  if (!restaurant || !canPlacePrototypeOrder(restaurant)) {
    return fail("Ресторан сейчас недоступен для повторного заказа.");
  }

  const unavailableItems: string[] = [];
  const newItems: CartItem[] = [];
  let pricesChanged = false;

  for (const snap of order.items) {
    const menuItem = state.menuItems.find((m) => m.id === snap.menuItemId);
    if (
      !menuItem ||
      menuItem.restaurantId !== restaurant.id ||
      !menuItem.available
    ) {
      unavailableItems.push(snap.name);
      continue;
    }

    let variantId: string | null = null;
    let currentVariantDeltaCents = 0;
    if (snap.selectedVariantId) {
      const variant = (menuItem.variants ?? []).find(
        (v) => v.id === snap.selectedVariantId,
      );
      if (!variant || !variant.available) {
        const sizeName = snap.selectedVariantName ?? "выбранный";
        unavailableItems.push(
          `${snap.name} — размер «${sizeName}» сейчас недоступен.`,
        );
        continue;
      }
      variantId = variant.id;
      currentVariantDeltaCents = variant.priceDeltaCents;
    }

    // Сравнение старой и актуальной цены (база + доплата за выбранный размер).
    if (
      menuItem.priceCents !== snap.baseUnitPriceCents ||
      currentVariantDeltaCents !== snap.variantPriceDeltaCents
    ) {
      pricesChanged = true;
    }

    newItems.push({
      menuItemId: menuItem.id,
      variantId,
      quantity: snap.quantity,
      cookingComment: snap.cookingComment ?? "",
    });
  }

  if (unavailableItems.length > 0 || newItems.length === 0) {
    return fail("Не удалось повторить заказ.", unavailableItems);
  }

  // Способ получения: сохранить прежний, если ресторан его поддерживает.
  const supportsDelivery =
    restaurant.deliveryModes.includes("PLATFORM_DRIVER") ||
    restaurant.deliveryModes.includes("RESTAURANT_DELIVERY");
  const supportsPickup = restaurant.deliveryModes.includes("PICKUP");
  const desired: FulfillmentChoice =
    order.deliveryMode === "PICKUP" ? "PICKUP" : "DELIVERY";
  const desiredSupported =
    desired === "PICKUP" ? supportsPickup : supportsDelivery;
  let fulfillmentChoice = desired;
  let fulfillmentChanged = false;
  if (!desiredSupported) {
    fulfillmentChoice = supportsDelivery ? "DELIVERY" : "PICKUP";
    fulfillmentChanged = true;
  }

  const now = new Date().toISOString();
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      // Адрес и (через state.customer) контактные данные не очищаем.
      cart: {
        ...createEmptyCart(state.cart.address),
        restaurantId: restaurant.id,
        items: newItems,
        fulfillmentChoice,
        // Инвариант клиентской корзины — ONLINE; фактический способ оплаты
        // выводится по deliveryMode при создании заказа (PAY_AT_RESTAURANT /
        // CASH_TO_RESTAURANT_COURIER / ONLINE).
        paymentMethod: "ONLINE",
      },
    },
    now,
  );

  return {
    state: nextState,
    result: {
      ok: true,
      error: null,
      unavailableItems: [],
      pricesChanged,
      fulfillmentChanged,
    },
  };
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
  actor: OrderActionActor = "RESTAURANT",
): PrototypeState {
  const now = new Date().toISOString();
  const readyPrefix =
    actor === "ADMIN" ? "Администратор Direct отметил готовность. " : "";

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
            : "Заказ готов и упакован.";

      return {
        ...order,
        status: nextStatus,
        updatedAt: now,
        history: [
          ...order.history,
          {
            id: `${order.id}-history-${order.history.length + 1}`,
            occurredAt: now,
            actor,
            type: "STATUS",
            fromStatus: "PREPARING",
            toStatus: nextStatus,
            message: `${readyPrefix}${message}`,
          },
        ],
      };
    },
    now,
  );
}

/**
 * Общий шаг курьерской доставки для обоих режимов (RESTAURANT_DELIVERY и
 * PLATFORM_DRIVER). Для водителя Direct переход READY → OUT_FOR_DELIVERY
 * разрешён только при назначенном водителе (§3). Все проверки — в домене.
 */
function advanceCourierStatus(
  state: PrototypeState,
  orderId: string,
  fromStatus: Order["status"],
  toStatus: Order["status"],
  restaurantMessage: string,
  platformMessage: string,
  actor: OrderActionActor = "RESTAURANT",
  requireDriverForPlatform = false,
): PrototypeState {
  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (
    !targetOrder ||
    (targetOrder.deliveryMode !== "RESTAURANT_DELIVERY" &&
      targetOrder.deliveryMode !== "PLATFORM_DRIVER") ||
    targetOrder.status !== fromStatus
  ) {
    return state;
  }
  if (
    requireDriverForPlatform &&
    targetOrder.deliveryMode === "PLATFORM_DRIVER" &&
    !targetOrder.assignedDriverId
  ) {
    return state;
  }
  const now = new Date().toISOString();
  const message =
    targetOrder.deliveryMode === "PLATFORM_DRIVER"
      ? platformMessage
      : restaurantMessage;
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
          actor,
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
  actor: OrderActionActor = "RESTAURANT",
): PrototypeState {
  return advanceCourierStatus(
    state,
    orderId,
    "READY",
    "OUT_FOR_DELIVERY",
    "Курьер ресторана выехал.",
    "Водитель Direct выехал.",
    actor,
    true,
  );
}

export function markOrderArriving(
  state: PrototypeState,
  orderId: string,
  actor: OrderActionActor = "RESTAURANT",
): PrototypeState {
  return advanceCourierStatus(
    state,
    orderId,
    "OUT_FOR_DELIVERY",
    "ARRIVING",
    "Курьер ресторана скоро будет.",
    "Водитель Direct скоро будет.",
    actor,
    false,
  );
}

/**
 * Атомарное завершение доставки собственным курьером ресторана (§11): один
 * шаг ARRIVING → DELIVERED, который также фиксирует получение наличных и
 * создаёт единственную неизменяемую settlement-запись комиссии Direct.
 *
 * Комиссия начисляется только здесь (по факту доставки). Повторное нажатие не
 * создаёт вторую запись: переход разрешён лишь из ARRIVING, а settlement
 * защищён идемпотентным id. Отменённый/недоставленный заказ settlement не
 * создаёт (в ARRIVING он ещё не попадает при отмене).
 */
export function markOrderDelivered(
  state: PrototypeState,
  orderId: string,
  actor: OrderActionActor = "RESTAURANT",
): PrototypeState {
  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (
    !targetOrder ||
    targetOrder.deliveryMode !== "RESTAURANT_DELIVERY" ||
    targetOrder.status !== "ARRIVING"
  ) {
    return state;
  }

  const now = new Date().toISOString();
  const nextHistoryNumber = targetOrder.history.length + 1;
  const deliveredPrefix =
    actor === "ADMIN" ? "Администратор Direct отметил: " : "";
  const updatedOrder: Order = {
    ...targetOrder,
    status: "DELIVERED",
    paymentStatus: "PAID_TO_RESTAURANT_COURIER",
    paidAt: now,
    updatedAt: now,
    history: [
      ...targetOrder.history,
      {
        id: `${targetOrder.id}-history-${nextHistoryNumber}`,
        occurredAt: now,
        actor,
        type: "PAYMENT",
        fromStatus: "ARRIVING",
        toStatus: "ARRIVING",
        message: `${deliveredPrefix}курьер ресторана получил оплату наличными.`,
      },
      {
        id: `${targetOrder.id}-history-${nextHistoryNumber + 1}`,
        occurredAt: now,
        actor,
        type: "STATUS",
        fromStatus: "ARRIVING",
        toStatus: "DELIVERED",
        message: "Заказ доставлен клиенту.",
      },
    ],
  };

  // Единственная запись комиссии за доставку (id привязан к заказу).
  const settlementId = `settlement-${orderId}`;
  const alreadySettled = state.settlements.some(
    (entry) => entry.id === settlementId || entry.orderId === orderId,
  );
  const settlement: SettlementEntry = {
    id: settlementId,
    orderId,
    restaurantId: targetOrder.restaurant.id,
    type: "RESTAURANT_DELIVERY_COMMISSION",
    amountCents: targetOrder.financials.platformCommissionReceivableCents,
    status: "PENDING",
    createdAt: now,
  };

  return finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((order) =>
        order.id === orderId ? updatedOrder : order,
      ),
      settlements: alreadySettled
        ? state.settlements
        : [...state.settlements, settlement],
    },
    now,
  );
}

export interface CompletePickupResult {
  ok: boolean;
  error: string | null;
}

/**
 * Атомарная выдача самовывоза по коду клиента: оплата в ресторане, выдача,
 * начисление комиссии Direct. Единственный путь завершить PICKUP-заказ.
 */
export function completePickupWithCode(
  state: PrototypeState,
  orderId: string,
  code: string,
  actor: OrderActionActor = "RESTAURANT",
): ActionResult<CompletePickupResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const done = (error: string | null): ActionResult<CompletePickupResult> => ({
    state,
    result: { ok: error === null, error },
  });

  if (!order || order.deliveryMode !== "PICKUP") {
    return done("Заказ не найден или не является самовывозом.");
  }
  if (order.status === "PICKED_UP" || order.pickupCodeUsed) {
    return done("Заказ уже выдан.");
  }
  if (order.status !== "READY_FOR_PICKUP") {
    return done("Заказ ещё не готов к выдаче.");
  }
  if (!order.pickupCode || code.trim() !== order.pickupCode) {
    return done("Неверный код клиента.");
  }

  const now = new Date().toISOString();
  const nextHistoryNumber = order.history.length + 1;
  const issuedBy =
    actor === "ADMIN" ? "Администратор Direct подтвердил выдачу" : "Заказ выдан";
  const updatedOrder: Order = {
    ...order,
    status: "PICKED_UP",
    paymentStatus: "PAID_AT_RESTAURANT",
    paidAt: now,
    pickupCodeUsed: true,
    updatedAt: now,
    history: [
      ...order.history,
      {
        id: `${order.id}-history-${nextHistoryNumber}`,
        occurredAt: now,
        actor,
        type: "PAYMENT",
        fromStatus: "READY_FOR_PICKUP",
        toStatus: "READY_FOR_PICKUP",
        message: "Оплата получена в ресторане.",
      },
      {
        id: `${order.id}-history-${nextHistoryNumber + 1}`,
        occurredAt: now,
        actor,
        type: "STATUS",
        fromStatus: "READY_FOR_PICKUP",
        toStatus: "PICKED_UP",
        message: `${issuedBy} клиенту по коду.`,
      },
    ],
  };

  // Начисление комиссии создаётся один раз (id привязан к заказу).
  const settlementId = `settlement-${orderId}`;
  const alreadySettled = state.settlements.some(
    (entry) => entry.id === settlementId || entry.orderId === orderId,
  );
  const settlement: SettlementEntry = {
    id: settlementId,
    orderId,
    restaurantId: order.restaurant.id,
    type: "PICKUP_COMMISSION",
    amountCents: order.financials.platformCommissionReceivableCents,
    status: "PENDING",
    createdAt: now,
  };

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      settlements: alreadySettled
        ? state.settlements
        : [...state.settlements, settlement],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Невыкуп: заказ готов, но клиент не пришёл. Закрывается без комиссии Direct;
 * увеличивается счётчик невыкупов клиента.
 */
export function markPickupNoShow(
  state: PrototypeState,
  orderId: string,
  reason: string,
  actor: OrderActionActor = "RESTAURANT",
): PrototypeState {
  const order = state.orders.find((o) => o.id === orderId);
  const normalizedReason = reason.trim();
  if (
    !order ||
    order.deliveryMode !== "PICKUP" ||
    order.status !== "READY_FOR_PICKUP" ||
    !normalizedReason
  ) {
    return state;
  }

  const now = new Date().toISOString();
  const noShowPrefix =
    actor === "ADMIN" ? "Администратор Direct отметил невыкуп. " : "";
  const updatedOrder: Order = {
    ...order,
    status: "CANCELED",
    cancellationReason: normalizedReason,
    updatedAt: now,
    history: [
      ...order.history,
      {
        id: `${order.id}-history-${order.history.length + 1}`,
        occurredAt: now,
        actor,
        type: "STATUS",
        fromStatus: "READY_FOR_PICKUP",
        toStatus: "CANCELED",
        message: `${noShowPrefix}Клиент не пришёл за заказом. Причина: ${normalizedReason}`,
      },
    ],
  };

  return finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      customer:
        order.customer.id === state.customer.id
          ? {
              ...state.customer,
              noShowPickupCount: state.customer.noShowPickupCount + 1,
            }
          : state.customer,
    },
    now,
  );
}

// --- Оперативные административные действия -----------------------------------

export interface AdminActionResult {
  ok: boolean;
  error: string | null;
}

const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  "DELIVERED",
  "PICKED_UP",
  "CANCELED",
];

function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

/** Освобождает назначенного водителя заказа (переводит в AVAILABLE). */
function releaseAssignedDriver(
  drivers: DriverProfile[],
  driverId: string | null,
): DriverProfile[] {
  if (!driverId) {
    return drivers;
  }
  return drivers.map((driver) =>
    driver.id === driverId ? { ...driver, status: "AVAILABLE" } : driver,
  );
}

function setDriverStatus(
  drivers: DriverProfile[],
  driverId: string,
  status: DriverStatus,
): DriverProfile[] {
  return drivers.map((driver) =>
    driver.id === driverId ? { ...driver, status } : driver,
  );
}

function adminHistoryEvent(
  order: Order,
  offset: number,
  occurredAt: string,
  type: OrderHistoryEvent["type"],
  fromStatus: OrderStatus | null,
  toStatus: OrderStatus,
  message: string,
): OrderHistoryEvent {
  return {
    id: `${order.id}-history-${order.history.length + offset}`,
    occurredAt,
    actor: "ADMIN",
    type,
    fromStatus,
    toStatus,
    message,
  };
}

/** Приостановка/возобновление приёма заказов рестораном. Заказы не трогаются. */
export function setRestaurantAcceptingOrders(
  state: PrototypeState,
  restaurantId: string,
  accepting: boolean,
): PrototypeState {
  const target = state.restaurants.find((r) => r.id === restaurantId);
  if (!target || target.isAcceptingOrders === accepting) {
    return state;
  }
  return finalizeMutation(state, {
    ...state,
    restaurants: state.restaurants.map((restaurant) =>
      restaurant.id === restaurantId
        ? { ...restaurant, isAcceptingOrders: accepting }
        : restaurant,
    ),
  });
}

/** Назначение свободного водителя Direct на заказ PLATFORM_DRIVER. */
export function assignDriverToOrder(
  state: PrototypeState,
  orderId: string,
  driverId: string,
): ActionResult<AdminActionResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const driver = state.drivers.find((d) => d.id === driverId);
  const fail = (error: string): ActionResult<AdminActionResult> => ({
    state,
    result: { ok: false, error },
  });

  if (!order) return fail("Заказ не найден.");
  if (order.deliveryMode !== "PLATFORM_DRIVER") {
    return fail("Водитель Direct назначается только доставке водителем Direct.");
  }
  if (isTerminalOrderStatus(order.status)) {
    return fail("Заказ завершён или отменён.");
  }
  // §3: назначение только после оплаты и только на этапах приготовления/готовности.
  if (order.paymentStatus !== "PAID") {
    return fail("Назначить водителя можно только после оплаты заказа.");
  }
  if (order.status !== "PREPARING" && order.status !== "READY") {
    return fail(
      "Назначить водителя можно только в статусе «Готовится» или «Готов».",
    );
  }
  if (order.assignedDriverId) {
    return fail("Водитель уже назначен — используйте переназначение.");
  }
  if (!driver) return fail("Водитель не найден.");
  if (driver.status !== "AVAILABLE") {
    return fail("Водитель недоступен.");
  }

  const now = new Date().toISOString();
  const updatedOrder: Order = {
    ...order,
    assignedDriverId: driverId,
    driverAssignedAt: now,
    updatedAt: now,
    history: [
      ...order.history,
      adminHistoryEvent(
        order,
        1,
        now,
        "STATUS",
        order.status,
        order.status,
        `Администратор Direct назначил водителя ${driver.name}.`,
      ),
    ],
  };
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      drivers: setDriverStatus(state.drivers, driverId, "BUSY"),
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/** Переназначение водителя: старый освобождается, причина обязательна. */
export function reassignDriverForOrder(
  state: PrototypeState,
  orderId: string,
  newDriverId: string,
  reason: string,
): ActionResult<AdminActionResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const newDriver = state.drivers.find((d) => d.id === newDriverId);
  const normalizedReason = reason.trim();
  const fail = (error: string): ActionResult<AdminActionResult> => ({
    state,
    result: { ok: false, error },
  });

  if (!order) return fail("Заказ не найден.");
  if (order.deliveryMode !== "PLATFORM_DRIVER") {
    return fail("Водитель Direct назначается только доставке водителем Direct.");
  }
  if (isTerminalOrderStatus(order.status)) {
    return fail("Заказ завершён или отменён.");
  }
  if (!order.assignedDriverId) {
    return fail("Водитель ещё не назначен.");
  }
  // §3: переназначение — для активной оплаченной доставки.
  const REASSIGN_STATUSES: OrderStatus[] = [
    "PREPARING",
    "READY",
    "OUT_FOR_DELIVERY",
    "ARRIVING",
  ];
  if (!REASSIGN_STATUSES.includes(order.status)) {
    return fail("Переназначение доступно только для активной доставки.");
  }
  if (!normalizedReason) return fail("Укажите причину переназначения.");
  if (!newDriver) return fail("Водитель не найден.");
  if (newDriver.id === order.assignedDriverId) {
    return fail("Этот водитель уже назначен.");
  }
  if (newDriver.status !== "AVAILABLE") {
    return fail("Водитель недоступен.");
  }

  const now = new Date().toISOString();
  const updatedOrder: Order = {
    ...order,
    assignedDriverId: newDriverId,
    driverAssignedAt: now,
    updatedAt: now,
    history: [
      ...order.history,
      adminHistoryEvent(
        order,
        1,
        now,
        "STATUS",
        order.status,
        order.status,
        `Администратор Direct переназначил водителя на ${newDriver.name}. Причина: ${normalizedReason}`,
      ),
    ],
  };
  // Сначала освобождаем старого, затем занимаем нового.
  const drivers = setDriverStatus(
    releaseAssignedDriver(state.drivers, order.assignedDriverId),
    newDriverId,
    "BUSY",
  );
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      drivers,
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/** Снятие назначения: водитель освобождается, причина обязательна. */
export function unassignDriverFromOrder(
  state: PrototypeState,
  orderId: string,
  reason: string,
): ActionResult<AdminActionResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const normalizedReason = reason.trim();
  const fail = (error: string): ActionResult<AdminActionResult> => ({
    state,
    result: { ok: false, error },
  });

  if (!order) return fail("Заказ не найден.");
  if (order.deliveryMode !== "PLATFORM_DRIVER") {
    return fail("Назначение есть только у доставки водителем Direct.");
  }
  if (isTerminalOrderStatus(order.status)) {
    return fail("Заказ завершён или отменён.");
  }
  if (!order.assignedDriverId) return fail("Водитель не назначен.");
  if (!normalizedReason) return fail("Укажите причину снятия назначения.");

  const now = new Date().toISOString();
  const driver = state.drivers.find((d) => d.id === order.assignedDriverId);
  const updatedOrder: Order = {
    ...order,
    assignedDriverId: null,
    driverAssignedAt: null,
    updatedAt: now,
    history: [
      ...order.history,
      adminHistoryEvent(
        order,
        1,
        now,
        "STATUS",
        order.status,
        order.status,
        `Администратор Direct снял назначение водителя${driver ? ` ${driver.name}` : ""}. Причина: ${normalizedReason}`,
      ),
    ],
  };
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      drivers: releaseAssignedDriver(state.drivers, order.assignedDriverId),
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Завершение доставки заказа водителем Direct (PLATFORM_DRIVER). Оплата уже
 * ONLINE (PAID), поэтому финансы и settlement не затрагиваются; назначенный
 * водитель освобождается.
 */
export function markOrderDeliveredByDriver(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  const order = state.orders.find((o) => o.id === orderId);
  // §3: завершение только для оплаченного PLATFORM_DRIVER-заказа с назначенным
  // водителем и только из OUT_FOR_DELIVERY/ARRIVING (не из PREPARING).
  if (
    !order ||
    order.deliveryMode !== "PLATFORM_DRIVER" ||
    !order.assignedDriverId ||
    order.paymentStatus !== "PAID" ||
    (order.status !== "OUT_FOR_DELIVERY" && order.status !== "ARRIVING")
  ) {
    return state;
  }
  const now = new Date().toISOString();
  const updatedOrder: Order = {
    ...order,
    status: "DELIVERED",
    updatedAt: now,
    history: [
      ...order.history,
      adminHistoryEvent(
        order,
        1,
        now,
        "STATUS",
        order.status,
        "DELIVERED",
        "Заказ доставлен водителем Direct.",
      ),
    ],
  };
  return finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      drivers: releaseAssignedDriver(state.drivers, order.assignedDriverId),
    },
    now,
  );
}

/**
 * Отмена заказа администратором (§12). Причина обязательна. Завершённый заказ
 * отменить нельзя. Новый settlement не создаётся, уже созданные начисления не
 * удаляются; назначенный водитель освобождается.
 */
export function adminCancelOrder(
  state: PrototypeState,
  orderId: string,
  reason: string,
): ActionResult<AdminActionResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const normalizedReason = reason.trim();
  const fail = (error: string): ActionResult<AdminActionResult> => ({
    state,
    result: { ok: false, error },
  });

  if (!order) return fail("Заказ не найден.");
  if (!normalizedReason) return fail("Укажите причину отмены.");
  if (order.status === "CANCELED") return fail("Заказ уже отменён.");
  if (order.status === "DELIVERED" || order.status === "PICKED_UP") {
    return fail("Завершённый заказ отменить нельзя.");
  }

  const now = new Date().toISOString();
  const updatedOrder: Order = {
    ...order,
    status: "CANCELED",
    cancellationReason: normalizedReason,
    assignedDriverId: null,
    driverAssignedAt: null,
    updatedAt: now,
    history: [
      ...order.history,
      adminHistoryEvent(
        order,
        1,
        now,
        "STATUS",
        order.status,
        "CANCELED",
        `Заказ отменён администратором Direct. Причина: ${normalizedReason}`,
      ),
    ],
  };
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      drivers: releaseAssignedDriver(state.drivers, order.assignedDriverId),
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Безопасные операционные статусы для административного исправления (§2),
 * зависящие от режима доставки заказа. Никогда не включают финансовые/терминальные
 * статусы (AWAITING_PAYMENT, DELIVERED, PICKED_UP, CANCELED). Самовывоз не может
 * получить курьерские статусы, доставка — самовывозный READY_FOR_PICKUP.
 */
export function getSafeAdminStatusCorrections(
  order: Order,
): OrderStatus[] {
  if (order.deliveryMode === "PICKUP") {
    return ["RESTAURANT_REVIEW", "PREPARING", "READY_FOR_PICKUP"];
  }
  // PLATFORM_DRIVER и RESTAURANT_DELIVERY — курьерские этапы, без самовывоза.
  return [
    "RESTAURANT_REVIEW",
    "PREPARING",
    "READY",
    "OUT_FOR_DELIVERY",
    "ARRIVING",
  ];
}

/**
 * Безопасное административное исправление статуса (§2, §11). Допустимые целевые
 * статусы зависят от типа заказа (getSafeAdminStatusCorrections); причина
 * обязательна. НЕ меняет оплату, settlement, финансовый snapshot и не назначает
 * водителя. Не может перевести в DELIVERED, PICKED_UP, CANCELED или
 * AWAITING_PAYMENT. Проверка дублируется и в UI, и здесь (домен).
 */
export function correctOrderStatus(
  state: PrototypeState,
  orderId: string,
  newStatus: OrderStatus,
  reason: string,
): ActionResult<AdminActionResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const normalizedReason = reason.trim();
  const fail = (error: string): ActionResult<AdminActionResult> => ({
    state,
    result: { ok: false, error },
  });

  if (!order) return fail("Заказ не найден.");
  if (!normalizedReason) return fail("Укажите причину исправления.");
  if (!getSafeAdminStatusCorrections(order).includes(newStatus)) {
    return fail("Этот статус несовместим с типом заказа.");
  }
  if (isTerminalOrderStatus(order.status)) {
    return fail("Заказ завершён или отменён.");
  }
  if (order.status === newStatus) {
    return fail("Статус уже установлен.");
  }

  const now = new Date().toISOString();
  const updatedOrder: Order = {
    ...order,
    status: newStatus,
    updatedAt: now,
    history: [
      ...order.history,
      adminHistoryEvent(
        order,
        1,
        now,
        "STATUS",
        order.status,
        newStatus,
        `Администратор Direct исправил статус. Причина: ${normalizedReason}`,
      ),
    ],
  };
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Аварийная выдача самовывоза без кода (§9). Доступна только администратору,
 * требует причину. Логика оплаты и начисления идентична выдаче по коду; вторая
 * комиссия не создаётся (settlement идемпотентен по id заказа).
 */
export function issuePickupWithoutCode(
  state: PrototypeState,
  orderId: string,
  reason: string,
): ActionResult<AdminActionResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const normalizedReason = reason.trim();
  const done = (error: string | null): ActionResult<AdminActionResult> => ({
    state,
    result: { ok: error === null, error },
  });

  if (!order || order.deliveryMode !== "PICKUP") {
    return done("Заказ не найден или не является самовывозом.");
  }
  if (order.status === "PICKED_UP" || order.pickupCodeUsed) {
    return done("Заказ уже выдан.");
  }
  if (order.status !== "READY_FOR_PICKUP") {
    return done("Заказ ещё не готов к выдаче.");
  }
  if (!normalizedReason) {
    return done("Укажите причину аварийной выдачи.");
  }

  const now = new Date().toISOString();
  const nextHistoryNumber = order.history.length + 1;
  const updatedOrder: Order = {
    ...order,
    status: "PICKED_UP",
    paymentStatus: "PAID_AT_RESTAURANT",
    paidAt: now,
    pickupCodeUsed: true,
    updatedAt: now,
    history: [
      ...order.history,
      {
        id: `${order.id}-history-${nextHistoryNumber}`,
        occurredAt: now,
        actor: "ADMIN",
        type: "PAYMENT",
        fromStatus: "READY_FOR_PICKUP",
        toStatus: "READY_FOR_PICKUP",
        message: "Оплата получена в ресторане (аварийная выдача).",
      },
      {
        id: `${order.id}-history-${nextHistoryNumber + 1}`,
        occurredAt: now,
        actor: "ADMIN",
        type: "STATUS",
        fromStatus: "READY_FOR_PICKUP",
        toStatus: "PICKED_UP",
        message: `Аварийная выдача без кода администратором Direct. Причина: ${normalizedReason}`,
      },
    ],
  };

  const settlementId = `settlement-${orderId}`;
  const alreadySettled = state.settlements.some(
    (entry) => entry.id === settlementId || entry.orderId === orderId,
  );
  const settlement: SettlementEntry = {
    id: settlementId,
    orderId,
    restaurantId: order.restaurant.id,
    type: "PICKUP_COMMISSION",
    amountCents: order.financials.platformCommissionReceivableCents,
    status: "PENDING",
    createdAt: now,
  };

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      settlements: alreadySettled
        ? state.settlements
        : [...state.settlements, settlement],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Административное изменение времени приготовления (§9, статус PREPARING).
 * Пересчитывает ожидаемое время готовности; финансы и оплату не трогает.
 */
export function adminSetPreparationMinutes(
  state: PrototypeState,
  orderId: string,
  minutes: number,
): PrototypeState {
  const allowed = [10, 15, 20, 25, 30, 40];
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || order.status !== "PREPARING" || !allowed.includes(minutes)) {
    return state;
  }
  const now = new Date().toISOString();
  const expectedReadyAt = new Date(
    new Date(now).getTime() + minutes * 60_000,
  ).toISOString();
  return replaceOrder(
    state,
    orderId,
    (o) => ({
      ...o,
      preparationMinutes: minutes,
      expectedReadyAt,
      updatedAt: now,
      history: [
        ...o.history,
        adminHistoryEvent(
          o,
          1,
          now,
          "STATUS",
          "PREPARING",
          "PREPARING",
          `Администратор Direct изменил время приготовления на ${minutes} минут.`,
        ),
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
  pickupPaymentMethods?: PickupPaymentMethod[];
  /** Комиссия Direct за самовывоз, bps (по умолчанию 1500 = 15%). */
  pickupCommissionRateBps?: number;
  // Контактные/операционные поля (необязательны; по умолчанию пустые).
  publicPhone?: string;
  timeZone?: string;
  contactPersonName?: string;
  contactPersonRole?: string;
  contactPhone?: string;
  contactEmail?: string;
  contactMessenger?: string;
  emergencyPhone?: string;
  internalAdminNote?: string;
  weeklySchedule?: WeeklySchedule;
}

export interface CreateRestaurantResult {
  restaurantId: string | null;
  error: string | null;
}

export function createRestaurant(
  state: PrototypeState,
  input: RestaurantFormInput,
): ActionResult<CreateRestaurantResult> {
  const pickupPaymentMethods = input.pickupPaymentMethods ?? ["CASH", "CARD"];
  const validationError = validatePickupPayment(
    input.pickupEnabled,
    pickupPaymentMethods,
  );
  if (validationError) {
    return { state, result: { restaurantId: null, error: validationError } };
  }

  const id = nextRestaurantId(state);
  const restaurant: Restaurant = {
    id,
    name: input.name.trim() || id,
    description: input.description,
    address: input.address,
    zoneId: input.zoneId,
    // §4: новый ресторан всегда создаётся безопасно — черновик, не принимает
    // заказы и не виден клиенту. Публикация и приём заказов — отдельные
    // осознанные действия администратора (в конструкторе).
    status: "DRAFT",
    isAcceptingOrders: false,
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
    pickupPaymentMethods,
    pickupCommissionRateBps: input.pickupCommissionRateBps ?? 1500,
    pickupPrepaymentThresholdCents: null,
    // Контакты и график: из формы либо безопасные пустые/стандартные значения.
    ...createRestaurantExtras({
      publicPhone: input.publicPhone,
      contactPersonName: input.contactPersonName,
      contactPersonRole: input.contactPersonRole,
      contactPhone: input.contactPhone,
      contactEmail: input.contactEmail,
      contactMessenger: input.contactMessenger,
      emergencyPhone: input.emergencyPhone,
      internalAdminNote: input.internalAdminNote,
      weeklySchedule: input.weeklySchedule,
      timeZone: input.timeZone,
    }),
  };
  const nextState = finalizeMutation(state, {
    ...state,
    restaurants: [...state.restaurants, restaurant],
  });
  return { state: nextState, result: { restaurantId: id, error: null } };
}

export interface UpdateRestaurantResult {
  ok: boolean;
  error: string | null;
}

export function updateRestaurant(
  state: PrototypeState,
  restaurantId: string,
  patch: Partial<RestaurantFormInput>,
): ActionResult<UpdateRestaurantResult> {
  const target = state.restaurants.find((r) => r.id === restaurantId);
  if (!target) {
    return { state, result: { ok: false, error: "Ресторан не найден." } };
  }
  const deliveryProvider = patch.deliveryProvider ?? target.deliveryProvider;
  const pickupEnabled = patch.pickupEnabled ?? target.pickupEnabled;
  const pickupPaymentMethods =
    patch.pickupPaymentMethods ?? target.pickupPaymentMethods;
  const settings =
    patch.restaurantDeliverySettings !== undefined
      ? patch.restaurantDeliverySettings
      : target.restaurantDeliverySettings;

  const validationError = validatePickupPayment(
    pickupEnabled,
    pickupPaymentMethods,
  );
  if (validationError) {
    return { state, result: { ok: false, error: validationError } };
  }

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
    pickupCommissionRateBps:
      patch.pickupCommissionRateBps ?? target.pickupCommissionRateBps,
    deliveryProvider,
    pickupEnabled,
    deliveryModes: deliveryModesForProvider(deliveryProvider, pickupEnabled),
    restaurantDeliverySettings:
      deliveryProvider === "RESTAURANT"
        ? (settings ?? defaultRestaurantDeliverySettings())
        : settings,
    pickupPaymentMethods,
    timeZone: patch.timeZone ?? target.timeZone,
    // Контакты и график: обновляем только явно переданные поля; остальные
    // сохраняются. Заказы и финансовые snapshots не затрагиваются.
    publicPhone: patch.publicPhone ?? target.publicPhone,
    contactPersonName: patch.contactPersonName ?? target.contactPersonName,
    contactPersonRole: patch.contactPersonRole ?? target.contactPersonRole,
    contactPhone: patch.contactPhone ?? target.contactPhone,
    contactEmail: patch.contactEmail ?? target.contactEmail,
    contactMessenger: patch.contactMessenger ?? target.contactMessenger,
    emergencyPhone: patch.emergencyPhone ?? target.emergencyPhone,
    internalAdminNote: patch.internalAdminNote ?? target.internalAdminNote,
    weeklySchedule: patch.weeklySchedule
      ? cloneWeeklySchedule(patch.weeklySchedule)
      : target.weeklySchedule,
  };

  const nextState = finalizeMutation(state, {
    ...state,
    restaurants: state.restaurants.map((restaurant) =>
      restaurant.id === restaurantId ? nextRestaurant : restaurant,
    ),
  });
  return { state: nextState, result: { ok: true, error: null } };
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
