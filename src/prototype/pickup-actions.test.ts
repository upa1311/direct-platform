import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  completePickupAtRestaurant,
  completePickupWithCode,
  createOrderFromCart,
  createRestaurant,
  markOrderReady,
  markPickupNoShow,
  setCartFulfillmentChoice,
  updateRestaurant,
  type RestaurantFormInput,
} from "./actions.ts";
import { upgradeToV6 } from "./prototype-store.ts";
import { getPickupNoShowEligibleAtIso } from "./selectors.ts";
import type { PrototypeState } from "./models.ts";

function makeReadyPickupOrder(): {
  state: PrototypeState;
  orderId: string;
  code: string;
} {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  s = created.state;
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(s, orderId, 20);
  s = markOrderReady(s, orderId);
  const order = s.orders.find((o) => o.id === orderId);
  assert.ok(order);
  assert.equal(order.status, "READY_FOR_PICKUP");
  // Новый самовывоз кода не имеет: подтверждением служит фактическая оплата.
  assert.equal(order.pickupCode, null);
  return { state: s, orderId, code: "" };
}

test("самовывоз: заказ не запускает онлайн-оплату", () => {
  const { state, orderId } = makeReadyPickupOrder();
  const order = state.orders.find((o) => o.id === orderId);
  assert.equal(order?.paymentMethod, "PAY_AT_RESTAURANT");
  // Не проходил через AWAITING_PAYMENT: статус оплаты — при получении.
  assert.equal(order?.paymentStatus, "DUE_AT_PICKUP");
  assert.equal(state.settlements.length, 0);
});

test("неготовый заказ не завершается и не создаёт settlement", () => {
  const { state, orderId } = makeReadyPickupOrder();
  // Код больше не проверяется; блокирует именно неподходящий статус.
  const preparing = {
    ...state,
    orders: state.orders.map((o) =>
      o.id === orderId ? { ...o, status: "PREPARING" as const } : o,
    ),
  };
  const result = completePickupAtRestaurant(preparing, orderId, "CASH");
  assert.equal(result.result.ok, false);
  assert.equal(result.state, preparing);
  assert.equal(result.state.settlements.length, 0);
});

test("фиксация оплаты завершает заказ и создаёт одну ledger-запись", () => {
  const { state, orderId } = makeReadyPickupOrder();
  const result = completePickupAtRestaurant(state, orderId, "CASH");
  assert.equal(result.result.ok, true);
  const order = result.state.orders.find((o) => o.id === orderId);
  assert.equal(order?.status, "PICKED_UP");
  assert.equal(order?.paymentStatus, "PAID_AT_RESTAURANT");
  assert.equal(order?.pickupPaidWith, "CASH");
  assert.equal(result.state.settlements.length, 1);
  const entry = result.state.settlements[0];
  assert.equal(entry.orderId, orderId);
  assert.equal(entry.type, "PICKUP_COMMISSION");
  assert.equal(entry.status, "PENDING");
  // 2 пиццы Маргарита $8 → еда $16 → комиссия 15% = $2.40.
  assert.equal(entry.amountCents, 240);
});

test("повторное использование кода не создаёт вторую ledger-запись", () => {
  const { state, orderId, code } = makeReadyPickupOrder();
  const first = completePickupWithCode(state, orderId, code, "CASH");
  const second = completePickupWithCode(first.state, orderId, code, "CASH");
  assert.equal(second.result.ok, false);
  assert.equal(second.state.settlements.length, 1);
});

test("невыкуп: без комиссии и увеличивает noShowPickupCount", () => {
  const { state, orderId } = makeReadyPickupOrder();
  const before = state.customer.noShowPickupCount;
  const order0 = state.orders.find((o) => o.id === orderId);
  assert.ok(order0);
  const eligibleAt = getPickupNoShowEligibleAtIso(order0);
  assert.ok(eligibleAt);
  const next = markPickupNoShow(
    state,
    orderId,
    "Клиент не пришёл",
    "RESTAURANT",
    eligibleAt,
  );
  assert.equal(next.result.ok, true);
  const order = next.state.orders.find((o) => o.id === orderId);
  assert.equal(order?.status, "CANCELED");
  assert.equal(next.state.settlements.length, 0);
  assert.equal(next.state.customer.noShowPickupCount, before + 1);
});

test("расчётная комиссия начисляется только после выдачи", () => {
  const { state, orderId, code } = makeReadyPickupOrder();
  // До выдачи ledger пуст, хотя расчётная комиссия есть в снимке.
  assert.equal(state.settlements.length, 0);
  const order = state.orders.find((o) => o.id === orderId);
  assert.equal(order?.financials.restaurantCommissionCents, 240);
  const done = completePickupWithCode(state, orderId, code, "CASH");
  assert.equal(done.state.settlements.length, 1);
});

