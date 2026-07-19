import {
  cloneWeeklySchedule,
  createDefaultState,
  createDefaultTariffs,
  createEmptyCart,
  createRestaurantExtras,
} from "./default-state";
import type {
  AppliedPromotionSnapshot,
  CancellationRequest,
  CartItem,
  DeliveryAddress,
  DeliveryMode,
  DriverProfile,
  DriverStatus,
  FulfillmentChoice,
  MenuItemVariant,
  OperationalActor,
  OperationalEvent,
  OperationalEventAction,
  OperationalPause,
  OperationalPauseMode,
  Order,
  OrderEtaAdjustment,
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
  RestaurantOrderWorkflowMode,
  RestaurantWorkspaceAction,
  RestaurantWorkspaceRole,
  SettlementEntry,
  TariffMatrix,
  WeeklySchedule,
} from "./models";
import {
  canRestaurantWorkspacePerformAction,
  resolveRestaurantWorkspaceRole,
} from "./restaurant-workflow";
import {
  calculateCartPricing,
  canPlacePrototypeOrder,
  computeNextOpeningIso,
  detectZoneId,
  getCartDeliveryMode,
  getCartItemViews,
  getOpenPreparationProblem,
  getRestaurant,
  isActiveOrderStatus,
  isAddressReady,
  isCustomerNameValid,
  getDriverActiveOrder,
  isCustomerPhoneValid,
  isMenuItemAvailableAt,
  isOperationalPauseActiveAt,
  isRestaurantAcceptingOrdersAt,
  getPickupNoShowEligibleAtIso,
  isPickupNoShowEligibleAt,
  PREPARATION_PROBLEM_ADMIN_PREFIX,
  PREPARATION_PROBLEM_KITCHEN_PREFIX,
  WORKING_RESTAURANT_IDS,
} from "./selectors";
import {
  computePickupSettlement,
  generatePickupCode,
  validatePickupPayment,
} from "./pricing-engine";
import {
  computeEtaFromIntent,
  ETA_REASON_MAX_LENGTH,
  validateEtaCandidate,
  type EtaAdjustmentIntent,
} from "./order-eta";
import { finalizeMutation } from "./prototype-store";
import { computeCompletedOrderAccountingEntries } from "./restaurant-accounting";

export interface ActionResult<T> {
  state: PrototypeState;
  result: T;
}

/**
 * Исправление 6: разные причины отказа не сливаются в один статус.
 * Доменные: NOT_AVAILABLE (блюдо), RESTAURANT_UNAVAILABLE (ресторан),
 * RESTAURANT_CONFLICT (в корзине другой ресторан). Инфраструктурные:
 * SYNC_UNAVAILABLE (нет Web Locks) и SAVE_FAILED (ошибка записи хранилища) —
 * клиент получает честную инфраструктурную ошибку, а не «блюдо недоступно».
 */
export type AddCartItemResult =
  | "ADDED"
  | "RESTAURANT_CONFLICT"
  | "RESTAURANT_UNAVAILABLE"
  | "NOT_AVAILABLE"
  | "SYNC_UNAVAILABLE"
  | "SAVE_FAILED";

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

  if (!menuItem || !isMenuItemAvailableAt(menuItem, Date.now())) {
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
  if (!isRestaurantAcceptingOrdersAt(restaurant, Date.now())) {
    // §7: активная операционная пауза — свой нейтральный текст.
    const paused = isOperationalPauseActiveAt(restaurant.orderPause, Date.now());
    return fail(
      paused
        ? "Ресторан временно не принимает новые заказы. Попробуйте позже или выберите другой ресторан."
        : "Ресторан сейчас не принимает заказы. Выберите другой ресторан или повторите позже.",
    );
  }
  if (!restaurant.deliveryModes.includes(deliveryMode)) {
    return fail("Этот способ получения недоступен для ресторана.");
  }
  if (state.cart.paymentMethod !== "ONLINE") {
    return fail("Выберите оплату онлайн.");
  }

  // §15: каждая позиция перепроверяется на операционную доступность.
  const hasMissingOrUnavailable = state.cart.items.some((cartItem) => {
    const menuItem = state.menuItems.find(
      (candidate) => candidate.id === cartItem.menuItemId,
    );
    return !menuItem || !isMenuItemAvailableAt(menuItem, Date.now());
  });
  if (hasMissingOrUnavailable) {
    return fail(
      "Некоторые блюда больше недоступны. Удалите их из корзины или выберите замену.",
    );
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
    // §3: исторический снимок способов оплаты на точке (для PICKUP).
    pickupPaymentMethodsSnapshot: isPickup
      ? [...restaurant.pickupPaymentMethods]
      : [],
    pickupPaidWith: null,
    pickupNoShowAt: null,
    assignedDriverId: null,
    driverAssignedAt: null,
    etaAdjustments: [],
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

/** Режим работы ресторана заказа (Этап 4); отсутствует → COMBINED. */
function orderRestaurantWorkflowMode(
  state: PrototypeState,
  order: Order,
): RestaurantOrderWorkflowMode {
  return (
    state.restaurants.find((r) => r.id === order.restaurant.id)
      ?.orderWorkflowMode ?? "COMBINED"
  );
}

/**
 * Этап 4: проверка права ресторанной workspace выполнить действие над заказом.
 * ADMIN — отдельный actor: матрицу ресторана не проходит (своя авторитетность),
 * ресторанную роль на события не ставит. Для RESTAURANT работает fail-closed:
 * в COMBINED роль резолвится в «COMBINED» (старые вызовы), в SPLIT требуется явная
 * OPERATOR/KITCHEN, иначе действие блокируется. `role` стампится на новые события.
 */
function checkRestaurantWorkspace(
  state: PrototypeState,
  order: Order,
  actor: OrderActionActor,
  action: RestaurantWorkspaceAction,
  workspaceRole?: RestaurantWorkspaceRole,
): { allowed: boolean; role?: RestaurantWorkspaceRole } {
  if (actor === "ADMIN") {
    return { allowed: true, role: undefined };
  }
  const workflowMode = orderRestaurantWorkflowMode(state, order);
  const allowed = canRestaurantWorkspacePerformAction({
    workflowMode,
    workspaceRole,
    action,
  });
  return {
    allowed,
    role: resolveRestaurantWorkspaceRole(workflowMode, workspaceRole) ?? undefined,
  };
}

/**
 * Этап 4: guard для действий уровня РЕСТОРАНА (пауза, доступность меню).
 * ADMIN и SYSTEM — собственная авторитетность, матрицу ресторана не проходят.
 * Для RESTAURANT работает так же fail-closed, как заказный guard.
 */
function checkRestaurantWorkspaceForRestaurant(
  state: PrototypeState,
  restaurantId: string,
  actor: OperationalActor,
  action: RestaurantWorkspaceAction,
  workspaceRole?: RestaurantWorkspaceRole,
): boolean {
  if (actor !== "RESTAURANT") {
    return true;
  }
  const workflowMode =
    state.restaurants.find((r) => r.id === restaurantId)?.orderWorkflowMode ??
    "COMBINED";
  return canRestaurantWorkspacePerformAction({
    workflowMode,
    workspaceRole,
    action,
  });
}

/** Исправление 3: результат критического lifecycle-перехода заказа. */
export interface OrderTransitionResult {
  ok: boolean;
  error: string | null;
}

/**
 * Порядок статусов вдоль жизненного цикла заказа — только для классификации
 * ошибки неправильного статуса («ещё не готов» против «уже обработан»).
 * READY/READY_FOR_PICKUP и DELIVERED/PICKED_UP — параллельные ветки одного шага.
 */
const ORDER_STATUS_PROGRESS: Record<OrderStatus, number> = {
  RESTAURANT_REVIEW: 0,
  AWAITING_PAYMENT: 1,
  PREPARING: 2,
  READY: 3,
  READY_FOR_PICKUP: 3,
  OUT_FOR_DELIVERY: 4,
  ARRIVING: 5,
  DELIVERED: 6,
  PICKED_UP: 6,
  CANCELED: 7,
};

/** Русская ошибка неправильного статуса относительно ожидаемого перехода. */
function wrongStatusError(
  actual: OrderStatus,
  expected: OrderStatus,
): string {
  return ORDER_STATUS_PROGRESS[actual] < ORDER_STATUS_PROGRESS[expected]
    ? "Заказ ещё не готов к этому переходу."
    : "Заказ уже обработан. Обновите данные.";
}

export interface AcceptRestaurantOrderResult {
  ok: boolean;
  error: string | null;
}

/**
 * Result-based приём заказа (Исправление 4.1). Общий transition с явным автором:
 * кабинет ресторана — actor="RESTAURANT", админка — "ADMIN". Все проверки — до
 * мутации; при ошибке возвращает исходный state тем же объектом (без события,
 * без финансовых изменений, без ревизии) и понятную русскую ошибку. Lifecycle
 * успешного пути не изменён. acceptRestaurantOrder — тонкий wrapper.
 */
export function acceptRestaurantOrderWithResult(
  state: PrototypeState,
  orderId: string,
  preparationMinutes: number,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<AcceptRestaurantOrderResult> {
  const fail = (error: string): ActionResult<AcceptRestaurantOrderResult> => ({
    state,
    result: { ok: false, error },
  });

  const allowedMinutes = [10, 15, 20, 25, 30, 40];
  if (!allowedMinutes.includes(preparationMinutes)) {
    return fail("Недопустимое время приготовления.");
  }

  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (!targetOrder) {
    return fail("Заказ не найден.");
  }
  if (!isWorkingRestaurantOrder(targetOrder)) {
    return fail("Заказ относится к другому ресторану.");
  }

  // Этап 4: приём заказа (и установка начального времени) — действие кухни/общего
  // экрана. В SPLIT оператор принять не может.
  const guard = checkRestaurantWorkspace(
    state,
    targetOrder,
    actor,
    "ACCEPT_ORDER",
    workspaceRole,
  );
  if (!guard.allowed) {
    return fail("Недостаточно прав для принятия заказа.");
  }
  const workspace = guard.role;

  // Гонка вкладок: заказ уже принят/отклонён/автозакрыт.
  if (targetOrder.status !== "RESTAURANT_REVIEW") {
    return fail("Заказ уже обработан. Обновите данные.");
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
    const nextState = replaceOrder(
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
            restaurantWorkspaceRole: workspace,
          },
        ],
      }),
      now,
    );
    return { state: nextState, result: { ok: true, error: null } };
  }

  if (targetOrder.paymentMethod !== "ONLINE") {
    return fail("Неподдерживаемый способ оплаты заказа.");
  }

  const nextState = replaceOrder(
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
          restaurantWorkspaceRole: workspace,
        },
      ],
    }),
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Compatibility-wrapper: прежняя сигнатура для существующих вызовов и тестов,
 * ожидающих только PrototypeState. Вся логика — в result-based версии.
 */
export function acceptRestaurantOrder(
  state: PrototypeState,
  orderId: string,
  preparationMinutes: number,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): PrototypeState {
  return acceptRestaurantOrderWithResult(
    state,
    orderId,
    preparationMinutes,
    actor,
    workspaceRole,
  ).state;
}

export interface RejectRestaurantOrderResult {
  ok: boolean;
  error: string | null;
}

/**
 * Result-based отклонение нового заказа рестораном (Исправление 3). Все проверки
 * — до любой мутации; при ошибке возвращает исходный state тем же объектом (без
 * события, без изменения статуса/оплаты/ETA/финансов/ревизии) и понятную русскую
 * ошибку. Это авторитетная реализация; rejectRestaurantOrder — тонкий wrapper.
 */
