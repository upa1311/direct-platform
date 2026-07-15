import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { createDefaultState } from "./default-state.ts";
import {
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
  updateCartAddress,
  updateRestaurant,
} from "./actions.ts";
import { calculateCartPricing, getRestaurant } from "./selectors.ts";
import { upgradeToV6 } from "./prototype-store.ts";
import type { PrototypeState } from "./models.ts";

function cartWithPizzas(count: number): PrototypeState {
  let s = createDefaultState();
  for (let i = 0; i < count; i += 1) {
    s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  }
  return s;
}

// --- Прогресс акции (§4, §12.1–5) ------------------------------------------

test("прогресс акции не исчезает после первой бесплатной пиццы (4 пиццы → остаток 4)", () => {
  const pricing = calculateCartPricing(cartWithPizzas(4));
  assert.equal(pricing.promotionFreeUnitCount, 1);
  assert.notEqual(pricing.promotionUnitsToNextFree, null);
  assert.equal(pricing.promotionUnitsToNextFree, 4);
});

test("прогресс акции: 5 пицц → остаток 3", () => {
  assert.equal(calculateCartPricing(cartWithPizzas(5)).promotionUnitsToNextFree, 3);
});

test("прогресс акции: 6 пицц → остаток 2", () => {
  assert.equal(calculateCartPricing(cartWithPizzas(6)).promotionUnitsToNextFree, 2);
});

test("прогресс акции: 7 пицц → остаток 1", () => {
  assert.equal(calculateCartPricing(cartWithPizzas(7)).promotionUnitsToNextFree, 1);
});

test("прогресс акции: 8 пицц → две бесплатные, прогресс заново с 4", () => {
  const pricing = calculateCartPricing(cartWithPizzas(8));
  assert.equal(pricing.promotionFreeUnitCount, 2);
  assert.equal(pricing.promotionUnitsToNextFree, 4);
});

// --- Самовывоз = 0 (§3, §12.6) ---------------------------------------------

test("самовывоз в итогах имеет стоимость доставки 0", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  assert.equal(calculateCartPricing(s).deliveryFeeCents, 0);
});

// --- Миграция и контакты (§9, §12.10–11, §13) ------------------------------

test("миграция: старый ресторан получает пустые контакты и стандартный график", () => {
  const legacy = {
    schemaVersion: 6,
    revision: 1,
    nextOrderNumber: 10,
    restaurants: [
      {
        id: "restaurant-1",
        name: "Старый ресторан",
        description: "Мигрируемый",
        address: "Бендеры",
        zoneId: "zone-1",
        status: "PUBLISHED",
        isAcceptingOrders: true,
        deliveryModes: ["PLATFORM_DRIVER", "PICKUP"],
        paymentMethods: ["ONLINE"],
        defaultPreparationMinutes: 25,
        deliveryProvider: "DIRECT",
        pickupEnabled: true,
        pickupPaymentMethods: ["CASH", "CARD"],
        commissionRateBps: 1500,
        restaurantDeliverySettings: null,
      },
    ],
    orders: [],
  };
  const migrated = upgradeToV6(legacy);
  const r = migrated.restaurants.find((x) => x.id === "restaurant-1");
  assert.ok(r, "ресторан должен сохраниться после миграции");
  // Пустые контактные поля.
  assert.equal(r.publicPhone, "");
  assert.equal(r.contactPersonName, "");
  assert.equal(r.contactPersonRole, "");
  assert.equal(r.contactPhone, "");
  assert.equal(r.contactEmail, "");
  assert.equal(r.contactMessenger, "");
  assert.equal(r.emergencyPhone, "");
  assert.equal(r.internalAdminNote, "");
  // Безопасный стандартный график на все 7 дней.
  assert.equal(Object.keys(r.weeklySchedule).length, 7);
  assert.equal(r.weeklySchedule.monday.enabled, true);
  assert.equal(r.weeklySchedule.monday.openTime, "00:00");
  assert.equal(r.weeklySchedule.sunday.closeTime, "23:59");
  // Название и настройки сохранились.
  assert.equal(r.name, "Старый ресторан");
});

test("контакты и график сохраняются после обновления ресторана", () => {
  const s = createDefaultState();
  const base = getRestaurant(s, "restaurant-1");
  assert.ok(base);
  const result = updateRestaurant(s, "restaurant-1", {
    publicPhone: "+373 552 00001",
    contactPersonName: "Новый контакт",
    contactPersonRole: "бухгалтер",
    contactEmail: "new@example.md",
    weeklySchedule: {
      ...base.weeklySchedule,
      sunday: { enabled: false, openTime: "", closeTime: "" },
    },
  });
  assert.equal(result.result.ok, true);
  const r = getRestaurant(result.state, "restaurant-1");
  assert.ok(r);
  assert.equal(r.publicPhone, "+373 552 00001");
  assert.equal(r.contactPersonName, "Новый контакт");
  assert.equal(r.contactPersonRole, "бухгалтер");
  assert.equal(r.contactEmail, "new@example.md");
  assert.equal(r.weeklySchedule.sunday.enabled, false);
  // Прочие настройки ресторана не потеряны.
  assert.equal(r.commissionRateBps, base.commissionRateBps);
  assert.equal(r.deliveryProvider, base.deliveryProvider);
});

test("изменение контактов ресторана не пересчитывает существующие заказы", () => {
  let s = createDefaultState();
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  s = created.state;
  const orderId = created.result.orderId as string;
  const before = JSON.stringify(s.orders.find((o) => o.id === orderId));

  const result = updateRestaurant(s, "restaurant-2", {
    publicPhone: "+373 999",
    internalAdminNote: "Изменённая заметка",
    contactPersonName: "Другой человек",
  });
  assert.equal(result.result.ok, true);
  const after = JSON.stringify(
    result.state.orders.find((o) => o.id === orderId),
  );
  assert.equal(after, before, "заказ (в т.ч. financials) не должен измениться");
});

// --- Русификация admin и разделение внутренних данных (§5, §10, §12.9,12) ---

const CLIENT_UI_FILES = [
  "src/app/client/page.tsx",
  "src/app/client/catalog/page.tsx",
  "src/app/client/restaurants/[restaurantId]/page.tsx",
  "src/app/client/cart/page.tsx",
  "src/app/client/orders/page.tsx",
  "src/app/client/orders/[orderId]/page.tsx",
];

const ADMIN_UI_FILES = [
  "src/app/admin/page.tsx",
  "src/app/admin/orders/page.tsx",
  "src/app/admin/restaurants/page.tsx",
  "src/app/admin/settlements/page.tsx",
  "src/app/admin/menu/page.tsx",
  "src/app/admin/drivers/page.tsx",
  "src/app/admin/zones/page.tsx",
];

test("внутренние контакты ресторана не используются в клиентском интерфейсе", () => {
  const internalFields = [
    "contactPersonName",
    "contactPersonRole",
    "contactPhone",
    "contactEmail",
    "contactMessenger",
    "emergencyPhone",
    "internalAdminNote",
  ];
  for (const file of CLIENT_UI_FILES) {
    const content = readFileSync(file, "utf8");
    for (const field of internalFields) {
      assert.equal(
        content.includes(field),
        false,
        `Внутреннее поле ${field} не должно использоваться в ${file}`,
      );
    }
  }
});

test("в видимом admin UI отсутствует слово ledger", () => {
  for (const file of ADMIN_UI_FILES) {
    const content = readFileSync(file, "utf8");
    assert.equal(
      /ledger/i.test(content),
      false,
      `Слово ledger не должно встречаться в ${file}`,
    );
  }
});
