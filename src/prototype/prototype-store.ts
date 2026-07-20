import {
  PROTOTYPE_SCHEMA_VERSION,
  WEEKDAY_ORDER,
  type Cart,
  type DaySchedule,
  type DeliveryMode,
  type FinancialSnapshot,
  type MenuItemSubmission,
  type MenuItemSubmissionReviewEntry,
  type MenuItemSubmissionVariant,
  type MenuItemVariant,
  type MenuPortion,
  type Order,
  type OrderItemSnapshot,
  type PrototypeState,
  type RestaurantDeliveryProvider,
  type WeeklySchedule,
} from "./models";
import {
  normalizeOptionalCategory,
  validateMenuPortion,
} from "./menu-catalog";
import {
  createAlwaysOpenDemoSchedule,
  createDefaultState,
  createEmptyCart,
} from "./default-state";
import { migrateFulfillmentChoice } from "./pricing-engine";
import { migrateLegacySettlementsToAccounting } from "./restaurant-accounting";
import {
  normalizeStoredMoneyMovement,
  type MoneyMovementRecoveryContext,
} from "./money-movement-snapshot";

export const PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v7";
export const PROTOTYPE_CHANNEL_NAME = "direct-prototype-channel-v7";
export const LEGACY_V6_PROTOTYPE_STORAGE_KEY = "direct-prototype-state-v6";
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

/**
 * Схемы, принимаемые из текущего ключа хранилища v7. Каждая следующая версия —
 * надмножество предыдущей (v8 добавил restaurantAccountingEntries, v9 —
 * restaurantAccountingResolutionEvents, v10 — каноническое движение денег в
 * FinancialSnapshot), поэтому состояние прежней версии безопасно принимается и
 * доводится нормализацией до текущей без потери данных. Ключ хранилища не
 * меняется.
 */
const PARSEABLE_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([7, 8, 9, 10]);

export function isPrototypeState(value: unknown): value is PrototypeState {
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  return (
    hasPrototypeStateShape(value) &&
    typeof schemaVersion === "number" &&
    PARSEABLE_SCHEMA_VERSIONS.has(schemaVersion) &&
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
/**
 * Структурированная порция из сохранённого состояния. Некорректные и legacy
 * значения (в т.ч. свободные строки вроде «350 грамм») превращаются в null —
 * источником истины остаётся только валидная пара value/unit.
 */
function normalizeMenuPortion(value: unknown): MenuPortion | null {
  if (!isRecord(value)) return null;
  const unit = value.unit;
  if (unit !== "G" && unit !== "ML" && unit !== "PCS" && unit !== "CM") {
    return null;
  }
  const portion: MenuPortion = { value: num(value.value, 0), unit };
  return validateMenuPortion(portion) === null ? portion : null;
}

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
    // Старые заказы снимка порции не имеют — остаются с null и не меняются.
    portionSnapshot: normalizeMenuPortion(raw.portionSnapshot),
    unitPriceCents,
    lineTotalCents,
  };
}

