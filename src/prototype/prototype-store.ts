import {
  PROTOTYPE_SCHEMA_VERSION,
  type Cart,
  type DeliveryMode,
  type FinancialSnapshot,
  type Order,
  type OrderItemSnapshot,
  type PrototypeState,
  type RestaurantDeliveryProvider,
} from "./models";
import { createDefaultState, createEmptyCart } from "./default-state";
import { migrateFulfillmentChoice } from "./pricing-engine";

export const PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v6";
export const PROTOTYPE_CHANNEL_NAME = "direct-prototype-channel-v6";
export const LEGACY_V5_PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v5";
export const LEGACY_V4_PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v4";
export const LEGACY_V3_PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v3";
export const LEGACY_V2_PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v2";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
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
  return (
    typeof value.revision === "number" &&
    typeof value.updatedAt === "string" &&
    typeof value.nextOrderNumber === "number" &&
    Array.isArray(value.zones) &&
    isRecord(value.platformSettings) &&
    isRecord(value.tariffs) &&
    Array.isArray(value.restaurants) &&
    Array.isArray(value.menuItems) &&
    isRecord(value.customer) &&
    isRecord(value.cart) &&
    Array.isArray((value.cart as { items?: unknown }).items) &&
    Array.isArray(value.orders) &&
    Array.isArray(value.drivers)
  );
}

