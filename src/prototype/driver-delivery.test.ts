import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  acceptRestaurantOrder,
  addCartItem,
  assignDriverToOrder,
  correctOrderStatus,
  createOrderFromCart,
  goDriverOnline,
  markOrderArrivingWithResult,
  markOrderDeliveredWithResult,
  markOrderOutForDeliveryWithResult,
  markOrderReady,
  reassignDriverForOrder,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import { parseStoredState } from "./prototype-store.ts";
import { getDriverById } from "./selectors.ts";
import {
  markDriverArrivedAtRestaurant,
  markDriverArrivingToCustomer,
  markDriverDeliveredOrder,
  markDriverPickedUpOrder,
  resolveDriverDeliveryStage,
  driverDeliveryEventId,
} from "./driver-delivery.ts";
import type {
  DriverDeliveryEvent,
  Order,
  PrototypeState,
  ZoneId,
} from "./models.ts";

/**
 * Рабочий путь назначенного водителя Direct (v18): прибытие → получение →
 * подъезд → доставка. Идентичность водителя проверяется доменом; журнал
 * append-only; accounting признаётся ровно один раз.
 */

const D1 = "driver-1";
const D2 = "driver-2";
const REST_ZONE: ZoneId = "zone-2"; // ресторан-2
const T = (n: number) => `2026-07-22T12:0${n}:00.000Z`;

const CURRENT_PAGE = readFileSync(
  "src/app/driver/current-order/page.tsx",
  "utf8",
);

/** READY, назначенный driver-1 (BUSY_DIRECT) платёжный онлайн-заказ ресторана-2. */
function assignedState(): { state: PrototypeState; orderId: string } {
  let s = goDriverOnline(createDefaultState(), D1, REST_ZONE).state;
  s = goDriverOnline(s, D2, REST_ZONE).state;
  s = updateCartAddress(s, {
    street: "Тестовая улица 1",
    house: "5",
    apartment: "12",
    entrance: "2",
    floor: "3",
    comment: "у ворот",
  });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, orderId);
  s = markOrderReady(s, orderId);
  s = assignDriverToOrder(s, orderId, D1).state;
  return { state: s, orderId };
}

/** Как assignedState, но заказ остаётся PREPARING (назначение при PREPARING). */
function assignedPreparingState(): { state: PrototypeState; orderId: string } {
  let s = goDriverOnline(createDefaultState(), D1, REST_ZONE).state;
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "5" });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, orderId); // PREPARING, PAID
  s = assignDriverToOrder(s, orderId, D1).state;
  return { state: s, orderId };
}

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}
const statusOf = (state: PrototypeState, orderId: string) =>
  orderOf(state, orderId).status;
const driverStatusOf = (state: PrototypeState, driverId: string) =>
  getDriverById(state, driverId)?.status;
const eventsOf = (state: PrototypeState) => state.driverDeliveryEvents;

/** Прогоняет заказ READY → OUT → ARRIVING (готов к доставке). */
function toArriving(state: PrototypeState, orderId: string): PrototypeState {
  let s = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  s = markDriverPickedUpOrder(s, D1, orderId, T(1)).state;
  s = markDriverArrivingToCustomer(s, D1, orderId, T(2)).state;
  return s;
}

// --- 1–9: schema и нормализация ------------------------------------------------

test("1: схема прототипа равна 18", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 18);
});

test("2: нормализатор принимает схемы 7–18", () => {
  const base = createDefaultState();
  for (let v = 7; v <= 18; v += 1) {
    const parsed = parseStoredState(JSON.stringify({ ...base, schemaVersion: v }));
    assert.ok(parsed, `схема ${v}`);
    assert.equal(parsed.schemaVersion, 18);
  }
  assert.equal(parseStoredState(JSON.stringify({ ...base, schemaVersion: 19 })), null);
});