test("нельзя сохранить включённый самовывоз без способа оплаты", () => {
  const state = createDefaultState();
  const update = updateRestaurant(state, "restaurant-1", {
    pickupEnabled: true,
    pickupPaymentMethods: [],
  });
  assert.equal(update.result.ok, false);
  assert.ok(update.result.error);
  // Ресторан не изменился.
  const r = update.state.restaurants.find((x) => x.id === "restaurant-1");
  assert.ok((r?.pickupPaymentMethods.length ?? 0) > 0);

  const input: RestaurantFormInput = {
    name: "Без оплаты",
    description: "d",
    address: "a",
    zoneId: "zone-1",
    deliveryProvider: "DIRECT",
    commissionRateBps: 1500,
    defaultPreparationMinutes: 25,
    pickupEnabled: true,
    status: "PUBLISHED",
    isAcceptingOrders: true,
    restaurantDeliverySettings: null,
    pickupPaymentMethods: [],
  };
  const create = createRestaurant(state, input);
  assert.equal(create.result.restaurantId, null);
  assert.ok(create.result.error);
});

test("миграция v6 сохраняет рестораны, меню, акции, зоны и тарифы", () => {
  const base = createDefaultState();
  const source = {
    ...base,
    schemaVersion: 5,
    restaurants: base.restaurants.map((r) =>
      r.id === "restaurant-1"
        ? {
            ...r,
            name: "Переименованный ресторан",
            commissionRateBps: 2000,
            pickupPaymentMethods: ["CARD"],
          }
        : r,
    ),
    menuItems: base.menuItems.map((m) =>
      m.id === "restaurant-1-item-1"
        ? {
            ...m,
            priceCents: 999,
            available: false,
            variants: [
              {
                id: "size-standard",
                name: "Стандартная",
                priceDeltaCents: 0,
                available: true,
                isDefault: true,
              },
              {
                id: "size-large",
                name: "Огромная",
                priceDeltaCents: 500,
                available: true,
                isDefault: false,
              },
            ],
          }
        : m,
    ),
    promotions: base.promotions.map((p) => ({
      ...p,
      title: "Моя изменённая акция",
      buyQuantity: 2,
    })),
    zones: base.zones.map((z) =>
      z.id === "zone-1" ? { ...z, streets: [...z.streets, "Новая улица"] } : z,
    ),
    tariffs: {
      ...base.tariffs,
      "zone-1": { ...base.tariffs["zone-1"], "zone-1": 777 },
    },
  };

  const migrated = upgradeToV6(source);

  const r1 = migrated.restaurants.find((r) => r.id === "restaurant-1");
  assert.equal(r1?.name, "Переименованный ресторан");
  assert.equal(r1?.commissionRateBps, 2000);
  assert.deepEqual(r1?.pickupPaymentMethods, ["CARD"]);

  const item = migrated.menuItems.find((m) => m.id === "restaurant-1-item-1");
  assert.equal(item?.priceCents, 999);
  assert.equal(item?.available, false);
  assert.equal(item?.variants?.[1]?.name, "Огромная");
  assert.equal(item?.variants?.[1]?.priceDeltaCents, 500);

  assert.equal(migrated.promotions[0]?.title, "Моя изменённая акция");
  assert.equal(migrated.promotions[0]?.buyQuantity, 2);

  const zone1 = migrated.zones.find((z) => z.id === "zone-1");
  assert.ok(zone1?.streets.includes("Новая улица"));
  assert.equal(migrated.tariffs["zone-1"]["zone-1"], 777);
});

test("миграция: старые pickup-заказы не получают начисления", () => {
  const base = createDefaultState();
  const oldPickupOrder = {
    id: "order-500",
    publicNumber: "DIR-0500",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    customer: { id: "customer-1", name: "К", phone: "x" },
    restaurant: {
      id: "restaurant-2",
      name: "Ресторан 2",
      address: "a",
      zoneId: "zone-2",
    },
    address: null,
    deliveryMode: "PICKUP",
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
    paidAt: null,
    status: "PICKED_UP",
    preparationMinutes: 20,
    expectedReadyAt: null,
    cancellationReason: null,
    items: [],
    financials: { foodSubtotalCents: 800, restaurantCommissionCents: 120 },
    history: [],
  };
  const source = { ...base, schemaVersion: 5, orders: [oldPickupOrder] };
  const migrated = upgradeToV6(source);
  assert.equal(migrated.orders.length, 1);
  assert.equal(migrated.orders[0].deliveryMode, "PICKUP");
  assert.equal(migrated.settlements.length, 0);
  // Снимок старого заказа не пересчитан.
  assert.equal(migrated.orders[0].financials.foodSubtotalCents, 800);
});
