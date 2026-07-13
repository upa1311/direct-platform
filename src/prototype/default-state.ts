import {
  PROTOTYPE_SCHEMA_VERSION,
  type Cart,
  type MenuItem,
  type PrototypeState,
  type Restaurant,
  type TariffMatrix,
  type Zone,
} from "./models";

const INITIAL_TIMESTAMP = "2026-07-12T00:00:00.000Z";

export const TEST_RESTAURANT_ID = "restaurant-1";

export const defaultZones: Zone[] = [
  { id: "zone-1", name: "Зона 1", streets: ["Тестовая улица 1"] },
  { id: "zone-2", name: "Зона 2", streets: ["Тестовая улица 2"] },
  { id: "zone-3", name: "Зона 3", streets: ["Тестовая улица 3"] },
  { id: "zone-4", name: "Зона 4", streets: ["Тестовая улица 4"] },
];

export function createDefaultTariffs(): TariffMatrix {
  return {
    "zone-1": {
      "zone-1": 200,
      "zone-2": 300,
      "zone-3": 400,
      "zone-4": 500,
    },
    "zone-2": {
      "zone-1": 300,
      "zone-2": 200,
      "zone-3": 300,
      "zone-4": 400,
    },
    "zone-3": {
      "zone-1": 400,
      "zone-2": 300,
      "zone-3": 200,
      "zone-4": 300,
    },
    "zone-4": {
      "zone-1": 500,
      "zone-2": 400,
      "zone-3": 300,
      "zone-4": 200,
    },
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
    deliveryModes: ["PLATFORM_DRIVER", "RESTAURANT_DELIVERY", "PICKUP"],
    paymentMethods: ["ONLINE", "CASH"],
    defaultPreparationMinutes: 25,
    recommendationRank: 1,
  },
  {
    id: "restaurant-2",
    name: "Ресторан 2",
    description: "Опубликованный тестовый ресторан с быстрым меню.",
    address: "Бендеры · тестовый адрес 2",
    zoneId: "zone-2",
    status: "PUBLISHED",
    isAcceptingOrders: false,
    deliveryModes: ["PLATFORM_DRIVER", "PICKUP"],
    paymentMethods: ["ONLINE", "CASH"],
    defaultPreparationMinutes: 20,
    recommendationRank: 3,
  },
  {
    id: "restaurant-3",
    name: "Ресторан 3",
    description: "Тестовая карточка собственной доставки ресторана.",
    address: "Бендеры · тестовый адрес 3",
    zoneId: "zone-3",
    status: "PUBLISHED",
    isAcceptingOrders: false,
    deliveryModes: ["PLATFORM_DRIVER", "RESTAURANT_DELIVERY"],
    paymentMethods: ["ONLINE"],
    defaultPreparationMinutes: 30,
    recommendationRank: 2,
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
  },
];

export function getDefaultRecommendationRank(restaurantId: string): number {
  return (
    defaultRestaurants.find((restaurant) => restaurant.id === restaurantId)
      ?.recommendationRank ?? Number.MAX_SAFE_INTEGER
  );
}

const defaultMenuItems: MenuItem[] = [
  {
    id: "restaurant-1-item-1",
    restaurantId: "restaurant-1",
    category: "Популярное",
    name: "Позиция 1",
    description: "Горячее блюдо из тестового меню.",
    priceCents: 520,
    currencyCode: "USD",
    available: true,
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
    category: "Основное",
    name: "Позиция 3",
    description: "Блюдо Ресторана 2.",
    priceCents: 640,
    currencyCode: "USD",
    available: true,
  },
  {
    id: "restaurant-2-item-2",
    restaurantId: "restaurant-2",
    category: "Десерты",
    name: "Позиция 4",
    description: "Десерт Ресторана 2.",
    priceCents: 290,
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

export function createEmptyCart(address?: Cart["address"]): Cart {
  return {
    restaurantId: null,
    items: [],
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "ONLINE",
    address: address ? { ...address } : {
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
    })),
    menuItems: defaultMenuItems.map((item) => ({ ...item })),
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
    },
    drivers: [],
    cart: createEmptyCart(),
    orders: [],
  };
}
