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
  OperationalEvent,
  OperationalPause,
  Order,
  OrderHistoryEvent,
  OrderStatus,
  PaymentMethod,
  PickupPaymentMethod,
  Promotion,
  PrototypeState,
  PublicationStatus,
  Restaurant,
  RestaurantOrderWorkflowMode,
  SettlementEntry,
  SettlementStatus,
  SettlementType,
  WeekdayId,
  ZoneId,
} from "./models";
import { WEEKDAY_LABELS, WEEKDAY_ORDER } from "./models";
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

/**
 * §4: клиентски-безопасное представление события истории. Опирается ТОЛЬКО на
 * структурные факты (тип события, переход статуса, order.pickupNoShowAt), а не на
 * парсинг текста message. Возвращает нейтральный текст и hideActor. ETA-события
 * нейтрализуются всегда в клиентском режиме; PICKUP-специфичные — только при
 * clientSafe. Прочие безопасные события отдаются как есть.
 */
export function clientHistoryEvent(
  event: OrderHistoryEvent,
  order: Order | undefined,
  clientSafe: boolean,
): { message: string; hideActor: boolean } {
  if (event.type === "ETA") {
    return {
      message: "Ресторан обновил ожидаемое время готовности заказа.",
      hideActor: true,
    };
  }
  // Исправление 2: внутреннее сообщение кухни («Кухня сообщила о проблеме: …»)
  // клиенту не показывается — только нейтральный текст без роли и причины.
  // Исходное событие не мутируется: оператор и администратор видят оригинал.
  if (event.type === "PREPARATION_PROBLEM") {
    return {
      message: "Ресторан сообщил о проблеме с выполнением заказа.",
      hideActor: true,
    };
  }
  if (clientSafe && order?.deliveryMode === "PICKUP") {
    if (
      event.type === "PAYMENT" &&
      event.fromStatus === "READY_FOR_PICKUP" &&
      event.toStatus === "READY_FOR_PICKUP"
    ) {
      return { message: "Оплата получена в ресторане.", hideActor: true };
    }
    if (
      event.type === "STATUS" &&
      event.fromStatus === "READY_FOR_PICKUP" &&
      event.toStatus === "PICKED_UP"
    ) {
      return { message: "Заказ получен.", hideActor: true };
    }
    // §2: ЛЮБАЯ отмена самовывоза (из любого нетерминального статуса)
    // нейтрализуется — внутренняя причина/actor клиенту не раскрываются.
    if (event.type === "STATUS" && event.toStatus === "CANCELED") {
      return {
        message:
          order?.pickupNoShowAt != null
            ? "Заказ был закрыт как невыкупленный."
            : "Заказ отменён.",
        hideActor: true,
      };
    }
  }
  return { message: event.message, hideActor: false };
}

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

/** Этап 10/11: русские подписи режима работы с заказами (enum клиенту не виден). */
export const workflowModeLabels: Record<RestaurantOrderWorkflowMode, string> = {
  COMBINED: "Общий экран",
  SPLIT_OPERATOR_KITCHEN: "Оператор и кухня раздельно",
};

/**
 * Исправление 5: русские подписи часовых поясов. IANA ID остаётся в данных и
 * <option value>, но пользователю показывается только русское название.
 */
export const restaurantTimeZoneLabels: Record<string, string> = {
  "Europe/Chisinau": "Кишинёв",
  "America/New_York": "Нью-Йорк",
  UTC: "Всемирное координированное время",
};

/** Русская подпись пояса; для неизвестного ID — безопасный русский fallback. */
export function getRestaurantTimeZoneLabel(timeZone: string): string {
  return restaurantTimeZoneLabels[timeZone] ?? "Другой часовой пояс";
}

/** §3: русские подписи статусов начислений (единый источник для всех экранов). */
export const settlementStatusLabels: Record<SettlementStatus, string> = {
  PENDING: "Ожидает расчёта",
  NETTED: "Учтено во взаиморасчёте",
  PAID: "Оплачено",
  WAIVED: "Списано",
};

/** §3: русские подписи типов начислений. */
export const settlementTypeLabels: Record<SettlementType, string> = {
  PICKUP_COMMISSION: "Комиссия за самовывоз",
  RESTAURANT_DELIVERY_COMMISSION: "Комиссия за доставку ресторана",
};

