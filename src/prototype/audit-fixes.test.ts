import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  adminCancelOrder,
  assignDriverToOrder,
  correctOrderStatus,
  createOrderFromCart,
  createRestaurant,
  getSafeAdminStatusCorrections,
  markOrderArriving,
  markOrderDelivered,
  markOrderDeliveredByDriver,
  markOrderOutForDelivery,
  markOrderReady,
  rejectRestaurantOrder,
  simulateSuccessfulOnlinePayment,
  unassignDriverFromOrder,
  updateCartAddress,
  updateRestaurant,
  type RestaurantFormInput,
} from "./actions.ts";
import {
  getDriverById,
  getEffectiveDeliverySettings,
  getRestaurant,
  isRestaurantOpenNow,
  shouldShowDriverAssignment,
} from "./selectors.ts";
import { normalizePrototypeState, upgradeToV6 } from "./prototype-store.ts";
import {
  WEEKDAY_ORDER,
  type PrototypeState,
  type WeeklySchedule,
} from "./models.ts";

function makePlatformReviewOrder(): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  return { state: created.state, orderId: created.result.orderId as string };
}

function makePlatformPreparing(): { state: PrototypeState; orderId: string } {
  const { state, orderId } = makePlatformReviewOrder();
  let s = acceptRestaurantOrder(state, orderId, 20); // AWAITING_PAYMENT
  s = simulateSuccessfulOnlinePayment(s, orderId); // PREPARING, PAID
  return { state: s, orderId };
}

function makePlatformReady(): { state: PrototypeState; orderId: string } {
  const { state, orderId } = makePlatformPreparing();
  const s = markOrderReady(state, orderId); // READY
  return { state: s, orderId };
}

function makePickupReview(): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart({
    ...s,
    cart: { ...s.cart, fulfillmentChoice: "PICKUP" },
  });
  return { state: created.state, orderId: created.result.orderId as string };
}

function makeRestaurantDeliveryArriving(): {
  state: PrototypeState;
  orderId: string;
} {
  let s = createDefaultState();
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  let st = created.state;
  const orderId = created.result.orderId as string;
  st = acceptRestaurantOrder(st, orderId, 20);
  st = markOrderReady(st, orderId);
  st = markOrderOutForDelivery(st, orderId);
  st = markOrderArriving(st, orderId);
  return { state: st, orderId };
}

function scheduleAllDays(open: string, close: string): WeeklySchedule {
  return WEEKDAY_ORDER.reduce((acc, day) => {
    acc[day] = { enabled: true, openTime: open, closeTime: close };
    return acc;
  }, {} as WeeklySchedule);
}

function baseRestaurant() {
  const r = getRestaurant(createDefaultState(), "restaurant-1");
  assert.ok(r);
  return r;
}

// 1–2: автор принятия
test("принятие из admin записывает actor ADMIN", () => {
  const { state, orderId } = makePlatformReviewOrder();
  const next = acceptRestaurantOrder(state, orderId, 20, "ADMIN");
  const order = next.orders.find((o) => o.id === orderId);
  const last = order?.history.at(-1);
  assert.equal(last?.actor, "ADMIN");
  assert.ok(last?.message.includes("Администратор Direct"));
});

test("принятие из кабинета ресторана записывает actor RESTAURANT", () => {
  const { state, orderId } = makePlatformReviewOrder();
  const next = acceptRestaurantOrder(state, orderId, 20); // default RESTAURANT
  const order = next.orders.find((o) => o.id === orderId);
  assert.equal(order?.history.at(-1)?.actor, "RESTAURANT");
});

// 3: админ-отклонение
test("административное отклонение записывает ADMIN", () => {
  const { state, orderId } = makePlatformReviewOrder();
  const next = rejectRestaurantOrder(state, orderId, "Ресторан закрыт", "ADMIN");
  const order = next.orders.find((o) => o.id === orderId);
  assert.equal(order?.status, "CANCELED");
  assert.equal(order?.history.at(-1)?.actor, "ADMIN");
});

// 4: админ-завершение собственной доставки
test("административное завершение собственной доставки записывает ADMIN", () => {
  const { state, orderId } = makeRestaurantDeliveryArriving();
  const next = markOrderDelivered(state, orderId, "ADMIN");
  const order = next.orders.find((o) => o.id === orderId);
  assert.equal(order?.status, "DELIVERED");
  assert.ok(order?.history.some((e) => e.actor === "ADMIN"));
});

