import type {
  FulfillmentChoice,
  RestaurantDeliveryProvider,
  RestaurantDeliverySettings,
} from "./pricing-engine";

export const PROTOTYPE_SCHEMA_VERSION = 6 as const;

export type {
  FulfillmentChoice,
  RestaurantDeliveryProvider,
  RestaurantDeliverySettings,
};

export type CurrencyCode = "USD";
export type ZoneId = "zone-1" | "zone-2" | "zone-3" | "zone-4";
export type PublicationStatus =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "PUBLISHED"
  | "HIDDEN"
  | "ARCHIVED";
export type DeliveryMode =
  | "PLATFORM_DRIVER"
  | "RESTAURANT_DELIVERY"
  | "PICKUP";
/** Историческое клиентское понятие v4. Сохранено для совместимости миграции. */
export type CustomerDeliveryMode = "PLATFORM_DRIVER" | "PICKUP";
export type PaymentMethod =
  | "ONLINE"
  | "CASH"
  | "PAY_AT_RESTAURANT"
  /** Наличные курьеру ресторана (RESTAURANT_DELIVERY). Деньги идут ресторану, не Direct. */
  | "CASH_TO_RESTAURANT_COURIER";
/** Способы оплаты, доступные на точке самовывоза. */
export type PickupPaymentMethod = "CASH" | "CARD";
export type OrderStatus =
  | "RESTAURANT_REVIEW"
  | "AWAITING_PAYMENT"
  | "PREPARING"
  | "READY"
  | "READY_FOR_PICKUP"
  | "PICKED_UP"
  | "OUT_FOR_DELIVERY"
  | "ARRIVING"
  | "DELIVERED"
  | "CANCELED";
export type PaymentStatus =
  | "NOT_STARTED"
  | "AWAITING_PAYMENT"
  | "PAID"
  | "CASH_ON_DELIVERY"
  | "DUE_AT_PICKUP"
  | "PAID_AT_RESTAURANT"
  /** Ожидается оплата наличными курьеру ресторана при получении. */
  | "DUE_TO_RESTAURANT_COURIER"
  /** Оплата наличными курьеру ресторана получена. */
  | "PAID_TO_RESTAURANT_COURIER";

export type SettlementType =
  | "PICKUP_COMMISSION"
  | "RESTAURANT_DELIVERY_COMMISSION";
export type SettlementStatus = "PENDING" | "NETTED" | "PAID" | "WAIVED";

/** Неизменяемая запись начисления комиссии Direct (ledger). */
export interface SettlementEntry {
  id: string;
  orderId: string;
  restaurantId: string;
  type: SettlementType;
  amountCents: number;
  status: SettlementStatus;
  createdAt: string;
}

export type PromotionType = "BUY_N_GET_M_CHEAPEST_FREE";

export interface PlatformSettings {
  currencyCode: CurrencyCode;
  restaurantCommissionRateBps: number;
  minimumPlatformGrossRevenueCents: number;
  cashMinimumFoodSubtotalCents: number;
  platformDriverCashEnabled: boolean;
}

export interface Zone {
  id: ZoneId;
  name: string;
  streets: string[];
}

export type TariffMatrix = Record<ZoneId, Record<ZoneId, number>>;