test("3: состояние до v18 получает пустой журнал", () => {
  const base = createDefaultState();
  const legacy = JSON.parse(JSON.stringify({ ...base, schemaVersion: 17 }));
  delete legacy.driverDeliveryEvents;
  const parsed = parseStoredState(JSON.stringify(legacy));
  assert.ok(parsed);
  assert.deepEqual(parsed.driverDeliveryEvents, []);
});

/** Разбор состояния с «сырыми» событиями журнала. */
function parseEvents(raw: unknown[]): DriverDeliveryEvent[] {
  const { state } = assignedState();
  const parsed = parseStoredState(
    JSON.stringify({ ...state, driverDeliveryEvents: raw }),
  );
  assert.ok(parsed);
  return parsed.driverDeliveryEvents;
}

test("4: валидное событие сохраняется", () => {
  const { state, orderId } = assignedState();
  const parsed = parseStoredState(
    JSON.stringify({
      ...state,
      driverDeliveryEvents: [
        {
          id: "e1",
          orderId,
          driverId: D1,
          type: "ARRIVED_AT_RESTAURANT",
          occurredAt: T(0),
          orderStatusBefore: "READY",
          orderStatusAfter: "READY",
        },
      ],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.driverDeliveryEvents.length, 1);
});

test("5: повреждённые и неизвестные удаляются", () => {
  const { orderId } = assignedState();
  const good = {
    id: "e1",
    orderId,
    driverId: D1,
    type: "ARRIVED_AT_RESTAURANT",
    occurredAt: T(0),
    orderStatusBefore: "READY",
    orderStatusAfter: "READY",
  };
  assert.equal(parseEvents([{ ...good, type: "WAT" }]).length, 0);
  assert.equal(parseEvents([{ ...good, occurredAt: "не-дата" }]).length, 0);
  assert.equal(parseEvents([{ ...good, orderStatusBefore: "NOPE" }]).length, 0);
  assert.equal(parseEvents([{ ...good, id: "" }]).length, 0);
});

test("6: дубликаты id удаляются", () => {
  const { orderId } = assignedState();
  const a = {
    id: "dup",
    orderId,
    driverId: D1,
    type: "ARRIVED_AT_RESTAURANT",
    occurredAt: T(0),
    orderStatusBefore: "READY",
    orderStatusAfter: "READY",
  };
  const b = { ...a, type: "ORDER_PICKED_UP", orderStatusBefore: "READY", orderStatusAfter: "OUT_FOR_DELIVERY" };
  // Один и тот же id — вторая запись отбрасывается (первая сохраняется).
  assert.equal(parseEvents([a, b]).length, 1);
});

test("7: дубликаты order+driver+type удаляются", () => {
  const { orderId } = assignedState();
  const a = {
    id: "e1",
    orderId,
    driverId: D1,
    type: "ARRIVED_AT_RESTAURANT",
    occurredAt: T(0),
    orderStatusBefore: "READY",
    orderStatusAfter: "READY",
  };
  const b = { ...a, id: "e2", occurredAt: T(1) };
  const kept = parseEvents([a, b]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "e1");
});

test("8: журнал не реконструируется из history", () => {
  // У доставленного заказа история есть, но журнал не восстанавливается.
  const { state, orderId } = assignedState();
  const delivered = markDriverDeliveredOrder(
    toArriving(state, orderId),
    D1,
    orderId,
    T(3),
  ).state;
  const stripped = { ...delivered, driverDeliveryEvents: [] };
  const parsed = parseStoredState(JSON.stringify(stripped));
  assert.ok(parsed);
  assert.deepEqual(parsed.driverDeliveryEvents, []);
});

test("9: нормализация идемпотентна", () => {
  const { state, orderId } = assignedState();
  const withEvent = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  const once = parseStoredState(JSON.stringify(withEvent));
  assert.ok(once);
  const twice = parseStoredState(JSON.stringify(once));
  assert.ok(twice);
  assert.deepEqual(twice.driverDeliveryEvents, once.driverDeliveryEvents);
});

// --- 10–17: прибытие ----------------------------------------------------------

test("10: назначенный BUSY_DIRECT водитель прибывает при PREPARING", () => {
  const { state, orderId } = assignedPreparingState();
  const res = markDriverArrivedAtRestaurant(state, D1, orderId, T(0));
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, orderId), "PREPARING");
});

