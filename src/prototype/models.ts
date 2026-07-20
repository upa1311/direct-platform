import type {
  FulfillmentChoice,
  RestaurantDeliveryProvider,
  RestaurantDeliverySettings,
} from "./pricing-engine";

export const PROTOTYPE_SCHEMA_VERSION = 9 as const;

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

/** Кто кому должен по обязательству двустороннего журнала расчётов. */
export type RestaurantAccountingDirection =
  | "RESTAURANT_OWES_DIRECT"
  | "DIRECT_OWES_RESTAURANT";

/** Природа обязательства: комиссия Direct или выплата ресторану. */
export type RestaurantAccountingType = "PLATFORM_COMMISSION" | "RESTAURANT_PAYOUT";

/** Жизненный статус обязательства (взаимозачёт/выплаты пока не выполняются). */
export type RestaurantAccountingStatus = "OPEN" | "SETTLED" | "WAIVED";

/** Источник обязательства: снимок заказа или миграция старого settlement. */
export type RestaurantAccountingSource =
  | "ORDER_FINANCIAL_SNAPSHOT"
  | "LEGACY_COMMISSION_SETTLEMENT";

/**
 * Запись полного ДВУСТОРОННЕГО журнала расчётов ресторана. В отличие от
 * SettlementEntry (только комиссия «ресторан должен Direct»), фиксирует обе
 * стороны: и долг ресторана перед Direct, и долг Direct перед рестораном. Суммы
 * берутся ТОЛЬКО из неизменяемого order.financials и не пересчитываются.
 */
export interface RestaurantAccountingEntry {
  id: string;
  orderId: string;
  restaurantId: string;
  direction: RestaurantAccountingDirection;
  type: RestaurantAccountingType;
  amountCents: number;
  currencyCode: CurrencyCode;
  status: RestaurantAccountingStatus;
  /** Момент признания — реальный completedAt заказа, не время вызова. */
  recognizedAt: string;
  settledAt: string | null;
  source: RestaurantAccountingSource;
  /** id исходного SettlementEntry для мигрированных записей, иначе null. */
  legacySettlementId: string | null;
}

/**
 * Append-only аудит закрытия обязательства администратором Direct. Фиксирует
 * решение (исполнено/списано) — реального движения денег система не выполняет.
 * На одну accounting entry существует не более одного успешного события.
 */
export interface RestaurantAccountingResolutionEvent {
  id: string;
  accountingEntryId: string;
  restaurantId: string;
  previousStatus: "OPEN";
  nextStatus: "SETTLED" | "WAIVED";
  occurredAt: string;
  actor: "ADMIN";
  note: string;
  /** Внешняя ссылка (банковская операция/кассовый документ/сверка) либо null. */
  externalReference: string | null;
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

/** Как задан срок операционной паузы приёма/доступности. */
export type OperationalPauseMode = "UNTIL_TIME" | "UNTIL_NEXT_OPEN" | "MANUAL";

/** Кто выполнил операционное действие. */
export type OperationalActor = "RESTAURANT" | "ADMIN" | "SYSTEM";

/**
 * Операционная пауза приёма заказов ресторана или доступности блюда. Отдельное
 * состояние, НЕ связанное с publication status. Для MANUAL resumeAt = null.
 */
export interface OperationalPause {
  startedAt: string;
  reason: string;
  mode: OperationalPauseMode;
  resumeAt: string | null;
  startedBy: OperationalActor;
}

export type OperationalEventAction =
  | "RESTAURANT_PAUSED"
  | "RESTAURANT_RESUMED"
  | "MENU_ITEM_UNAVAILABLE"
  | "MENU_ITEM_AVAILABLE";

/** Запись операционного журнала (пауза/возобновление ресторана и блюд). */
export interface OperationalEvent {
  id: string;
  occurredAt: string;
  actor: OperationalActor;
  action: OperationalEventAction;
  restaurantId: string;
  menuItemId: string | null;
  reason: string;
  resumeAt: string | null;
  /**
   * Реальная рабочая роль ресторана, выполнившая действие: меню ведут и кухня,
   * и оператор, и общий экран, поэтому операторское действие не должно
   * записываться как кухонное. Старые события без поля продолжают работать.
   */
  restaurantWorkspaceRole?: RestaurantWorkspaceRole;
}

/**
 * Режим организации работы ресторана с заказами (Этап 1). Меняет только рабочий
 * экран/роли/права, НЕ создаёт второй заказ и не меняет жизненный цикл.
 * COMBINED — один общий экран; SPLIT_OPERATOR_KITCHEN — оператор и кухня отдельно.
 */
export type RestaurantOrderWorkflowMode = "COMBINED" | "SPLIT_OPERATOR_KITCHEN";

/** Рабочая роль внутри ресторана — фиксируется в аудите, клиенту не видна. */
export type RestaurantWorkspaceRole = "COMBINED" | "OPERATOR" | "KITCHEN";

/** Действия ресторанной workspace для матрицы прав (Этап 3). */
export type RestaurantWorkspaceAction =
  | "ACCEPT_ORDER"
  | "SET_INITIAL_ETA"
  | "ADJUST_ETA"
  /** Кухня подтверждает фактическое начало приготовления (только SPLIT). */
  | "START_KITCHEN_PREPARATION"
  | "MARK_READY"
  | "REPORT_PREPARATION_PROBLEM"
  | "RESOLVE_PREPARATION_PROBLEM"
  | "MANAGE_CUSTOMER"
  | "MANAGE_CANCELLATION"
  | "MANAGE_DRIVER"
  | "HANDOFF_ORDER"
  | "PAUSE_RESTAURANT"
  /** Временное включение/выключение уже существующих блюд. */
  | "CHANGE_MENU_AVAILABILITY"
  /** Создание черновика нового блюда, его правка и отправка на модерацию. */
  | "MANAGE_MENU_CATALOG";

/** Категории данных заказа для матрицы видимости (Этап 3). */
export type RestaurantWorkspaceData =
  | "ORDER_NUMBER"
  | "FULFILLMENT"
  | "ORDER_ITEMS"
  | "COOKING_COMMENTS"
  | "CUSTOMER_NAME"
  | "CUSTOMER_PHONE"
  | "FULL_ADDRESS"
  | "PAYMENT_STATUS"
  | "EXPECTED_READY_AT"
  | "ETA_ADJUSTMENTS"
  | "PREPARATION_PROBLEMS"
  | "DRIVER_DETAILS"
  | "PICKUP_HANDOFF"
  | "FINANCIAL_BREAKDOWN";

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
  /** Операционная пауза приёма заказов (отдельно от publication status). */
  orderPause: OperationalPause | null;
  /**
   * Режим работы с заказами (Этап 1). Legacy/новые/seed → «COMBINED». Меняет
   * только экран/роли/права, не заказы и не жизненный цикл.
   */
  orderWorkflowMode: RestaurantOrderWorkflowMode;
}