/** Заполняет недостающие поля финансового снимка нейтральными значениями. */
function normalizeFinancials(
  value: unknown,
  deliveryMode: DeliveryMode,
  movementContext: MoneyMovementRecoveryContext,
): FinancialSnapshot {
  const raw = isRecord(value) ? value : {};
  const foodSubtotalCents = num(raw.foodSubtotalCents, 0);
  const isPickup = deliveryMode === "PICKUP";
  const base: Omit<FinancialSnapshot, "moneyMovementStatus" | "moneyMovement"> = {
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

  // v10: каноническое движение денег — fail-closed нормализация по ИСХОДНЫМ
  // данным снимка (см. normalizeStoredMoneyMovement). Fallback-нули base выше
  // существуют только для совместимости прочих UI-полей: recovery движение из
  // них не строит — отсутствующие суммы не являются доказанными нулями.
  // Сохранённый COMPLETE проверяется структурно и семантически (канал,
  // получатель и все суммы совпадают с канонической функцией) и принимается
  // ИСХОДНЫМ объектом — история не пересчитывается; любое расхождение —
  // REVIEW_REQUIRED; незавершённый самовывоз — законный PENDING.
  const recovered = normalizeStoredMoneyMovement(
    value,
    deliveryMode,
    movementContext,
  );
  return {
    ...base,
    moneyMovementStatus: recovered.moneyMovementStatus,
    ...(recovered.moneyMovement
      ? { moneyMovement: recovered.moneyMovement }
      : {}),
  };
}

function normalizePickupMethods(value: unknown): ("CASH" | "CARD")[] {
  if (!Array.isArray(value)) return [];
  return value.filter((m): m is "CASH" | "CARD" => m === "CASH" || m === "CARD");
}

/**
 * Миграция kitchenStartedAt для сохранённых заказов. Явное валидное значение
 * (ISO или null) сохраняется как есть. Legacy-заказы без поля: до приготовления
 * (RESTAURANT_REVIEW/AWAITING_PAYMENT) и в отменённом статусе — null; заказы,
 * уже дошедшие до PREPARING и дальше, считаются начатыми (момент входа в
 * PREPARING из истории, иначе updatedAt/createdAt), чтобы завершённые и
 * готовящиеся старые заказы не показывались как «кухня не начала» и не
 * блокировали готовность/не звучали.
 */
function normalizeKitchenStartedAt(
  raw: Record<string, unknown>,
  status: Order["status"],
): string | null {
  const isValidIso = (v: unknown): v is string =>
    typeof v === "string" && !Number.isNaN(Date.parse(v));
  if (isValidIso(raw.kitchenStartedAt)) {
    return raw.kitchenStartedAt;
  }
  if (raw.kitchenStartedAt === null) {
    return null;
  }
  if (
    status === "RESTAURANT_REVIEW" ||
    status === "AWAITING_PAYMENT" ||
    status === "CANCELED"
  ) {
    return null;
  }
  const preparingEntry = Array.isArray(raw.history)
    ? (raw.history as { toStatus?: unknown; occurredAt?: unknown }[]).find(
        (event) => event?.toStatus === "PREPARING",
      )
    : undefined;
  const candidates = [
    preparingEntry?.occurredAt,
    raw.updatedAt,
    raw.createdAt,
  ];
  const fallback = candidates.find(isValidIso);
  return fallback ?? new Date(0).toISOString();
}

function normalizeOrder(
  value: unknown,
  restaurants: PrototypeState["restaurants"],
): Order {
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
  // §2: старые заказы без аудита ETA получают пустой массив; существующие
  // записи сохраняются как есть (не удаляем и не пересоздаём заказ).
  const etaAdjustments = Array.isArray(raw.etaAdjustments)
    ? (raw.etaAdjustments as Order["etaAdjustments"]).map((entry) => ({
        ...entry,
      }))
    : [];
  const restaurant = isRecord(raw.restaurant) ? raw.restaurant : {};
  const customer = isRecord(raw.customer) ? raw.customer : {};

  // §3: снимок способов оплаты на точке. Если поле есть — сохраняем как есть;
  // для legacy PICKUP без поля восстанавливаем из ресторана, иначе безопасный
  // fallback ["CASH","CARD"]; для не-PICKUP — [].
  let pickupPaymentMethodsSnapshot: ("CASH" | "CARD")[];
  if (Array.isArray(raw.pickupPaymentMethodsSnapshot)) {
    pickupPaymentMethodsSnapshot = normalizePickupMethods(
      raw.pickupPaymentMethodsSnapshot,
    );
  } else if (deliveryMode === "PICKUP") {
    const rest = restaurants.find((r) => r.id === str(restaurant.id, ""));
    const fromRestaurant = normalizePickupMethods(rest?.pickupPaymentMethods);
    pickupPaymentMethodsSnapshot =
      fromRestaurant.length > 0 ? fromRestaurant : ["CASH", "CARD"];
  } else {
    pickupPaymentMethodsSnapshot = [];
  }
  const pickupPaidWith =
    raw.pickupPaidWith === "CASH" || raw.pickupPaidWith === "CARD"
      ? raw.pickupPaidWith
      : null;
  // §3: структурированный признак невыкупа сохраняется только при корректном ISO;
  // иначе (legacy/битые данные) — null. Не выводим из истории или статуса.
  const pickupNoShowAt =
    typeof raw.pickupNoShowAt === "string" &&
    !Number.isNaN(Date.parse(raw.pickupNoShowAt))
      ? raw.pickupNoShowAt
      : null;

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
        : raw.paymentMethod === "CASH_TO_RESTAURANT_COURIER"
          ? "CASH_TO_RESTAURANT_COURIER"
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
    kitchenStartedAt: normalizeKitchenStartedAt(raw, safeStatus),
    cancellationReason:
      typeof raw.cancellationReason === "string"
        ? raw.cancellationReason
        : null,
    pickupCode: typeof raw.pickupCode === "string" ? raw.pickupCode : null,
    pickupCodeUsed: raw.pickupCodeUsed === true,
    pickupPaymentMethodsSnapshot,
    pickupPaidWith,
    pickupNoShowAt,
    // Назначение водителя: у старых заказов отсутствует → null (без пересчётов).
    assignedDriverId:
      typeof raw.assignedDriverId === "string" ? raw.assignedDriverId : null,
    driverAssignedAt:
      typeof raw.driverAssignedAt === "string" ? raw.driverAssignedAt : null,
    items: Array.isArray(raw.items) ? raw.items.map(normalizeOrderItem) : [],
    financials: normalizeFinancials(raw.financials, deliveryMode, {
      pickupPaidWith,
      // Самовывоз фактически оплачен/выдан: клиент уже платил на точке, и
      // отсутствие сохранённого способа оплаты — повод для REVIEW, а не для
      // догадок о канале.
      pickupSettled:
        deliveryMode === "PICKUP" &&
        (safeStatus === "PICKED_UP" ||
          raw.paymentStatus === "PAID_AT_RESTAURANT" ||
          raw.pickupCodeUsed === true),
    }),
    history,
    etaAdjustments,
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

/**
 * Приведение legacy delivery `paymentMethods` к современной ONLINE-only модели.
 * Старая schema v2 допускала `QR`/`CASH`; сейчас доставка только `ONLINE`
 * (в прототипе CASH disabled). Любой исходный набор — содержащий `ONLINE`,
 * старые `QR`/`CASH`, пустой, отсутствующий или с неизвестными значениями —
 * нормализуется в `["ONLINE"]`. Иначе после миграции v2 ресторан теряет
 * `ONLINE` и выпадает из современного flow (см. selectors.ts и client/cart:
 * `paymentMethods.includes("ONLINE")`). `CASH` сознательно НЕ переносится как
 * способ оплаты доставки. Способы оплаты на точке (`pickupPaymentMethods`)
 * нормализуются отдельно и здесь не затрагиваются.
 */
function normalizeDeliveryPaymentMethods(): PrototypeState["restaurants"][number]["paymentMethods"] {
  return ["ONLINE"];
}

/** Нормализация графика одного дня; недостающее — безопасный стандарт. */
function normalizeDaySchedule(value: unknown): DaySchedule {
  const raw = isRecord(value) ? value : {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    openTime: str(raw.openTime, "09:00"),
    closeTime: str(raw.closeTime, "22:00"),
  };
}

/**
 * Нормализация недельного графика. Legacy-ресторан БЕЗ графика работал всегда
 * (часов ещё не было) — миграция сохраняет доступность, задавая круглосуточный
 * график, а не новый безопасный «закрыто по умолчанию» (§6). Уже настроенные
 * часы не перезаписываются: присутствующие дни сохраняются, отсутствующие
 * дозаполняются рабочим стандартом. Существующие рестораны не удаляются.
 */
function normalizeWeeklySchedule(value: unknown): WeeklySchedule {
  if (!isRecord(value)) {
    return createAlwaysOpenDemoSchedule();
  }
  return WEEKDAY_ORDER.reduce((schedule, day) => {
    schedule[day] =
      value[day] !== undefined
        ? normalizeDaySchedule(value[day])
        : { enabled: true, openTime: "09:00", closeTime: "22:00" };
    return schedule;
  }, {} as WeeklySchedule);
}

/** Валидная операционная пауза из хранилища, иначе null (§5, §12). */
function normalizeOperationalPause(
  value: unknown,
): PrototypeState["restaurants"][number]["orderPause"] {
  if (!isRecord(value)) return null;
  const mode = value.mode;
  if (mode !== "UNTIL_TIME" && mode !== "UNTIL_NEXT_OPEN" && mode !== "MANUAL") {
    return null;
  }
  const startedBy = value.startedBy;
  return {
    startedAt: str(value.startedAt, new Date(0).toISOString()),
    reason: str(value.reason, ""),
    mode,
    resumeAt: typeof value.resumeAt === "string" ? value.resumeAt : null,
    startedBy:
      startedBy === "ADMIN" || startedBy === "SYSTEM" ? startedBy : "RESTAURANT",
  };
}

/** Дозаполняет операционные поля блюда (§12): availabilityPause по умолчанию null. */
function normalizeMenuItem(
  value: unknown,
): PrototypeState["menuItems"][number] {
  const raw = isRecord(value) ? value : {};
  const item = raw as unknown as PrototypeState["menuItems"][number];
  // Варианты старых блюд не имеют порции — получают null, остальное как есть.
  const variants = Array.isArray(raw.variants)
    ? (raw.variants as MenuItemVariant[]).map((variant) => ({
        ...variant,
        portion: normalizeMenuPortion(
          (variant as unknown as Record<string, unknown>).portion,
        ),
      }))
    : undefined;
  return {
    ...item,
    // Старое available сохраняется как есть (в т.ч. ручная недоступность false).
    availabilityPause: normalizeOperationalPause(raw.availabilityPause),
    // Категория необязательна: пустая строка и пробелы — это «без категории».
    category: normalizeOptionalCategory(raw.category),
    // Старые блюда не имеют фотографии и порции.
    imageMediaId:
      typeof raw.imageMediaId === "string" && raw.imageMediaId.trim()
        ? raw.imageMediaId.trim()
        : null,
    portion: normalizeMenuPortion(raw.portion),
    ...(variants ? { variants } : {}),
  };
}

/** Один вариант заявки из сохранённого состояния. */
function normalizeSubmissionVariant(
  value: unknown,
): MenuItemSubmissionVariant {
  const raw = isRecord(value) ? value : {};
  return {
    id: str(raw.id, ""),
    name: str(raw.name, ""),
    priceDeltaCents: num(raw.priceDeltaCents, 0),
    isDefault: raw.isDefault === true,
    portion: normalizeMenuPortion(raw.portion),
  };
}

/** Запись истории решений по заявке. */
function normalizeSubmissionReviewEntry(
  value: unknown,
): MenuItemSubmissionReviewEntry {
  const raw = isRecord(value) ? value : {};
  const action = raw.action;
  return {
    id: str(raw.id, ""),
    occurredAt: str(raw.occurredAt, new Date(0).toISOString()),
    action:
      action === "APPROVED" || action === "REJECTED" || action === "SUBMITTED"
        ? action
        : "SUBMITTED",
    by: raw.by === "ADMIN" ? "ADMIN" : "RESTAURANT",
    reason: typeof raw.reason === "string" ? raw.reason : null,
  };
}

/** Заявка на новое блюдо из сохранённого состояния. */
function normalizeMenuItemSubmission(value: unknown): MenuItemSubmission {
  const raw = isRecord(value) ? value : {};
  const status = raw.status;
  return {
    id: str(raw.id, ""),
    restaurantId: str(raw.restaurantId, ""),
    status:
      status === "PENDING_REVIEW" ||
      status === "APPROVED" ||
      status === "REJECTED"
        ? status
        : "DRAFT",
    name: str(raw.name, ""),
    description: str(raw.description, ""),
    priceCents: typeof raw.priceCents === "number" ? raw.priceCents : null,
    currencyCode: "USD",
    category: normalizeOptionalCategory(raw.category),
    imageMediaId:
      typeof raw.imageMediaId === "string" && raw.imageMediaId.trim()
        ? raw.imageMediaId.trim()
        : null,
    portion: normalizeMenuPortion(raw.portion),
    variants: Array.isArray(raw.variants)
      ? raw.variants.map(normalizeSubmissionVariant)
      : [],
    createdAt: str(raw.createdAt, new Date(0).toISOString()),
    updatedAt: str(raw.updatedAt, new Date(0).toISOString()),
    submittedAt: typeof raw.submittedAt === "string" ? raw.submittedAt : null,
    reviewedAt: typeof raw.reviewedAt === "string" ? raw.reviewedAt : null,
    reviewedBy: raw.reviewedBy === "ADMIN" ? "ADMIN" : null,
    rejectionReason:
      typeof raw.rejectionReason === "string" ? raw.rejectionReason : null,
    publishedMenuItemId:
      typeof raw.publishedMenuItemId === "string"
        ? raw.publishedMenuItemId
        : null,
    reviewHistory: Array.isArray(raw.reviewHistory)
      ? raw.reviewHistory.map(normalizeSubmissionReviewEntry)
      : [],
  };
}

/** Записи операционного журнала; у старых состояний — пустой массив (§18). */
function normalizeOperationalEvents(
  value: unknown,
): PrototypeState["operationalEvents"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.restaurantId !== "string"
    ) {
      return [];
    }
    return [entry as unknown as PrototypeState["operationalEvents"][number]];
  });
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
    paymentMethods: normalizeDeliveryPaymentMethods(),
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
    // Новые контактные/операционные поля: у старых ресторанов отсутствуют →
    // безопасные пустые значения; ресторан при этом сохраняется, не удаляется.
    publicPhone: str(raw.publicPhone, ""),
    contactPersonName: str(raw.contactPersonName, ""),
    contactPersonRole: str(raw.contactPersonRole, ""),
    contactPhone: str(raw.contactPhone, ""),
    contactEmail: str(raw.contactEmail, ""),
    contactMessenger: str(raw.contactMessenger, ""),
    emergencyPhone: str(raw.emergencyPhone, ""),
    internalAdminNote: str(raw.internalAdminNote, ""),
    weeklySchedule: normalizeWeeklySchedule(raw.weeklySchedule),
    timeZone: str(raw.timeZone, "Europe/Chisinau"),
    orderPause: normalizeOperationalPause(raw.orderPause),
    // Этап 2 (v6→v7): ресторан без режима или с неизвестным значением → COMBINED.
    orderWorkflowMode:
      raw.orderWorkflowMode === "SPLIT_OPERATOR_KITCHEN"
        ? "SPLIT_OPERATOR_KITCHEN"
        : "COMBINED",
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