export function isPrototypeState(value: unknown): value is PrototypeState {
  return (
    hasPrototypeStateShape(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion ===
      PROTOTYPE_SCHEMA_VERSION &&
    Array.isArray((value as { promotions?: unknown }).promotions) &&
    Array.isArray((value as { settlements?: unknown }).settlements)
  );
}

function normalizeDeliveryMode(value: unknown): DeliveryMode {
  return value === "PICKUP" ||
    value === "RESTAURANT_DELIVERY" ||
    value === "PLATFORM_DRIVER"
    ? value
    : "PLATFORM_DRIVER";
}

function providerForMode(mode: DeliveryMode): RestaurantDeliveryProvider {
  return mode === "RESTAURANT_DELIVERY" ? "RESTAURANT" : "DIRECT";
}

/** Заполняет недостающие поля снимка позиции нейтральными значениями. */
function normalizeOrderItem(value: unknown): OrderItemSnapshot {
  const raw = isRecord(value) ? value : {};
  const unitPriceCents = num(raw.unitPriceCents, num(raw.finalUnitPriceCents, 0));
  const quantity = num(raw.quantity, 1);
  const lineTotalCents = num(
    raw.lineTotalCents,
    num(raw.finalLineTotalCents, unitPriceCents * quantity),
  );
  return {
    menuItemId: str(raw.menuItemId, ""),
    name: str(raw.name, ""),
    description: str(raw.description, ""),
    quantity,
    baseUnitPriceCents: num(raw.baseUnitPriceCents, unitPriceCents),
    selectedVariantId:
      typeof raw.selectedVariantId === "string" ? raw.selectedVariantId : null,
    selectedVariantName:
      typeof raw.selectedVariantName === "string"
        ? raw.selectedVariantName
        : null,
    variantPriceDeltaCents: num(raw.variantPriceDeltaCents, 0),
    finalUnitPriceCents: num(raw.finalUnitPriceCents, unitPriceCents),
    lineSubtotalBeforeDiscountCents: num(
      raw.lineSubtotalBeforeDiscountCents,
      lineTotalCents,
    ),
    promotionDiscountCents: num(raw.promotionDiscountCents, 0),
    finalLineTotalCents: num(raw.finalLineTotalCents, lineTotalCents),
    currencyCode: "USD",
    cookingComment: str(raw.cookingComment, ""),
    unitPriceCents,
    lineTotalCents,
  };
}

/** Заполняет недостающие поля финансового снимка нейтральными значениями. */
function normalizeFinancials(
  value: unknown,
  deliveryMode: DeliveryMode,
): FinancialSnapshot {
  const raw = isRecord(value) ? value : {};
  const foodSubtotalCents = num(raw.foodSubtotalCents, 0);
  const isPickup = deliveryMode === "PICKUP";
  return {
    currencyCode: "USD",
    deliveryMode,
    deliveryProvider:
      raw.deliveryProvider === "RESTAURANT" || raw.deliveryProvider === "DIRECT"
        ? raw.deliveryProvider
        : providerForMode(deliveryMode),
    restaurantCommissionRateBps: num(raw.restaurantCommissionRateBps, 1500),
    restaurantCommissionCents: num(raw.restaurantCommissionCents, 0),
    foodSubtotalBeforeDiscountsCents: num(
      raw.foodSubtotalBeforeDiscountsCents,
      foodSubtotalCents,
    ),
    variantSurchargeSubtotalCents: num(raw.variantSurchargeSubtotalCents, 0),
    promotionDiscountCents: num(raw.promotionDiscountCents, 0),
    foodSubtotalCents,
    deliveryFeeCents: isPickup ? 0 : num(raw.deliveryFeeCents, 0),
    standardRestaurantDeliveryFeeCents:
      typeof raw.standardRestaurantDeliveryFeeCents === "number"
        ? raw.standardRestaurantDeliveryFeeCents
        : null,
    freeDeliveryThresholdCents:
      typeof raw.freeDeliveryThresholdCents === "number"
        ? raw.freeDeliveryThresholdCents
        : null,
    minimumOrderCents:
      typeof raw.minimumOrderCents === "number" ? raw.minimumOrderCents : null,
    smallOrderFeeCents: num(raw.smallOrderFeeCents, 0),
    platformGrossRevenueCents: num(raw.platformGrossRevenueCents, 0),
    driverPayoutCents: isPickup ? 0 : num(raw.driverPayoutCents, 0),
    restaurantPayoutBeforeBankFeeCents: num(
      raw.restaurantPayoutBeforeBankFeeCents,
      0,
    ),
    customerTotalCents: num(raw.customerTotalCents, foodSubtotalCents),
    restaurantZoneId: (raw.restaurantZoneId ?? "zone-1") as
      FinancialSnapshot["restaurantZoneId"],
    customerZoneId: isPickup
      ? null
      : ((raw.customerZoneId ?? null) as FinancialSnapshot["customerZoneId"]),
    appliedPromotion: isRecord(raw.appliedPromotion)
      ? (raw.appliedPromotion as unknown as FinancialSnapshot["appliedPromotion"])
      : null,
    restaurantDelivery: isRecord(raw.restaurantDelivery)
      ? (raw.restaurantDelivery as unknown as FinancialSnapshot["restaurantDelivery"])
      : null,
    // Поля модели самовывоза: для старых заказов нейтральные значения.
    restaurantCollectedFromCustomerCents: num(
      raw.restaurantCollectedFromCustomerCents,
      0,
    ),
    platformCollectedFromCustomerCents: num(
      raw.platformCollectedFromCustomerCents,
      0,
    ),
    platformCommissionReceivableCents: num(
      raw.platformCommissionReceivableCents,
      0,
    ),
    restaurantNetAfterPlatformCommissionCents: num(
      raw.restaurantNetAfterPlatformCommissionCents,
      0,
    ),
  };
}

function normalizeOrder(value: unknown): Order {
  const raw = isRecord(value) ? value : {};
  const deliveryMode = normalizeDeliveryMode(raw.deliveryMode);
  const wasCashOrder =
    raw.paymentMethod === "CASH" || raw.paymentStatus === "CASH_ON_DELIVERY";
  const rawStatus = str(raw.status, "RESTAURANT_REVIEW") as Order["status"];
  const safeStatus =
    wasCashOrder && (rawStatus === "PREPARING" || rawStatus === "READY")
      ? "AWAITING_PAYMENT"
      : rawStatus;
  const history = Array.isArray(raw.history)
    ? (raw.history as Order["history"]).map((event) => ({ ...event }))
    : [];
  const restaurant = isRecord(raw.restaurant) ? raw.restaurant : {};
  const customer = isRecord(raw.customer) ? raw.customer : {};

  return {
    id: str(raw.id, ""),
    publicNumber: str(raw.publicNumber, ""),
    createdAt: str(raw.createdAt, new Date(0).toISOString()),
    updatedAt: str(raw.updatedAt, new Date(0).toISOString()),
    customer: {
      id: str(customer.id, "customer-1"),
      name: str(customer.name, ""),
      phone: str(customer.phone, ""),
    },
    restaurant: {
      id: str(restaurant.id, ""),
      name: str(restaurant.name, ""),
      address: str(restaurant.address, ""),
      zoneId: (restaurant.zoneId ?? "zone-1") as Order["restaurant"]["zoneId"],
    },
    address:
      deliveryMode === "PICKUP"
        ? null
        : isRecord(raw.address)
          ? (raw.address as unknown as Order["address"])
          : null,
    deliveryMode,
    paymentMethod: wasCashOrder
      ? "ONLINE"
      : raw.paymentMethod === "PAY_AT_RESTAURANT"
        ? "PAY_AT_RESTAURANT"
        : "ONLINE",
    paymentStatus: wasCashOrder
      ? safeStatus === "AWAITING_PAYMENT"
        ? "AWAITING_PAYMENT"
        : "NOT_STARTED"
      : (str(raw.paymentStatus, "NOT_STARTED") as Order["paymentStatus"]),
    paidAt: wasCashOrder
      ? null
      : typeof raw.paidAt === "string"
        ? raw.paidAt
        : null,
    status: safeStatus,
    preparationMinutes:
      typeof raw.preparationMinutes === "number"
        ? raw.preparationMinutes
        : null,
    expectedReadyAt:
      wasCashOrder
        ? null
        : typeof raw.expectedReadyAt === "string"
          ? raw.expectedReadyAt
          : null,
    cancellationReason:
      typeof raw.cancellationReason === "string"
        ? raw.cancellationReason
        : null,
    pickupCode: typeof raw.pickupCode === "string" ? raw.pickupCode : null,
    pickupCodeUsed: raw.pickupCodeUsed === true,
    items: Array.isArray(raw.items) ? raw.items.map(normalizeOrderItem) : [],
    financials: normalizeFinancials(raw.financials, deliveryMode),
    history,
  };
}

function normalizeCart(value: unknown, fallback: Cart): Cart {
  const raw = isRecord(value) ? value : {};
  const address = isRecord(raw.address)
    ? (raw.address as unknown as Cart["address"])
    : fallback.address;
  const items = Array.isArray(raw.items)
    ? raw.items.flatMap((item) => {
        if (!isRecord(item) || typeof item.menuItemId !== "string") {
          return [];
        }
        return [
          {
            menuItemId: item.menuItemId,
            variantId:
              typeof item.variantId === "string" ? item.variantId : null,
            quantity: num(item.quantity, 1),
            cookingComment: str(item.cookingComment, ""),
          },
        ];
      })
    : [];
  return {
    restaurantId:
      typeof raw.restaurantId === "string" ? raw.restaurantId : null,
    items,
    fulfillmentChoice:
      raw.fulfillmentChoice === "PICKUP" || raw.fulfillmentChoice === "DELIVERY"
        ? raw.fulfillmentChoice
        : migrateFulfillmentChoice(raw.deliveryMode),
    paymentMethod: "ONLINE",
    address,
  };
}

function normalizeRestaurantV5(
  value: unknown,
): PrototypeState["restaurants"][number] {
  const raw = isRecord(value) ? value : {};
  const provider =
    raw.deliveryProvider === "RESTAURANT" ? "RESTAURANT" : "DIRECT";
  const pickupPaymentMethods = Array.isArray(raw.pickupPaymentMethods)
    ? (raw.pickupPaymentMethods.filter(
        (m) => m === "CASH" || m === "CARD",
      ) as PrototypeState["restaurants"][number]["pickupPaymentMethods"])
    : (["CASH", "CARD"] as PrototypeState["restaurants"][number]["pickupPaymentMethods"]);
  return {
    ...(raw as unknown as PrototypeState["restaurants"][number]),
    deliveryProvider: provider,
    pickupEnabled:
      typeof raw.pickupEnabled === "boolean" ? raw.pickupEnabled : true,
    commissionRateBps: num(
      raw.commissionRateBps,
      provider === "RESTAURANT" ? 700 : 1500,
    ),
    restaurantDeliverySettings: isRecord(raw.restaurantDeliverySettings)
      ? (raw.restaurantDeliverySettings as unknown as PrototypeState["restaurants"][number]["restaurantDeliverySettings"])
      : null,
    pickupPaymentMethods,
    pickupCommissionRateBps: num(raw.pickupCommissionRateBps, 1500),
    pickupPrepaymentThresholdCents:
      typeof raw.pickupPrepaymentThresholdCents === "number"
        ? raw.pickupPrepaymentThresholdCents
        : null,
  };
}

function normalizeCustomer(
  value: unknown,
  fallback: PrototypeState["customer"],
): PrototypeState["customer"] {
  if (!isRecord(value)) {
    return fallback;
  }
  return {
    ...(value as unknown as PrototypeState["customer"]),
    noShowPickupCount: num(value.noShowPickupCount, 0),
  };
}

function normalizeSettlements(value: unknown): PrototypeState["settlements"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.orderId !== "string"
    ) {
      return [];
    }
    return [entry as unknown as PrototypeState["settlements"][number]];
  });
}

