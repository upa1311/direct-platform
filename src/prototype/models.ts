import type {
  FulfillmentChoice,
  RestaurantDeliveryProvider,
  RestaurantDeliverySettings,
} from "./pricing-engine";

export const PROTOTYPE_SCHEMA_VERSION = 5 as const;

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
export type PaymentMethod = "ONLINE" | "CASH";
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
  | "CASH_ON_DELIVERY";

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
}

export interface DriverProfile {
  id: string;
  name: string;
  cashEnabled: boolean;
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
}

export interface OrderHistoryEvent {
  id: string;
  occurredAt: string;
  actor: "CLIENT" | "RESTAURANT" | "SYSTEM";
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
  items: OrderItemSnapshot[];
  financials: FinancialSnapshot;
  history: OrderHistoryEvent[];
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
  /** Прогресс до следующего подарка по акции (единиц), null если акции нет. */
  promotionUnitsToNextFree: number | null;
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