/** Единица измерения порции. Свободная строка источником истины не является. */
export type MenuPortionUnit = "G" | "ML" | "PCS" | "CM";

/** Структурированная порция блюда или варианта; null — порция не указана. */
export interface MenuPortion {
  value: number;
  unit: MenuPortionUnit;
}

export interface MenuItemVariant {
  id: string;
  name: string;
  priceDeltaCents: number;
  available: boolean;
  isDefault: boolean;
  /** Порция варианта; null — используется базовая порция блюда. */
  portion: MenuPortion | null;
}

export interface MenuItem {
  id: string;
  restaurantId: string;
  /**
   * Категорию ресторан придумывает сам; глобального справочника Direct нет.
   * null — категория не указана (пустая строка нормализуется в null).
   */
  category: string | null;
  name: string;
  description: string;
  priceCents: number;
  currencyCode: CurrencyCode;
  available: boolean;
  /** Ссылка на media-объект фотографии; null — фотографии нет. */
  imageMediaId: string | null;
  /** Базовая порция блюда; null — не указана. */
  portion: MenuPortion | null;
  /** Варианты размеров. Пусто/undefined — товар без размеров (старый flow). */
  variants?: MenuItemVariant[];
  /** Операционная временная недоступность блюда (кухня). null — нет паузы. */
  availabilityPause?: OperationalPause | null;
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
  /**
   * Снимок порции на момент заказа: порция выбранного варианта, иначе базовая
   * порция блюда, иначе null. Будущее изменение граммовки в меню не меняет уже
   * оформленные заказы.
   */
  portionSnapshot: MenuPortion | null;
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
  type: "STATUS" | "PAYMENT" | "ETA" | "PREPARATION_PROBLEM" | "KITCHEN_START";
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  message: string;
  /**
   * Рабочая роль ресторана, выполнившая действие (Этап 1). Только для внутреннего
   * аудита; клиенту не показывается. Старые события без поля продолжают работать.
   */
  restaurantWorkspaceRole?: RestaurantWorkspaceRole;
  /**
   * Идентификатор проблемы приготовления (для type === "PREPARATION_PROBLEM").
   * OPEN-событие кухни и RESOLVED-событие оператора несут один и тот же id, что
   * связывает сообщение и его решение. Старые события без поля считаются OPEN,
   * а их id проблемы — это event.id (см. getOpenPreparationProblem).
   */
  preparationProblemId?: string;
  /**
   * Состояние проблемы приготовления. OPEN — кухня сообщила, ожидается решение;
   * RESOLVED — оператор/общий экран подтвердил, что заказ продолжается. Отсутствие
   * поля у старого события трактуется как OPEN.
   */
  preparationProblemState?: "OPEN" | "RESOLVED";
}

/**
 * Структурированная запись корректировки ожидаемого времени готовности (§2).
 * Хранит ISO старого и нового ETA — не только человекочитаемый текст.
 */