// 5–6: несовместимые статусы
test("PICKUP нельзя перевести в OUT_FOR_DELIVERY исправлением", () => {
  const { state, orderId } = makePickupReview();
  const order = state.orders.find((o) => o.id === orderId)!;
  assert.equal(
    getSafeAdminStatusCorrections(order).includes("OUT_FOR_DELIVERY"),
    false,
  );
  const res = correctOrderStatus(state, orderId, "OUT_FOR_DELIVERY", "тест");
  assert.equal(res.result.ok, false);
});

test("доставку нельзя перевести в READY_FOR_PICKUP исправлением", () => {
  const { state, orderId } = makePlatformReady();
  const order = state.orders.find((o) => o.id === orderId)!;
  assert.equal(
    getSafeAdminStatusCorrections(order).includes("READY_FOR_PICKUP"),
    false,
  );
  const res = correctOrderStatus(state, orderId, "READY_FOR_PICKUP", "тест");
  assert.equal(res.result.ok, false);
});

// 7: generic correction не меняет оплату/settlement
test("исправление статуса не меняет paymentStatus и settlement", () => {
  const { state, orderId } = makePlatformReady();
  const before = state.orders.find((o) => o.id === orderId);
  const res = correctOrderStatus(state, orderId, "PREPARING", "ошибка");
  assert.equal(res.result.ok, true);
  const after = res.state.orders.find((o) => o.id === orderId);
  assert.equal(after?.status, "PREPARING");
  assert.equal(after?.paymentStatus, before?.paymentStatus);
  assert.equal(res.state.settlements.length, state.settlements.length);
});

// 8–9: назначение только после оплаты
test("водителя нельзя назначить до принятия и оплаты", () => {
  const { state, orderId } = makePlatformReviewOrder(); // RESTAURANT_REVIEW, не оплачен
  const res = assignDriverToOrder(state, orderId, "driver-1");
  assert.equal(res.result.ok, false);
  assert.equal(getDriverById(res.state, "driver-1")?.status, "AVAILABLE");
});

test("водителя можно назначить после оплаты", () => {
  const { state, orderId } = makePlatformReady(); // PAID, READY
  const res = assignDriverToOrder(state, orderId, "driver-1");
  assert.equal(res.result.ok, true);
  assert.equal(getDriverById(res.state, "driver-1")?.status, "BUSY");
});

// 10: READY без водителя нельзя в OUT
test("READY без водителя нельзя перевести в OUT_FOR_DELIVERY", () => {
  const { state, orderId } = makePlatformReady();
  const next = markOrderOutForDelivery(state, orderId, "ADMIN");
  assert.equal(
    next.orders.find((o) => o.id === orderId)?.status,
    "READY",
  );
});

// 11: PREPARING нельзя сразу DELIVERED
test("PREPARING нельзя сразу завершить как DELIVERED", () => {
  const { state, orderId } = makePlatformPreparing();
  const assigned = assignDriverToOrder(state, orderId, "driver-1");
  const next = markOrderDeliveredByDriver(assigned.state, orderId);
  assert.equal(
    next.orders.find((o) => o.id === orderId)?.status,
    "PREPARING",
  );
});

// 12: завершение доставки требует назначенного водителя
test("завершение доставки требует назначенного водителя", () => {
  const { state, orderId } = makePlatformReady();
  const assigned = assignDriverToOrder(state, orderId, "driver-1");
  const out = markOrderOutForDelivery(assigned.state, orderId, "ADMIN");
  const removed = unassignDriverFromOrder(out, orderId, "Водитель заболел");
  // Теперь заказ в OUT, но без водителя — завершить нельзя.
  const next = markOrderDeliveredByDriver(removed.state, orderId);
  assert.equal(
    next.orders.find((o) => o.id === orderId)?.status,
    "OUT_FOR_DELIVERY",
  );
});

// 13: отмена освобождает водителя
test("отмена освобождает водителя", () => {
  const { state, orderId } = makePlatformReady();
  const assigned = assignDriverToOrder(state, orderId, "driver-1");
  const canceled = adminCancelOrder(assigned.state, orderId, "Клиент отменил");
  assert.equal(canceled.result.ok, true);
  assert.equal(getDriverById(canceled.state, "driver-1")?.status, "AVAILABLE");
});