export function rejectRestaurantOrderWithResult(
  state: PrototypeState,
  orderId: string,
  reason: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<RejectRestaurantOrderResult> {
  const fail = (error: string): ActionResult<RejectRestaurantOrderResult> => ({
    state,
    result: { ok: false, error },
  });

  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (!targetOrder) {
    return fail("Заказ не найден.");
  }
  // Ресторан может отклонять только заказы рабочих ресторанов прототипа.
  if (actor === "RESTAURANT" && !isWorkingRestaurantOrder(targetOrder)) {
    return fail("Заказ относится к другому ресторану.");
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return fail("Укажите причину отклонения.");
  }
  // Этап 4: отклонение — часть работы с отменой (оператор/общий экран). Кухня в
  // SPLIT использует «Не можем приготовить» (REPORT_PREPARATION_PROBLEM).
  const guard = checkRestaurantWorkspace(
    state,
    targetOrder,
    actor,
    "MANAGE_CANCELLATION",
    workspaceRole,
  );
  if (!guard.allowed) {
    return fail("Недостаточно прав для отклонения заказа.");
  }
  // Гонка вкладок: кухня уже приняла / заказ автозакрылся / уже отклонён.
  if (targetOrder.status !== "RESTAURANT_REVIEW") {
    return fail("Заказ уже обработан. Обновите данные.");
  }

  const now = new Date().toISOString();
  const rejectedBy =
    actor === "ADMIN"
      ? "Администратор Direct отклонил заказ от имени ресторана"
      : "Ресторан отклонил заказ";

  const nextState = replaceOrder(
    state,
    orderId,
    (order) => ({
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
          restaurantWorkspaceRole: guard.role,
        },
      ],
    }),
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Compatibility-wrapper: прежняя сигнатура для существующих вызовов и тестов,
 * ожидающих только PrototypeState. Вся логика — в result-based версии.
 */
export function rejectRestaurantOrder(
  state: PrototypeState,
  orderId: string,
  reason: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): PrototypeState {
  return rejectRestaurantOrderWithResult(
    state,
    orderId,
    reason,
    actor,
    workspaceRole,
  ).state;
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
  // §6: бесплатная самостоятельная отмена — до начала приготовления, т.е.
  // RESTAURANT_REVIEW или AWAITING_PAYMENT (онлайн-заказ ещё не оплачен).
  if (
    order.status !== "RESTAURANT_REVIEW" &&
    order.status !== "AWAITING_PAYMENT"
  ) {
    return fail(
      "Ресторан уже начал готовить заказ. Самостоятельная отмена недоступна. Отправьте запрос на отмену.",
    );
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return fail("Укажите причину отмены.");
  }

  const now = new Date().toISOString();
  const fromStatus = order.status;
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
          fromStatus,
          toStatus: "CANCELED",
          message: `Клиент отменил заказ. Причина: ${normalizedReason}`,
        },
      ],
    }),
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/** Таймаут ответа ресторана на новый заказ (§4): ровно 7 минут. */
export const RESTAURANT_RESPONSE_TIMEOUT_MS = 7 * 60 * 1000;

/**
 * Автозакрытие неотвеченных заказов (§4). Идемпотентный чистый sweep: любой
 * заказ в RESTAURANT_REVIEW, у которого с `createdAt` прошло ≥ 7 минут,
 * переводится в CANCELED (actor SYSTEM). Если ресторан успел принять/отклонить —
 * заказ уже не в RESTAURANT_REVIEW и не трогается. Не меняет оплату, snapshot,
 * settlements, корзину, водителя. Повторный запуск не добавляет второе событие
 * (уже CANCELED). Проверяет заказы ВСЕХ ресторанов.
 */
export function expireUnansweredRestaurantOrders(
  state: PrototypeState,
  nowIso: string,
): PrototypeState {
  const nowMs = Date.parse(nowIso);
  const expiredIds = state.orders
    .filter(
      (order) =>
        order.status === "RESTAURANT_REVIEW" &&
        nowMs - Date.parse(order.createdAt) >= RESTAURANT_RESPONSE_TIMEOUT_MS,
    )
    .map((order) => order.id);

  if (expiredIds.length === 0) {
    return state;
  }

  const expiredSet = new Set(expiredIds);
  const orders = state.orders.map((order) => {
    if (!expiredSet.has(order.id)) {
      return order;
    }
    return {
      ...order,
      status: "CANCELED" as OrderStatus,
      cancellationReason: "Ресторан не ответил в течение 7 минут",
      updatedAt: nowIso,
      history: [
        ...order.history,
        {
          id: `${order.id}-history-${order.history.length + 1}`,
          occurredAt: nowIso,
          actor: "SYSTEM" as const,
          type: "STATUS" as const,
          fromStatus: "RESTAURANT_REVIEW" as OrderStatus,
          toStatus: "CANCELED" as OrderStatus,
          message:
            "Заказ автоматически закрыт: ресторан не ответил в течение 7 минут.",
        },
      ],
    };
  });

  return finalizeMutation(state, { ...state, orders }, nowIso);
}

/** Статусы заказа, в которых доступен только ЗАПРОС на отмену (§10). */
const CANCELLATION_REQUEST_STATUSES: readonly OrderStatus[] = [
  "PREPARING",
  "READY",
  "READY_FOR_PICKUP",
  "OUT_FOR_DELIVERY",
  "ARRIVING",
];

export interface RequestCancellationResult {
  ok: boolean;
  error: string | null;
}

function cancellationRequestId(orderId: string): string {
  return `cancellation-request-${orderId}`;
}

/**
 * Клиентский запрос на отмену уже готовящегося заказа (§10). Не меняет статус
 * заказа, оплату, snapshot; settlement не создаётся. Разрешён только для
 * активных статусов приготовления/доставки; RESTAURANT_REVIEW/AWAITING_PAYMENT
 * используют бесплатную отмену, терминальные — запрещены. Один запрос на заказ:
 * повторный вызов при уже существующем запросе не создаёт дубликат.
 */
export function requestOrderCancellationByClient(
  state: PrototypeState,
  orderId: string,
  reason: string,
): ActionResult<RequestCancellationResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const fail = (error: string): ActionResult<RequestCancellationResult> => ({
    state,
    result: { ok: false, error },
  });
  if (!order) {
    return fail("Заказ не найден.");
  }
  if (!CANCELLATION_REQUEST_STATUSES.includes(order.status)) {
    return fail("Для этого заказа запрос на отмену недоступен.");
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return fail("Укажите причину запроса.");
  }
  const requestId = cancellationRequestId(orderId);
  if (state.cancellationRequests.some((r) => r.id === requestId)) {
    return fail("Запрос на отмену уже отправлен.");
  }

  const now = new Date().toISOString();
  const request: CancellationRequest = {
    id: requestId,
    orderId,
    customerId: order.customer.id,
    restaurantId: order.restaurant.id,
    requestedAt: now,
    requestedOrderStatus: order.status,
    paymentMethod: order.paymentMethod,
    reason: normalizedReason,
    status: "PENDING",
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    requestedBy: "CLIENT",
  };

  const orders = state.orders.map((o) =>
    o.id === orderId
      ? {
          ...o,
          updatedAt: now,
          history: [
            ...o.history,
            {
              id: `${o.id}-history-${o.history.length + 1}`,
              occurredAt: now,
              actor: "CLIENT" as const,
              type: "STATUS" as const,
              fromStatus: o.status,
              toStatus: o.status,
              message: `Клиент отправил запрос на отмену. Причина: ${normalizedReason}`,
            },
          ],
        }
      : o,
  );

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders,
      cancellationRequests: [...state.cancellationRequests, request],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Ресторанный запрос на отмену у Direct. Проходит через ТОТ ЖЕ CancellationRequest
 * pipeline, что и клиентский (никакой параллельной модели): создаёт обычный
 * PENDING-запрос с тем же id (один на заказ) и одно событие истории. Разрешён
 * оператору (в SPLIT) и общему экрану (в COMBINED) через MANAGE_CANCELLATION;
 * кухне — нет. Требует OPEN preparation problem, чей id совпадает с переданным.
 * Не меняет статус заказа, ETA, оплату, financial snapshot, settlement, pickupCode
 * и водителя — решение (CANCELED/refund или отказ) принимает Direct существующим
 * approve/reject контуром. При любой ошибке state возвращается тем же объектом.
 */
export function requestOrderCancellationByRestaurant(
  state: PrototypeState,
  orderId: string,
  preparationProblemId: string,
  reason: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
  nowIso: string = new Date().toISOString(),
): ActionResult<RequestCancellationResult> {
  const fail = (error: string): ActionResult<RequestCancellationResult> => ({
    state,
    result: { ok: false, error },
  });

  if (typeof nowIso !== "string" || Number.isNaN(Date.parse(nowIso))) {
    return fail("Некорректное время операции.");
  }
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) {
    return fail("Заказ не найден.");
  }
  const guard = checkRestaurantWorkspace(
    state,
    order,
    actor,
    "MANAGE_CANCELLATION",
    workspaceRole,
  );
  if (!guard.allowed) {
    return fail("Недостаточно прав для запроса отмены у Direct.");
  }
  if (order.status !== "PREPARING") {
    return fail("Запросить отмену можно только у готовящегося заказа.");
  }
  // Запрос отмены ресторана привязан к активной проблеме приготовления: устаревшая
  // вкладка, чужой или уже решённый problemId получают ошибку без мутации.
  const open = getOpenPreparationProblem(order);
  if (!open || open.problemId !== preparationProblemId) {
    return fail("Проблема уже решена или не найдена. Обновите данные.");
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return fail("Укажите причину запроса.");
  }
  if (normalizedReason.length > ETA_REASON_MAX_LENGTH) {
    return fail("Причина слишком длинная.");
  }
  // Один запрос на заказ — тот же id, что у клиентского flow: повторный вызов
  // (в т.ч. из устаревшей вкладки после rebase) не создаёт дубликат.
  const requestId = cancellationRequestId(orderId);
  if (state.cancellationRequests.some((r) => r.id === requestId)) {
    return fail("Запрос на отмену уже отправлен.");
  }

  const now = nowIso;
  const request: CancellationRequest = {
    id: requestId,
    orderId,
    customerId: order.customer.id,
    restaurantId: order.restaurant.id,
    requestedAt: now,
    requestedOrderStatus: "PREPARING",
    paymentMethod: order.paymentMethod,
    reason: normalizedReason,
    status: "PENDING",
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    requestedBy: "RESTAURANT",
    restaurantWorkspaceRole: guard.role,
    preparationProblemId: open.problemId,
  };

  const updatedOrder: Order = {
    ...order,
    updatedAt: now,
    history: [
      ...order.history,
      {
        id: `${order.id}-history-${order.history.length + 1}`,
        occurredAt: now,
        actor,
        type: "STATUS",
        fromStatus: order.status,
        toStatus: order.status,
        // История видна клиенту: внутреннюю причину сюда НЕ пишем — она хранится
        // только в CancellationRequest.reason (оператор/COMBINED/admin). Роль и
        // actor остаются для внутреннего аудита.
        message: "Ресторан отправил запрос на отмену в Direct.",
        restaurantWorkspaceRole: guard.role,
      },
    ],
  };

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      cancellationRequests: [...state.cancellationRequests, request],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Администратор отклоняет запрос на отмену (§12). Заказ не меняется и продолжает
 * выполняться. Причина обязательна. Идемпотентно: не-PENDING запрос не меняется.
 */