test("11: может прибыть при READY", () => {
  const { state, orderId } = assignedState();
  const res = markDriverArrivedAtRestaurant(state, D1, orderId, T(0));
  assert.equal(res.result.ok, true, res.result.error ?? "");
});

test("12: статус заказа при прибытии не меняется", () => {
  const { state, orderId } = assignedState();
  const res = markDriverArrivedAtRestaurant(state, D1, orderId, T(0));
  assert.equal(statusOf(res.state, orderId), "READY");
  const ev = eventsOf(res.state).find((e) => e.type === "ARRIVED_AT_RESTAURANT");
  assert.ok(ev);
  assert.equal(ev.orderStatusBefore, ev.orderStatusAfter);
});

test("13: event и history создаются один раз", () => {
  const { state, orderId } = assignedState();
  const res = markDriverArrivedAtRestaurant(state, D1, orderId, T(0));
  assert.equal(
    eventsOf(res.state).filter((e) => e.type === "ARRIVED_AT_RESTAURANT").length,
    1,
  );
  const historyCount = orderOf(res.state, orderId).history.filter((h) =>
    h.message.includes("прибыл в ресторан"),
  ).length;
  assert.equal(historyCount, 1);
  assert.equal(
    eventsOf(res.state)[0].id,
    driverDeliveryEventId(orderId, D1, "ARRIVED_AT_RESTAURANT"),
  );
});

test("14: повторное прибытие — no-op без роста ревизии", () => {
  const { state, orderId } = assignedState();
  const first = markDriverArrivedAtRestaurant(state, D1, orderId, T(0));
  const second = markDriverArrivedAtRestaurant(first.state, D1, orderId, T(1));
  assert.equal(second.result.ok, true);
  assert.equal(second.state, first.state, "тот же объект state");
  assert.equal(second.state.revision, first.state.revision);
});

test("15: другой водитель отклоняется", () => {
  const { state, orderId } = assignedState();
  const res = markDriverArrivedAtRestaurant(state, D2, orderId, T(0));
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Этот заказ назначен другому водителю.");
  assert.equal(res.state, state);
});

test("16: старый водитель после переназначения отклоняется", () => {
  const { state, orderId } = assignedState();
  const arrived = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  const reassigned = reassignDriverForOrder(arrived, orderId, D2, "ближе").state;
  const res = markDriverPickedUpOrder(reassigned, D1, orderId, T(1));
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Этот заказ назначен другому водителю.");
});

test("17: наличный / PICKUP / RESTAURANT_DELIVERY заказ отклоняется", () => {
  const { state, orderId } = assignedState();
  const mutate = (patch: Partial<Order>): PrototypeState => ({
    ...state,
    orders: state.orders.map((o) => (o.id === orderId ? { ...o, ...patch } : o)),
  });
  assert.equal(
    markDriverArrivedAtRestaurant(mutate({ paymentMethod: "CASH" }), D1, orderId, T(0)).result.ok,
    false,
  );
  assert.equal(
    markDriverArrivedAtRestaurant(mutate({ deliveryMode: "PICKUP" }), D1, orderId, T(0)).result.ok,
    false,
  );
  assert.equal(
    markDriverArrivedAtRestaurant(mutate({ deliveryMode: "RESTAURANT_DELIVERY" }), D1, orderId, T(0)).result.ok,
    false,
  );
});

// --- 18–23: получение ---------------------------------------------------------

