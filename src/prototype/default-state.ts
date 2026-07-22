import {
  PROTOTYPE_SCHEMA_VERSION,
  WEEKDAY_ORDER,
  type Cart,
  type MenuItem,
  type MenuItemVariant,
  type Promotion,
  type PrototypeState,
  type Restaurant,
  type TariffMatrix,
  type WeeklySchedule,
  type Zone,
} from "./models";

const INITIAL_TIMESTAMP = "2026-07-12T00:00:00.000Z";

export const TEST_RESTAURANT_ID = "restaurant-1";

/**
 * Безопасный график нового/ненастроенного ресторана (§6): все дни ЗАКРЫТЫ до
 * ручной настройки. Так новый ресторан не начнёт случайно принимать ночные
 * заказы, пока администратор не задал реальные часы. НЕ круглосуточно.
 */
export function createDefaultWeeklySchedule(): WeeklySchedule {
  return WEEKDAY_ORDER.reduce((schedule, day) => {
    schedule[day] = { enabled: false, openTime: "", closeTime: "" };
    return schedule;
  }, {} as WeeklySchedule);
}

/**
 * Круглосуточный график (00:00–23:59 все семь дней). Используется ЯВНО только для
 * seed/demo-ресторанов 1–3, чтобы демо стабильно принимало заказы. Не является
 * дефолтом нового ресторана.
 */
export function createAlwaysOpenDemoSchedule(): WeeklySchedule {
  return WEEKDAY_ORDER.reduce((schedule, day) => {
    schedule[day] = { enabled: true, openTime: "00:00", closeTime: "23:59" };
    return schedule;
  }, {} as WeeklySchedule);
}

/** Глубокая копия недельного графика. */
export function cloneWeeklySchedule(source: WeeklySchedule): WeeklySchedule {
  return WEEKDAY_ORDER.reduce((schedule, day) => {
    schedule[day] = { ...source[day] };
    return schedule;
  }, {} as WeeklySchedule);
}

/** Новые контактные поля ресторана; по умолчанию пустые. */
type RestaurantExtras = Pick<
  Restaurant,
  | "publicPhone"
  | "contactPersonName"
  | "contactPersonRole"
  | "contactPhone"
  | "contactEmail"
  | "contactMessenger"
  | "emergencyPhone"
  | "internalAdminNote"
  | "weeklySchedule"
  | "timeZone"
  | "orderPause"
  | "orderWorkflowMode"
  | "financialCollectionMode"
>;

/** Часовой пояс по умолчанию (Бендеры / Приднестровье). */
export const DEFAULT_RESTAURANT_TIME_ZONE = "Europe/Chisinau";

export function createRestaurantExtras(
  overrides: Partial<RestaurantExtras> = {},
): RestaurantExtras {
  // Коалесценция каждого поля: undefined в overrides не затирает безопасный
  // дефолт (удобно для необязательных полей формы). График всегда клонируется.
  return {
    publicPhone: overrides.publicPhone ?? "",
    contactPersonName: overrides.contactPersonName ?? "",
    contactPersonRole: overrides.contactPersonRole ?? "",
    contactPhone: overrides.contactPhone ?? "",
    contactEmail: overrides.contactEmail ?? "",
    contactMessenger: overrides.contactMessenger ?? "",
    emergencyPhone: overrides.emergencyPhone ?? "",
    internalAdminNote: overrides.internalAdminNote ?? "",
    weeklySchedule: overrides.weeklySchedule
      ? cloneWeeklySchedule(overrides.weeklySchedule)
      : createDefaultWeeklySchedule(),
    timeZone: overrides.timeZone || DEFAULT_RESTAURANT_TIME_ZONE,
    orderPause: overrides.orderPause ?? null,
    // Этап 1: по умолчанию единый общий экран.
    orderWorkflowMode: overrides.orderWorkflowMode ?? "COMBINED",
    // v13: по умолчанию прежнее поведение платформы — Direct получает
    // онлайн-платежи своей доставки, ресторан — самовывоз и своего курьера.
    financialCollectionMode:
      overrides.financialCollectionMode ?? "MIXED_COLLECTION",
  };
}