export function rejectCancellationRequest(
  state: PrototypeState,
  requestId: string,
  note: string,
): ActionResult<AdminActionResult> {
  const request = state.cancellationRequests.find((r) => r.id === requestId);
  const normalizedNote = note.trim();
  const fail = (error: string): ActionResult<AdminActionResult> => ({
    state,
    result: { ok: false, error },
  });
  if (!request) return fail("Запрос не найден.");
  if (request.status !== "PENDING") return fail("Запрос уже рассмотрен.");
  if (!normalizedNote) return fail("Укажите причину решения.");

  const now = new Date().toISOString();
  // Инициатор — по существующему структурному правилу (requestedBy). Для
  // ресторанного запроса решение Direct внутреннее: комментарий администратора
  // в клиентскую историю не пишем, он остаётся в request.resolutionNote. Для
  // клиентского/legacy запроса решение адресовано клиенту — текст с причиной
  // сохраняем как прежде.
  const isRestaurantRequest = request.requestedBy === "RESTAURANT";
  const rejectionMessage = isRestaurantRequest
    ? "Direct отклонил запрос ресторана на отмену. Заказ продолжает выполняться."
    : `Администратор Direct отклонил запрос на отмену. Причина: ${normalizedNote}`;
  const order = state.orders.find((o) => o.id === request.orderId);
  const orders = order
    ? state.orders.map((o) =>
        o.id === order.id
          ? {
              ...o,
              updatedAt: now,
              history: [
                ...o.history,
                adminHistoryEvent(o, 1, now, "STATUS", o.status, o.status, rejectionMessage),
              ],
            }
          : o,
      )
    : state.orders;

  const cancellationRequests = state.cancellationRequests.map((r) =>
    r.id === requestId
      ? {
          ...r,
          status: "REJECTED" as const,
          resolvedAt: now,
          resolvedBy: "ADMIN" as const,
          resolutionNote: normalizedNote,
        }
      : r,
  );

  const nextState = finalizeMutation(
    state,
    { ...state, orders, cancellationRequests },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Администратор одобряет отмену после начала приготовления (§12). Атомарно:
 * заказ → CANCELED, запрос → APPROVED, назначенный водитель освобождается.
 * КРИТИЧНО: оплата НЕ меняется (ONLINE/PAID остаётся PAID, paidAt не очищается),
 * refund автоматически НЕ выполняется, financial snapshot не меняется,
 * settlement не создаётся и не удаляется. Идемпотентно: не-PENDING запрос или
 * терминальный заказ не изменяются.
 */
export function approveCancellationRequest(
  state: PrototypeState,
  requestId: string,
  note: string,
): ActionResult<AdminActionResult> {
  const request = state.cancellationRequests.find((r) => r.id === requestId);
  const normalizedNote = note.trim();
  const fail = (error: string): ActionResult<AdminActionResult> => ({
    state,
    result: { ok: false, error },
  });
  if (!request) return fail("Запрос не найден.");
  if (request.status !== "PENDING") return fail("Запрос уже рассмотрен.");
  if (!normalizedNote) return fail("Укажите решение.");

  const order = state.orders.find((o) => o.id === request.orderId);
  if (!order) return fail("Заказ не найден.");
  if (isTerminalOrderStatus(order.status)) {
    return fail("Заказ уже завершён или отменён.");
  }

  const now = new Date().toISOString();
  const wasOnlinePaid =
    order.paymentMethod === "ONLINE" && order.paymentStatus === "PAID";
  const refundNote = wasOnlinePaid
    ? "Администратор Direct одобрил отмену после начала приготовления. Автоматический возврат не выполнялся."
    : "Администратор Direct одобрил отмену после начала приготовления.";

  const updatedOrder: Order = {
    ...order,
    status: "CANCELED",
    cancellationReason: `Отмена одобрена администратором Direct. ${normalizedNote}`,
    // Оплату и paidAt НЕ трогаем — возврат отдельным решением.
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
        refundNote,
      ),
    ],
  };

  const cancellationRequests = state.cancellationRequests.map((r) =>
    r.id === requestId
      ? {
          ...r,
          status: "APPROVED" as const,
          resolvedAt: now,
          resolvedBy: "ADMIN" as const,
          resolutionNote: normalizedNote,
        }
      : r,
  );

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === order.id ? updatedOrder : o)),
      drivers: releaseAssignedDriver(state, order.assignedDriverId, order.id),
      cancellationRequests,
    },
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

  // Повторять можно только завершённый заказ (DELIVERED/PICKED_UP/CANCELED).
  // Проверка в domain-слое, не только в UI — корзина не меняется.
  if (isActiveOrderStatus(order.status)) {
    return fail("Повторить можно только завершённый заказ.");
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

/**
 * Исправление 3: result-based подтверждение тестовой онлайн-оплаты. Все проверки
 * до мутации; при ошибке возвращается исходный state тем же объектом (revision,
 * history, financial snapshot, settlement не меняются).
 */
export function simulateSuccessfulOnlinePaymentWithResult(
  state: PrototypeState,
  orderId: string,
): ActionResult<OrderTransitionResult> {
  const fail = (error: string): ActionResult<OrderTransitionResult> => ({
    state,
    result: { ok: false, error },
  });
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return fail("Заказ не найден.");
  if (order.paymentMethod !== "ONLINE") {
    return fail("Заказ не оплачивается онлайн.");
  }
  if (order.paymentStatus === "PAID") {
    return fail("Оплата уже подтверждена.");
  }
  if (order.status !== "AWAITING_PAYMENT") {
    return fail(wrongStatusError(order.status, "AWAITING_PAYMENT"));
  }

  const now = new Date().toISOString();
  const preparationMinutes = order.preparationMinutes ?? 25;
  const expectedReadyAt = new Date(
    new Date(now).getTime() + preparationMinutes * 60_000,
  ).toISOString();
  const nextHistoryNumber = order.history.length + 1;

  const nextState = replaceOrder(
    state,
    orderId,
    (current) => ({
      ...current,
      paymentStatus: "PAID",
      paidAt: now,
      status: "PREPARING",
      expectedReadyAt,
      updatedAt: now,
      history: [
        ...current.history,
        {
          id: `${current.id}-history-${nextHistoryNumber}`,
          occurredAt: now,
          actor: "SYSTEM",
          type: "PAYMENT",
          fromStatus: "AWAITING_PAYMENT",
          toStatus: "AWAITING_PAYMENT",
          message: "Тестовая онлайн-оплата успешно подтверждена.",
        },
        {
          id: `${current.id}-history-${nextHistoryNumber + 1}`,
          occurredAt: now,
          actor: "SYSTEM",
          type: "STATUS",
          fromStatus: "AWAITING_PAYMENT",
          toStatus: "PREPARING",
          message: "Заказ передан ресторану в приготовление.",
        },
      ],
    }),
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/** Compatibility-wrapper: прежняя state-возвращающая сигнатура. */
export function simulateSuccessfulOnlinePayment(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  return simulateSuccessfulOnlinePaymentWithResult(state, orderId).state;
}

/**
 * Исправление 3: result-based отметка готовности. Неправильный статус и
 * недостаток прав — доменные ошибки, а не молчаливый no-op; при ошибке
 * возвращается исходный state тем же объектом (без history-события).
 */
export function markOrderReadyWithResult(
  state: PrototypeState,
  orderId: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<OrderTransitionResult> {
  const fail = (error: string): ActionResult<OrderTransitionResult> => ({
    state,
    result: { ok: false, error },
  });
  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (!targetOrder) {
    return fail("Заказ не найден.");
  }
  // Этап 4: готовность — действие кухни/общего экрана; оператор в SPLIT не может.
  const guard = checkRestaurantWorkspace(
    state,
    targetOrder,
    actor,
    "MARK_READY",
    workspaceRole,
  );
  if (!guard.allowed) {
    return fail("Недостаточно прав для выполнения действия.");
  }
  if (targetOrder.status !== "PREPARING") {
    return fail(wrongStatusError(targetOrder.status, "PREPARING"));
  }
  if (getOpenPreparationProblem(targetOrder)) {
    return fail(
      "Сначала дождитесь решения проблемы приготовления.",
    );
  }
  const workspace = guard.role;

  const now = new Date().toISOString();
  const readyPrefix =
    actor === "ADMIN" ? "Администратор Direct отметил готовность. " : "";
  const nextStatus =
    targetOrder.deliveryMode === "PICKUP" ? "READY_FOR_PICKUP" : "READY";
  const message =
    targetOrder.deliveryMode === "PICKUP"
      ? "Заказ готов к выдаче клиенту."
      : targetOrder.deliveryMode === "RESTAURANT_DELIVERY"
        ? "Заказ готов, ожидает курьера ресторана."
        : "Заказ готов и упакован.";

  const nextState = replaceOrder(
    state,
    orderId,
    (order) => ({
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
          restaurantWorkspaceRole: workspace,
        },
      ],
    }),
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/** Compatibility-wrapper: прежняя state-возвращающая сигнатура. */
export function markOrderReady(
  state: PrototypeState,
  orderId: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): PrototypeState {
  return markOrderReadyWithResult(state, orderId, actor, workspaceRole).state;
}

export interface AdjustOrderEtaResult {
  ok: boolean;
  error: string | null;
  previousExpectedReadyAt: string | null;
  nextExpectedReadyAt: string | null;
}

/** Время HH:MM в часовом поясе ресторана (для текста истории ETA). */
function formatEtaTimeInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timeZone || "Europe/Chisinau",
  }).format(new Date(iso));
}

/**
 * Корректировка ожидаемого времени готовности заказа кухней/админом (Кухня 3).
 * Только для PREPARING; НЕ меняет статус, preparationMinutes, состав, цены,
 * financial snapshot, paymentStatus/paidAt, settlement, назначенного водителя,
 * CancellationRequest, createdAt и точку входа в PREPARING (событие type "ETA",
 * fromStatus === toStatus, поэтому getOrderStatusSince не сбрасывается).
 * Меняет только expectedReadyAt, updatedAt и добавляет одну audit-запись +
 * одно history-событие. `nowIso` — явный аргумент для детерминированных тестов.
 */
export function adjustOrderExpectedReadyAt(
  state: PrototypeState,
  orderId: string,
  nextExpectedReadyAt: string,
  reason: string,
  actor: "RESTAURANT" | "ADMIN",
  nowIso: string,
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<AdjustOrderEtaResult> {
  const order = state.orders.find((o) => o.id === orderId);
  const fail = (error: string): ActionResult<AdjustOrderEtaResult> => ({
    state,
    result: {
      ok: false,
      error,
      previousExpectedReadyAt: null,
      nextExpectedReadyAt: null,
    },
  });

  if (!order) return fail("Заказ не найден.");
  // Этап 4: корректировка времени — действие кухни/общего экрана; оператор нет.
  const guard = checkRestaurantWorkspace(
    state,
    order,
    actor,
    "ADJUST_ETA",
    workspaceRole,
  );
  if (!guard.allowed) {
    return fail("Недостаточно прав для изменения времени.");
  }
  const workspace = guard.role;
  if (Number.isNaN(Date.parse(nowIso))) {
    return fail("Некорректное время операции.");
  }
  if (order.status !== "PREPARING") {
    return fail("Изменить время можно только для заказа в приготовлении.");
  }
  const prev = order.expectedReadyAt;
  if (!prev || Number.isNaN(Date.parse(prev))) {
    return fail("У заказа нет корректного ожидаемого времени.");
  }
  const normReason = reason.trim();
  if (!normReason) return fail("Укажите причину.");
  if (normReason.length > ETA_REASON_MAX_LENGTH) {
    return fail("Причина слишком длинная (максимум 300 символов).");
  }

  const boundsError = validateEtaCandidate(nextExpectedReadyAt, nowIso);
  if (boundsError) return fail(boundsError);

  const nextMs = Date.parse(nextExpectedReadyAt);
  // Новое ETA не должно совпадать со старым с точностью до секунды (идемпотентно:
  // повторный идентичный вызов не создаёт дубликат — expectedReadyAt уже равен).
  if (Math.floor(nextMs / 1000) === Math.floor(Date.parse(prev) / 1000)) {
    return fail("Новое время совпадает с текущим.");
  }

  const timeZone =
    state.restaurants.find((r) => r.id === order.restaurant.id)?.timeZone ??
    "Europe/Chisinau";
  const isDelay = nextMs > Date.parse(prev);
  // §7: префикс сообщения зависит от actor (кухня vs администратор Direct).
  const who = actor === "ADMIN" ? "Администратор Direct" : "Ресторан";
  const message = isDelay
    ? `${who} изменил ожидаемое время готовности с ${formatEtaTimeInZone(prev, timeZone)} на ${formatEtaTimeInZone(nextExpectedReadyAt, timeZone)}. Причина: ${normReason}`
    : `${who} сообщил, что заказ будет готов раньше: новое время ${formatEtaTimeInZone(nextExpectedReadyAt, timeZone)}. Причина: ${normReason}`;

  const adjustment: OrderEtaAdjustment = {
    id: `eta-${orderId}-${order.etaAdjustments.length + 1}`,
    occurredAt: nowIso,
    actor,
    previousExpectedReadyAt: prev,
    nextExpectedReadyAt,
    reason: normReason,
    restaurantWorkspaceRole: workspace,
  };

  const updatedOrder: Order = {
    ...order,
    expectedReadyAt: nextExpectedReadyAt,
    updatedAt: nowIso,
    etaAdjustments: [...order.etaAdjustments, adjustment],
    history: [
      ...order.history,
      {
        id: `${order.id}-history-${order.history.length + 1}`,
        occurredAt: nowIso,
        actor,
        type: "ETA",
        fromStatus: "PREPARING",
        toStatus: "PREPARING",
        message,
        restaurantWorkspaceRole: workspace,
      },
    ],
  };

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
    },
    nowIso,
  );
  return {
    state: nextState,
    result: {
      ok: true,
      error: null,
      previousExpectedReadyAt: prev,
      nextExpectedReadyAt,
    },
  };
}