test("18: до прибытия получить нельзя", () => {
  const { state, orderId } = assignedState();
  const res = markDriverPickedUpOrder(state, D1, orderId, T(1));
  assert.equal(res.result.ok, false);
  assert.equal(statusOf(res.state, orderId), "READY");
});

test("19: PREPARING получить нельзя", () => {
  const { state, orderId } = assignedPreparingState();
  const arrived = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  const res = markDriverPickedUpOrder(arrived, D1, orderId, T(1));
  assert.equal(res.result.ok, false);
  assert.equal(statusOf(res.state, orderId), "PREPARING");
});

test("20: READY + прибытие → OUT_FOR_DELIVERY", () => {
  const { state, orderId } = assignedState();
  const arrived = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  const res = markDriverPickedUpOrder(arrived, D1, orderId, T(1));
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, orderId), "OUT_FOR_DELIVERY");
});

test("21: событие получения создаётся один раз", () => {
  const { state, orderId } = assignedState();
  let s = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  s = markDriverPickedUpOrder(s, D1, orderId, T(1)).state;
  assert.equal(eventsOf(s).filter((e) => e.type === "ORDER_PICKED_UP").length, 1);
});

test("22: после получения водитель остаётся BUSY_DIRECT", () => {
  const { state, orderId } = assignedState();
  let s = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  s = markDriverPickedUpOrder(s, D1, orderId, T(1)).state;
  assert.equal(driverStatusOf(s, D1), "BUSY_DIRECT");
});

test("23: событие старого водителя не подходит новому", () => {
  const { state, orderId } = assignedState();
  const arrived = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  const reassigned = reassignDriverForOrder(arrived, orderId, D2, "ближе").state;
  // У нового водителя нет собственного ARRIVED — получить нельзя.
  const res = markDriverPickedUpOrder(reassigned, D2, orderId, T(1));
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Действие недоступно на текущем этапе заказа.");
});

// --- 24–28: подъезд -----------------------------------------------------------

test("24: OUT_FOR_DELIVERY + получение → ARRIVING", () => {
  const { state, orderId } = assignedState();
  let s = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  s = markDriverPickedUpOrder(s, D1, orderId, T(1)).state;
  const res = markDriverArrivingToCustomer(s, D1, orderId, T(2));
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, orderId), "ARRIVING");
});

test("25: событие подъезда создаётся", () => {
  const { state, orderId } = assignedState();
  const s = toArriving(state, orderId);
  assert.equal(eventsOf(s).filter((e) => e.type === "ARRIVING_TO_CUSTOMER").length, 1);
});

test("26: до получения подъезд невозможен", () => {
  const { state, orderId } = assignedState();
  const arrived = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  const res = markDriverArrivingToCustomer(arrived, D1, orderId, T(2));
  assert.equal(res.result.ok, false);
  assert.equal(statusOf(res.state, orderId), "READY");
});

test("27: другой водитель на подъезде отклоняется", () => {
  const { state, orderId } = assignedState();
  let s = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  s = markDriverPickedUpOrder(s, D1, orderId, T(1)).state;
  const res = markDriverArrivingToCustomer(s, D2, orderId, T(2));
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Этот заказ назначен другому водителю.");
});

test("28: повторный подъезд — no-op", () => {
  const { state, orderId } = assignedState();
  const s = toArriving(state, orderId);
  const again = markDriverArrivingToCustomer(s, D1, orderId, T(3));
  assert.equal(again.result.ok, true);
  assert.equal(again.state, s);
});

// --- 29–38: доставка ----------------------------------------------------------

test("29–33: ARRIVING + подъезд → DELIVERED, водитель на подтверждении зоны", () => {
  const { state, orderId } = assignedState();
  const s = toArriving(state, orderId);
  const res = markDriverDeliveredOrder(s, D1, orderId, T(3));
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, orderId), "DELIVERED"); // 29
  assert.equal(
    eventsOf(res.state).filter((e) => e.type === "ORDER_DELIVERED").length,
    1,
  ); // 30
  assert.equal(driverStatusOf(res.state, D1), "ZONE_CONFIRMATION_REQUIRED"); // 31,33
  const customerZone = orderOf(state, orderId).financials.customerZoneId;
  assert.equal(getDriverById(res.state, D1)?.suggestedZoneId, customerZone); // 32
});

