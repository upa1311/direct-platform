import {
  PROTOTYPE_SCHEMA_VERSION,
  type Cart,
  type CustomerDeliveryMode,
  type DeliveryAddress,
  type FinancialSnapshot,
  type Order,
  type PaymentMethod,
  type PrototypeState,
  type Restaurant,
  type ZoneId,
} from "./models";
import {
  createDefaultTariffs,
  getDefaultRecommendationRank,
} from "./default-state";

export const PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v4";
export const PROTOTYPE_CHANNEL_NAME = "direct-prototype-channel-v4";
export const LEGACY_V3_PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v3";
export const LEGACY_PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v2";

interface LegacyV3Cart extends Omit<Cart, "deliveryMode"> {
  deliveryMode: "PLATFORM_DRIVER";
}

interface LegacyV3FinancialSnapshot
  extends Omit<FinancialSnapshot, "deliveryMode" | "customerZoneId"> {
  deliveryMode: "PLATFORM_DRIVER";
  customerZoneId: ZoneId;
}

interface LegacyV3Order
  extends Omit<Order, "address" | "deliveryMode" | "financials"> {
  address: DeliveryAddress;
  deliveryMode: "PLATFORM_DRIVER";
  financials: LegacyV3FinancialSnapshot;
}

interface LegacyV3PrototypeState
  extends Omit<PrototypeState, "schemaVersion" | "cart" | "orders"> {
  schemaVersion: 3;
  cart: LegacyV3Cart;
  orders: LegacyV3Order[];
}

type LegacyPaymentMethod = "QR" | "CASH";

interface LegacyCart extends Omit<LegacyV3Cart, "paymentMethod"> {
  paymentMethod: LegacyPaymentMethod;
}

interface LegacyRestaurant extends Omit<Restaurant, "paymentMethods"> {
  paymentMethods: LegacyPaymentMethod[];
}

interface LegacyOrder extends Omit<LegacyV3Order, "paymentMethod"> {
  paymentMethod: LegacyPaymentMethod;
}

interface LegacyPrototypeState
  extends Omit<
    LegacyV3PrototypeState,
    "schemaVersion" | "cart" | "restaurants" | "orders"
  > {
  schemaVersion: 2;
  cart: LegacyCart;
  restaurants: LegacyRestaurant[];
  orders: LegacyOrder[];
}

export function finalizeMutation(
  currentState: PrototypeState,
  nextState: PrototypeState,
  timestamp = new Date().toISOString(),
): PrototypeState {
  return {
    ...nextState,
    schemaVersion: PROTOTYPE_SCHEMA_VERSION,
    revision: currentState.revision + 1,
    updatedAt: timestamp,
  };
}

function hasPrototypeStateShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const candidate = value as Partial<PrototypeState>;

  return (
    typeof candidate.revision === "number" &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.nextOrderNumber === "number" &&
    Array.isArray(candidate.zones) &&
    candidate.zones.every(
      (zone) => isRecord(zone) && Array.isArray(zone.streets),
    ) &&
    isRecord(candidate.platformSettings) &&
    isRecord(candidate.tariffs) &&
    Array.isArray(candidate.restaurants) &&
    candidate.restaurants.every(
      (restaurant) =>
        isRecord(restaurant) && Array.isArray(restaurant.paymentMethods),
    ) &&
    Array.isArray(candidate.menuItems) &&
    candidate.menuItems.every(isRecord) &&
    isRecord(candidate.customer) &&
    isRecord(candidate.cart) &&
    Array.isArray(candidate.cart.items) &&
    isRecord(candidate.cart.address) &&
    Array.isArray(candidate.orders) &&
    candidate.orders.every(
      (order) => isRecord(order) && Array.isArray(order.history),
    ) &&
    Array.isArray(candidate.drivers)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function isPrototypeState(value: unknown): value is PrototypeState {
  return (
    hasPrototypeStateShape(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion ===
      PROTOTYPE_SCHEMA_VERSION
  );
}

function isLegacyPrototypeState(
  value: unknown,
): value is LegacyPrototypeState {
  return (
    hasPrototypeStateShape(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 2
  );
}

function isLegacyV3PrototypeState(
  value: unknown,
): value is LegacyV3PrototypeState {
  return (
    hasPrototypeStateShape(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 3
  );
}

function normalizePaymentMethod(value: unknown): PaymentMethod {
  if (value === "CASH" || value === "QR") {
    return "ONLINE";
  }
  return "ONLINE";
}

function normalizePaymentMethods(values: unknown): PaymentMethod[] {
  if (!Array.isArray(values)) {
    return ["ONLINE"];
  }

  const methods = values.map(normalizePaymentMethod);
  return [...new Set(methods)];
}

function normalizeCartDeliveryMode(
  value: unknown,
): CustomerDeliveryMode | null {
  return value === "PLATFORM_DRIVER" || value === "PICKUP" ? value : null;
}

function normalizeOrderDeliveryMode(value: unknown): CustomerDeliveryMode {
  return value === "PICKUP" ? "PICKUP" : "PLATFORM_DRIVER";
}

function normalizeHistoryMessage(message: string): string {
  return message
    .replaceAll("QR-оплата", "онлайн-оплата")
    .replaceAll("QR-оплаты", "онлайн-оплаты")
    .replaceAll("QR-заказ", "онлайн-заказ");
}

export function normalizePrototypeState(
  state: PrototypeState,
): PrototypeState {
  const defaultTariffs = createDefaultTariffs();
  const zoneIds = ["zone-1", "zone-2", "zone-3", "zone-4"] as const;
  const tariffs = Object.fromEntries(
    zoneIds.map((fromZoneId) => [
      fromZoneId,
      Object.fromEntries(
        zoneIds.map((toZoneId) => {
          const saved = state.tariffs[fromZoneId]?.[toZoneId];
          return [
            toZoneId,
            Number.isInteger(saved) && Number(saved) >= 0
              ? saved
              : defaultTariffs[fromZoneId][toZoneId],
          ];
        }),
      ),
    ]),
  ) as PrototypeState["tariffs"];
  const platformDriverCashEnabled = false;
  const cartPaymentMethod = normalizePaymentMethod(
    state.cart.paymentMethod,
  );
  const cartDeliveryMode = normalizeCartDeliveryMode(
    state.cart.deliveryMode,
  );

  return {
    ...state,
    schemaVersion: PROTOTYPE_SCHEMA_VERSION,
    platformSettings: {
      ...state.platformSettings,
      platformDriverCashEnabled,
    },
    tariffs,
    restaurants: state.restaurants.map((restaurant) => ({
      ...restaurant,
      recommendationRank:
        Number.isFinite(restaurant.recommendationRank) &&
        Number(restaurant.recommendationRank) >= 0
          ? Number(restaurant.recommendationRank)
          : getDefaultRecommendationRank(restaurant.id),
      status:
        restaurant.id === "restaurant-1" ||
        restaurant.id === "restaurant-2" ||
        restaurant.id === "restaurant-3"
          ? "PUBLISHED"
          : restaurant.status,
      isAcceptingOrders:
        restaurant.id === "restaurant-1"
          ? true
          : restaurant.id === "restaurant-2" || restaurant.id === "restaurant-3"
            ? false
            : restaurant.isAcceptingOrders,
      paymentMethods: normalizePaymentMethods(restaurant.paymentMethods),
    })),
    cart: {
      ...state.cart,
      deliveryMode: cartDeliveryMode,
      paymentMethod: cartPaymentMethod,
    },
    orders: state.orders.map((order) => {
      const deliveryMode = normalizeOrderDeliveryMode(order.deliveryMode);
      const isPickup = deliveryMode === "PICKUP";
      const wasCashOrder =
        order.paymentMethod === "CASH" ||
        order.paymentStatus === "CASH_ON_DELIVERY";
      const safeStatus =
        wasCashOrder &&
        (order.status === "PREPARING" || order.status === "READY")
          ? "AWAITING_PAYMENT"
          : order.status;

      return {
        ...order,
        address: isPickup ? null : order.address,
        deliveryMode,
        paymentMethod: "ONLINE",
        status: safeStatus,
        paymentStatus: wasCashOrder
          ? safeStatus === "AWAITING_PAYMENT"
            ? "AWAITING_PAYMENT"
            : "NOT_STARTED"
          : order.paymentStatus,
        paidAt: wasCashOrder ? null : order.paidAt,
        expectedReadyAt: wasCashOrder ? null : order.expectedReadyAt,
        financials: {
          ...order.financials,
          deliveryMode,
          deliveryFeeCents: isPickup
            ? 0
            : order.financials.deliveryFeeCents,
          driverPayoutCents: isPickup
            ? 0
            : order.financials.driverPayoutCents,
          customerTotalCents: isPickup
            ? order.financials.foodSubtotalCents +
              order.financials.smallOrderFeeCents
            : order.financials.customerTotalCents,
          customerZoneId: isPickup
            ? null
            : order.financials.customerZoneId,
        },
        history: order.history.map((event) => ({ ...event })),
      };
    }),
  };
}

export function migrateV3PrototypeState(
  legacyState: LegacyV3PrototypeState,
): PrototypeState {
  const migratedState = {
    ...legacyState,
    schemaVersion: PROTOTYPE_SCHEMA_VERSION,
    cart: {
      ...legacyState.cart,
      deliveryMode: null,
      paymentMethod: normalizePaymentMethod(legacyState.cart.paymentMethod),
    },
    orders: legacyState.orders.map((order) => ({
      ...order,
      deliveryMode: "PLATFORM_DRIVER" as const,
      paymentMethod: normalizePaymentMethod(order.paymentMethod),
      financials: {
        ...order.financials,
        deliveryMode: "PLATFORM_DRIVER" as const,
      },
      history: order.history.map((event) => ({ ...event })),
    })),
  } as PrototypeState;

  return normalizePrototypeState(migratedState);
}

export function migrateLegacyPrototypeState(
  legacyState: LegacyPrototypeState,
): PrototypeState {
  const migratedState = {
    ...legacyState,
    schemaVersion: PROTOTYPE_SCHEMA_VERSION,
    restaurants: legacyState.restaurants.map((restaurant) => ({
      ...restaurant,
      isAcceptingOrders:
        restaurant.id === "restaurant-1"
          ? true
          : restaurant.id === "restaurant-2" ||
              restaurant.id === "restaurant-3"
            ? false
            : restaurant.isAcceptingOrders,
      paymentMethods: normalizePaymentMethods(restaurant.paymentMethods),
    })),
    cart: {
      ...legacyState.cart,
      deliveryMode: null,
      paymentMethod: normalizePaymentMethod(legacyState.cart.paymentMethod),
    },
    orders: legacyState.orders.map((order) => ({
      ...order,
      deliveryMode: "PLATFORM_DRIVER" as const,
      paymentMethod: normalizePaymentMethod(order.paymentMethod),
      financials: {
        ...order.financials,
        deliveryMode: "PLATFORM_DRIVER" as const,
      },
      history: order.history.map((event) => ({
        ...event,
        message: normalizeHistoryMessage(event.message),
      })),
    })),
  } as PrototypeState;

  return normalizePrototypeState(migratedState);
}

export function parseStoredState(
  serialized: string | null,
): PrototypeState | null {
  if (!serialized) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    return isPrototypeState(parsed) ? normalizePrototypeState(parsed) : null;
  } catch {
    return null;
  }
}

export function parseLegacyStoredState(
  serialized: string | null,
): PrototypeState | null {
  if (!serialized) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    return isLegacyPrototypeState(parsed)
      ? migrateLegacyPrototypeState(parsed)
      : null;
  } catch {
    return null;
  }
}

export function parseV3StoredState(
  serialized: string | null,
): PrototypeState | null {
  if (!serialized) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    return isLegacyV3PrototypeState(parsed)
      ? migrateV3PrototypeState(parsed)
      : null;
  } catch {
    return null;
  }
}

export function isNewerState(
  candidate: PrototypeState,
  current: PrototypeState,
): boolean {
  return (
    candidate.revision > current.revision ||
    (candidate.revision === current.revision &&
      candidate.updatedAt > current.updatedAt)
  );
}