/** Нормализация одного водителя: добавляет безопасный статус и телефон. */
function normalizeDriver(value: unknown): PrototypeState["drivers"][number] {
  const raw = isRecord(value) ? value : {};
  const status =
    raw.status === "AVAILABLE" ||
    raw.status === "BUSY" ||
    raw.status === "OFFLINE"
      ? raw.status
      : "OFFLINE"; // безопасный статус для старых водителей
  return {
    id: str(raw.id, ""),
    name: str(raw.name, ""),
    cashEnabled: raw.cashEnabled === true,
    status,
    phone: str(raw.phone, ""),
  };
}

/**
 * Нормализация списка водителей (§6). Если `drivers` — массив, он сохраняется
 * как есть (в т.ч. пустой), водители не удаляются и тестовые не подставляются.
 * Fallback (seed-водители) используется только если поле отсутствует/повреждено
 * (не массив). Seed-водители остаются лишь в свежем default-state прототипа.
 */
function normalizeDrivers(
  value: unknown,
  fallback: PrototypeState["drivers"],
): PrototypeState["drivers"] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value
    .filter((d) => isRecord(d) && typeof d.id === "string")
    .map(normalizeDriver);
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
 * Записи двустороннего журнала расчётов: у состояний до v8 поля нет. Оставляем
 * только валидные по форме записи; недостающие legacy-записи из settlements
 * дозаполняет migrateLegacySettlementsToAccounting в normalizePrototypeState.
 */
