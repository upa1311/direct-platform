import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  adminCancelOrder,
  assignDriverToOrder,
  completePickupAtRestaurant,
  correctOrderStatus,
  createOrderFromCart,
  goDriverOnline,
  issuePickupWithoutCode,
  markOrderArriving,
  markOrderDelivered,
  markOrderOutForDelivery,
  markOrderReady,
  reassignDriverForOrder,
  rejectRestaurantOrder,
  setRestaurantAcceptingOrders,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
  updateRestaurant,
} from "./actions.ts";
import {
  markDriverArrivedAtRestaurant,
  markDriverArrivingToCustomer,
  markDriverDeliveredOrder,
  markDriverPickedUpOrder,
} from "./driver-delivery.ts";

/**
 * v18: назначенный водитель Direct сам ведёт курьерские этапы. Гоняем заказ по
 * рабочему пути водителя (прибытие → получение → подъезд → доставка).
 */
function driveDeliveredByDriver(
  state: PrototypeState,
  orderId: string,
  driverId: string,
): PrototypeState {
  let s = markDriverArrivedAtRestaurant(state, driverId, orderId, "2026-07-22T12:00:00.000Z").state;
  s = markDriverPickedUpOrder(s, driverId, orderId, "2026-07-22T12:01:00.000Z").state;
  s = markDriverArrivingToCustomer(s, driverId, orderId, "2026-07-22T12:02:00.000Z").state;
  s = markDriverDeliveredOrder(s, driverId, orderId, "2026-07-22T12:03:00.000Z", {
    cashCollectionConfirmed: false,
  }).state;
  return s;
}
import {
  canPlacePrototypeOrder,
  getDriverById,
  getRestaurant,
} from "./selectors.ts";
import { upgradeToV6 } from "./prototype-store.ts";
import type { PrototypeState } from "./models.ts";

/**
 * v16: демо-водители стартуют не в сети и без зоны, а назначить можно только
 * AVAILABLE-водителя с подтверждённой зоной. Тесты назначения выводят нужных
 * водителей онлайн явно — автоматической зоны в домене нет.
 */
function seedOnline(): PrototypeState {
  let s = createDefaultState();
  s = goDriverOnline(s, "driver-1", "zone-1").state;
  s = goDriverOnline(s, "driver-2", "zone-1").state;
  return s;
}