/**
 * Корректировка ETA по типизированному намерению (§1). Один общий nowIso
 * используется и для расчёта нового времени из intent, и для domain-validation —
 * поэтому вариант «через 1 минуту» и границы ранней готовности не устаревают
 * между выбором и submit. Тонкая обёртка над adjustOrderExpectedReadyAt.
 */
export function adjustOrderEtaFromIntent(
  state: PrototypeState,
  orderId: string,
  intent: EtaAdjustmentIntent,
  reason: string,
  actor: "RESTAURANT" | "ADMIN",
  nowIso: string,
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<AdjustOrderEtaResult> {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || !order.expectedReadyAt) {
    // Делегируем — adjustOrderExpectedReadyAt вернёт корректную ошибку.
    return adjustOrderExpectedReadyAt(
      state,
      orderId,
      "",
      reason,
      actor,
      nowIso,
      workspaceRole,
    );
  }
  const next = computeEtaFromIntent(intent, order.expectedReadyAt, nowIso);
  return adjustOrderExpectedReadyAt(
    state,
    orderId,
    next,
    reason,
    actor,
    nowIso,
    workspaceRole,
  );
}

export interface PreparationProblemResult {
  ok: boolean;
  error: string | null;
}

/** Допустимые причины проблемы приготовления (Этап 6), для UI. */
export const PREPARATION_PROBLEM_REASONS = [
  "Нет блюда",
  "Закончился ингредиент",
  "Кухня перегружена",
  "Техническая проблема",
  "Не можем выполнить комментарий",
  "Ресторан скоро закрывается",
  "Другая причина",
] as const;

/**
 * Этап 6: кухня сообщает «не можем приготовить». Разрешено COMBINED (в COMBINED)
 * и KITCHEN (в SPLIT), для статусов RESTAURANT_REVIEW и PREPARING. Действие НЕ
 * меняет статус, оплату, refund, financial snapshot, settlement, expectedReadyAt
 * и не отменяет заказ — только добавляет структурное событие истории, сразу
 * видимое оператору. Финансовую отмену выполняет оператор существующим flow.
 */