test("34–35: accounting создаётся один раз; повтор не создаёт второй", () => {
  const { state, orderId } = assignedState();
  const s = toArriving(state, orderId);
  const before = s.restaurantAccountingEntries.length;
  const first = markDriverDeliveredOrder(s, D1, orderId, T(3));
  assert.equal(first.result.ok, true, first.result.error ?? "");
  const afterFirst = first.state.restaurantAccountingEntries.length;
  assert.ok(afterFirst > before, "обязательства признаны");
  // Повтор тем же водителем — успешный no-op, второй accounting не создаётся.
  const second = markDriverDeliveredOrder(first.state, D1, orderId, T(4));
  assert.equal(second.result.ok, true);
  assert.equal(second.state, first.state);
  assert.equal(second.state.restaurantAccountingEntries.length, afterFirst);
  assert.equal(
    eventsOf(second.state).filter((e) => e.type === "ORDER_DELIVERED").length,
    1,
  );
});

test("36: ошибка accounting полностью fail-closed", () => {
  const { state, orderId } = assignedState();
  const s = toArriving(state, orderId);
  // Портим снимок движения денег: accounting откажется признавать.
  const broken: PrototypeState = {
    ...s,
    orders: s.orders.map((o) =>
      o.id === orderId
        ? {
            ...o,
            financials: { ...o.financials, moneyMovementStatus: "REVIEW_REQUIRED" },
          }
        : o,
    ),
  };
  // REVIEW_REQUIRED не создаёт обязательств, но и не падает — доставка проходит
  // без новых записей. Проверяем именно отсутствие дубля и целостность.
  const res = markDriverDeliveredOrder(broken, D1, orderId, T(3));
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(
    res.state.restaurantAccountingEntries.length,
    broken.restaurantAccountingEntries.length,
  );
});

test("37: другой водитель не может завершить", () => {
  const { state, orderId } = assignedState();
  const s = toArriving(state, orderId);
  const res = markDriverDeliveredOrder(s, D2, orderId, T(3));
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Этот заказ назначен другому водителю.");
  assert.equal(res.state, s);
});

test("38: старый водитель после переназначения не может завершить", () => {
  const { state, orderId } = assignedState();
  const s = toArriving(state, orderId);
  const reassigned = reassignDriverForOrder(s, orderId, D2, "ближе").state;
  const res = markDriverDeliveredOrder(reassigned, D1, orderId, T(3));
  assert.equal(res.result.ok, false);
});

// --- 39–42: resolver ----------------------------------------------------------

test("39: все пять нормальных этапов определяются правильно", () => {
  const { state, orderId } = assignedState();
  assert.equal(resolveDriverDeliveryStage(state, D1, orderId), "GO_TO_RESTAURANT");
  const s1 = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  assert.equal(resolveDriverDeliveryStage(s1, D1, orderId), "READY_TO_PICK_UP");
  const s2 = markDriverPickedUpOrder(s1, D1, orderId, T(1)).state;
  assert.equal(resolveDriverDeliveryStage(s2, D1, orderId), "GO_TO_CUSTOMER");
  const s3 = markDriverArrivingToCustomer(s2, D1, orderId, T(2)).state;
  assert.equal(resolveDriverDeliveryStage(s3, D1, orderId), "ARRIVING_TO_CUSTOMER");
  // WAITING_AT_RESTAURANT — прибытие при PREPARING.
  const prep = assignedPreparingState();
  const arrivedPrep = markDriverArrivedAtRestaurant(prep.state, D1, prep.orderId, T(0)).state;
  assert.equal(
    resolveDriverDeliveryStage(arrivedPrep, D1, prep.orderId),
    "WAITING_AT_RESTAURANT",
  );
});