// 14: новый ресторан DRAFT и не принимает
test("новый ресторан создаётся DRAFT и не принимает заказы", () => {
  const s = createDefaultState();
  const input: RestaurantFormInput = {
    name: "Новый",
    description: "d",
    address: "",
    zoneId: "zone-1",
    deliveryProvider: "DIRECT",
    financialCollectionMode: "MIXED_COLLECTION",
    commissionRateBps: 1500,
    defaultPreparationMinutes: 25,
    pickupEnabled: true,
    status: "PUBLISHED", // должно игнорироваться
    isAcceptingOrders: true, // должно игнорироваться
    restaurantDeliverySettings: null,
  };
  const res = createRestaurant(s, input);
  const created = res.state.restaurants.find(
    (r) => r.id === res.result.restaurantId,
  );
  assert.ok(created);
  assert.equal(created.status, "DRAFT");
  assert.equal(created.isAcceptingOrders, false);
  assert.equal(created.address, "");
});

// 15: пустой массив drivers остаётся пустым
test("пустой массив drivers остаётся пустым после normalize", () => {
  const s = createDefaultState();
  const withNoDrivers = { ...s, drivers: [] };
  const normalized = normalizePrototypeState(withNoDrivers);
  assert.equal(normalized.drivers.length, 0);
  // Через upgradeToV6 (legacy) — тоже пусто.
  const migrated = upgradeToV6({
    schemaVersion: 6,
    revision: 1,
    nextOrderNumber: 5,
    drivers: [],
    orders: [],
  });
  assert.equal(migrated.drivers.length, 0);
});

// 16: pickupCommissionRateBps сохраняется
test("pickupCommissionRateBps сохраняется", () => {
  const s = createDefaultState();
  const res = updateRestaurant(s, "restaurant-1", {
    pickupCommissionRateBps: 1200,
  });
  assert.equal(
    getRestaurant(res.state, "restaurant-1")?.pickupCommissionRateBps,
    1200,
  );
});

// 17: provider DIRECT показывает матрицу (собственные настройки не действуют)
test("переключение provider на DIRECT отключает собственные настройки", () => {
  const restaurant3 = baseRestaurant();
  // restaurant-3 в дефолте — RESTAURANT со своими настройками; берём его.
  const r3 = getRestaurant(createDefaultState(), "restaurant-3")!;
  assert.ok(getEffectiveDeliverySettings(r3)); // у RESTAURANT — действуют
  const asDirect = { ...r3, deliveryProvider: "DIRECT" as const };
  assert.equal(getEffectiveDeliverySettings(asDirect), null);
  void restaurant3;
});

// 18: часовой пояс ресторана (Europe/Chisinau), не время администратора
test("время ресторана считается в его часовом поясе (Europe/Chisinau)", () => {
  const open0922 = scheduleAllDays("09:00", "22:00");
  const chisinau = {
    ...baseRestaurant(),
    timeZone: "Europe/Chisinau",
    weeklySchedule: open0922,
  };
  const farEast = {
    ...baseRestaurant(),
    timeZone: "Pacific/Kiritimati", // UTC+14
    weeklySchedule: open0922,
  };
  // 2026-07-13T00:00:00Z: в Кишинёве 03:00 (закрыто), на Kiritimati 14:00 (открыто).
  const instant = new Date("2026-07-13T00:00:00Z");
  assert.equal(isRestaurantOpenNow(chisinau, instant), false);
  assert.equal(isRestaurantOpenNow(farEast, instant), true);
  // Обычный дневной интервал: 09:00Z → Кишинёв 12:00 → открыто.
  assert.equal(
    isRestaurantOpenNow(chisinau, new Date("2026-07-13T09:00:00Z")),
    true,
  );
  // Закрытый день.
  const closedSunday = {
    ...baseRestaurant(),
    timeZone: "Europe/Chisinau",
    weeklySchedule: {
      ...open0922,
      sunday: { enabled: false, openTime: "", closeTime: "" },
    },
  };
  // 2026-07-12 — воскресенье; 12:00Z → Кишинёв 15:00 вс → закрыто.
  assert.equal(
    isRestaurantOpenNow(closedSunday, new Date("2026-07-12T12:00:00Z")),
    false,
  );
});