function makePlatformOrder(): { state: PrototypeState; orderId: string } {
  let s = seedOnline();
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

function makePlatformOrderReady(): { state: PrototypeState; orderId: string } {
  const { state, orderId } = makePlatformOrder();
  let s = acceptRestaurantOrder(state, orderId, 20); // AWAITING_PAYMENT
  s = simulateSuccessfulOnlinePayment(s, orderId); // PREPARING
  s = markOrderReady(s, orderId); // READY
  return { state: s, orderId };
}

function makePickupReady(): {
  state: PrototypeState;
  orderId: string;
  code: string;
} {
  let s = seedOnline();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart({
    ...s,
    cart: { ...s.cart, fulfillmentChoice: "PICKUP" },
  });
  let st = created.state;
  const orderId = created.result.orderId as string;
  st = acceptRestaurantOrder(st, orderId, 20); // PREPARING (оплата в ресторане)
  st = markOrderReady(st, orderId); // READY_FOR_PICKUP
  const order = st.orders.find((o) => o.id === orderId);
  assert.equal(order?.pickupCode, null);
  return { state: st, orderId, code: "" };
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
  st = acceptRestaurantOrder(st, orderId, 20); // PREPARING
  st = markOrderReady(st, orderId); // READY
  st = markOrderOutForDelivery(st, orderId);
  st = markOrderArriving(st, orderId); // ARRIVING
  return { state: st, orderId };
}

// 1–2: приостановка / возобновление ресторана
test("приостановленный ресторан не принимает новые заказы", () => {
  let s = createDefaultState();
  s = setRestaurantAcceptingOrders(s, "restaurant-2", false);
  assert.equal(getRestaurant(s, "restaurant-2")?.isAcceptingOrders, false);
  assert.equal(
    canPlacePrototypeOrder(getRestaurant(s, "restaurant-2")!),
    false,
  );
  const added = addCartItem(s, "restaurant-2-item-1", "size-standard");
  assert.equal(added.result, "RESTAURANT_UNAVAILABLE");
});

test("возобновлённый ресторан снова принимает заказы", () => {
  let s = createDefaultState();
  s = setRestaurantAcceptingOrders(s, "restaurant-2", false);
  s = setRestaurantAcceptingOrders(s, "restaurant-2", true);
  assert.equal(canPlacePrototypeOrder(getRestaurant(s, "restaurant-2")!), true);
  assert.equal(
    addCartItem(s, "restaurant-2-item-1", "size-standard").result,
    "ADDED",
  );
});

// 3: контакты и график сохраняются
test("контакты и график сохраняются после обновления", () => {
  const s = createDefaultState();
  const res = updateRestaurant(s, "restaurant-1", {
    publicPhone: "+373 111",
    contactPersonName: "Контакт",
    weeklySchedule: {
      ...getRestaurant(s, "restaurant-1")!.weeklySchedule,
      monday: { enabled: false, openTime: "", closeTime: "" },
    },
  });
  const r = getRestaurant(res.state, "restaurant-1");
  assert.equal(r?.publicPhone, "+373 111");
  assert.equal(r?.contactPersonName, "Контакт");
  assert.equal(r?.weeklySchedule.monday.enabled, false);
});

// 4: изменение ресторана не меняет старый snapshot заказа
test("приостановка ресторана не меняет существующий заказ", () => {
  const { state, orderId } = makePlatformOrder();
  const before = JSON.stringify(state.orders.find((o) => o.id === orderId));
  const next = setRestaurantAcceptingOrders(state, "restaurant-2", false);
  const after = JSON.stringify(next.orders.find((o) => o.id === orderId));
  assert.equal(after, before);
});

// 5: PLATFORM_DRIVER может получить доступного водителя (после оплаты)
test("PLATFORM_DRIVER получает доступного водителя", () => {
  const { state, orderId } = makePlatformOrderReady();
  const res = assignDriverToOrder(state, orderId, "driver-1");
  assert.equal(res.result.ok, true);
  assert.equal(
    res.state.orders.find((o) => o.id === orderId)?.assignedDriverId,
    "driver-1",
  );
  assert.equal(getDriverById(res.state, "driver-1")?.status, "BUSY_DIRECT");
});

// 6: PICKUP не может получить водителя Direct
test("PICKUP не может получить водителя Direct", () => {
  const { state, orderId } = makePickupReady();
  const res = assignDriverToOrder(state, orderId, "driver-1");
  assert.equal(res.result.ok, false);
  assert.equal(getDriverById(res.state, "driver-1")?.status, "AVAILABLE");
});

// 7: RESTAURANT_DELIVERY не может получить водителя Direct
test("RESTAURANT_DELIVERY не может получить водителя Direct", () => {
  const { state, orderId } = makeRestaurantDeliveryArriving();
  const res = assignDriverToOrder(state, orderId, "driver-1");
  assert.equal(res.result.ok, false);
});

// 8: переназначение освобождает старого водителя
test("переназначение освобождает старого водителя", () => {
  const { state, orderId } = makePlatformOrderReady();
  const assigned = assignDriverToOrder(state, orderId, "driver-1");
  const reassigned = reassignDriverForOrder(
    assigned.state,
    orderId,
    "driver-2",
    "Первый водитель занят",
  );
  assert.equal(reassigned.result.ok, true);
  assert.equal(
    getDriverById(reassigned.state, "driver-1")?.status,
    "ZONE_CONFIRMATION_REQUIRED",
  );
  assert.equal(getDriverById(reassigned.state, "driver-2")?.status, "BUSY_DIRECT");
  assert.equal(
    reassigned.state.orders.find((o) => o.id === orderId)?.assignedDriverId,
    "driver-2",
  );
});

// 9: завершение заказа освобождает водителя
test("завершение заказа освобождает водителя", () => {
  const { state, orderId } = makePlatformOrderReady();
  const assigned = assignDriverToOrder(state, orderId, "driver-1");
  // Курьерские этапы ведёт сам водитель: прибытие → получение → подъезд → доставка.
  const delivered = driveDeliveredByDriver(assigned.state, orderId, "driver-1");
  assert.equal(
    delivered.orders.find((o) => o.id === orderId)?.status,
    "DELIVERED",
  );
  assert.equal(
    getDriverById(delivered, "driver-1")?.status,
    "ZONE_CONFIRMATION_REQUIRED",
  );
});

// 10: отмена освобождает водителя
test("отмена заказа освобождает водителя", () => {
  const { state, orderId } = makePlatformOrderReady();
  const assigned = assignDriverToOrder(state, orderId, "driver-1");
  const canceled = adminCancelOrder(
    assigned.state,
    orderId,
    "Клиент отменил",
  );
  assert.equal(canceled.result.ok, true);
  assert.equal(
    canceled.state.orders.find((o) => o.id === orderId)?.status,
    "CANCELED",
  );
  assert.equal(
    getDriverById(canceled.state, "driver-1")?.status,
    "ZONE_CONFIRMATION_REQUIRED",
  );
});

// 11: отклонение требует причину
test("отклонение заказа требует причину", () => {
  const { state, orderId } = makePlatformOrder();
  const rejected = rejectRestaurantOrder(state, orderId, "   ");
  assert.equal(
    rejected.orders.find((o) => o.id === orderId)?.status,
    "RESTAURANT_REVIEW",
  );
});

// 12: отмена администратором требует причину
test("отмена администратором требует причину", () => {
  const { state, orderId } = makePlatformOrder();
  const res = adminCancelOrder(state, orderId, "");
  assert.equal(res.result.ok, false);
  assert.equal(
    res.state.orders.find((o) => o.id === orderId)?.status,
    "RESTAURANT_REVIEW",
  );
});

// 13: административное действие записывается с actor ADMIN
test("административное действие записывается с actor ADMIN", () => {
  const { state, orderId } = makePlatformOrderReady();
  const res = assignDriverToOrder(state, orderId, "driver-1");
  const order = res.state.orders.find((o) => o.id === orderId);
  assert.ok(order?.history.some((e) => e.actor === "ADMIN"));
});

// 14–15: безопасное исправление статуса
test("исправление статуса не создаёт settlement и не меняет оплату", () => {
  const { state, orderId } = makePlatformOrderReady(); // READY
  const before = state.orders.find((o) => o.id === orderId);
  const res = correctOrderStatus(
    state,
    orderId,
    "PREPARING",
    "Ошибочно отметили готовым",
  );
  assert.equal(res.result.ok, true);
  const after = res.state.orders.find((o) => o.id === orderId);
  assert.equal(after?.status, "PREPARING");
  // settlement не создан
  assert.equal(res.state.settlements.length, state.settlements.length);
  // paymentStatus не изменён
  assert.equal(after?.paymentStatus, before?.paymentStatus);
  // ADMIN событие записано
  assert.ok(after?.history.some((e) => e.actor === "ADMIN"));
});

test("исправление статуса не может выставить DELIVERED", () => {
  const { state, orderId } = makePlatformOrderReady();
  const res = correctOrderStatus(
    state,
    orderId,
    "DELIVERED",
    "Попытка обхода",
  );
  assert.equal(res.result.ok, false);
});

// 16: обычная выдача PICKUP требует код
test("обычная выдача PICKUP кода не требует", () => {
  const { state, orderId } = makePickupReady();
  // Заказ не оплачен заранее: подтверждением служит фактическая оплата.
  const done = completePickupAtRestaurant(state, orderId, "CASH");
  assert.equal(done.result.ok, true, done.result.error ?? "");
  assert.equal(
    done.state.orders.find((o) => o.id === orderId)?.status,
    "PICKED_UP",
  );
  assert.equal(done.state.settlements.length, 1);
});

// 17: аварийная выдача требует причину
test("аварийная выдача без кода требует причину", () => {
  const { state, orderId } = makePickupReady();
  const res = issuePickupWithoutCode(state, orderId, "  ", "CASH");
  assert.equal(res.result.ok, false);
  assert.equal(res.state.settlements.length, 0);
});

// 18: аварийная выдача создаёт не более одного settlement
test("аварийная выдача создаёт одну settlement и не дублирует", () => {
  const { state, orderId } = makePickupReady();
  const first = issuePickupWithoutCode(state, orderId, "Клиент забыл код", "CASH");
  assert.equal(first.result.ok, true);
  assert.equal(first.state.settlements.length, 1);
  assert.equal(
    first.state.orders.find((o) => o.id === orderId)?.status,
    "PICKED_UP",
  );
  // повторная попытка не создаёт вторую запись
  const second = issuePickupWithoutCode(first.state, orderId, "Ещё раз", "CASH");
  assert.equal(second.result.ok, false);
  assert.equal(second.state.settlements.length, 1);
});

// 19: завершение RESTAURANT_DELIVERY сохраняет финансовую логику
test("завершение RESTAURANT_DELIVERY сохраняет финансовую логику", () => {
  const { state, orderId } = makeRestaurantDeliveryArriving();
  const commissionBefore = state.orders.find((o) => o.id === orderId)
    ?.financials.restaurantCommissionCents;
  const delivered = markOrderDelivered(state, orderId);
  const order = delivered.orders.find((o) => o.id === orderId);
  assert.equal(order?.status, "DELIVERED");
  assert.equal(order?.paymentStatus, "PAID_TO_RESTAURANT_COURIER");
  assert.equal(delivered.settlements.length, 1);
  const entry = delivered.settlements[0];
  assert.equal(entry.type, "RESTAURANT_DELIVERY_COMMISSION");
  assert.equal(entry.amountCents, commissionBefore);
  // Финансовый snapshot заказа не переписан.
  assert.equal(order?.financials.restaurantCommissionCents, commissionBefore);
});

// 20: миграция старых данных (заказы без водителя, водители без статуса)
test("старые данные корректно мигрируют (водитель/назначение)", () => {
  const legacy = {
    schemaVersion: 6,
    revision: 2,
    nextOrderNumber: 20,
    drivers: [{ id: "driver-old", name: "Старый водитель", cashEnabled: true }],
    orders: [
      {
        id: "order-old",
        publicNumber: "DIR-0009",
        deliveryMode: "PLATFORM_DRIVER",
        paymentMethod: "ONLINE",
        paymentStatus: "PAID",
        status: "READY",
        restaurant: {
          id: "restaurant-2",
          name: "Ресторан 2",
          address: "Бендеры",
          zoneId: "zone-2",
        },
        items: [],
      },
    ],
  };
  const migrated = upgradeToV6(legacy);
  const driver = migrated.drivers.find((d) => d.id === "driver-old");
  assert.ok(driver, "старый водитель сохранён");
  assert.equal(driver.status, "OFFLINE"); // безопасный статус
  const order = migrated.orders.find((o) => o.id === "order-old");
  assert.ok(order);
  assert.equal(order.assignedDriverId, null);
  assert.equal(order.driverAssignedAt, null);
  // Историческая оплата не менялась.
  assert.equal(order.paymentStatus, "PAID");
});