/** Идентификаторы дней недели графика работы (пн–вс). */
export type WeekdayId =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/** Порядок дней недели для отображения. */
export const WEEKDAY_ORDER: WeekdayId[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** Русские названия дней недели для админки. */
export const WEEKDAY_LABELS: Record<WeekdayId, string> = {
  monday: "Понедельник",
  tuesday: "Вторник",
  wednesday: "Среда",
  thursday: "Четверг",
  friday: "Пятница",
  saturday: "Суббота",
  sunday: "Воскресенье",
};

/** График одного дня: открыт/закрыт и часы работы (формат «09:00»). */
export interface DaySchedule {
  enabled: boolean;
  openTime: string;
  closeTime: string;
}

/** Структурированный недельный график работы ресторана. */
export type WeeklySchedule = Record<WeekdayId, DaySchedule>;

export interface Restaurant {
  id: string;
  name: string;
  description: string;
  address: string;
  zoneId: ZoneId;
  status: PublicationStatus;
  isAcceptingOrders: boolean;
  deliveryModes: DeliveryMode[];
  paymentMethods: PaymentMethod[];
  defaultPreparationMinutes: number;
  recommendationRank?: number;
  /** Кто фактически доставляет заказ — единый источник истины. */
  deliveryProvider: RestaurantDeliveryProvider;
  pickupEnabled: boolean;
  commissionRateBps: number;
  /** Собственные условия доставки для ресторана типа RESTAURANT. */
  restaurantDeliverySettings: RestaurantDeliverySettings | null;
  /** Способы оплаты на точке самовывоза (наличные/карта). */
  pickupPaymentMethods: PickupPaymentMethod[];
  /** Комиссия Direct за самовывоз (по умолчанию 1500 bps = 15%). */
  pickupCommissionRateBps: number;
  /** Порог предоплаты самовывоза. Пока не активирован (null). */
  pickupPrepaymentThresholdCents: number | null;
  /** Публичный телефон ресторана (можно показывать клиенту в будущем). */
  publicPhone: string;
  /** Имя основного контактного лица (внутреннее, только для /admin). */
  contactPersonName: string;
  /** Роль: владелец/управляющий/администратор/бухгалтер/другое (внутреннее). */
  contactPersonRole: string;
  /** Прямой телефон контактного лица (внутреннее). */
  contactPhone: string;
  /** Рабочий email (внутреннее). */
  contactEmail: string;
  /** Необязательный мессенджер: Telegram/Viber/WhatsApp (внутреннее). */
  contactMessenger: string;
  /** Необязательный номер для срочных операционных проблем (внутреннее). */
  emergencyPhone: string;
  /** Внутренний комментарий Direct; клиент и ресторан его не видят. */
  internalAdminNote: string;
  /** Структурированный недельный график работы. */
  weeklySchedule: WeeklySchedule;
  /** Часовой пояс ресторана (IANA), например «Europe/Chisinau». */
  timeZone: string;
}

export interface MenuItemVariant {
  id: string;
  name: string;
  priceDeltaCents: number;
  available: boolean;
  isDefault: boolean;
}

export interface MenuItem {
  id: string;
  restaurantId: string;
  category: string;
  name: string;
  description: string;
  priceCents: number;
  currencyCode: CurrencyCode;
  available: boolean;
  /** Варианты размеров. Пусто/undefined — товар без размеров (старый flow). */
  variants?: MenuItemVariant[];
}

export interface Promotion {
  id: string;
  restaurantId: string;
  title: string;
  enabled: boolean;
  type: PromotionType;
  buyQuantity: number;
  freeQuantity: number;
  repeat: boolean;
  eligibleMenuItemIds: string[];
  displayText: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryAddress {
  street: string;
  house: string;
  apartment: string;
  entrance: string;
  floor: string;
  comment: string;
  zoneId: ZoneId | null;
}

export interface SavedAddress extends DeliveryAddress {
  id: string;
  label: string;
}

export interface CustomerProfile {
  id: string;
  name: string;
  phone: string;
  phoneVerified: boolean;
  addresses: SavedAddress[];
  /** Счётчик невыкупленных заказов самовывоза. */
  noShowPickupCount: number;
}

/** Оперативный статус водителя Direct. */
export type DriverStatus = "AVAILABLE" | "BUSY" | "OFFLINE";

export interface DriverProfile {
  id: string;
  name: string;
  cashEnabled: boolean;
  /** Доступен / занят / не на смене. Для назначения годятся только AVAILABLE. */
  status: DriverStatus;
  /** Телефон водителя (для связи из админки). */
  phone: string;
}

export interface CartItem {
  menuItemId: string;
  variantId: string | null;
  quantity: number;
  cookingComment: string;
}

export interface Cart {
  restaurantId: string | null;
  items: CartItem[];
  fulfillmentChoice: FulfillmentChoice;
  paymentMethod: PaymentMethod;
  address: DeliveryAddress;
}

export interface OrderItemSnapshot {
  menuItemId: string;
  name: string;
  description: string;
  quantity: number;
  baseUnitPriceCents: number;
  selectedVariantId: string | null;
  selectedVariantName: string | null;
  variantPriceDeltaCents: number;
  finalUnitPriceCents: number;
  lineSubtotalBeforeDiscountCents: number;
  promotionDiscountCents: number;
  finalLineTotalCents: number;
  currencyCode: CurrencyCode;
  cookingComment: string;
  /** Совместимость с прежними представлениями заказа. */
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface OrderCustomerSnapshot {
  id: string;
  name: string;
  phone: string;
}

export interface OrderRestaurantSnapshot {
  id: string;
  name: string;
  address: string;
  zoneId: ZoneId;
}

export interface AppliedPromotionSnapshot {
  promotionId: string;
  title: string;
  type: PromotionType;
  freeUnitCount: number;
  discountCents: number;
}

export interface RestaurantDeliverySnapshot {
  minimumOrderCents: number;
  freeDeliveryThresholdCents: number | null;
  standardDeliveryFeeCents: number;
  appliedDeliveryFeeCents: number;
  freeDeliveryApplied: boolean;
}

export interface FinancialSnapshot {
  currencyCode: CurrencyCode;
  deliveryMode: DeliveryMode;
  deliveryProvider: RestaurantDeliveryProvider;
  restaurantCommissionRateBps: number;
  restaurantCommissionCents: number;
  foodSubtotalBeforeDiscountsCents: number;
  variantSurchargeSubtotalCents: number;
  promotionDiscountCents: number;
  foodSubtotalCents: number;
  deliveryFeeCents: number;
  standardRestaurantDeliveryFeeCents: number | null;
  freeDeliveryThresholdCents: number | null;
  minimumOrderCents: number | null;
  smallOrderFeeCents: number;
  platformGrossRevenueCents: number;
  driverPayoutCents: number;
  restaurantPayoutBeforeBankFeeCents: number;
  customerTotalCents: number;
  restaurantZoneId: ZoneId;
  customerZoneId: ZoneId | null;
  appliedPromotion: AppliedPromotionSnapshot | null;
  restaurantDelivery: RestaurantDeliverySnapshot | null;
  /**
   * Кто реально собирает деньги клиента. При PICKUP платит ресторан на точке,
   * поэтому Direct клиентский платёж не удерживает.
   */
  restaurantCollectedFromCustomerCents: number;
  platformCollectedFromCustomerCents: number;
  /** Сколько ресторан должен Direct (комиссия + small-order fee, если есть). */
  platformCommissionReceivableCents: number;
  restaurantNetAfterPlatformCommissionCents: number;
}

export interface OrderHistoryEvent {
  id: string;
  occurredAt: string;
  actor: "CLIENT" | "RESTAURANT" | "SYSTEM" | "ADMIN";
  type: "STATUS" | "PAYMENT";
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  message: string;
}

export interface Order {
  id: string;
  publicNumber: string;
  createdAt: string;
  updatedAt: string;
  customer: OrderCustomerSnapshot;
  restaurant: OrderRestaurantSnapshot;
  address: DeliveryAddress | null;
  deliveryMode: DeliveryMode;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  paidAt: string | null;
  status: OrderStatus;
  preparationMinutes: number | null;
  expectedReadyAt: string | null;
  cancellationReason: string | null;
  /** Одноразовый код выдачи самовывоза (только для PICKUP). */
  pickupCode: string | null;
  pickupCodeUsed: boolean;
  /** Назначенный водитель Direct (только PLATFORM_DRIVER). */
  assignedDriverId: string | null;
  /** Время назначения водителя. */
  driverAssignedAt: string | null;
  items: OrderItemSnapshot[];
  financials: FinancialSnapshot;
  history: OrderHistoryEvent[];
}

export type CancellationRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

/** Клиентский запрос на отмену уже готовящегося заказа (рассматривает Direct). */
export interface CancellationRequest {
  id: string;
  orderId: string;
  customerId: string;
  restaurantId: string;
  requestedAt: string;
  requestedOrderStatus: OrderStatus;
  paymentMethod: PaymentMethod;
  reason: string;
  status: CancellationRequestStatus;
  resolvedAt: string | null;
  resolvedBy: "ADMIN" | null;
  resolutionNote: string | null;
}

export interface PrototypeState {
  schemaVersion: typeof PROTOTYPE_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  nextOrderNumber: number;
  platformSettings: PlatformSettings;
  zones: Zone[];
  tariffs: TariffMatrix;
  restaurants: Restaurant[];
  menuItems: MenuItem[];
  promotions: Promotion[];
  customer: CustomerProfile;
  drivers: DriverProfile[];
  cart: Cart;
  orders: Order[];
  settlements: SettlementEntry[];
  cancellationRequests: CancellationRequest[];
}

/** Результат расчёта корзины для клиентского оформления. */
export interface CartPricing {
  deliveryMode: DeliveryMode | null;
  deliveryProvider: RestaurantDeliveryProvider | null;
  foodSubtotalBeforeDiscountsCents: number;
  variantSurchargeSubtotalCents: number;
  promotionDiscountCents: number;
  foodSubtotalCents: number;
  deliveryFeeCents: number | null;
  standardRestaurantDeliveryFeeCents: number | null;
  restaurantCommissionCents: number;
  smallOrderFeeCents: number;
  platformGrossRevenueCents: number;
  driverPayoutCents: number | null;
  restaurantPayoutBeforeBankFeeCents: number;
  customerTotalCents: number | null;
  appliedPromotion: AppliedPromotionSnapshot | null;
  /** Прогресс до следующей завершённой группы (единиц), null если акции нет. */
  promotionUnitsToNextFree: number | null;
  /**
   * Сколько ещё ПЛАТНЫХ участвующих пицц добавить до следующей бесплатной.
   * 0 — следующая пицца уже бесплатная; null — акции нет / нет участвующих.
   * Клиентский показатель (не менять формулу самой акции).
   */
  promotionPaidUnitsBeforeNextFree: number | null;
  promotionFreeUnitCount: number;
  promotionEligibleUnits: number;
  /** Состояние собственной доставки ресторана. */
  restaurantDeliveryStatus:
    | "OK"
    | "BELOW_MINIMUM"
    | "ZONE_NOT_SERVED"
    | null;
  restaurantDeliveryMissingCents: number | null;
  freeDeliveryRemainingCents: number | null;
  minimumOrderCents: number | null;
  freeDeliveryThresholdCents: number | null;
}