/** Стандартный набор размеров для тестовых блюд: базовая и +$2.00. */
export function createSizeVariants(): MenuItemVariant[] {
  return [
    {
      id: "size-standard",
      name: "Стандартная",
      priceDeltaCents: 0,
      available: true,
      isDefault: true,
      // Порция у демо-вариантов не задана: поле необязательное.
      portion: null,
    },
    {
      id: "size-large",
      name: "Большая",
      priceDeltaCents: 200,
      available: true,
      isDefault: false,
      portion: null,
    },
  ];
}

export const defaultZones: Zone[] = [
  { id: "zone-1", name: "Зона 1", streets: ["Тестовая улица 1"] },
  { id: "zone-2", name: "Зона 2", streets: ["Тестовая улица 2"] },
  { id: "zone-3", name: "Зона 3", streets: ["Тестовая улица 3"] },
  { id: "zone-4", name: "Зона 4", streets: ["Тестовая улица 4"] },
];

export function createDefaultTariffs(): TariffMatrix {
  return {
    "zone-1": { "zone-1": 200, "zone-2": 300, "zone-3": 400, "zone-4": 500 },
    "zone-2": { "zone-1": 300, "zone-2": 200, "zone-3": 300, "zone-4": 400 },
    "zone-3": { "zone-1": 400, "zone-2": 300, "zone-3": 200, "zone-4": 300 },
    "zone-4": { "zone-1": 500, "zone-2": 400, "zone-3": 300, "zone-4": 200 },
  };
}

