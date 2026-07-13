export const PROTOTYPE_SCHEMA_VERSION = 4 as const;

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
export type CustomerDeliveryMode = "PLATFORM_DRIVER" | "PICKUP";
export type PaymentMethod = "ONLINE" | "CASH";
export type OrderStatus =
  | "RESTAURANT_REVIEW"
  | "AWAITING_PAYMENT"
  | "PREPARING"
  | "READY"
  | "READY_FOR_PICKUP"
  | "PICKED_UP"
  | "CANCELED";
export type PaymentStatus =
  | "NOT_STARTED"
  | "AWAITING_PAYMENT"
  | "PAID"
  | "CASH_ON_DELIVERY";

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
  quantity: number;
  cookingComment: string;
}

export interface Cart {
  restaurantId: string | null;
  items: CartItem[];
  deliveryMode: CustomerDeliveryMode | null;
  paymentMethod: PaymentMethod;
  address: DeliveryAddress;
}

export interface OrderItemSnapshot {
  menuItemId: string;
  name: string;
  description: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  currencyCode: CurrencyCode;
  cookingComment: string;
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

export interface FinancialSnapshot {
  currencyCode: CurrencyCode;
  deliveryMode: CustomerDeliveryMode;
  restaurantCommissionRateBps: number;
  restaurantCommissionCents: number;
  foodSubtotalCents: number;
  deliveryFeeCents: number;
  smallOrderFeeCents: number;
  platformGrossRevenueCents: number;
  driverPayoutCents: number;
  restaurantPayoutBeforeBankFeeCents: number;
  customerTotalCents: number;
  restaurantZoneId: ZoneId;
  customerZoneId: ZoneId | null;
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
  deliveryMode: CustomerDeliveryMode;
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
  customer: CustomerProfile;
  drivers: DriverProfile[];
  cart: Cart;
  orders: Order[];
}

export interface CartPricing {
  foodSubtotalCents: number;
  deliveryFeeCents: number | null;
  restaurantCommissionCents: number;
  smallOrderFeeCents: number;
  platformGrossRevenueCents: number;
  driverPayoutCents: number | null;
  restaurantPayoutBeforeBankFeeCents: number;
  customerTotalCents: number | null;
}