function normalizeRestaurantAccountingEntries(
  value: unknown,
): PrototypeState["restaurantAccountingEntries"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.orderId !== "string" ||
      typeof entry.amountCents !== "number"
    ) {
      return [];
    }
    return [
      entry as unknown as PrototypeState["restaurantAccountingEntries"][number],
    ];
  });
}

/**
 * Append-only аудит закрытия обязательств: у состояний до v9 поля нет — пустой
 * массив. Оставляем только валидные по форме события; повторная нормализация
 * идемпотентна (события не дублируются и не пересоздаются).
 */
function normalizeRestaurantAccountingResolutionEvents(
  value: unknown,
): PrototypeState["restaurantAccountingResolutionEvents"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((event) => {
    if (
      !isRecord(event) ||
      typeof event.id !== "string" ||
      typeof event.accountingEntryId !== "string"
    ) {
      return [];
    }
    return [
      event as unknown as PrototypeState["restaurantAccountingResolutionEvents"][number],
    ];
  });
}

/**
 * Запросы на отмену: у старых состояний поля нет — используем пустой массив
 * (§9). Не ломает старые snapshots и не входит в финансовые данные.
 */
function normalizeCancellationRequests(
  value: unknown,
): PrototypeState["cancellationRequests"] {
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
    return [entry as unknown as PrototypeState["cancellationRequests"][number]];
  });
}