const defaultRestaurants: Restaurant[] = [
  {
    id: "restaurant-1",
    name: "Ресторан 1",
    description: "Тестовое меню для знакомства с сервисом Direct.",
    address: "Бендеры · тестовый адрес 1",
    zoneId: "zone-1",
    status: "PUBLISHED",
    isAcceptingOrders: true,
    deliveryModes: ["PLATFORM_DRIVER", "PICKUP"],
    paymentMethods: ["ONLINE"],
    defaultPreparationMinutes: 25,
    recommendationRank: 1,
    deliveryProvider: "DIRECT",
    pickupEnabled: true,
    pickupPaymentMethods: ["CASH", "CARD"],
    pickupCommissionRateBps: 1500,
    pickupPrepaymentThresholdCents: null,
    commissionRateBps: 1500,
    restaurantDeliverySettings: null,
    ...createRestaurantExtras({
      publicPhone: "+373 552 10001",
      contactPersonName: "Алексей Иванов",
      contactPersonRole: "владелец",
      contactPhone: "+373 777 10001",
      contactEmail: "rest1@example.md",
      internalAdminNote: "Звонить управляющему после 10:00.",
      // Демо-ресторан 1–3 (§6): круглосуточный график явно, не через дефолт.
      weeklySchedule: createAlwaysOpenDemoSchedule(),
    }),
  },
  {
    id: "restaurant-2",
    name: "Ресторан 2",
    description: "Опубликованный тестовый ресторан с быстрым меню.",
    address: "Бендеры · тестовый адрес 2",
    zoneId: "zone-2",
    status: "PUBLISHED",
    isAcceptingOrders: true,
    deliveryModes: ["PLATFORM_DRIVER", "PICKUP"],
    paymentMethods: ["ONLINE"],
    defaultPreparationMinutes: 20,
    recommendationRank: 3,
    deliveryProvider: "DIRECT",
    pickupEnabled: true,
    pickupPaymentMethods: ["CASH", "CARD"],
    pickupCommissionRateBps: 1500,
    pickupPrepaymentThresholdCents: null,
    commissionRateBps: 1500,
    restaurantDeliverySettings: null,
    ...createRestaurantExtras({
      publicPhone: "+373 552 20002",
      contactPersonName: "Мария Сидорова",
      contactPersonRole: "администратор",
      contactPhone: "+373 777 20002",
      contactEmail: "rest2@example.md",
      contactMessenger: "Telegram @rest2",
      weeklySchedule: createAlwaysOpenDemoSchedule(),
    }),
  },
  {
    id: "restaurant-3",
    name: "Ресторан 3",
    description: "Тестовая карточка собственной доставки ресторана.",
    address: "Бендеры · тестовый адрес 3",
    zoneId: "zone-3",
    status: "PUBLISHED",
    isAcceptingOrders: true,
    deliveryModes: ["RESTAURANT_DELIVERY", "PICKUP"],
    paymentMethods: ["ONLINE"],
    defaultPreparationMinutes: 30,
    recommendationRank: 2,
    deliveryProvider: "RESTAURANT",
    pickupEnabled: true,
    pickupPaymentMethods: ["CASH", "CARD"],
    pickupCommissionRateBps: 1500,
    pickupPrepaymentThresholdCents: null,
    commissionRateBps: 700,
    restaurantDeliverySettings: {
      minimumOrderCents: 1000,
      freeDeliveryThresholdCents: 2500,
      servedZoneIds: ["zone-1", "zone-2", "zone-3", "zone-4"],
      zoneFeesCents: {
        "zone-1": 300,
        "zone-2": 350,
        "zone-3": 400,
        "zone-4": 450,
      },
    },
    ...createRestaurantExtras({
      publicPhone: "+373 552 30003",
      contactPersonName: "Ирина Петрова",
      contactPersonRole: "управляющий",
      contactPhone: "+373 777 30003",
      contactEmail: "rest3@example.md",
      contactMessenger: "Telegram @rest3",
      emergencyPhone: "+373 777 90003",
      internalAdminNote:
        "По выплатам связываться только с бухгалтером.",
      weeklySchedule: createAlwaysOpenDemoSchedule(),
    }),
  },
  {
    id: "restaurant-4",
    name: "Ресторан 4",
    description: "Черновик ресторана, видимый только администратору.",
    address: "Бендеры · тестовый адрес 4",
    zoneId: "zone-4",
    status: "DRAFT",
    isAcceptingOrders: false,
    deliveryModes: ["PLATFORM_DRIVER"],
    paymentMethods: ["ONLINE"],
    defaultPreparationMinutes: 25,
    recommendationRank: 4,
    deliveryProvider: "DIRECT",
    pickupEnabled: true,
    pickupPaymentMethods: ["CASH", "CARD"],
    pickupCommissionRateBps: 1500,
    pickupPrepaymentThresholdCents: null,
    commissionRateBps: 1500,
    restaurantDeliverySettings: null,
    ...createRestaurantExtras(),
  },
  {
    id: "restaurant-5",
    name: "Ресторан 5",
    description: "Скрытый тестовый ресторан для проверки статусов.",
    address: "Бендеры · тестовый адрес 5",
    zoneId: "zone-2",
    status: "HIDDEN",
    isAcceptingOrders: false,
    deliveryModes: ["PLATFORM_DRIVER", "PICKUP"],
    paymentMethods: ["ONLINE"],
    defaultPreparationMinutes: 35,
    recommendationRank: 5,
    deliveryProvider: "DIRECT",
    pickupEnabled: true,
    pickupPaymentMethods: ["CASH", "CARD"],
    pickupCommissionRateBps: 1500,
    pickupPrepaymentThresholdCents: null,
    commissionRateBps: 1500,
    restaurantDeliverySettings: null,
    ...createRestaurantExtras(),
  },
];

export function getDefaultRecommendationRank(restaurantId: string): number {
  return (
    defaultRestaurants.find((restaurant) => restaurant.id === restaurantId)
      ?.recommendationRank ?? Number.MAX_SAFE_INTEGER
  );
}

/**
 * Демо-меню задаётся без новых необязательных полей, а фотография и порция
 * добавляются ниже единообразно: у всех seed-блюд их нет.
 */
type SeedMenuItem = Omit<MenuItem, "imageMediaId" | "portion">;

