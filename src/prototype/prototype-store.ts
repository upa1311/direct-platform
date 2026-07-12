import {
  PROTOTYPE_SCHEMA_VERSION,
  type Cart,
  type Order,
  type PaymentMethod,
  type PrototypeState,
  type Restaurant,
} from "./models";
import { createDefaultTariffs } from "./default-state";

export const PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v3";
export const PROTOTYPE_CHANNEL_NAME = "direct-prototype-channel-v3";
export const LEGACY_PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v2";

type LegacyPaymentMethod = "QR" | "CASH";

interface LegacyCart extends Omit<Cart, "paymentMethod"> {
  paymentMethod: LegacyPaymentMethod;
}

interface LegacyRestaurant extends Omit<Restaurant, "paymentMethods"> {
  paymentMethods: LegacyPaymentMethod[];
}

interface LegacyOrder extends Omit<Order, "paymentMethod"> {
  paymentMethod: LegacyPaymentMethod;
}

interface LegacyPrototypeState
  extends Omit<
    PrototypeState,
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
      paymentMethod: cartPaymentMethod,
    },
    orders: state.orders.map((order) => {
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
        paymentMethod: "ONLINE",
        status: safeStatus,
        paymentStatus: wasCashOrder
          ? safeStatus === "AWAITING_PAYMENT"
            ? "AWAITING_PAYMENT"
            : "NOT_STARTED"
          : order.paymentStatus,
        paidAt: wasCashOrder ? null : order.paidAt,
        expectedReadyAt: wasCashOrder ? null : order.expectedReadyAt,
        history: order.history.map((event) => ({
          ...event,
          message: normalizeHistoryMessage(event.message),
        })),
      };
    }),
  };
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
      paymentMethod: normalizePaymentMethod(legacyState.cart.paymentMethod),
    },
    orders: legacyState.orders.map((order) => ({
      ...order,
      paymentMethod: normalizePaymentMethod(order.paymentMethod),
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