/**
 * Приведение уже v6-совместимого состояния к корректному виду. Сохраняет
 * пользовательские и админские данные (рестораны, меню, акции, тарифы, зоны,
 * настройки, корзину, заказы, ledger) и лишь мягко дозаполняет недостающие поля.
 */
export function normalizePrototypeState(
  state: PrototypeState,
): PrototypeState {
  const defaults = createDefaultState();
  return {
    ...state,
    schemaVersion: PROTOTYPE_SCHEMA_VERSION,
    platformSettings: {
      ...(isRecord(state.platformSettings)
        ? state.platformSettings
        : defaults.platformSettings),
      platformDriverCashEnabled: false,
    },
    zones: Array.isArray(state.zones) ? state.zones : defaults.zones,
    tariffs: isRecord(state.tariffs) ? state.tariffs : defaults.tariffs,
    restaurants: Array.isArray(state.restaurants)
      ? state.restaurants.map(normalizeRestaurantV5)
      : defaults.restaurants,
    menuItems: Array.isArray(state.menuItems)
      ? state.menuItems
      : defaults.menuItems,
    promotions: Array.isArray(state.promotions)
      ? state.promotions
      : defaults.promotions,
    customer: normalizeCustomer(state.customer, defaults.customer),
    drivers: Array.isArray(state.drivers) ? state.drivers : defaults.drivers,
    cart: normalizeCart(state.cart, defaults.cart),
    orders: Array.isArray(state.orders)
      ? state.orders.map(normalizeOrder)
      : [],
    settlements: normalizeSettlements(state.settlements),
  };
}