const defaultMenuItemSeeds: SeedMenuItem[] = [
  {
    id: "restaurant-1-item-1",
    restaurantId: "restaurant-1",
    category: "Популярное",
    name: "Позиция 1",
    description: "Горячее блюдо из тестового меню.",
    priceCents: 520,
    currencyCode: "USD",
    available: true,
    variants: createSizeVariants(),
  },
  {
    id: "restaurant-1-item-2",
    restaurantId: "restaurant-1",
    category: "Популярное",
    name: "Позиция 2",
    description: "Основное блюдо с кратким описанием.",
    priceCents: 380,
    currencyCode: "USD",
    available: true,
    variants: createSizeVariants(),
  },
  {
    id: "restaurant-1-item-3",
    restaurantId: "restaurant-1",
    category: "Напитки",
    name: "Напиток 1",
    description: "Напиток объёмом 500 мл.",
    priceCents: 180,
    currencyCode: "USD",
    available: false,
  },
  {
    id: "restaurant-2-item-1",
    restaurantId: "restaurant-2",
    category: "Пиццы",
    name: "Пицца Маргарита",
    description: "Тестовая пицца, участвует в акции.",
    priceCents: 800,
    currencyCode: "USD",
    available: true,
    variants: createSizeVariants(),
  },
  {
    id: "restaurant-2-item-2",
    restaurantId: "restaurant-2",
    category: "Пиццы",
    name: "Пицца Пепперони",
    description: "Тестовая пицца, участвует в акции.",
    priceCents: 900,
    currencyCode: "USD",
    available: true,
    variants: createSizeVariants(),
  },
  {
    id: "restaurant-2-item-3",
    restaurantId: "restaurant-2",
    category: "Пиццы",
    name: "Пицца Четыре сыра",
    description: "Тестовая пицца, участвует в акции.",
    priceCents: 1000,
    currencyCode: "USD",
    available: true,
    variants: createSizeVariants(),
  },
  {
    id: "restaurant-2-item-4",
    restaurantId: "restaurant-2",
    category: "Напитки",
    name: "Лимонад 0.5",
    description: "Напиток Ресторана 2, в акции не участвует.",
    priceCents: 200,
    currencyCode: "USD",
    available: true,
  },
  {
    id: "restaurant-3-item-1",
    restaurantId: "restaurant-3",
    category: "Основное",
    name: "Позиция 5",
    description: "Блюдо Ресторана 3.",
    priceCents: 710,
    currencyCode: "USD",
    available: true,
    variants: createSizeVariants(),
  },
  {
    id: "restaurant-3-item-3",
    restaurantId: "restaurant-3",
    category: "Основное",
    name: "Позиция 6",
    description: "Второе блюдо Ресторана 3 с размерами.",
    priceCents: 560,
    currencyCode: "USD",
    available: true,
    variants: createSizeVariants(),
  },
  {
    id: "restaurant-3-item-2",
    restaurantId: "restaurant-3",
    category: "Напитки",
    name: "Напиток 2",
    description: "Напиток Ресторана 3.",
    priceCents: 210,
    currencyCode: "USD",
    available: false,
  },
  {
    id: "restaurant-4-item-1",
    restaurantId: "restaurant-4",
    category: "Основное",
    name: "Черновая позиция",
    description: "Позиция неопубликованного ресторана.",
    priceCents: 450,
    currencyCode: "USD",
    available: false,
  },
  {
    id: "restaurant-5-item-1",
    restaurantId: "restaurant-5",
    category: "Основное",
    name: "Скрытая позиция",
    description: "Позиция скрытого ресторана.",
    priceCents: 500,
    currencyCode: "USD",
    available: false,
  },
];

/** Демо-блюда без фотографии и без указанной порции — оба поля необязательны. */
const defaultMenuItems: MenuItem[] = defaultMenuItemSeeds.map((item) => ({
  ...item,
  imageMediaId: null,
  portion: null,
}));

const defaultPromotions: Promotion[] = [
  {
    id: "promo-restaurant-2-pizza",
    restaurantId: "restaurant-2",
    title: "Каждая 4-я пицца — бесплатно",
    enabled: true,
    type: "BUY_N_GET_M_CHEAPEST_FREE",
    buyQuantity: 3,
    freeQuantity: 1,
    repeat: true,
    eligibleMenuItemIds: [
      "restaurant-2-item-1",
      "restaurant-2-item-2",
      "restaurant-2-item-3",
    ],
    displayText: "Каждая 4-я пицца — бесплатно",
    createdAt: INITIAL_TIMESTAMP,
    updatedAt: INITIAL_TIMESTAMP,
  },
];