export function reportRestaurantPreparationProblem(
  state: PrototypeState,
  orderId: string,
  reason: string,
  actor: OrderActionActor = "RESTAURANT",
  nowIso: string = new Date().toISOString(),
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<PreparationProblemResult> {
  const fail = (error: string): ActionResult<PreparationProblemResult> => ({
    state,
    result: { ok: false, error },
  });

  if (typeof nowIso !== "string" || Number.isNaN(Date.parse(nowIso))) {
    return fail("Некорректное время операции.");
  }
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) {
    return fail("Заказ не найден.");
  }
  const guard = checkRestaurantWorkspace(
    state,
    order,
    actor,
    "REPORT_PREPARATION_PROBLEM",
    workspaceRole,
  );
  if (!guard.allowed) {
    return fail("Недостаточно прав для сообщения о проблеме приготовления.");
  }
  if (order.status !== "RESTAURANT_REVIEW" && order.status !== "PREPARING") {
    return fail("Сообщить о проблеме можно только до готовности заказа.");
  }
  // Этап 1: пока прежняя проблема не решена, вторую не отправляем — иначе
  // копятся дубли и оператор не понимает, какая активна.
  if (getOpenPreparationProblem(order)) {
    return fail("Проблема уже передана оператору. Дождитесь решения.");
  }
  // Этап 1: пока прежняя проблема не решена, вторую не отправляем — иначе
  // копятся дубли и оператор не понимает, какая активна.
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return fail("Укажите причину.");
  }
  if (normalizedReason.length > ETA_REASON_MAX_LENGTH) {
    return fail("Причина слишком длинная.");
  }

  const now = nowIso;
  const prefix =
    actor === "ADMIN"
      ? PREPARATION_PROBLEM_ADMIN_PREFIX
      : PREPARATION_PROBLEM_KITCHEN_PREFIX;
  // Id события служит и id проблемы: OPEN и последующий RESOLVED делят его.
  const eventId = `${order.id}-history-${order.history.length + 1}`;
  const updatedOrder: Order = {
    ...order,
    updatedAt: now,
    history: [
      ...order.history,
      {
        id: eventId,
        occurredAt: now,
        actor,
        type: "PREPARATION_PROBLEM",
        fromStatus: order.status,
        toStatus: order.status,
        message: `${prefix}${normalizedReason}`,
        restaurantWorkspaceRole: guard.role,
        preparationProblemId: eventId,
        preparationProblemState: "OPEN",
      },
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
 * Этап 1 из 2: оператор (в COMBINED — общий экран) подтверждает, что проблема
 * приготовления решена и заказ продолжается. Действие ТОЛЬКО замыкает цикл
 * сообщение → решение: статус, ETA, позиции, оплату, financial snapshot,
 * settlement и pickupCode оно НЕ меняет и заказ не отменяет. Эскалация в Direct
 * (отмена/возврат) — отдельный следующий этап, здесь её нет.
 *
 * Guard: заказ существует и в PREPARING; указанная проблема существует и всё ещё
 * OPEN (повторное/устаревшее решение получает ошибку без мутации); причина не
 * пуста и ≤ 300; роль разрешена (SPLIT: только OPERATOR; COMBINED: общий экран).
 */
export function resolveRestaurantPreparationProblem(
  state: PrototypeState,
  orderId: string,
  preparationProblemId: string,
  reason: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
  nowIso: string = new Date().toISOString(),
): ActionResult<PreparationProblemResult> {
  const fail = (error: string): ActionResult<PreparationProblemResult> => ({
    state,
    result: { ok: false, error },
  });

  if (typeof nowIso !== "string" || Number.isNaN(Date.parse(nowIso))) {
    return fail("Некорректное время операции.");
  }
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) {
    return fail("Заказ не найден.");
  }
  const guard = checkRestaurantWorkspace(
    state,
    order,
    actor,
    "RESOLVE_PREPARATION_PROBLEM",
    workspaceRole,
  );
  if (!guard.allowed) {
    return fail("Недостаточно прав для решения проблемы приготовления.");
  }
  if (order.status !== "PREPARING") {
    return fail("Решить проблему можно только у готовящегося заказа.");
  }
  // Проблема должна существовать и быть всё ещё открытой: устаревшая вкладка,
  // повторное подтверждение или чужой id получают ошибку без мутации.
  const open = getOpenPreparationProblem(order);
  if (!open || open.problemId !== preparationProblemId) {
    return fail("Проблема уже решена или не найдена. Обновите данные.");
  }
  // Пока Direct не рассмотрел ресторанный запрос отмены по этой же проблеме,
  // решать её нельзя: иначе проблема стала бы RESOLVED, «Готово» разблокировалось,
  // а PENDING-запрос завис бы. Legacy/клиентский запрос (requestedBy !== RESTAURANT)
  // этим специальным guard не блокирует.
  const pendingRestaurantRequest = state.cancellationRequests.find(
    (r) => r.orderId === orderId && r.status === "PENDING",
  );
  if (
    pendingRestaurantRequest &&
    pendingRestaurantRequest.requestedBy === "RESTAURANT" &&
    pendingRestaurantRequest.preparationProblemId === preparationProblemId
  ) {
    return fail("Сначала дождитесь решения Direct по запросу на отмену.");
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return fail("Укажите причину решения.");
  }
  if (normalizedReason.length > ETA_REASON_MAX_LENGTH) {
    return fail("Причина слишком длинная.");
  }

  const now = nowIso;
  const updatedOrder: Order = {
    ...order,
    updatedAt: now,
    history: [
      ...order.history,
      {
        id: `${order.id}-history-${order.history.length + 1}`,
        occurredAt: now,
        actor,
        type: "PREPARATION_PROBLEM",
        fromStatus: order.status,
        toStatus: order.status,
        message: `Оператор подтвердил решение: ${normalizedReason}`,
        restaurantWorkspaceRole: guard.role,
        preparationProblemId,
        preparationProblemState: "RESOLVED",
      },
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

/** Причины решения проблемы приготовления оператором (Этап 1), для UI. */
export const PREPARATION_PROBLEM_RESOLUTION_REASONS = [
  "Проблема устранена",
  "Клиент согласился продолжить заказ",
  "Другая причина",
] as const;

/**
 * Общий шаг курьерской доставки для обоих режимов (RESTAURANT_DELIVERY и
 * PLATFORM_DRIVER). Для водителя Direct переход READY → OUT_FOR_DELIVERY
 * разрешён только при назначенном водителе (§3). Все проверки — в домене.
 */
function advanceCourierStatusWithResult(
  state: PrototypeState,
  orderId: string,
  fromStatus: Order["status"],
  toStatus: Order["status"],
  restaurantMessage: string,
  platformMessage: string,
  actor: OrderActionActor = "RESTAURANT",
  requireDriverForPlatform = false,
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<OrderTransitionResult> {
  const fail = (error: string): ActionResult<OrderTransitionResult> => ({
    state,
    result: { ok: false, error },
  });
  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (!targetOrder) {
    return fail("Заказ не найден.");
  }
  if (
    targetOrder.deliveryMode !== "RESTAURANT_DELIVERY" &&
    targetOrder.deliveryMode !== "PLATFORM_DRIVER"
  ) {
    return fail("Неподдерживаемый способ получения заказа.");
  }
  // Этап 4: передача заказа курьеру/водителю — зона оператора/общего экрана.
  const guard = checkRestaurantWorkspace(
    state,
    targetOrder,
    actor,
    "HANDOFF_ORDER",
    workspaceRole,
  );
  if (!guard.allowed) {
    return fail("Недостаточно прав для выполнения действия.");
  }
  if (targetOrder.status !== fromStatus) {
    return fail(wrongStatusError(targetOrder.status, fromStatus));
  }
  if (
    requireDriverForPlatform &&
    targetOrder.deliveryMode === "PLATFORM_DRIVER" &&
    !targetOrder.assignedDriverId
  ) {
    return fail("Для заказа не назначен водитель.");
  }
  const now = new Date().toISOString();
  const message =
    targetOrder.deliveryMode === "PLATFORM_DRIVER"
      ? platformMessage
      : restaurantMessage;
  const nextState = replaceOrder(
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
          restaurantWorkspaceRole: guard.role,
        },
      ],
    }),
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

export function markOrderOutForDeliveryWithResult(
  state: PrototypeState,
  orderId: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<OrderTransitionResult> {
  return advanceCourierStatusWithResult(
    state,
    orderId,
    "READY",
    "OUT_FOR_DELIVERY",
    "Курьер ресторана выехал.",
    "Водитель Direct выехал.",
    actor,
    true,
    workspaceRole,
  );
}

/** Compatibility-wrapper: прежняя state-возвращающая сигнатура. */
export function markOrderOutForDelivery(
  state: PrototypeState,
  orderId: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): PrototypeState {
  return markOrderOutForDeliveryWithResult(state, orderId, actor, workspaceRole)
    .state;
}

export function markOrderArrivingWithResult(
  state: PrototypeState,
  orderId: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<OrderTransitionResult> {
  return advanceCourierStatusWithResult(
    state,
    orderId,
    "OUT_FOR_DELIVERY",
    "ARRIVING",
    "Курьер ресторана скоро будет.",
    "Водитель Direct скоро будет.",
    actor,
    false,
    workspaceRole,
  );
}

/** Compatibility-wrapper: прежняя state-возвращающая сигнатура. */
export function markOrderArriving(
  state: PrototypeState,
  orderId: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): PrototypeState {
  return markOrderArrivingWithResult(state, orderId, actor, workspaceRole)
    .state;
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
export function markOrderDeliveredWithResult(
  state: PrototypeState,
  orderId: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<OrderTransitionResult> {
  const fail = (error: string): ActionResult<OrderTransitionResult> => ({
    state,
    result: { ok: false, error },
  });
  const targetOrder = state.orders.find((order) => order.id === orderId);
  if (!targetOrder) {
    return fail("Заказ не найден.");
  }
  if (targetOrder.deliveryMode !== "RESTAURANT_DELIVERY") {
    return fail("Неподдерживаемый способ получения заказа.");
  }
  // Этап 4: завершение доставки — выдача заказа (оператор/общий экран).
  const guard = checkRestaurantWorkspace(
    state,
    targetOrder,
    actor,
    "HANDOFF_ORDER",
    workspaceRole,
  );
  if (!guard.allowed) {
    return fail("Недостаточно прав для выполнения действия.");
  }
  if (targetOrder.status !== "ARRIVING") {
    return fail(wrongStatusError(targetOrder.status, "ARRIVING"));
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
        restaurantWorkspaceRole: guard.role,
      },
      {
        id: `${targetOrder.id}-history-${nextHistoryNumber + 1}`,
        occurredAt: now,
        actor,
        type: "STATUS",
        fromStatus: "ARRIVING",
        toStatus: "DELIVERED",
        message: "Заказ доставлен клиенту.",
        restaurantWorkspaceRole: guard.role,
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

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((order) =>
        order.id === orderId ? updatedOrder : order,
      ),
      settlements: alreadySettled
        ? state.settlements
        : [...state.settlements, settlement],
      // Двусторонний журнал: признаём обязательства завершённого заказа из его
      // снимка, идемпотентно (без дублей по orderId+type).
      restaurantAccountingEntries: [
        ...state.restaurantAccountingEntries,
        ...computeCompletedOrderAccountingEntries(
          updatedOrder,
          state.restaurantAccountingEntries,
        ),
      ],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/** Compatibility-wrapper: прежняя state-возвращающая сигнатура. */
export function markOrderDelivered(
  state: PrototypeState,
  orderId: string,
  actor: OrderActionActor = "RESTAURANT",
  workspaceRole?: RestaurantWorkspaceRole,
): PrototypeState {
  return markOrderDeliveredWithResult(state, orderId, actor, workspaceRole)
    .state;
}

export interface CompletePickupResult {
  ok: boolean;
  error: string | null;
  /** Способ, которым фактически заплатил клиент; null при любой ошибке. */
  paidWith: PickupPaymentMethod | null;
}

/** Ровно четыре цифры (после trim). */
function isFourDigitCode(value: string): boolean {
  return /^\d{4}$/.test(value.trim());
}

/**
 * Атомарная выдача самовывоза по коду клиента: фиксирует оплату на точке,
 * переводит заказ в PICKED_UP и один раз начисляет комиссию Direct. Единственный
 * штатный путь завершить PICKUP-заказ. Все проверки — до любой мутации; при любой
 * ошибке состояние возвращается тем же ref (идемпотентность повторного вызова).
 */
export function completePickupWithCode(
  state: PrototypeState,
  orderId: string,
  code: string,
  paidWith: PickupPaymentMethod,
  actor: OrderActionActor = "RESTAURANT",
  nowIso: string = new Date().toISOString(),
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<CompletePickupResult> {
  const fail = (error: string): ActionResult<CompletePickupResult> => ({
    state,
    result: { ok: false, error, paidWith: null },
  });

  // 1. Корректное время операции (детерминизм, единый nowIso).
  if (typeof nowIso !== "string" || Number.isNaN(Date.parse(nowIso))) {
    return fail("Некорректное время операции.");
  }
  // 2-3. Существование и тип заказа.
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || order.deliveryMode !== "PICKUP") {
    return fail("Заказ не найден или не является самовывозом.");
  }
  // Этап 4: выдача заказа — действие оператора/общего экрана; кухня в SPLIT нет.
  const handoffGuard = checkRestaurantWorkspace(
    state,
    order,
    actor,
    "HANDOFF_ORDER",
    workspaceRole,
  );
  if (!handoffGuard.allowed) {
    return fail("Недостаточно прав для выдачи заказа.");
  }
  const handoffWorkspace = handoffGuard.role;
  // 14. Повторная выдача — без двойной мутации, тот же ref состояния.
  if (order.status === "PICKED_UP" || order.pickupCodeUsed) {
    return fail("Заказ уже выдан.");
  }
  // 4. Готовность к выдаче.
  if (order.status !== "READY_FOR_PICKUP") {
    return fail("Заказ ещё не готов к выдаче.");
  }
  // 5. Способ оплаты заказа — оплата на точке.
  if (order.paymentMethod !== "PAY_AT_RESTAURANT") {
    return fail("Этот заказ не оплачивается при получении.");
  }
  // 6. Оплата ещё ожидается на точке.
  if (order.paymentStatus !== "DUE_AT_PICKUP") {
    return fail("Оплата по заказу не ожидается.");
  }
  // 7. Код выдачи существует.
  if (!order.pickupCode) {
    return fail("Для заказа не сгенерирован код выдачи.");
  }
  // 8. Код ещё не использован (дублирует 14 на уровне флага).
  if (order.pickupCodeUsed) {
    return fail("Заказ уже выдан.");
  }
  // 9. Ровно четыре цифры.
  if (!isFourDigitCode(code)) {
    return fail("Код должен состоять из четырёх цифр.");
  }
  // 10. Код совпадает.
  if (code.trim() !== order.pickupCode) {
    return fail("Неверный код клиента.");
  }
  // 11. Способ оплаты выбран корректно.
  if (paidWith !== "CASH" && paidWith !== "CARD") {
    return fail("Выберите способ оплаты.");
  }
  // 12. Способ доступен на точке (по историческому снимку).
  if (!order.pickupPaymentMethodsSnapshot.includes(paidWith)) {
    return fail("Этот способ оплаты недоступен на точке.");
  }
  // 13. Комиссия ещё не начислена.
  const settlementId = `settlement-${orderId}`;
  if (
    state.settlements.some(
      (entry) => entry.id === settlementId || entry.orderId === orderId,
    )
  ) {
    return fail("Начисление по заказу уже создано.");
  }

  const now = nowIso;
  const nextHistoryNumber = order.history.length + 1;
  const paymentMessage =
    actor === "ADMIN"
      ? paidWith === "CASH"
        ? "Администратор Direct подтвердил оплату наличными в ресторане."
        : "Администратор Direct подтвердил оплату картой в ресторане."
      : paidWith === "CASH"
        ? "Оплата получена в ресторане наличными."
        : "Оплата получена в ресторане картой.";
  const statusMessage =
    actor === "ADMIN"
      ? "Администратор Direct подтвердил выдачу клиенту по коду."
      : "Заказ выдан клиенту по коду.";
  const updatedOrder: Order = {
    ...order,
    status: "PICKED_UP",
    paymentStatus: "PAID_AT_RESTAURANT",
    paidAt: now,
    pickupCodeUsed: true,
    pickupPaidWith: paidWith,
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
        message: paymentMessage,
        restaurantWorkspaceRole: handoffWorkspace,
      },
      {
        id: `${order.id}-history-${nextHistoryNumber + 1}`,
        occurredAt: now,
        actor,
        type: "STATUS",
        fromStatus: "READY_FOR_PICKUP",
        toStatus: "PICKED_UP",
        message: statusMessage,
        restaurantWorkspaceRole: handoffWorkspace,
      },
    ],
  };

  // Начисление комиссии по историческому финснимку заказа (без пересчёта).
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
      settlements: [...state.settlements, settlement],
      // Двусторонний журнал: признаём обязательства завершённого заказа.
      restaurantAccountingEntries: [
        ...state.restaurantAccountingEntries,
        ...computeCompletedOrderAccountingEntries(
          updatedOrder,
          state.restaurantAccountingEntries,
        ),
      ],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null, paidWith } };
}

export const PICKUP_NO_SHOW_REASON_MAX_LENGTH = 300;

export interface PickupNoShowResult {
  ok: boolean;
  error: string | null;
  /** ISO-момент, с которого невыкуп допустим (для UI); null, если неприменимо. */
  eligibleAt: string | null;
}

/**
 * Невыкуп: заказ готов, но клиент не пришёл. Закрывается без комиссии Direct;
 * увеличивается счётчик невыкупов клиента. Разрешён не раньше 30 минут после
 * РЕАЛЬНОГО перехода в READY_FOR_PICKUP (по STATUS-событию, не по updatedAt).
 * Оплата остаётся DUE_AT_PICKUP, paidAt/pickupPaidWith — null, код не гасится,
 * начислений нет. Ставит структурированный pickupNoShowAt = nowIso.
 * Fail-closed (§5): любое расхождение оплаченного/выданного состояния — отказ
 * без мутации (тот же ref). Идемпотентен: повторный вызов ничего не меняет.
 */
export function markPickupNoShow(
  state: PrototypeState,
  orderId: string,
  reason: string,
  actor: OrderActionActor = "RESTAURANT",
  nowIso: string = new Date().toISOString(),
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<PickupNoShowResult> {
  const fail = (
    error: string,
    eligibleAt: string | null = null,
  ): ActionResult<PickupNoShowResult> => ({
    state,
    result: { ok: false, error, eligibleAt },
  });

  if (typeof nowIso !== "string" || Number.isNaN(Date.parse(nowIso))) {
    return fail("Некорректное время операции.");
  }
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || order.deliveryMode !== "PICKUP") {
    return fail("Заказ не найден или не является самовывозом.");
  }
  // Этап 4: невыкуп — управление отменой; действие оператора/общего экрана.
  // Исправление 3: сохраняем результат guard, чтобы событие получило роль
  // (для ADMIN guard.role остаётся undefined — ресторанная роль не ставится).
  const noShowGuard = checkRestaurantWorkspace(
    state,
    order,
    actor,
    "MANAGE_CANCELLATION",
    workspaceRole,
  );
  if (!noShowGuard.allowed) {
    return fail("Недостаточно прав для отметки невыкупа.");
  }
  if (order.status !== "READY_FOR_PICKUP") {
    return fail("Невыкуп можно отметить только для готового к выдаче заказа.");
  }
  // §5: fail-closed — заказ не должен быть уже оплачен/выдан ни в каком виде.
  if (
    order.paymentMethod !== "PAY_AT_RESTAURANT" ||
    order.paymentStatus !== "DUE_AT_PICKUP" ||
    order.pickupCodeUsed !== false ||
    order.paidAt !== null ||
    order.pickupPaidWith !== null ||
    state.settlements.some((entry) => entry.orderId === orderId)
  ) {
    return fail("Заказ уже оплачен или выдан — невыкуп невозможен.");
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return fail("Укажите причину невыкупа.");
  }
  if (normalizedReason.length > PICKUP_NO_SHOW_REASON_MAX_LENGTH) {
    return fail("Причина слишком длинная.");
  }
  const eligibleAt = getPickupNoShowEligibleAtIso(order);
  if (!isPickupNoShowEligibleAt(order, nowIso)) {
    return fail("Невыкуп ещё нельзя отметить: не прошло 30 минут.", eligibleAt);
  }

  const now = nowIso;
  const noShowPrefix =
    actor === "ADMIN" ? "Администратор Direct отметил невыкуп. " : "";
  // §5: явно сохраняем безопасное состояние — оплата не фиксируется, код не
  // гасится, начислений нет, финансы не трогаем; только статус + признак.
  const updatedOrder: Order = {
    ...order,
    status: "CANCELED",
    paymentStatus: order.paymentStatus,
    paidAt: null,
    pickupPaidWith: null,
    pickupCodeUsed: false,
    pickupNoShowAt: now,
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
        restaurantWorkspaceRole: noShowGuard.role,
      },
    ],
  };

  const nextState = finalizeMutation(
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
  return { state: nextState, result: { ok: true, error: null, eligibleAt } };
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

/**
 * Освобождает назначенного водителя заказа `releasedOrderId`. Fail-closed: в
 * AVAILABLE переводим только если у водителя НЕ осталось другого активного
 * заказа (проверка через getDriverActiveOrder с исключением освобождаемого
 * заказа). Если другой активный заказ есть (в т.ч. при повреждённом двойном
 * назначении) — водитель остаётся/становится BUSY, а не AVAILABLE.
 */
function releaseAssignedDriver(
  state: PrototypeState,
  driverId: string | null,
  releasedOrderId: string,
): DriverProfile[] {
  if (!driverId) {
    return state.drivers;
  }
  const hasOtherActive =
    getDriverActiveOrder(state, driverId, releasedOrderId) !== null;
  return setDriverStatus(
    state.drivers,
    driverId,
    hasOtherActive ? "BUSY" : "AVAILABLE",
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

/**
 * Приостановка/возобновление приёма заказов рестораном (админ). Заказы не
 * трогаются. §21: административное решение всегда очищает stale orderPause —
 * временная пауза не подменяет ручное решение админа.
 */
export function setRestaurantAcceptingOrdersWithResult(
  state: PrototypeState,
  restaurantId: string,
  accepting: boolean,
): ActionResult<OrderTransitionResult> {
  const target = state.restaurants.find((r) => r.id === restaurantId);
  if (!target) {
    return { state, result: { ok: false, error: "Ресторан не найден." } };
  }
  const needsChange =
    target.isAcceptingOrders !== accepting || target.orderPause !== null;
  if (!needsChange) {
    // Действительно идемпотентная настройка: требуемое значение уже установлено
    // (например, другой вкладкой). Успех без изменения (changed=false у ack).
    return { state, result: { ok: true, error: null } };
  }
  const nextState = finalizeMutation(state, {
    ...state,
    restaurants: state.restaurants.map((restaurant) =>
      restaurant.id === restaurantId
        ? { ...restaurant, isAcceptingOrders: accepting, orderPause: null }
        : restaurant,
    ),
  });
  return { state: nextState, result: { ok: true, error: null } };
}

/** Compatibility-wrapper: прежняя state-возвращающая сигнатура. */
export function setRestaurantAcceptingOrders(
  state: PrototypeState,
  restaurantId: string,
  accepting: boolean,
): PrototypeState {
  return setRestaurantAcceptingOrdersWithResult(state, restaurantId, accepting)
    .state;
}

/**
 * Этап 10: смена режима работы ресторана. Меняет ТОЛЬКО orderWorkflowMode —
 * заказы, статусы, ETA, оплату, водителя, financial snapshot, settlement и
 * историю не трогает. Совпадающий режим — доменная ошибка: активную radio-карту
 * UI не переключает, поэтому совпадение означает опередившую другую вкладку.
 */
export function setRestaurantWorkflowModeWithResult(
  state: PrototypeState,
  restaurantId: string,
  mode: RestaurantOrderWorkflowMode,
): ActionResult<OrderTransitionResult> {
  const target = state.restaurants.find((r) => r.id === restaurantId);
  if (!target) {
    return { state, result: { ok: false, error: "Ресторан не найден." } };
  }
  if (target.orderWorkflowMode === mode) {
    return {
      state,
      result: {
        ok: false,
        error: "Режим работы уже изменён другой вкладкой.",
      },
    };
  }
  const nextState = finalizeMutation(state, {
    ...state,
    restaurants: state.restaurants.map((restaurant) =>
      restaurant.id === restaurantId
        ? { ...restaurant, orderWorkflowMode: mode }
        : restaurant,
    ),
  });
  return { state: nextState, result: { ok: true, error: null } };
}

/** Compatibility-wrapper: прежняя state-возвращающая сигнатура. */
export function setRestaurantWorkflowMode(
  state: PrototypeState,
  restaurantId: string,
  mode: RestaurantOrderWorkflowMode,
): PrototypeState {
  return setRestaurantWorkflowModeWithResult(state, restaurantId, mode).state;
}

// --- Операционная пауза приёма и доступность меню (Этап кухни 2) ------------

export interface OperationalActionResult {
  ok: boolean;
  error: string | null;
}

export interface BulkOperationalResult {
  ok: boolean;
  error: string | null;
  /** Сколько блюд реально изменено. */
  affected: number;
}

function makeOperationalEvent(
  index: number,
  occurredAt: string,
  actor: OperationalActor,
  action: OperationalEventAction,
  restaurantId: string,
  menuItemId: string | null,
  reason: string,
  resumeAt: string | null,
): OperationalEvent {
  return {
    id: `op-${restaurantId}-${menuItemId ?? "restaurant"}-${index}`,
    occurredAt,
    actor,
    action,
    restaurantId,
    menuItemId,
    reason,
    resumeAt,
  };
}

/**
 * Разрешает срок паузы в конкретный resumeAt. Возвращает `{ resumeAt }` или
 * `{ error }`. MANUAL → null; UNTIL_TIME → переданное время (в будущем);
 * UNTIL_NEXT_OPEN → ближайшее открытие по графику ресторана.
 */
function resolvePauseResumeAt(
  restaurant: Restaurant,
  mode: OperationalPauseMode,
  resumeAt: string | null,
  nowMs: number,
): { resumeAt: string | null } | { error: string } {
  // Исправление 6: runtime-данные (старый localStorage, ручной вызов, JS) могут
  // принести неизвестный режим — не трактуем его молча как UNTIL_NEXT_OPEN.
  if (mode !== "UNTIL_TIME" && mode !== "UNTIL_NEXT_OPEN" && mode !== "MANUAL") {
    return { error: "Неизвестный режим паузы." };
  }
  if (mode === "MANUAL") {
    return { resumeAt: null };
  }
  if (mode === "UNTIL_TIME") {
    if (!resumeAt) return { error: "Укажите время возобновления." };
    if (Date.parse(resumeAt) <= nowMs) {
      return { error: "Время возобновления должно быть в будущем." };
    }
    return { resumeAt };
  }
  // UNTIL_NEXT_OPEN
  const next = resumeAt ?? computeNextOpeningIso(restaurant, nowMs);
  if (!next) {
    return {
      error:
        "В графике нет рабочих дней. Выберите «До ручного включения».",
    };
  }
  if (Date.parse(next) <= nowMs) {
    return { error: "Время возобновления должно быть в будущем." };
  }
  return { resumeAt: next };
}

/**
 * Операционная пауза приёма новых заказов рестораном (§2, §6). Блокирует только
 * новые заказы: активные заказы, цены, snapshots, settlement, водители и запросы
 * на отмену не трогаются. Причина обязательна. Идентичная активная пауза не
 * создаёт лишней мутации.
 */
export function pauseRestaurantOrders(
  state: PrototypeState,
  restaurantId: string,
  reason: string,
  mode: OperationalPauseMode,
  resumeAt: string | null,
  actor: OperationalActor,
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<OperationalActionResult> {
  const restaurant = state.restaurants.find((r) => r.id === restaurantId);
  const fail = (error: string): ActionResult<OperationalActionResult> => ({
    state,
    result: { ok: false, error },
  });
  if (!restaurant) return fail("Ресторан не найден.");
  // Этап 4: пауза ресторана — кухня/общий экран; оператор в SPLIT не может.
  if (
    !checkRestaurantWorkspaceForRestaurant(
      state,
      restaurantId,
      actor,
      "PAUSE_RESTAURANT",
      workspaceRole,
    )
  ) {
    return fail("Недостаточно прав для паузы ресторана.");
  }
  const normReason = reason.trim();
  if (!normReason) return fail("Укажите причину паузы.");

  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const resolved = resolvePauseResumeAt(restaurant, mode, resumeAt, nowMs);
  if ("error" in resolved) return fail(resolved.error);

  const pause: OperationalPause = {
    startedAt: now,
    reason: normReason,
    mode,
    resumeAt: resolved.resumeAt,
    startedBy: actor,
  };

  // Идемпотентность: идентичная активная пауза не мутирует состояние.
  const existing = restaurant.orderPause;
  if (
    existing &&
    !restaurant.isAcceptingOrders &&
    existing.reason === normReason &&
    existing.mode === mode &&
    existing.resumeAt === resolved.resumeAt
  ) {
    return { state, result: { ok: true, error: null } };
  }

  const event = makeOperationalEvent(
    state.operationalEvents.length + 1,
    now,
    actor,
    "RESTAURANT_PAUSED",
    restaurantId,
    null,
    normReason,
    resolved.resumeAt,
  );
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      restaurants: state.restaurants.map((r) =>
        r.id === restaurantId
          ? { ...r, isAcceptingOrders: false, orderPause: pause }
          : r,
      ),
      operationalEvents: [...state.operationalEvents, event],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Возобновление приёма заказов рестораном (§6). Ручное (RESTAURANT/ADMIN) либо
 * автоматическое (SYSTEM). Идемпотентно: уже принимающий без паузы не мутирует.
 */
export function resumeRestaurantOrders(
  state: PrototypeState,
  restaurantId: string,
  actor: OperationalActor,
  reason = "",
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<OperationalActionResult> {
  const restaurant = state.restaurants.find((r) => r.id === restaurantId);
  const fail = (error: string): ActionResult<OperationalActionResult> => ({
    state,
    result: { ok: false, error },
  });
  if (!restaurant) return fail("Ресторан не найден.");
  if (
    !checkRestaurantWorkspaceForRestaurant(
      state,
      restaurantId,
      actor,
      "PAUSE_RESTAURANT",
      workspaceRole,
    )
  ) {
    return fail("Недостаточно прав для возобновления приёма.");
  }
  if (restaurant.isAcceptingOrders && !restaurant.orderPause) {
    return { state, result: { ok: true, error: null } };
  }

  const now = new Date().toISOString();
  const message =
    reason.trim() ||
    (actor === "SYSTEM"
      ? "Автоматическое возобновление приёма"
      : "Возобновление приёма заказов");
  const event = makeOperationalEvent(
    state.operationalEvents.length + 1,
    now,
    actor,
    "RESTAURANT_RESUMED",
    restaurantId,
    null,
    message,
    null,
  );
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      restaurants: state.restaurants.map((r) =>
        r.id === restaurantId
          ? { ...r, isAcceptingOrders: true, orderPause: null }
          : r,
      ),
      operationalEvents: [...state.operationalEvents, event],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Временная операционная недоступность блюда (§13). Меняет только available и
 * availabilityPause выбранного блюда выбранного ресторана. Цену, variants и
 * исторические snapshot не трогает. Идемпотентно для идентичной паузы.
 */
export function setMenuItemOperationallyUnavailable(
  state: PrototypeState,
  restaurantId: string,
  menuItemId: string,
  reason: string,
  mode: OperationalPauseMode,
  resumeAt: string | null,
  actor: OperationalActor,
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<OperationalActionResult> {
  const restaurant = state.restaurants.find((r) => r.id === restaurantId);
  const item = state.menuItems.find((m) => m.id === menuItemId);
  const fail = (error: string): ActionResult<OperationalActionResult> => ({
    state,
    result: { ok: false, error },
  });
  if (!restaurant) return fail("Ресторан не найден.");
  if (!item) return fail("Блюдо не найдено.");
  if (item.restaurantId !== restaurantId) {
    return fail("Блюдо относится к другому ресторану.");
  }
  // Этап 4: доступность меню — кухня/общий экран.
  if (
    !checkRestaurantWorkspaceForRestaurant(
      state,
      restaurantId,
      actor,
      "CHANGE_MENU_AVAILABILITY",
      workspaceRole,
    )
  ) {
    return fail("Недостаточно прав для изменения доступности меню.");
  }
  const normReason = reason.trim();
  if (!normReason) return fail("Укажите причину.");

  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const resolved = resolvePauseResumeAt(restaurant, mode, resumeAt, nowMs);
  if ("error" in resolved) return fail(resolved.error);

  const pause: OperationalPause = {
    startedAt: now,
    reason: normReason,
    mode,
    resumeAt: resolved.resumeAt,
    startedBy: actor,
  };
  const existing = item.availabilityPause;
  if (
    existing &&
    !item.available &&
    existing.reason === normReason &&
    existing.mode === mode &&
    existing.resumeAt === resolved.resumeAt
  ) {
    return { state, result: { ok: true, error: null } };
  }

  const event = makeOperationalEvent(
    state.operationalEvents.length + 1,
    now,
    actor,
    "MENU_ITEM_UNAVAILABLE",
    restaurantId,
    menuItemId,
    normReason,
    resolved.resumeAt,
  );
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      menuItems: state.menuItems.map((m) =>
        m.id === menuItemId
          ? { ...m, available: false, availabilityPause: pause }
          : m,
      ),
      operationalEvents: [...state.operationalEvents, event],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/** Возврат блюда в меню (§13). Очищает availabilityPause, ставит available. */
export function restoreMenuItemAvailability(
  state: PrototypeState,
  restaurantId: string,
  menuItemId: string,
  actor: OperationalActor,
  reason = "",
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<OperationalActionResult> {
  const item = state.menuItems.find((m) => m.id === menuItemId);
  const fail = (error: string): ActionResult<OperationalActionResult> => ({
    state,
    result: { ok: false, error },
  });
  if (!state.restaurants.some((r) => r.id === restaurantId)) {
    return fail("Ресторан не найден.");
  }
  if (!item) return fail("Блюдо не найдено.");
  if (item.restaurantId !== restaurantId) {
    return fail("Блюдо относится к другому ресторану.");
  }
  if (
    !checkRestaurantWorkspaceForRestaurant(
      state,
      restaurantId,
      actor,
      "CHANGE_MENU_AVAILABILITY",
      workspaceRole,
    )
  ) {
    return fail("Недостаточно прав для изменения доступности меню.");
  }
  if (item.available && !item.availabilityPause) {
    return { state, result: { ok: true, error: null } };
  }

  const now = new Date().toISOString();
  const message =
    reason.trim() ||
    (actor === "SYSTEM"
      ? "Автоматическое возвращение в меню"
      : "Блюдо возвращено в меню");
  const event = makeOperationalEvent(
    state.operationalEvents.length + 1,
    now,
    actor,
    "MENU_ITEM_AVAILABLE",
    restaurantId,
    menuItemId,
    message,
    null,
  );
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      menuItems: state.menuItems.map((m) =>
        m.id === menuItemId
          ? { ...m, available: true, availabilityPause: null }
          : m,
      ),
      operationalEvents: [...state.operationalEvents, event],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Массовое отключение категории (§14). По умолчанию меняет только СЕЙЧАС
 * доступные блюда выбранной категории выбранного ресторана. Каждое реально
 * изменённое блюдо даёт одно событие журнала.
 */
export function pauseCategoryItems(
  state: PrototypeState,
  restaurantId: string,
  category: string,
  reason: string,
  mode: OperationalPauseMode,
  resumeAt: string | null,
  actor: OperationalActor,
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<BulkOperationalResult> {
  const restaurant = state.restaurants.find((r) => r.id === restaurantId);
  const fail = (error: string): ActionResult<BulkOperationalResult> => ({
    state,
    result: { ok: false, error, affected: 0 },
  });
  if (!restaurant) return fail("Ресторан не найден.");
  if (
    !checkRestaurantWorkspaceForRestaurant(
      state,
      restaurantId,
      actor,
      "CHANGE_MENU_AVAILABILITY",
      workspaceRole,
    )
  ) {
    return fail("Недостаточно прав для изменения доступности меню.");
  }
  const normReason = reason.trim();
  if (!normReason) return fail("Укажите причину.");

  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const resolved = resolvePauseResumeAt(restaurant, mode, resumeAt, nowMs);
  if ("error" in resolved) return fail(resolved.error);

  const targets = state.menuItems.filter(
    (m) =>
      m.restaurantId === restaurantId &&
      m.category === category &&
      isMenuItemAvailableAt(m, nowMs),
  );
  if (targets.length === 0) {
    return { state, result: { ok: true, error: null, affected: 0 } };
  }
  const targetIds = new Set(targets.map((m) => m.id));
  const pause: OperationalPause = {
    startedAt: now,
    reason: normReason,
    mode,
    resumeAt: resolved.resumeAt,
    startedBy: actor,
  };
  const events = targets.map((m, i) =>
    makeOperationalEvent(
      state.operationalEvents.length + 1 + i,
      now,
      actor,
      "MENU_ITEM_UNAVAILABLE",
      restaurantId,
      m.id,
      normReason,
      resolved.resumeAt,
    ),
  );
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      menuItems: state.menuItems.map((m) =>
        targetIds.has(m.id)
          ? { ...m, available: false, availabilityPause: pause }
          : m,
      ),
      operationalEvents: [...state.operationalEvents, ...events],
    },
    now,
  );
  return {
    state: nextState,
    result: { ok: true, error: null, affected: targets.length },
  };
}

/** Массовый возврат категории (§14): только сейчас недоступные блюда. */
export function restoreCategoryItems(
  state: PrototypeState,
  restaurantId: string,
  category: string,
  actor: OperationalActor,
  workspaceRole?: RestaurantWorkspaceRole,
): ActionResult<BulkOperationalResult> {
  const restaurant = state.restaurants.find((r) => r.id === restaurantId);
  const fail = (error: string): ActionResult<BulkOperationalResult> => ({
    state,
    result: { ok: false, error, affected: 0 },
  });
  if (!restaurant) return fail("Ресторан не найден.");
  if (
    !checkRestaurantWorkspaceForRestaurant(
      state,
      restaurantId,
      actor,
      "CHANGE_MENU_AVAILABILITY",
      workspaceRole,
    )
  ) {
    return fail("Недостаточно прав для изменения доступности меню.");
  }

  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const targets = state.menuItems.filter(
    (m) =>
      m.restaurantId === restaurantId &&
      m.category === category &&
      !isMenuItemAvailableAt(m, nowMs),
  );
  if (targets.length === 0) {
    return { state, result: { ok: true, error: null, affected: 0 } };
  }
  const targetIds = new Set(targets.map((m) => m.id));
  const events = targets.map((m, i) =>
    makeOperationalEvent(
      state.operationalEvents.length + 1 + i,
      now,
      actor,
      "MENU_ITEM_AVAILABLE",
      restaurantId,
      m.id,
      "Категория возвращена в меню",
      null,
    ),
  );
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      menuItems: state.menuItems.map((m) =>
        targetIds.has(m.id)
          ? { ...m, available: true, availabilityPause: null }
          : m,
      ),
      operationalEvents: [...state.operationalEvents, ...events],
    },
    now,
  );
  return {
    state: nextState,
    result: { ok: true, error: null, affected: targets.length },
  };
}

/**
 * Автоматическое снятие истёкших операционных пауз (§17). Возобновляет
 * рестораны и блюда с resumeAt <= now (MANUAL/«до ручного» не трогает).
 * Идемпотентно; при отсутствии изменений возвращает исходную ссылку state.
 * Заказы, финансы, settlement, корзину и запросы на отмену не меняет.
 */
export function resumeExpiredOperationalPauses(
  state: PrototypeState,
  nowIso: string,
): PrototypeState {
  const nowMs = Date.parse(nowIso);
  const isExpired = (pause: OperationalPause | null | undefined): boolean =>
    Boolean(pause && pause.resumeAt !== null && Date.parse(pause.resumeAt) <= nowMs);

  const expiredRestaurants = state.restaurants.filter((r) =>
    isExpired(r.orderPause),
  );
  const expiredItems = state.menuItems.filter((m) =>
    isExpired(m.availabilityPause),
  );
  if (expiredRestaurants.length === 0 && expiredItems.length === 0) {
    return state;
  }

  const restaurantIds = new Set(expiredRestaurants.map((r) => r.id));
  const itemIds = new Set(expiredItems.map((m) => m.id));
  let index = state.operationalEvents.length + 1;
  const events: OperationalEvent[] = [];
  for (const r of expiredRestaurants) {
    events.push(
      makeOperationalEvent(
        index++,
        nowIso,
        "SYSTEM",
        "RESTAURANT_RESUMED",
        r.id,
        null,
        "Автоматическое возобновление приёма",
        null,
      ),
    );
  }
  for (const m of expiredItems) {
    events.push(
      makeOperationalEvent(
        index++,
        nowIso,
        "SYSTEM",
        "MENU_ITEM_AVAILABLE",
        m.restaurantId,
        m.id,
        "Автоматическое возвращение в меню",
        null,
      ),
    );
  }

  return finalizeMutation(
    state,
    {
      ...state,
      restaurants: state.restaurants.map((r) =>
        restaurantIds.has(r.id)
          ? { ...r, isAcceptingOrders: true, orderPause: null }
          : r,
      ),
      menuItems: state.menuItems.map((m) =>
        itemIds.has(m.id)
          ? { ...m, available: true, availabilityPause: null }
          : m,
      ),
      operationalEvents: [...state.operationalEvents, ...events],
    },
    nowIso,
  );
}

/** Результат действия из кабинета водителя. */
export interface DriverActionResult {
  ok: boolean;
  error: string | null;
}

/**
 * Водитель сам управляет сменой: онлайн (`OFFLINE → AVAILABLE`) или офлайн
 * (`AVAILABLE → OFFLINE`). Инварианты:
 *  - неизвестный водитель → ошибка, состояние не меняется;
 *  - уйти офлайн во время активной доставки нельзя (есть заказ в работе или
 *    статус `BUSY`) — сначала завершается доставка;
 *  - `BUSY` онлайн-запросом не понижается (водитель уже на смене и везёт заказ);
 *  - повторный запрос того же состояния — успех без изменения ревизии (no-op).
 *
 * `BUSY` устанавливается/снимается только жизненным циклом назначения (assign /
 * complete / cancel), а не этим действием. Состояние не мутируется.
 */
export function setDriverAvailability(
  state: PrototypeState,
  driverId: string,
  online: boolean,
): ActionResult<DriverActionResult> {
  const fail = (error: string): ActionResult<DriverActionResult> => ({
    state,
    result: { ok: false, error },
  });
  const ok = (nextState: PrototypeState): ActionResult<DriverActionResult> => ({
    state: nextState,
    result: { ok: true, error: null },
  });

  const driver = state.drivers.find((d) => d.id === driverId);
  if (!driver) return fail("Водитель не найден.");

  if (online) {
    // Онлайн только из OFFLINE; AVAILABLE/BUSY уже на смене — no-op успех.
    if (driver.status !== "OFFLINE") return ok(state);
    // Fail-closed: OFFLINE-водитель с уже существующим активным назначенным
    // заказом (повреждённое состояние) НЕ становится AVAILABLE. Статус не
    // «чиним» молча и не переводим в BUSY здесь — просто отказ.
    if (getDriverActiveOrder(state, driverId)) {
      return fail("Нельзя выйти на смену свободным: есть незавершённый активный заказ.");
    }
    const now = new Date().toISOString();
    return ok(
      finalizeMutation(
        state,
        { ...state, drivers: setDriverStatus(state.drivers, driverId, "AVAILABLE") },
        now,
      ),
    );
  }

  // Офлайн: запрещён при активной доставке.
  if (driver.status === "BUSY" || getDriverActiveOrder(state, driverId)) {
    return fail("Нельзя уйти офлайн во время активной доставки.");
  }
  // Офлайн только из AVAILABLE; уже OFFLINE — no-op успех.
  if (driver.status !== "AVAILABLE") return ok(state);
  const now = new Date().toISOString();
  return ok(
    finalizeMutation(
      state,
      { ...state, drivers: setDriverStatus(state.drivers, driverId, "OFFLINE") },
      now,
    ),
  );
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
  // Fail-closed «один активный заказ на водителя»: не полагаемся только на
  // status. Назначаемый заказ ещё не привязан к этому водителю, поэтому любой
  // найденный активный заказ — это ДРУГОЙ заказ.
  if (getDriverActiveOrder(state, driverId)) {
    return fail("У водителя уже есть активный заказ.");
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
  // Тот же fail-closed guard для нового водителя: нельзя переназначить на того,
  // кто уже ведёт другую активную доставку (исключаем текущий заказ — он сейчас
  // на старом водителе, но защищаемся явно). Не полагаемся только на status.
  if (getDriverActiveOrder(state, newDriverId, orderId)) {
    return fail("У водителя уже есть активный заказ.");
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
  // Сначала освобождаем старого (fail-closed, исключая текущий заказ), затем
  // занимаем нового.
  const drivers = setDriverStatus(
    releaseAssignedDriver(state, order.assignedDriverId, order.id),
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
      drivers: releaseAssignedDriver(state, order.assignedDriverId, order.id),
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
export function markOrderDeliveredByDriverWithResult(
  state: PrototypeState,
  orderId: string,
): ActionResult<OrderTransitionResult> {
  const fail = (error: string): ActionResult<OrderTransitionResult> => ({
    state,
    result: { ok: false, error },
  });
  const order = state.orders.find((o) => o.id === orderId);
  // §3: завершение только для оплаченного PLATFORM_DRIVER-заказа с назначенным
  // водителем и только из OUT_FOR_DELIVERY/ARRIVING (не из PREPARING).
  if (!order) {
    return fail("Заказ не найден.");
  }
  if (order.deliveryMode !== "PLATFORM_DRIVER") {
    return fail("Неподдерживаемый способ получения заказа.");
  }
  if (
    order.status === "DELIVERED" ||
    order.status === "PICKED_UP" ||
    order.status === "CANCELED"
  ) {
    return fail("Заказ уже обработан. Обновите данные.");
  }
  if (!order.assignedDriverId) {
    return fail("Для заказа не назначен водитель.");
  }
  if (order.paymentStatus !== "PAID") {
    return fail("Оплата по заказу ещё не подтверждена.");
  }
  if (order.status !== "OUT_FOR_DELIVERY" && order.status !== "ARRIVING") {
    return fail("Заказ ещё не готов к этому переходу.");
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
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      drivers: releaseAssignedDriver(state, order.assignedDriverId, order.id),
      // Двусторонний журнал: признаём обязательства завершённого заказа.
      restaurantAccountingEntries: [
        ...state.restaurantAccountingEntries,
        ...computeCompletedOrderAccountingEntries(
          updatedOrder,
          state.restaurantAccountingEntries,
        ),
      ],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/** Compatibility-wrapper: прежняя state-возвращающая сигнатура. */
export function markOrderDeliveredByDriver(
  state: PrototypeState,
  orderId: string,
): PrototypeState {
  return markOrderDeliveredByDriverWithResult(state, orderId).state;
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
  // §3: если у заказа есть PENDING-запрос на отмену, обычная админ-отмена
  // атомарно разрешает его как APPROVED — терминальный заказ не остаётся с
  // висящим PENDING. Оплата/paidAt/snapshot/settlement не меняются, refund нет.
  const pendingRequest = state.cancellationRequests.find(
    (r) => r.orderId === orderId && r.status === "PENDING",
  );
  const wasOnlinePaid =
    order.paymentMethod === "ONLINE" && order.paymentStatus === "PAID";
  const historyMessage = pendingRequest
    ? wasOnlinePaid
      ? "Администратор Direct одобрил отмену после начала приготовления. Автоматический возврат не выполнялся."
      : `Администратор Direct одобрил отмену после начала приготовления. Причина: ${normalizedReason}`
    : `Заказ отменён администратором Direct. Причина: ${normalizedReason}`;

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
        historyMessage,
      ),
    ],
  };
  const cancellationRequests = pendingRequest
    ? state.cancellationRequests.map((r) =>
        r.id === pendingRequest.id
          ? {
              ...r,
              status: "APPROVED" as const,
              resolvedAt: now,
              resolvedBy: "ADMIN" as const,
              resolutionNote: normalizedReason,
            }
          : r,
      )
    : state.cancellationRequests;

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === orderId ? updatedOrder : o)),
      drivers: releaseAssignedDriver(state, order.assignedDriverId, order.id),
      cancellationRequests,
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
 * Аварийная выдача самовывоза без кода (§10). Доступна только администратору
 * Direct (кухня такой кнопки не имеет), требует причину (1..300) и способ оплаты
 * на точке. Инварианты оплаты, статуса и начисления идентичны штатной выдаче по
 * коду; вторая комиссия не создаётся (settlement идемпотентен по id заказа).
 */
export function issuePickupWithoutCode(
  state: PrototypeState,
  orderId: string,
  reason: string,
  paidWith: PickupPaymentMethod,
  nowIso: string = new Date().toISOString(),
): ActionResult<AdminActionResult> {
  // §6: аварийная выдача — исключительно администраторское действие. Actor не
  // принимается извне: домен фиксирует его как ADMIN, а не доверяет вызывающему.
  const actor: OrderActionActor = "ADMIN";
  const fail = (error: string): ActionResult<AdminActionResult> => ({
    state,
    result: { ok: false, error },
  });

  if (typeof nowIso !== "string" || Number.isNaN(Date.parse(nowIso))) {
    return fail("Некорректное время операции.");
  }
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || order.deliveryMode !== "PICKUP") {
    return fail("Заказ не найден или не является самовывозом.");
  }
  if (order.status === "PICKED_UP" || order.pickupCodeUsed) {
    return fail("Заказ уже выдан.");
  }
  if (order.status !== "READY_FOR_PICKUP") {
    return fail("Заказ ещё не готов к выдаче.");
  }
  if (order.paymentMethod !== "PAY_AT_RESTAURANT") {
    return fail("Этот заказ не оплачивается при получении.");
  }
  if (order.paymentStatus !== "DUE_AT_PICKUP") {
    return fail("Оплата по заказу не ожидается.");
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    return fail("Укажите причину аварийной выдачи.");
  }
  if (normalizedReason.length > PICKUP_NO_SHOW_REASON_MAX_LENGTH) {
    return fail("Причина слишком длинная.");
  }
  if (paidWith !== "CASH" && paidWith !== "CARD") {
    return fail("Выберите способ оплаты.");
  }
  if (!order.pickupPaymentMethodsSnapshot.includes(paidWith)) {
    return fail("Этот способ оплаты недоступен на точке.");
  }
  const settlementId = `settlement-${orderId}`;
  if (
    state.settlements.some(
      (entry) => entry.id === settlementId || entry.orderId === orderId,
    )
  ) {
    return fail("Начисление по заказу уже создано.");
  }

  const now = nowIso;
  const nextHistoryNumber = order.history.length + 1;
  const paymentMessage =
    paidWith === "CASH"
      ? "Оплата получена в ресторане наличными (аварийная выдача)."
      : "Оплата получена в ресторане картой (аварийная выдача).";
  const updatedOrder: Order = {
    ...order,
    status: "PICKED_UP",
    paymentStatus: "PAID_AT_RESTAURANT",
    paidAt: now,
    pickupCodeUsed: true,
    pickupPaidWith: paidWith,
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
        message: paymentMessage,
      },
      {
        id: `${order.id}-history-${nextHistoryNumber + 1}`,
        occurredAt: now,
        actor,
        type: "STATUS",
        fromStatus: "READY_FOR_PICKUP",
        toStatus: "PICKED_UP",
        message: `Аварийная выдача без кода администратором Direct. Причина: ${normalizedReason}`,
      },
    ],
  };

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
      settlements: [...state.settlements, settlement],
      // Двусторонний журнал: признаём обязательства завершённого заказа.
      restaurantAccountingEntries: [
        ...state.restaurantAccountingEntries,
        ...computeCompletedOrderAccountingEntries(
          updatedOrder,
          state.restaurantAccountingEntries,
        ),
      ],
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

/**
 * Административное изменение времени приготовления (§9, статус PREPARING).
 * Пересчитывает ожидаемое время готовности; финансы и оплату не трогает.
 */
export function adminSetPreparationMinutesWithResult(
  state: PrototypeState,
  orderId: string,
  minutes: number,
): ActionResult<OrderTransitionResult> {
  const fail = (error: string): ActionResult<OrderTransitionResult> => ({
    state,
    result: { ok: false, error },
  });
  const allowed = [10, 15, 20, 25, 30, 40];
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) {
    return fail("Заказ не найден.");
  }
  if (order.status !== "PREPARING") {
    return fail("Изменить время можно только для готовящегося заказа.");
  }
  if (!allowed.includes(minutes)) {
    return fail("Недопустимое время приготовления.");
  }
  const now = new Date().toISOString();
  const expectedReadyAt = new Date(
    new Date(now).getTime() + minutes * 60_000,
  ).toISOString();
  const nextState = replaceOrder(
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
  return { state: nextState, result: { ok: true, error: null } };
}

/** Compatibility-wrapper: прежняя state-возвращающая сигнатура. */
export function adminSetPreparationMinutes(
  state: PrototypeState,
  orderId: string,
  minutes: number,
): PrototypeState {
  return adminSetPreparationMinutesWithResult(state, orderId, minutes).state;
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
  /** Этап 10: организация работы с заказами; по умолчанию COMBINED. */
  orderWorkflowMode?: RestaurantOrderWorkflowMode;
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
      orderWorkflowMode: input.orderWorkflowMode,
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
    orderWorkflowMode: patch.orderWorkflowMode ?? target.orderWorkflowMode,
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