/**
 * Миграция любой предыдущей версии (v5/v4/v3/v2) в v6. Все корректные данные из
 * исходного состояния СОХРАНЯЮТСЯ (настройки, зоны, тарифы, рестораны, меню,
 * акции, клиент, водители, корзина, заказы, счётчик номеров); дефолты берутся
 * только при отсутствии соответствующих данных. Каждый ресторан проходит
 * нормализацию полей v6, но не заменяется дефолтным. Старым pickup-заказам
 * комиссия задним числом НЕ начисляется (settlements начинается пустым).
 */
export function upgradeToV6(raw: unknown): PrototypeState {
  const source = isRecord(raw) ? raw : {};
  const defaults = createDefaultState();
  const merged: PrototypeState = {
    ...defaults,
    revision: num(source.revision, 0),
    nextOrderNumber: num(source.nextOrderNumber, defaults.nextOrderNumber),
    platformSettings: isRecord(source.platformSettings)
      ? (source.platformSettings as unknown as PrototypeState["platformSettings"])
      : defaults.platformSettings,
    zones: Array.isArray(source.zones)
      ? (source.zones as unknown as PrototypeState["zones"])
      : defaults.zones,
    tariffs: isRecord(source.tariffs)
      ? (source.tariffs as unknown as PrototypeState["tariffs"])
      : defaults.tariffs,
    restaurants:
      Array.isArray(source.restaurants) && source.restaurants.length > 0
        ? (source.restaurants as unknown as PrototypeState["restaurants"])
        : defaults.restaurants,
    menuItems:
      Array.isArray(source.menuItems) && source.menuItems.length > 0
        ? (source.menuItems as unknown as PrototypeState["menuItems"])
        : defaults.menuItems,
    promotions: Array.isArray(source.promotions)
      ? (source.promotions as unknown as PrototypeState["promotions"])
      : defaults.promotions,
    customer: normalizeCustomer(source.customer, defaults.customer),
    drivers: Array.isArray(source.drivers)
      ? (source.drivers as PrototypeState["drivers"])
      : defaults.drivers,
    cart: normalizeCart(source.cart, defaults.cart),
    orders: Array.isArray(source.orders)
      ? (source.orders as unknown[]).map(normalizeOrder)
      : [],
    settlements: [],
  };
  return normalizePrototypeState(merged);
}

export function parseStoredState(
  serialized: string | null,
): PrototypeState | null {
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isPrototypeState(parsed) ? normalizePrototypeState(parsed) : null;
  } catch {
    return null;
  }
}

/** Загружает и мигрирует любую предыдущую версию (v5/v4/v3/v2) в v6. */
export function parseLegacyStoredState(
  serialized: string | null,
): PrototypeState | null {
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || !Array.isArray(parsed.orders)) {
      return null;
    }
    return upgradeToV6(parsed);
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

export { createEmptyCart };