function cloneVariants(
  variants: MenuItemVariant[] | undefined,
): MenuItemVariant[] | undefined {
  return variants ? variants.map((variant) => ({ ...variant })) : undefined;
}

export function createEmptyCart(address?: Cart["address"]): Cart {
  return {
    restaurantId: null,
    items: [],
    fulfillmentChoice: "DELIVERY",
    paymentMethod: "ONLINE",
    address: address
      ? { ...address }
      : {
          street: "",
          house: "",
          apartment: "",
          entrance: "",
          floor: "",
          comment: "",
          zoneId: null,
        },
  };
}

export function createDefaultState(): PrototypeState {
  return {
    schemaVersion: PROTOTYPE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: INITIAL_TIMESTAMP,
    nextOrderNumber: 1001,
    platformSettings: {
      currencyCode: "USD",
      restaurantCommissionRateBps: 1500,
      minimumPlatformGrossRevenueCents: 100,
      cashMinimumFoodSubtotalCents: 700,
      platformDriverCashEnabled: false,
    },
    zones: defaultZones.map((zone) => ({
      ...zone,
      streets: [...zone.streets],
    })),
    tariffs: createDefaultTariffs(),
    restaurants: defaultRestaurants.map((restaurant) => ({
      ...restaurant,
      deliveryModes: [...restaurant.deliveryModes],
      paymentMethods: [...restaurant.paymentMethods],
      pickupPaymentMethods: [...restaurant.pickupPaymentMethods],
      weeklySchedule: cloneWeeklySchedule(restaurant.weeklySchedule),
      restaurantDeliverySettings: restaurant.restaurantDeliverySettings
        ? {
            ...restaurant.restaurantDeliverySettings,
            servedZoneIds: [
              ...restaurant.restaurantDeliverySettings.servedZoneIds,
            ],
            zoneFeesCents: {
              ...restaurant.restaurantDeliverySettings.zoneFeesCents,
            },
          }
        : null,
    })),
    menuItems: defaultMenuItems.map((item) => ({
      ...item,
      variants: cloneVariants(item.variants),
    })),
    // Заявок на новые блюда в демо-состоянии нет.
    menuItemSubmissions: [],
    promotions: defaultPromotions.map((promotion) => ({
      ...promotion,
      eligibleMenuItemIds: [...promotion.eligibleMenuItemIds],
    })),
    customer: {
      id: "customer-1",
      name: "Тестовый клиент",
      phone: "+373 000 00 100",
      phoneVerified: true,
      addresses: [
        {
          id: "address-1",
          label: "Тестовый адрес",
          street: "Тестовая улица 1",
          house: "1",
          apartment: "",
          entrance: "",
          floor: "",
          comment: "",
          zoneId: "zone-1",
        },
      ],
      noShowPickupCount: 0,
    },
    // Демо-водители стартуют не в сети и без зоны: зону водитель подтверждает
    // сам, автоматическая «правдоподобная» зона не подставляется. Наличные
    // разрешены только Петру; глобальный platformDriverCashEnabled выключен.
    drivers: [
      {
        id: "driver-1",
        name: "Водитель Пётр",
        cashEnabled: true,
        status: "OFFLINE",
        currentZoneId: null,
        suggestedZoneId: null,
        phone: "+373 777 40001",
      },
      {
        id: "driver-2",
        name: "Водитель Олег",
        cashEnabled: false,
        status: "OFFLINE",
        currentZoneId: null,
        suggestedZoneId: null,
        phone: "+373 777 40002",
      },
      {
        id: "driver-3",
        name: "Водитель Сергей",
        cashEnabled: false,
        status: "OFFLINE",
        currentZoneId: null,
        suggestedZoneId: null,
        phone: "+373 777 40003",
      },
    ],
    // Предложения создаёт доменный reconciliation после загрузки, а не seed.
    driverOffers: [],
    cart: createEmptyCart(),
    orders: [],
    settlements: [],
    restaurantAccountingEntries: [],
    restaurantAccountingResolutionEvents: [],
    restaurantSettlementRecords: [],
    cancellationRequests: [],
    operationalEvents: [],
  };
}