// 19: ночной график 18:00–02:00
test("ночной график 18:00–02:00 работает корректно", () => {
  const night = {
    ...baseRestaurant(),
    timeZone: "Europe/Chisinau",
    weeklySchedule: scheduleAllDays("18:00", "02:00"),
  };
  // Вторник 01:00 по Кишинёву = понедельник 22:00Z (июль, UTC+3) → открыто (график пн).
  assert.equal(
    isRestaurantOpenNow(night, new Date("2026-07-13T22:00:00Z")),
    true,
  );
  // Вторник 10:00 по Кишинёву = 07:00Z вторник → закрыто.
  assert.equal(
    isRestaurantOpenNow(night, new Date("2026-07-14T07:00:00Z")),
    false,
  );
  // Вечер 20:00 по Кишинёву = 17:00Z → открыто (после 18:00 нет; 20:00 в интервале).
  assert.equal(
    isRestaurantOpenNow(night, new Date("2026-07-13T17:00:00Z")),
    true,
  );
});

// 20: старые snapshots и settlements не пересчитываются
test("изменение ресторана не пересчитывает старые snapshots и settlements", () => {
  // Заказ RESTAURANT_DELIVERY, доведённый до settlement.
  const { state, orderId } = makeRestaurantDeliveryArriving();
  const delivered = markOrderDelivered(state, orderId, "RESTAURANT");
  const orderBefore = JSON.stringify(
    delivered.orders.find((o) => o.id === orderId),
  );
  const settlementsBefore = JSON.stringify(delivered.settlements);

  const updated = updateRestaurant(delivered, "restaurant-3", {
    pickupCommissionRateBps: 999,
    contactPhone: "+373 000",
    internalAdminNote: "изменено",
  });
  assert.equal(updated.result.ok, true);
  const orderAfter = JSON.stringify(
    updated.state.orders.find((o) => o.id === orderId),
  );
  assert.equal(orderAfter, orderBefore);
  assert.equal(JSON.stringify(updated.state.settlements), settlementsBefore);
});

// --- §3: видимость блока назначения водителя --------------------------------

function orderOf(state: PrototypeState, orderId: string) {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

test("назначение водителя скрыто в RESTAURANT_REVIEW (неоплачен)", () => {
  const { state, orderId } = makePlatformReviewOrder();
  assert.equal(shouldShowDriverAssignment(orderOf(state, orderId)), false);
});

test("назначение водителя скрыто в AWAITING_PAYMENT (неоплачен)", () => {
  const { state, orderId } = makePlatformReviewOrder();
  const awaiting = acceptRestaurantOrder(state, orderId, 20); // AWAITING_PAYMENT
  assert.equal(shouldShowDriverAssignment(orderOf(awaiting, orderId)), false);
});

test("назначение водителя видно после оплаты (PREPARING/READY)", () => {
  const prep = makePlatformPreparing();
  assert.equal(
    shouldShowDriverAssignment(orderOf(prep.state, prep.orderId)),
    true,
  );
  const ready = makePlatformReady();
  assert.equal(
    shouldShowDriverAssignment(orderOf(ready.state, ready.orderId)),
    true,
  );
});

test("назначение водителя видно назначенному заказу в пути (OUT_FOR_DELIVERY)", () => {
  const { state, orderId } = makePlatformReady();
  const assigned = assignDriverToOrder(state, orderId, "driver-1");
  const out = markOrderOutForDelivery(assigned.state, orderId);
  assert.equal(shouldShowDriverAssignment(orderOf(out, orderId)), true);
});

test("назначение водителя скрыто для PICKUP и RESTAURANT_DELIVERY", () => {
  const pickup = makePickupReview();
  assert.equal(
    shouldShowDriverAssignment(orderOf(pickup.state, pickup.orderId)),
    false,
  );
  const rd = makeRestaurantDeliveryArriving();
  assert.equal(shouldShowDriverAssignment(orderOf(rd.state, rd.orderId)), false);
});

test("назначение водителя скрыто у завершённого/отменённого заказа", () => {
  const { state, orderId } = makePlatformReady();
  const canceled = adminCancelOrder(state, orderId, "Отмена");
  assert.equal(shouldShowDriverAssignment(orderOf(canceled.state, orderId)), false);
});