export interface OrderEtaAdjustment {
  id: string;
  occurredAt: string;
  actor: "RESTAURANT" | "ADMIN";
  previousExpectedReadyAt: string;
  nextExpectedReadyAt: string;
  reason: string;
  /** Рабочая роль ресторана (Этап 1); внутренний аудит, клиенту не видна. */
  restaurantWorkspaceRole?: RestaurantWorkspaceRole;
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
  /**
   * Момент фактического подтверждения кухней начала приготовления. В COMBINED
   * ставится автоматически при переходе в PREPARING. В SPLIT_OPERATOR_KITCHEN
   * остаётся null до действия кухни «Начать готовить»: пока null и статус
   * PREPARING — кухня получает повторяющийся сигнал, а готовность заблокирована.
   * Единственный источник истины ожидания кухни (не UI-state и не localStorage).
   */
  kitchenStartedAt: string | null;
  cancellationReason: string | null;
  /** Одноразовый код выдачи самовывоза (только для PICKUP). */
  pickupCode: string | null;
  pickupCodeUsed: boolean;
  /**
   * Исторический снимок способов оплаты на точке на момент заказа (§3).
   * Для не-PICKUP — []. Изменение настроек ресторана его не меняет.
   */
  pickupPaymentMethodsSnapshot: PickupPaymentMethod[];
  /** Чем клиент фактически заплатил при выдаче (§4). null до выдачи/невыкупа. */
  pickupPaidWith: PickupPaymentMethod | null;
  /**
   * Структурированный признак невыкупа самовывоза: ISO-момент, когда заказ был
   * закрыт как невыкупленный через markPickupNoShow. null для всех прочих отмен
   * (в т.ч. обычной adminCancelOrder из READY_FOR_PICKUP). Единственный источник
   * истины для «это невыкуп», не история и не статусный переход.
   */
  pickupNoShowAt: string | null;
  /** Назначенный водитель Direct (только PLATFORM_DRIVER). */
  assignedDriverId: string | null;
  /** Время назначения водителя. */
  driverAssignedAt: string | null;
  items: OrderItemSnapshot[];
  financials: FinancialSnapshot;
  history: OrderHistoryEvent[];
  /** Аудит корректировок ожидаемого времени готовности (кухня, §2). */
  etaAdjustments: OrderEtaAdjustment[];
}

/**
 * Жизненный цикл заявки ресторана на новое блюдо. Ресторан не добавляет объект
 * в опубликованный menuItems напрямую: DRAFT → PENDING_REVIEW → APPROVED, либо
 * REJECTED → правка → снова PENDING_REVIEW.
 */
export type MenuItemSubmissionStatus =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED";

/** Вариант внутри заявки (ещё не опубликован). */
export interface MenuItemSubmissionVariant {
  id: string;
  name: string;
  priceDeltaCents: number;
  isDefault: boolean;
  portion: MenuPortion | null;
}

/** Что произошло с заявкой: лёгкий встроенный аудит, без второй event-системы. */
export type MenuItemSubmissionReviewAction =
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED";

export interface MenuItemSubmissionReviewEntry {
  id: string;
  occurredAt: string;
  action: MenuItemSubmissionReviewAction;
  by: "RESTAURANT" | "ADMIN";
  /** Причина отклонения; для прочих действий null. */
  reason: string | null;
}

/**
 * Заявка на новое блюдо. Живёт отдельно от опубликованного меню: до APPROVED
 * блюда физически нет в menuItems, поэтому клиент его не видит нигде.
 */
export interface MenuItemSubmission {
  id: string;
  restaurantId: string;
  status: MenuItemSubmissionStatus;
  name: string;
  description: string;
  priceCents: number | null;
  currencyCode: CurrencyCode;
  category: string | null;
  imageMediaId: string | null;
  portion: MenuPortion | null;
  variants: MenuItemSubmissionVariant[];
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: "ADMIN" | null;
  /** Актуальная причина отклонения; очищается при повторной отправке. */
  rejectionReason: string | null;
  publishedMenuItemId: string | null;
  /** История решений: прошлые причины остаются здесь, а не в rejectionReason. */
  reviewHistory: MenuItemSubmissionReviewEntry[];
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
  /**
   * Кто инициировал запрос. Отсутствие поля (старые сохранённые состояния)
   * трактуется как "CLIENT" — совместимость без повышения schemaVersion.
   */
  requestedBy?: "CLIENT" | "RESTAURANT";
  /** Рабочая роль ресторана, создавшая запрос (только для ресторанных запросов). */
  restaurantWorkspaceRole?: RestaurantWorkspaceRole;
  /** Проблема приготовления, из-за которой ресторан запросил отмену. */
  preparationProblemId?: string;
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
  /** Заявки на новые блюда. Клиентские селекторы их не читают. */
  menuItemSubmissions: MenuItemSubmission[];
  promotions: Promotion[];
  customer: CustomerProfile;
  drivers: DriverProfile[];
  cart: Cart;
  orders: Order[];
  settlements: SettlementEntry[];
  /** Полный двусторонний журнал расчётов ресторана (комиссии и выплаты). */
  restaurantAccountingEntries: RestaurantAccountingEntry[];
  /** Append-only аудит административного закрытия обязательств. */
  restaurantAccountingResolutionEvents: RestaurantAccountingResolutionEvent[];
  cancellationRequests: CancellationRequest[];
  operationalEvents: OperationalEvent[];
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