/** Подпись статуса начисления; сырой enum пользователю не показываем. */
export function formatSettlementStatus(status: string): string {
  return (
    settlementStatusLabels[status as SettlementStatus] ??
    "Неизвестный статус расчёта"
  );
}

/** Подпись типа начисления; сырой enum пользователю не показываем. */
export function formatSettlementType(type: string): string {
  return (
    settlementTypeLabels[type as SettlementType] ?? "Неизвестный тип начисления"
  );
}

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

/**
 * §4: единый 24-часовой форматтер времени «HH:MM» в часовом поясе. Всегда с
 * ведущим нулём и без AM/PM/24:00 (hourCycle h23). Единственный источник формата
 * часов для всех пользовательских мест (пауза, открытие, ETA кухни/клиента).
 */
export function formatClock24(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
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
  nowMs = 0,
): Restaurant[] {
  const restaurants = getPublishedRestaurants(state);
  const stableOrder = new Map(
    restaurants.map((restaurant, index) => [restaurant.id, index]),
  );
  const compareFallback = (left: Restaurant, right: Restaurant) =>
    getRestaurantRank(left) - getRestaurantRank(right) ||
    (stableOrder.get(left.id) ?? 0) - (stableOrder.get(right.id) ?? 0);

  // §7: «Открыты сейчас» — по фактическому состоянию ACCEPTING на nowMs. При
  // nowMs<=0 (до гидратации) порядок стабилен и ложный «открыт» не влияет.
  const accepting = (restaurant: Restaurant) =>
    nowMs > 0 && isRestaurantAcceptingOrdersAt(restaurant, nowMs);

  return [...restaurants].sort((left, right) => {
    if (sort === "DELIVERY") {
      const leftFee = getAvailablePlatformDeliveryFeeCents(state, left, nowMs);
      const rightFee = getAvailablePlatformDeliveryFeeCents(state, right, nowMs);
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

    if (sort === "OPEN") {
      const leftOpen = accepting(left);
      const rightOpen = accepting(right);
      if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
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

/** Активна ли операционная пауза в момент nowMs (истёкшая — уже НЕ активна). */
export function isOperationalPauseActiveAt(
  pause: OperationalPause | null | undefined,
  nowMs: number,
): boolean {
  if (!pause) return false;
  // MANUAL / «до ручного включения» — активна, пока не сняли вручную.
  if (pause.resumeAt === null) return true;
  return Date.parse(pause.resumeAt) > nowMs;
}

/**
 * Клиентская подсказка о времени возобновления приёма (§12), в часовом поясе
 * ресторана. Показывается только для активной паузы с конкретным resumeAt;
 * для MANUAL/«до ручного включения» возвращает null. Единый форматтер для
 * каталога, страницы ресторана и корзины (без дублирования Intl-кода).
 */
export function getRestaurantResumeHint(
  restaurant: Restaurant,
  nowMs: number,
): string | null {
  const pause = restaurant.orderPause;
  if (!isOperationalPauseActiveAt(pause, nowMs) || !pause?.resumeAt) {
    return null;
  }
  const time = formatClock24(
    pause.resumeAt,
    restaurant.timeZone || "Europe/Chisinau",
  );
  return `Приём возобновится примерно в ${time}`;
}

/** Базовая конфигурация ресторана достаточна для приёма заказов вообще. */
function isRestaurantBaseConfigured(restaurant: Restaurant): boolean {
  return (
    restaurant.status === "PUBLISHED" &&
    restaurant.paymentMethods.includes("ONLINE") &&
    (restaurant.deliveryModes.includes("PLATFORM_DRIVER") ||
      restaurant.deliveryModes.includes("RESTAURANT_DELIVERY") ||
      restaurant.deliveryModes.includes("PICKUP"))
  );
}

/**
 * Разрешает ли приём АДМИНИСТРАТИВНЫЙ слой (без учёта графика работы): базовая
 * конфигурация + операционная пауза + ручной приём. Истёкшая пауза не блокирует.
 * Основа для kitchen-состояния (кухня не смотрит на клиентский график) и для
 * единого availability-state.
 */
function isRestaurantAdminAcceptingAt(
  restaurant: Restaurant,
  nowMs: number,
): boolean {
  if (!isRestaurantBaseConfigured(restaurant)) return false;
  if (restaurant.orderPause) {
    return !isOperationalPauseActiveAt(restaurant.orderPause, nowMs);
  }
  return restaurant.isAcceptingOrders;
}

/**
 * Единое состояние доступности ресторана (§2) — ЕДИНСТВЕННЫЙ источник истины для
 * клиента и домена. Приоритет: UNAVAILABLE (не настроен) → OPERATIONAL_PAUSE
 * (активная пауза кухни/ресторана) → ADMIN_DISABLED (ручной приём выключен) →
 * CLOSED_SCHEDULE (закрыт по weeklySchedule в часовом поясе ресторана) →
 * ACCEPTING. Истёкшая пауза не блокирует до maintenance-sweep.
 */
export type RestaurantAvailabilityState =
  | "ACCEPTING"
  | "OPERATIONAL_PAUSE"
  | "CLOSED_SCHEDULE"
  | "ADMIN_DISABLED"
  | "UNAVAILABLE";

export function getRestaurantAvailabilityStateAt(
  restaurant: Restaurant,
  nowMs: number,
): RestaurantAvailabilityState {
  if (!isRestaurantBaseConfigured(restaurant)) return "UNAVAILABLE";
  if (isOperationalPauseActiveAt(restaurant.orderPause, nowMs)) {
    return "OPERATIONAL_PAUSE";
  }
  if (!isRestaurantAdminAcceptingAt(restaurant, nowMs)) return "ADMIN_DISABLED";
  if (!isRestaurantOpenNow(restaurant, new Date(nowMs))) {
    return "CLOSED_SCHEDULE";
  }
  return "ACCEPTING";
}

/**
 * Принимает ли ресторан НОВЫЕ заказы в момент nowMs (§3). Ровно тогда, когда
 * единое состояние доступности === ACCEPTING (включая проверку графика). Все
 * доменные преграды (addCartItem, createOrderFromCart) идут через этот helper.
 */
export function isRestaurantAcceptingOrdersAt(
  restaurant: Restaurant,
  nowMs: number,
): boolean {
  return getRestaurantAvailabilityStateAt(restaurant, nowMs) === "ACCEPTING";
}

export function canPlacePrototypeOrder(
  restaurant: Restaurant,
  nowMs: number = Date.now(),
): boolean {
  return isRestaurantAcceptingOrdersAt(restaurant, nowMs);
}

/**
 * Единое состояние приёма заказов для UI кухни. Toolbar и RestaurantPauseControl
 * обязаны использовать только этот helper (без дублирования условий). Кухня НЕ
 * учитывает клиентский график: закрытие по расписанию не превращает приём в
 * ADMIN_DISABLED на экране кухни (поведение сохранено).
 * - OPERATIONAL_PAUSE — активна операционная пауза ресторана;
 * - ACCEPTING — приём разрешён администратором (в т.ч. истёкшая пауза до sweep);
 * - ADMIN_DISABLED — приём выключен администратором/конфигурацией.
 */
export type KitchenAcceptanceState =
  | "ACCEPTING"
  | "OPERATIONAL_PAUSE"
  | "ADMIN_DISABLED";

export function getKitchenAcceptanceState(
  restaurant: Restaurant,
  nowMs: number,
): KitchenAcceptanceState {
  if (isOperationalPauseActiveAt(restaurant.orderPause, nowMs)) {
    return "OPERATIONAL_PAUSE";
  }
  if (isRestaurantAdminAcceptingAt(restaurant, nowMs)) {
    return "ACCEPTING";
  }
  return "ADMIN_DISABLED";
}

/** Доступно ли блюдо для НОВОГО заказа в момент nowMs (§12, §15). */
export function isMenuItemAvailableAt(
  menuItem: MenuItem,
  nowMs: number,
): boolean {
  if (menuItem.availabilityPause) {
    // Пауза есть — истёкшая делает блюдо доступным ещё до sweep.
    return !isOperationalPauseActiveAt(menuItem.availabilityPause, nowMs);
  }
  return menuItem.available;
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

/**
 * Тариф Direct для каталога/сортировки (§8). Только рестораны типа DIRECT,
 * которые ФАКТИЧЕСКИ принимают заказ на nowMs (открыты по графику, без паузы и
 * админ-отключения). До гидратации (nowMs<=0) — null, чтобы закрытый или ещё не
 * определённый ресторан не получал бейдж «Выгодная доставка». Тарифную матрицу и
 * финансовую формулу не меняет.
 */
export function getAvailablePlatformDeliveryFeeCents(
  state: PrototypeState,
  restaurant: Restaurant,
  nowMs: number,
): number | null {
  if (
    nowMs <= 0 ||
    getRestaurantAvailabilityStateAt(restaurant, nowMs) !== "ACCEPTING" ||
    restaurant.deliveryProvider !== "DIRECT" ||
    !restaurant.deliveryModes.includes("PLATFORM_DRIVER")
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
  return `Ожидаемая готовность: ${formatClock24(expectedReadyAt, timeZone)}`;
}

/**
 * Человекочитаемая длительность для карточек кухни: < 60 — «32 мин»;
 * ровно час — «1 ч»; больше часа — «1 ч 17 мин» (нулевой остаток минут не
 * пишется). Чистая функция; отрицательные значения приводятся к нулю.
 */
export function formatKitchenDuration(totalMinutes: number): string {
  const total = Math.max(0, Math.floor(totalMinutes));
  if (total < 60) {
    return `${total} мин`;
  }
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? `${hours} ч` : `${hours} ч ${minutes} мин`;
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
    return {
      text: `Просрочено на ${formatKitchenDuration(overdueMin)}`,
      overdue: true,
    };
  }
  const totalSec = Math.ceil(diffMs / 1000);
  if (totalSec >= 60) {
    return {
      text: formatKitchenDuration(Math.floor(totalSec / 60)),
      overdue: false,
    };
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

/**
 * §11: невыкуп самовывоза можно отметить не раньше, чем через 30 минут после
 * РЕАЛЬНОГО перехода PREPARING → READY_FOR_PICKUP. Единый порог для домена и UI.
 */
export const PICKUP_NO_SHOW_WAIT_MS = 30 * 60 * 1000;

/**
 * Момент реального перехода заказа в READY_FOR_PICKUP (по STATUS-событию, не по
 * updatedAt — чтобы платёжные/технические события того же статуса не сбрасывали
 * отсчёт). Для не-READY_FOR_PICKUP возвращает null.
 */
export function getReadyForPickupSinceIso(order: Order): string | null {
  if (order.status !== "READY_FOR_PICKUP") {
    return null;
  }
  const event = [...order.history]
    .reverse()
    .find(
      (e) =>
        e.type === "STATUS" &&
        e.toStatus === "READY_FOR_PICKUP" &&
        e.fromStatus !== e.toStatus,
    );
  return event?.occurredAt ?? null;
}

/**
 * ISO-момент, начиная с которого допустим невыкуп (READY_FOR_PICKUP + 30 мин).
 * null, если заказ не в READY_FOR_PICKUP или нет реального перехода.
 */
export function getPickupNoShowEligibleAtIso(order: Order): string | null {
  const since = getReadyForPickupSinceIso(order);
  if (!since) {
    return null;
  }
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) {
    return null;
  }
  return new Date(sinceMs + PICKUP_NO_SHOW_WAIT_MS).toISOString();
}

/** Наступил ли момент, когда невыкуп можно отметить (на nowIso). */
export function isPickupNoShowEligibleAt(order: Order, nowIso: string): boolean {
  const eligibleAt = getPickupNoShowEligibleAtIso(order);
  if (!eligibleAt) {
    return false;
  }
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) {
    return false;
  }
  return nowMs >= Date.parse(eligibleAt);
}

/**
 * «Новые» — RESTAURANT_REVIEW, самые старые сверху (ждут дольше всех).
 *
 * В SPLIT решение по новому заказу принимает оператор, поэтому у кухни новых
 * заказов нет вовсе: список пуст. Правило живёт здесь, а не в разметке, чтобы
 * оно проверялось тестом и было одним и тем же для карточек, звука и таймера.
 * Доменные права этим не подменяются: приём кухни блокирует матрица прав.
 */
export function getKitchenNewOrders(
  state: PrototypeState,
  restaurantId: string,
): Order[] {
  const mode =
    state.restaurants.find((r) => r.id === restaurantId)?.orderWorkflowMode ??
    "COMBINED";
  if (mode === "SPLIT_OPERATOR_KITCHEN") return [];
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
 * Порядок «Готовятся» по expectedReadyAt: просроченные (наименьшее время)
 * первыми, затем ближайшие к готовности; заказы без expectedReadyAt — в конце.
 * Чистый компаратор, общий для кухни и оператора — один источник сортировки.
 */
export function comparePreparingByReadyAt(a: Order, b: Order): number {
  const ta = a.expectedReadyAt
    ? Date.parse(a.expectedReadyAt)
    : Number.POSITIVE_INFINITY;
  const tb = b.expectedReadyAt
    ? Date.parse(b.expectedReadyAt)
    : Number.POSITIVE_INFINITY;
  return ta - tb;
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
  return kitchenOrders(state, restaurantId, ["PREPARING"]).sort(
    comparePreparingByReadyAt,
  );
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

/**
 * Показывать ли клиенту нейтральное уведомление об обновлённом времени
 * готовности (§10). Только для активного PREPARING с хотя бы одной
 * корректировкой; для READY/завершённых — не показываем как активное.
 */
export function hasActiveEtaUpdate(order: Order): boolean {
  return order.status === "PREPARING" && order.etaAdjustments.length > 0;
}

/** Часы HH:MM актуального ожидаемого времени заказа в часовом поясе ресторана. */
export function formatOrderEtaClock(
  state: PrototypeState,
  order: Order,
): string {
  if (!order.expectedReadyAt) return "не задана";
  const timeZone =
    state.restaurants.find((r) => r.id === order.restaurant.id)?.timeZone ??
    "Europe/Chisinau";
  return formatClock24(order.expectedReadyAt, timeZone);
}

/**
 * Форматирует произвольный ISO (например, prev/next ETA из audit) в дату-время
 * в часовом поясе РЕСТОРАНА (§3) — не по времени администратора. Единый helper
 * для admin ETA-сводки.
 */
export function formatOrderEtaInRestaurantZone(
  state: PrototypeState,
  order: Order,
  iso: string,
): string {
  const timeZone =
    state.restaurants.find((r) => r.id === order.restaurant.id)?.timeZone ??
    "Europe/Chisinau";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(iso));
}

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

/**
 * Отменён из реальной готовности к выдаче (по STATUS-переходу
 * READY_FOR_PICKUP → CANCELED). Сам по себе НЕ означает невыкуп: обычная
 * adminCancelOrder тоже даёт такой переход. Настоящий невыкуп — только
 * pickupNoShowAt !== null.
 */
function hasReadyToCanceledTransition(order: Order): boolean {
  return order.history.some(
    (event) =>
      event.type === "STATUS" &&
      event.fromStatus === "READY_FOR_PICKUP" &&
      event.toStatus === "CANCELED",
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
  // §1: настоящий невыкуп — исключительно по структурному признаку.
  const noShow = pickupOrders.filter(
    (order) => order.pickupNoShowAt !== null,
  ).length;
  // Подозрительные закрытия после готовности: отменены из READY_FOR_PICKUP, но
  // это НЕ зафиксированный невыкуп (обычная административная отмена).
  const suspiciousAfterReady = pickupOrders.filter(
    (order) =>
      order.status === "CANCELED" &&
      order.pickupNoShowAt === null &&
      hasReadyToCanceledTransition(order),
  ).length;
  // Процент неявок считаем только относительно выданных + настоящих невыкупов.
  const denominator = issued + noShow;
  return {
    issued,
    noShow,
    noShowPercent:
      denominator > 0 ? Math.round((noShow / denominator) * 100) : 0,
    suspiciousAfterReady,
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

export interface ClientScheduleSummary {
  /** Текущий день недели в часовом поясе ресторана. */
  currentWeekdayId: WeekdayId;
  /** Часы работы сегодняшнего дня («09:00–22:00» либо «Закрыто»). */
  todayScheduleLabel: string;
  /** Открыт ли ресторан прямо сейчас (совпадает с isRestaurantOpenNow). */
  isOpen: boolean;
  /** День, чей интервал сейчас активен (может быть вчера при ночном графике). */
  activeScheduleWeekdayId: WeekdayId;
  /** Часы активного интервала. */
  activeScheduleLabel: string;
  /** Готовая непротиворечивая строка статуса для клиента. */
  statusText: string;
}

/**
 * §1: непротиворечивая клиентская сводка графика. Открытость и активный интервал
 * считаются из ОДНОГО прохода по structured weeklySchedule (не из текста
 * getScheduleLabel), поэтому «Сегодня: Закрыто · Сейчас открыто» невозможно.
 * После полуночи, когда продолжается ночной интервал предыдущего дня, статус —
 * «Сейчас открыто до HH:MM · Сегодня: Закрыто». Всё в часовом поясе ресторана.
 */
export function getClientRestaurantScheduleSummary(
  restaurant: Restaurant,
  now: Date,
): ClientScheduleSummary {
  const { weekdayId, minutes } = getRestaurantLocalNow(restaurant, now);
  const todayScheduleLabel = getScheduleLabel(restaurant, weekdayId);

  let isOpen = false;
  let carriedOver = false;
  let activeWeekday: WeekdayId = weekdayId;

  const today = restaurant.weeklySchedule[weekdayId];
  if (today?.enabled) {
    const open = timeToMinutes(today.openTime);
    const close = timeToMinutes(today.closeTime);
    if (open !== null && close !== null) {
      // Обычный дневной интервал либо ночной до полуночи (close < open).
      if (close > open && minutes >= open && minutes <= close) {
        isOpen = true;
      } else if (close < open && minutes >= open) {
        isOpen = true;
      }
    }
  }
  if (!isOpen) {
    const prevId = previousWeekday(weekdayId);
    const prev = restaurant.weeklySchedule[prevId];
    if (prev?.enabled) {
      const open = timeToMinutes(prev.openTime);
      const close = timeToMinutes(prev.closeTime);
      if (open !== null && close !== null && close < open && minutes <= close) {
        isOpen = true;
        carriedOver = true;
        activeWeekday = prevId;
      }
    }
  }

  const activeScheduleLabel = getScheduleLabel(restaurant, activeWeekday);

  let statusText: string;
  if (!isOpen) {
    statusText = `Сегодня: ${todayScheduleLabel} · Сейчас закрыто`;
  } else if (carriedOver) {
    const closeStr = restaurant.weeklySchedule[activeWeekday].closeTime || "—";
    statusText = `Сейчас открыто до ${closeStr} · Сегодня: ${todayScheduleLabel}`;
  } else {
    statusText = `Сегодня: ${todayScheduleLabel} · Сейчас открыто`;
  }

  return {
    currentWeekdayId: weekdayId,
    todayScheduleLabel,
    isOpen,
    activeScheduleWeekdayId: activeWeekday,
    activeScheduleLabel,
    statusText,
  };
}

/** «Откроется сегодня/завтра/в пятницу в 09:00» в часовом поясе ресторана. */
export function formatNextOpeningHint(
  restaurant: Restaurant,
  nowMs: number,
): string | null {
  const iso = computeNextOpeningIso(restaurant, nowMs);
  if (!iso) return null;
  const openMs = Date.parse(iso);
  const timeZone = restaurant.timeZone || "Europe/Chisinau";
  const today = localDateParts(nowMs, timeZone);
  const openDay = localDateParts(openMs, timeZone);
  const dayDiff = Math.round(
    (Date.UTC(openDay.year, openDay.month - 1, openDay.day) -
      Date.UTC(today.year, today.month - 1, today.day)) /
      86_400_000,
  );
  const time = formatClock24(new Date(openMs).toISOString(), timeZone);
  let dayPhrase: string;
  if (dayDiff <= 0) dayPhrase = "сегодня";
  else if (dayDiff === 1) dayPhrase = "завтра";
  else {
    const weekdayId = getRestaurantLocalNow(restaurant, new Date(openMs))
      .weekdayId;
    dayPhrase = `в ${WEEKDAY_LABELS[weekdayId].toLowerCase()}`;
  }
  return `Откроется ${dayPhrase} в ${time}`;
}

export type RestaurantAvailabilityTone =
  | "accepting"
  | "paused"
  | "closed"
  | "unavailable";

export interface ClientRestaurantAvailability {
  state: RestaurantAvailabilityState;
  /** Можно ли фактически добавить блюдо / отправить заказ прямо сейчас. */
  canAcceptOrders: boolean;
  /** Короткая подпись со статусом (для точки-бейджа). */
  shortLabel: string;
  /** Вторичная подсказка (возобновление паузы / ближайшее открытие) либо null. */
  detailLabel: string | null;
  /** Визуальный тон бейджа. */
  tone: RestaurantAvailabilityTone;
}

/**
 * §4: единая клиентская модель статуса ресторана. Опирается на то же
 * getRestaurantAvailabilityStateAt, поэтому подпись НИКОГДА не противоречит
 * фактической возможности заказа и schedule summary. До гидратации (nowMs<=0)
 * возвращает нейтральный не-зелёный статус без «принимает заказы».
 */
export function getClientRestaurantAvailabilityAt(
  restaurant: Restaurant,
  nowMs: number,
): ClientRestaurantAvailability {
  if (nowMs <= 0) {
    return {
      state: "CLOSED_SCHEDULE",
      canAcceptOrders: false,
      shortLabel: "—",
      detailLabel: null,
      tone: "closed",
    };
  }
  const state = getRestaurantAvailabilityStateAt(restaurant, nowMs);
  switch (state) {
    case "ACCEPTING":
      return {
        state,
        canAcceptOrders: true,
        shortLabel: "Открыто · принимает заказы",
        detailLabel: null,
        tone: "accepting",
      };
    case "OPERATIONAL_PAUSE":
      return {
        state,
        canAcceptOrders: false,
        shortLabel: "Временно не принимает заказы",
        detailLabel: getRestaurantResumeHint(restaurant, nowMs),
        tone: "paused",
      };
    case "CLOSED_SCHEDULE":
      return {
        state,
        canAcceptOrders: false,
        shortLabel: "Закрыто сейчас",
        detailLabel: formatNextOpeningHint(restaurant, nowMs),
        tone: "closed",
      };
    case "ADMIN_DISABLED":
      return {
        state,
        canAcceptOrders: false,
        shortLabel: "Сейчас не принимает заказы",
        detailLabel: null,
        tone: "unavailable",
      };
    default:
      return {
        state: "UNAVAILABLE",
        canAcceptOrders: false,
        shortLabel: "Заказы недоступны",
        detailLabel: null,
        tone: "unavailable",
      };
  }
}

/** Смещение часового пояса (мс) для момента utcMs. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utcMs));
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    const asIfUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second),
    );
    return asIfUtc - utcMs;
  } catch {
    return 0;
  }
}

/** Локальное настенное время (в timeZone) → UTC-инстант в мс. */
function zonedWallToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = tzOffsetMs(guess, timeZone);
  let instant = guess - off1;
  const off2 = tzOffsetMs(instant, timeZone);
  if (off2 !== off1) instant = guess - off2;
  return instant;
}

/** Календарные Y-M-D локальной даты ресторана для момента utcMs. */
function localDateParts(
  utcMs: number,
  timeZone: string,
): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(utcMs));
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
    };
  } catch {
    const d = new Date(utcMs);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    };
  }
}

/**
 * Ближайшее будущее открытие ресторана по графику (§4), в его часовом поясе
 * (IANA, не UTC-offset). Возвращает ISO-инстант или null, если ни один день не
 * рабочий. Выбирает первое открытие строго позже nowMs: закрыт до сегодняшнего
 * открытия → сегодня; открыт/открытие прошло → следующий рабочий день;
 * выключенные дни пропускаются. weeklySchedule не мутируется.
 */
export function computeNextOpeningIso(
  restaurant: Restaurant,
  nowMs: number,
): string | null {
  const timeZone = restaurant.timeZone || "Europe/Chisinau";
  const { year, month, day } = localDateParts(nowMs, timeZone);
  const startWeekday = getRestaurantLocalNow(restaurant, new Date(nowMs)).weekdayId;
  const startIndex = WEEKDAY_ORDER.indexOf(startWeekday);

  for (let offset = 0; offset <= 7; offset += 1) {
    const weekday = WEEKDAY_ORDER[(startIndex + offset) % 7];
    const schedule = restaurant.weeklySchedule[weekday];
    if (!schedule?.enabled) continue;
    const openMinutes = timeToMinutes(schedule.openTime);
    if (openMinutes === null) continue;

    // Локальная календарная дата (year,month,day) + offset дней.
    const shifted = new Date(Date.UTC(year, month - 1, day) + offset * 86_400_000);
    const instant = zonedWallToUtcMs(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      shifted.getUTCDate(),
      Math.floor(openMinutes / 60),
      openMinutes % 60,
      timeZone,
    );
    if (instant > nowMs) {
      return new Date(instant).toISOString();
    }
  }
  return null;
}

/** Последние операционные события ресторана (журнал кухни), новые сверху. */
export function getRestaurantOperationalEvents(
  state: PrototypeState,
  restaurantId: string,
  limit = 10,
): OperationalEvent[] {
  return state.operationalEvents
    .filter((event) => event.restaurantId === restaurantId)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, limit);
}

// --- Проблема приготовления: OPEN/RESOLVED (Этап 1 из 2) --------------------

/** Префикс сообщения кухни о проблеме приготовления (для извлечения причины). */
export const PREPARATION_PROBLEM_KITCHEN_PREFIX =
  "Кухня сообщила о проблеме: ";
/** Префикс сообщения администратора о проблеме приготовления. */
export const PREPARATION_PROBLEM_ADMIN_PREFIX = "Администратор Direct: ";

/** Id проблемы у события: явный preparationProblemId либо (legacy) event.id. */
export function preparationProblemIdOf(event: OrderHistoryEvent): string {
  return event.preparationProblemId ?? event.id;
}

/** Исходная причина кухни из сообщения OPEN-события (без служебного префикса). */
export function preparationProblemReason(event: OrderHistoryEvent): string {
  const message = event.message ?? "";
  if (message.startsWith(PREPARATION_PROBLEM_KITCHEN_PREFIX)) {
    return message.slice(PREPARATION_PROBLEM_KITCHEN_PREFIX.length);
  }
  if (message.startsWith(PREPARATION_PROBLEM_ADMIN_PREFIX)) {
    return message.slice(PREPARATION_PROBLEM_ADMIN_PREFIX.length);
  }
  return message;
}

export interface PreparationProblemView {
  /** Идентификатор проблемы, общий для OPEN и RESOLVED событий. */
  problemId: string;
  /** Исходная причина кухни (без служебного префикса). */
  reason: string;
  /** OPEN-событие проблемы. */
  event: OrderHistoryEvent;
  occurredAt: string;
}

/**
 * Нерешённая проблема приготовления заказа либо null. Чистая функция, историю
 * не мутирует. OPEN и RESOLVED сопоставляются по problemId: проблема считается
 * активной, только если для её id НЕТ RESOLVED-события. Legacy-событие без
 * preparationProblemState трактуется как OPEN, его id — event.id. Возвращается
 * самая поздняя из активных.
 */
export function getOpenPreparationProblem(
  order: Order,
): PreparationProblemView | null {
  const resolvedIds = new Set<string>();
  for (const event of order.history) {
    if (
      event.type === "PREPARATION_PROBLEM" &&
      event.preparationProblemState === "RESOLVED"
    ) {
      resolvedIds.add(preparationProblemIdOf(event));
    }
  }
  for (let i = order.history.length - 1; i >= 0; i -= 1) {
    const event = order.history[i];
    if (event.type !== "PREPARATION_PROBLEM") continue;
    // RESOLVED-событие — это решение, а не открытие проблемы.
    if (event.preparationProblemState === "RESOLVED") continue;
    const problemId = preparationProblemIdOf(event);
    if (resolvedIds.has(problemId)) continue;
    return {
      problemId,
      reason: preparationProblemReason(event),
      event,
      occurredAt: event.occurredAt,
    };
  }
  return null;
}

/**
 * Последнее RESOLVED-событие проблемы приготовления либо null. Для кухни: показ
 * спокойного подтверждения «оператор подтвердил решение» после решения.
 */
export function getLatestResolvedPreparationProblem(
  order: Order,
): PreparationProblemView | null {
  for (let i = order.history.length - 1; i >= 0; i -= 1) {
    const event = order.history[i];
    if (
      event.type === "PREPARATION_PROBLEM" &&
      event.preparationProblemState === "RESOLVED"
    ) {
      return {
        problemId: preparationProblemIdOf(event),
        reason: preparationProblemReason(event),
        event,
        occurredAt: event.occurredAt,
      };
    }
  }
  return null;
}

export { TEST_RESTAURANT_ID };