/**
 * Приведение уже v6-совместимого состояния к корректному виду. Сохраняет
 * пользовательские и админские данные (рестораны, меню, акции, тарифы, зоны,
 * настройки, корзину, заказы, ledger) и лишь мягко дозаполняет недостающие поля.
 */
const SEED_PIZZA_PROMO_ID = "promo-restaurant-2-pizza";
const NEW_SEED_PROMO_NAME = "Каждая 4-я пицца — бесплатно";
/** Прежние стандартные названия seed-акции Direct (только их и заменяем). */
const OLD_SEED_PROMO_NAMES = new Set([
  "Закажи 3 пиццы и получи четвёртую бесплатно",
  "Купи 3 пиццы и получи четвёртую в подарок",
  "3 пиццы + четвёртая в подарок",
  "3 пиццы + 4-я в подарок",
  "3 + 1 в подарок",
]);

/**
 * Точечная нормализация названия seed-акции «3+1» (§3). Обновляет title/
 * displayText на новое стандартное имя ТОЛЬКО у акции `promo-restaurant-2-pizza`
 * и ТОЛЬКО если сейчас там одно из прежних стандартных значений Direct. Имя,
 * заданное администратором вручную, не перезаписывается. Снимки заказов не
 * затрагиваются (нормализуются только акции, не история заказов).
 */