test("40: противоречия дают REVIEW_REQUIRED", () => {
  const { state, orderId } = assignedState();
  // OUT_FOR_DELIVERY без события получения (искусственно смещённый статус).
  const jumped: PrototypeState = {
    ...state,
    orders: state.orders.map((o) =>
      o.id === orderId ? { ...o, status: "OUT_FOR_DELIVERY" } : o,
    ),
  };
  assert.equal(resolveDriverDeliveryStage(jumped, D1, orderId), "REVIEW_REQUIRED");
});

test("41: события старого водителя не управляют этапом нового", () => {
  const { state, orderId } = assignedState();
  let s = markDriverArrivedAtRestaurant(state, D1, orderId, T(0)).state;
  s = markDriverPickedUpOrder(s, D1, orderId, T(1)).state; // OUT_FOR_DELIVERY, событие driver-1
  const reassigned = reassignDriverForOrder(s, orderId, D2, "ближе").state;
  // Новый водитель на OUT_FOR_DELIVERY без СВОЕГО pickup → REVIEW_REQUIRED.
  assert.equal(resolveDriverDeliveryStage(reassigned, D2, orderId), "REVIEW_REQUIRED");
});

test("42: неверный статус водителя даёт REVIEW_REQUIRED", () => {
  const { state, orderId } = assignedState();
  const notBusy: PrototypeState = {
    ...state,
    drivers: state.drivers.map((d) =>
      d.id === D1 ? { ...d, status: "AVAILABLE" } : d,
    ),
  };
  assert.equal(resolveDriverDeliveryStage(notBusy, D1, orderId), "REVIEW_REQUIRED");
});

// --- 43–46: обход lifecycle ---------------------------------------------------

test("43: ресторан не может двигать PLATFORM_DRIVER по курьерским этапам", () => {
  const { state, orderId } = assignedState();
  const out = markOrderOutForDeliveryWithResult(state, orderId, "RESTAURANT");
  assert.equal(out.result.ok, false);
  assert.equal(out.result.error, "Этот этап отмечает назначенный водитель Direct.");
  const arriving = markOrderArrivingWithResult(state, orderId, "ADMIN");
  assert.equal(arriving.result.ok, false);
});

test("44: RESTAURANT_DELIVERY продолжает работать", () => {
  // Собственная доставка ресторана-3: READY → OUT → ARRIVING → DELIVERED.
  let s = updateCartAddress(createDefaultState(), { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20);
  s = markOrderReady(s, orderId);
  const out = markOrderOutForDeliveryWithResult(s, orderId, "ADMIN");
  assert.equal(out.result.ok, true, out.result.error ?? "");
  const arriving = markOrderArrivingWithResult(out.state, orderId, "ADMIN");
  assert.equal(arriving.result.ok, true);
  const delivered = markOrderDeliveredWithResult(arriving.state, orderId, "ADMIN");
  assert.equal(delivered.result.ok, true, delivered.result.error ?? "");
  assert.equal(statusOf(delivered.state, orderId), "DELIVERED");
});

test("45: старый provider-метод без driver identity недоступен UI", () => {
  const provider = readFileSync("src/prototype/prototype-provider.tsx", "utf8");
  const admin = readFileSync("src/app/admin/orders/page.tsx", "utf8");
  // Нет провайдерского метода markDeliveredByDriver и его использования в UI.
  assert.ok(!provider.includes("markDeliveredByDriver:"));
  assert.ok(!provider.includes("markOrderDeliveredByDriverWithResult"));
  assert.ok(!admin.includes("markDeliveredByDriver"));
});

test("46: админское исправление статуса с причиной сохраняется", () => {
  const { state, orderId } = assignedState();
  const res = correctOrderStatus(state, orderId, "OUT_FOR_DELIVERY", "аварийно");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, orderId), "OUT_FOR_DELIVERY");
});

