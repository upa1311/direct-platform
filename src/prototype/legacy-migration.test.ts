import assert from "node:assert/strict";
import { test } from "node:test";

import { canPlacePrototypeOrder } from "./selectors.ts";
import { upgradeToV6 } from "./prototype-store.ts";

/**
 * Собирает legacy-состояние schemaVersion 2 с одним рестораном и одним старым
 * заказом. `paymentMethods` ресторана задаётся аргументом, чтобы проверять
 * разные legacy-наборы (в т.ч. отсутствующий — если передать `undefined`).
 * Остальные v6-поля ресторана намеренно отсутствуют — как в реальном v2 — и
 * должны дозаполниться миграцией, а не заменить ресторан дефолтным.
 */
function makeLegacyV2State(restaurantPaymentMethods: unknown): unknown {
  const restaurant: Record<string, unknown> = {
    id: "legacy-rest-1",
    name: "Легаси ресторан",
    description: "Мигрированный из v2.",
    address: "Бендеры · legacy 1",
    zoneId: "zone-1",
    status: "PUBLISHED",
    isAcceptingOrders: true,
    deliveryModes: ["PLATFORM_DRIVER", "PICKUP"],
    defaultPreparationMinutes: 30,
  };
  if (restaurantPaymentMethods !== undefined) {
    restaurant.paymentMethods = restaurantPaymentMethods;
  }
  return {
    schemaVersion: 2,
    revision: 3,
    nextOrderNumber: 42,
    restaurants: [restaurant],
    orders: [
      {
        id: "legacy-order-1",
        publicNumber: "0001",
        deliveryMode: "PLATFORM_DRIVER",
        paymentMethod: "ONLINE",
        paymentStatus: "PAID",
        status: "DELIVERED",
        restaurant: {
          id: "legacy-rest-1",
          name: "Легаси ресторан",
          address: "Бендеры · legacy 1",
          zoneId: "zone-1",
        },
        items: [],
      },
    ],
  };
}

test("legacy v2 → v6: paymentMethods ['QR','CASH'] → ['ONLINE'], ресторан доступен, settlement не создаётся", () => {
  const migrated = upgradeToV6(makeLegacyV2State(["QR", "CASH"]));

  const restaurant = migrated.restaurants.find((r) => r.id === "legacy-rest-1");
  assert.ok(restaurant, "ресторан должен сохраниться после миграции");

  // Название и настройки ресторана сохранились (ресторан не заменён дефолтным).
  assert.equal(restaurant.name, "Легаси ресторан");
  assert.equal(restaurant.description, "Мигрированный из v2.");
  assert.equal(restaurant.address, "Бендеры · legacy 1");
  assert.equal(restaurant.zoneId, "zone-1");
  assert.deepStrictEqual(restaurant.deliveryModes, [
    "PLATFORM_DRIVER",
    "PICKUP",
  ]);
  assert.equal(restaurant.defaultPreparationMinutes, 30);

  // paymentMethods строго равно ["ONLINE"] — QR/CASH не переносятся.
  assert.deepStrictEqual(restaurant.paymentMethods, ["ONLINE"]);

  // Ресторан остаётся доступным для современного ONLINE flow.
  assert.equal(canPlacePrototypeOrder(restaurant), true);

  // pickupPaymentMethods — отдельные способы оплаты на точке — дозаполнены и
  // НЕ затронуты нормализацией delivery paymentMethods.
  assert.deepStrictEqual(restaurant.pickupPaymentMethods, ["CASH", "CARD"]);

  // Схема поднята до текущей (v8).
  assert.equal(migrated.schemaVersion, 8);
  // Legacy-ресторан получает режим работы по умолчанию (Этап 2).
  assert.equal(migrated.restaurants[0].orderWorkflowMode, "COMBINED");

  // Старым заказам settlement задним числом не начисляется.
  assert.equal(migrated.settlements.length, 0);

  // Старый заказ сохранился, его исторический paymentMethod не изменён.
  const order = migrated.orders.find((o) => o.id === "legacy-order-1");
  assert.ok(order, "старый заказ должен сохраниться");
  assert.equal(order.paymentMethod, "ONLINE");
  assert.equal(order.status, "DELIVERED");
});

test("legacy v2 → v6: отсутствующий paymentMethods → ['ONLINE'] и доступность", () => {
  const migrated = upgradeToV6(makeLegacyV2State(undefined));
  const restaurant = migrated.restaurants.find((r) => r.id === "legacy-rest-1");
  assert.ok(restaurant);
  assert.deepStrictEqual(restaurant.paymentMethods, ["ONLINE"]);
  assert.equal(canPlacePrototypeOrder(restaurant), true);
});

test("legacy v2 → v6: пустой paymentMethods → ['ONLINE'] и доступность", () => {
  const migrated = upgradeToV6(makeLegacyV2State([]));
  const restaurant = migrated.restaurants.find((r) => r.id === "legacy-rest-1");
  assert.ok(restaurant);
  assert.deepStrictEqual(restaurant.paymentMethods, ["ONLINE"]);
  assert.equal(canPlacePrototypeOrder(restaurant), true);
});

test("legacy v2 → v6: неизвестные значения paymentMethods → ['ONLINE']", () => {
  const migrated = upgradeToV6(makeLegacyV2State(["GIFT_CARD", "BONUS"]));
  const restaurant = migrated.restaurants.find((r) => r.id === "legacy-rest-1");
  assert.ok(restaurant);
  assert.deepStrictEqual(restaurant.paymentMethods, ["ONLINE"]);
  assert.equal(canPlacePrototypeOrder(restaurant), true);
});