function normalizeSeedPromotion(
  promotion: PrototypeState["promotions"][number],
): PrototypeState["promotions"][number] {
  if (promotion.id !== SEED_PIZZA_PROMO_ID) {
    return promotion;
  }
  const title = OLD_SEED_PROMO_NAMES.has(promotion.title)
    ? NEW_SEED_PROMO_NAME
    : promotion.title;
  const displayText = OLD_SEED_PROMO_NAMES.has(promotion.displayText)
    ? NEW_SEED_PROMO_NAME
    : promotion.displayText;
  if (title === promotion.title && displayText === promotion.displayText) {
    return promotion;
  }
  return { ...promotion, title, displayText };
}

export function normalizePrototypeState(
  state: PrototypeState,
): PrototypeState {
  const defaults = createDefaultState();
  // §3: рестораны нормализуем до заказов, чтобы восстановить снимок способов
  // оплаты legacy PICKUP-заказов из актуального списка ресторана.
  const restaurants = Array.isArray(state.restaurants)
    ? state.restaurants.map(normalizeRestaurantV5)
    : defaults.restaurants;
  const normalizedSettlements = normalizeSettlements(state.settlements);
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
    restaurants,
    menuItems: Array.isArray(state.menuItems)
      ? state.menuItems.map(normalizeMenuItem)
      : defaults.menuItems,
    // Старое состояние заявок не имеет — безопасный пустой список.
    menuItemSubmissions: Array.isArray(state.menuItemSubmissions)
      ? state.menuItemSubmissions.map(normalizeMenuItemSubmission)
      : [],
    promotions: Array.isArray(state.promotions)
      ? state.promotions.map(normalizeSeedPromotion)
      : defaults.promotions,
    customer: normalizeCustomer(state.customer, defaults.customer),
    drivers: normalizeDrivers(state.drivers, defaults.drivers),
    cart: normalizeCart(state.cart, defaults.cart),
    orders: Array.isArray(state.orders)
      ? state.orders.map((order) => normalizeOrder(order, restaurants))
      : [],
    settlements: normalizedSettlements,
    // Двусторонний журнал: сохраняем валидные записи и идемпотентно мигрируем
    // существующие комиссионные settlements (без дублей по legacySettlementId).
    restaurantAccountingEntries: migrateLegacySettlementsToAccounting(
      normalizeRestaurantAccountingEntries(state.restaurantAccountingEntries),
      normalizedSettlements,
    ),
    restaurantAccountingResolutionEvents:
      normalizeRestaurantAccountingResolutionEvents(
        state.restaurantAccountingResolutionEvents,
      ),
    cancellationRequests: normalizeCancellationRequests(
      state.cancellationRequests,
    ),
    operationalEvents: normalizeOperationalEvents(state.operationalEvents),
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
  const upgradeRestaurants =
    Array.isArray(source.restaurants) && source.restaurants.length > 0
      ? (source.restaurants as unknown as PrototypeState["restaurants"])
      : defaults.restaurants;
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
    restaurants: upgradeRestaurants,
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
      ? (source.orders as unknown[]).map((order) =>
          normalizeOrder(order, upgradeRestaurants),
        )
      : [],
    settlements: [],
    cancellationRequests: normalizeCancellationRequests(
      source.cancellationRequests,
    ),
    operationalEvents: normalizeOperationalEvents(source.operationalEvents),
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

/**
 * Исправление 3/5: выбор авторитетного базового состояния для сериализованной
 * мутации. Перед мутацией вкладка перечитывает persisted state и работает от
 * самого свежего (localStorage может быть новее локального stateRef, если другая
 * вкладка уже успела сохранить свою мутацию). Чистая функция — тестируется без
 * React. Production-backend позднее заменит это серверной транзакцией и
 * optimistic concurrency по ревизии.
 */
export function selectLatestPrototypeState(
  localState: PrototypeState,
  storedState: PrototypeState | null,
): PrototypeState {
  if (!storedState) return localState;
  return isNewerState(storedState, localState) ? storedState : localState;
}

/** Русская инфраструктурная ошибка неудачного сохранения транзакции. */
export const PROTOTYPE_SAVE_FAILED_ERROR =
  "Не удалось сохранить действие. Обновите страницу и повторите.";

/**
 * Исправление 2: подтверждение state-only мутации. `ok:false` — действие
 * отклонено (инфраструктура или домен); `ok:true, changed:true` — новая версия
 * состояния записана; `ok:true, changed:false` — допустимый идемпотентный no-op
 * (состояние уже в требуемом виде, revision не изменилась).
 */
export interface MutationAck {
  ok: boolean;
  error: string | null;
  changed: boolean;
}

/**
 * Исправление 1.2: безопасное чтение сырого значения localStorage. Перехватывает
 * SecurityError, недоступность localStorage и любые другие исключения чтения —
 * гидратация приложения не должна падать из-за хранилища.
 */
export function safeReadStoredValue(key: string): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Безопасное чтение и разбор v7-состояния (битый JSON/ошибка чтения → null). */
export function safeReadStoredState(key: string): PrototypeState | null {
  return parseStoredState(safeReadStoredValue(key));
}

/** Безопасное чтение самого свежего доступного legacy-состояния (v6…v2). */
export function readLegacyPrototypeState(): PrototypeState | null {
  return (
    parseLegacyStoredState(
      safeReadStoredValue(LEGACY_V6_PROTOTYPE_STORAGE_KEY),
    ) ??
    parseLegacyStoredState(
      safeReadStoredValue(LEGACY_V5_PROTOTYPE_STORAGE_KEY),
    ) ??
    parseLegacyStoredState(
      safeReadStoredValue(LEGACY_V4_PROTOTYPE_STORAGE_KEY),
    ) ??
    parseLegacyStoredState(
      safeReadStoredValue(LEGACY_V3_PROTOTYPE_STORAGE_KEY),
    ) ??
    parseLegacyStoredState(safeReadStoredValue(LEGACY_V2_PROTOTYPE_STORAGE_KEY))
  );
}

export interface BootstrapResolution {
  /** Состояние, которое вкладка должна принять локально. */
  state: PrototypeState;
  /** Нужно ли записать выбранное состояние в v7 (только при отсутствии v7). */
  shouldPersist: boolean;
}

/**
 * Исправление 1.1: чистое решение bootstrap. Вызывается под Web Lock с ЗАНОВО
 * прочитанными значениями (никаких snapshot'ов до lock):
 * 1) существующий валидный v7 авторитетен — legacy НЕ записывается, v7
 *    принимается локально только если он свежее текущего локального состояния
 *    (например, уже принятого из BroadcastChannel);
 * 2) без v7 выбирается самое свежее из legacy и локального состояния; пока
 *    локальное — нетронутый initial default, приоритет у legacy (у старых
 *    версий revision мог отсутствовать и парситься как 0);
 * 3) без v7 и без legacy ничего не записывается.
 */
export function resolveBootstrapState({
  freshV7State,
  legacyState,
  localState,
  localIsInitial,
}: {
  freshV7State: PrototypeState | null;
  legacyState: PrototypeState | null;
  localState: PrototypeState;
  localIsInitial: boolean;
}): BootstrapResolution {
  if (freshV7State) {
    return {
      state: isNewerState(freshV7State, localState) ? freshV7State : localState,
      shouldPersist: false,
    };
  }
  if (legacyState) {
    const preferLegacy =
      localIsInitial || isNewerState(legacyState, localState);
    return {
      state: preferLegacy ? legacyState : localState,
      shouldPersist: true,
    };
  }
  return { state: localState, shouldPersist: false };
}

/** Русская fail-closed ошибка при недоступном Web Locks API. */
export const SAFE_TAB_SYNC_UNAVAILABLE_ERROR =
  "Безопасная синхронизация вкладок недоступна в этом браузере.";

export interface SerializedMutationOutcome<T> {
  /** Состояние, которое вкладка должна принять локально (rebase либо результат). */
  nextState: PrototypeState;
  /** Была ли записана новая версия состояния (persist выполнен успешно). */
  committed: boolean;
  /** Доменный результат мутации. */
  result: T;
}

/**
 * Чистое ядро сериализованной транзакции (Исправления 1–3). Порядок commit:
 * 1) выбрать свежий base (local vs persisted); 2) выполнить чистую мутацию;
 * 3) если state не изменился — ничего не записывать (revision не растёт);
 * 4) иначе СНАЧАЛА persist (может бросить — тогда транзакция НЕ успешна и
 * вызывающий не должен принимать неподтверждённый state), ЗАТЕМ рассылка;
 * ошибка broadcast ПОСЛЕ успешного persist транзакцию не откатывает — другие
 * вкладки получат событие storage. Тестируется без React и navigator.locks.
 */
export function executeSerializedPrototypeMutation<T>({
  localState,
  storedState,
  mutation,
  persist,
  broadcast,
}: {
  localState: PrototypeState;
  storedState: PrototypeState | null;
  mutation: (baseState: PrototypeState) => { state: PrototypeState; result: T };
  persist: (state: PrototypeState) => void;
  broadcast?: (state: PrototypeState) => void;
}): SerializedMutationOutcome<T> {
  const baseState = selectLatestPrototypeState(localState, storedState);
  const action = mutation(baseState);
  if (action.state === baseState) {
    // No-op мутация: не записываем и не увеличиваем revision; вкладка при этом
    // принимает rebased base (он мог быть свежее локального).
    return { nextState: baseState, committed: false, result: action.result };
  }
  // Сначала persist: если запись бросила — исключение уходит вызывающему,
  // stateRef остаётся на подтверждённом состоянии, успех не объявляется.
  persist(action.state);
  try {
    broadcast?.(action.state);
  } catch {
    // Рассылка после успешной записи не критична: событие storage догонит.
  }
  return { nextState: action.state, committed: true, result: action.result };
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