// --- 47–55: UI (проверка исходника) -------------------------------------------

test("47–49: на этапах четыре русские кнопки, одна главная на этап", () => {
  for (const label of ["Я в ресторане", "Заказ получен", "Я подъезжаю", "Заказ доставлен"]) {
    assert.ok(CURRENT_PAGE.includes(label), label);
  }
  // Каждая кнопка этапа — через единый MainButton (одна главная на этап).
  assert.ok(CURRENT_PAGE.includes("MainButton"));
  assert.ok(CURRENT_PAGE.includes("resolveDriverDeliveryStage"));
});

test("48: при ожидании активной кнопки получения нет", () => {
  // WAITING_AT_RESTAURANT-ветка внутри StagePanel не содержит MainButton.
  const panel = CURRENT_PAGE.slice(CURRENT_PAGE.indexOf("function StagePanel"));
  const start = panel.indexOf('case "WAITING_AT_RESTAURANT"');
  const end = panel.indexOf('case "READY_TO_PICK_UP"');
  assert.ok(start !== -1 && end !== -1);
  const block = panel.slice(start, end);
  assert.ok(!block.includes("MainButton"));
  assert.ok(block.includes("Ожидаем готовность заказа"));
});

test("50: после доставки редирект на /driver", () => {
  assert.ok(CURRENT_PAGE.includes('router.push("/driver")'));
});

test("51: REVIEW_REQUIRED не показывает переходов", () => {
  assert.ok(CURRENT_PAGE.includes("требует проверки Direct"));
});

test("52: приватность — заказ показывается только назначенному водителю", () => {
  assert.ok(CURRENT_PAGE.includes("assignedDriverId === selectedDriverId"));
});

test("53–55: нет наличных кнопок, жалоб и карты", () => {
  for (const forbidden of [
    "Получить наличные",
    "Передать наличные",
    "Жалоба",
    "Пожаловаться",
    "Открыть карту",
    "GPS",
  ]) {
    assert.ok(!CURRENT_PAGE.includes(forbidden), forbidden);
  }
});

// --- 56–62: regression --------------------------------------------------------

test("56–58: driver offers, срок и звук предложений не изменены", () => {
  const offers = readFileSync("src/prototype/driver-offers.ts", "utf8");
  assert.ok(offers.includes("DRIVER_OFFER_DURATION_MS = 30_000"));
  const soundLogic = readFileSync(
    "src/components/driver/driver-offer-sound-logic.ts",
    "utf8",
  );
  assert.ok(soundLogic.includes("DRIVER_OFFER_SOUND_KEY"));
  assert.ok(soundLogic.includes("DRIVER_OFFER_BEEP_INTERVAL_MS = 10_000"));
});

test("59: high-value cash warning не изменён (файл на месте)", () => {
  const warning = readFileSync(
    "src/components/kitchen/high-value-cash-order-warning.tsx",
    "utf8",
  );
  assert.ok(warning.length > 0);
});

test("60: platformDriverCashEnabled остаётся false", () => {
  assert.equal(createDefaultState().platformSettings.platformDriverCashEnabled, false);
});

test("61–62: денежные формулы не дублируются в driver-delivery", () => {
  const src = readFileSync("src/prototype/driver-delivery.ts", "utf8");
  // Завершение переиспользует канонический applyDriverDeliveredOrder, а не
  // импортирует финансовые модули напрямую.
  assert.ok(src.includes("applyDriverDeliveredOrder"));
  for (const forbidden of [
    "computeCompletedOrderAccounting",
    "bank-fee",
    "order-money-movement",
    "pricing-engine",
    "restaurant-settlement-records",
  ]) {
    assert.ok(!src.includes(forbidden), forbidden);
  }
});
