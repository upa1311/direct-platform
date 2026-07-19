import assert from "node:assert/strict";
import { test } from "node:test";

import { setDriverAvailability } from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import {
  getDriverActiveOrder,
  isDriverAvailableForOffers,
} from "./selectors.ts";
import type {
  DriverStatus,
  Order,
  OrderStatus,
  PrototypeState,
} from "./models.ts";

// Сид: driver-1/driver-2 = AVAILABLE, driver-3 = OFFLINE.
const AVAILABLE_DRIVER = "driver-1";
const OFFLINE_DRIVER = "driver-3";

function withDriverStatus(
  state: PrototypeState,
  driverId: string,
  status: DriverStatus,
): PrototypeState {
  return {
    ...state,
    drivers: state.drivers.map((d) =>
      d.id === driverId ? { ...d, status } : d,
    ),
  };
}

/** Минимальный заказ, назначенный водителю (селектор читает только эти поля). */
function assignedOrder(driverId: string, status: OrderStatus): Order {
  return {
    id: `order-${driverId}`,
    assignedDriverId: driverId,
    status,
  } as unknown as Order;
}

const statusOf = (state: PrototypeState, driverId: string): DriverStatus =>
  state.drivers.find((d) => d.id === driverId)!.status;

// 1 --------------------------------------------------------------------------

test("OFFLINE → онлайн переводит водителя в AVAILABLE (revision +1)", () => {
  const state = createDefaultState();
  const res = setDriverAvailability(state, OFFLINE_DRIVER, true);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, OFFLINE_DRIVER), "AVAILABLE");
  assert.equal(res.state.revision, state.revision + 1);
});

// 2 --------------------------------------------------------------------------

test("AVAILABLE → офлайн переводит водителя в OFFLINE (revision +1)", () => {
  const state = createDefaultState();
  const res = setDriverAvailability(state, AVAILABLE_DRIVER, false);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, AVAILABLE_DRIVER), "OFFLINE");
  assert.equal(res.state.revision, state.revision + 1);
});

// 3 --------------------------------------------------------------------------

test("неизвестный водитель → ошибка, состояние не меняется", () => {
  const state = createDefaultState();
  const before = JSON.stringify(state);
  const res = setDriverAvailability(state, "driver-нет", true);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Водитель не найден.");
  assert.equal(res.state, state, "та же ссылка на state");
  assert.equal(JSON.stringify(state), before);
});

// 4 --------------------------------------------------------------------------

test("повторный онлайн для AVAILABLE — no-op успех без роста ревизии", () => {
  const state = createDefaultState();
  const res = setDriverAvailability(state, AVAILABLE_DRIVER, true);
  assert.equal(res.result.ok, true);
  assert.equal(res.state, state, "state не пересобран");
  assert.equal(res.state.revision, state.revision);
  assert.equal(statusOf(res.state, AVAILABLE_DRIVER), "AVAILABLE");
});

// 5 --------------------------------------------------------------------------

test("повторный офлайн для OFFLINE — no-op успех без роста ревизии", () => {
  const state = createDefaultState();
  const res = setDriverAvailability(state, OFFLINE_DRIVER, false);
  assert.equal(res.result.ok, true);
  assert.equal(res.state, state);
  assert.equal(res.state.revision, state.revision);
  assert.equal(statusOf(res.state, OFFLINE_DRIVER), "OFFLINE");
});

// 6 --------------------------------------------------------------------------

test("BUSY водитель не может уйти офлайн (активная доставка)", () => {
  const state = withDriverStatus(createDefaultState(), AVAILABLE_DRIVER, "BUSY");
  const before = JSON.stringify(state);
  const res = setDriverAvailability(state, AVAILABLE_DRIVER, false);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Нельзя уйти офлайн во время активной доставки.");
  assert.equal(res.state, state, "state неизменен");
  assert.equal(JSON.stringify(state), before);
});

// 7 --------------------------------------------------------------------------

test("онлайн-запрос не понижает BUSY (водитель уже на смене и везёт заказ)", () => {
  const state = withDriverStatus(createDefaultState(), AVAILABLE_DRIVER, "BUSY");
  const res = setDriverAvailability(state, AVAILABLE_DRIVER, true);
  assert.equal(res.result.ok, true);
  assert.equal(res.state, state, "no-op, BUSY сохранён");
  assert.equal(statusOf(res.state, AVAILABLE_DRIVER), "BUSY");
});

// 8 --------------------------------------------------------------------------

test("офлайн заблокирован активным назначенным заказом даже без статуса BUSY", () => {
  // Инвариант «один активный заказ» защищён селектором getDriverActiveOrder,
  // а не только полем status (защита от рассинхронизации).
  let state = createDefaultState();
  state = {
    ...state,
    orders: [assignedOrder(AVAILABLE_DRIVER, "OUT_FOR_DELIVERY")],
  };
  const res = setDriverAvailability(state, AVAILABLE_DRIVER, false);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Нельзя уйти офлайн во время активной доставки.");
});

// 9 --------------------------------------------------------------------------

test("после завершения доставки (заказ терминальный, статус AVAILABLE) офлайн разрешён", () => {
  let state = createDefaultState();
  state = { ...state, orders: [assignedOrder(AVAILABLE_DRIVER, "DELIVERED")] };
  assert.equal(getDriverActiveOrder(state, AVAILABLE_DRIVER), null);
  const res = setDriverAvailability(state, AVAILABLE_DRIVER, false);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, AVAILABLE_DRIVER), "OFFLINE");
});

// 10 -------------------------------------------------------------------------

test("getDriverActiveOrder: активный назначенный заказ виден, терминальный/чужой — нет", () => {
  const base = createDefaultState();
  const active = { ...base, orders: [assignedOrder(AVAILABLE_DRIVER, "ARRIVING")] };
  assert.equal(getDriverActiveOrder(active, AVAILABLE_DRIVER)?.id, `order-${AVAILABLE_DRIVER}`);
  // Терминальный статус не считается активным.
  const done = { ...base, orders: [assignedOrder(AVAILABLE_DRIVER, "DELIVERED")] };
  assert.equal(getDriverActiveOrder(done, AVAILABLE_DRIVER), null);
  // Заказ другого водителя не виден.
  assert.equal(getDriverActiveOrder(active, OFFLINE_DRIVER), null);
});

// 11 -------------------------------------------------------------------------

test("isDriverAvailableForOffers: AVAILABLE без активного заказа получает предложения", () => {
  const state = createDefaultState();
  const available = state.drivers.find((d) => d.id === AVAILABLE_DRIVER)!;
  const offline = state.drivers.find((d) => d.id === OFFLINE_DRIVER)!;
  assert.equal(isDriverAvailableForOffers(state, available), true);
  assert.equal(isDriverAvailableForOffers(state, offline), false);
  assert.equal(
    isDriverAvailableForOffers(state, { ...available, status: "BUSY" }),
    false,
  );
  // Fail-closed: AVAILABLE-по-полю, но с активным заказом → недоступен.
  const withActive = {
    ...state,
    orders: [assignedOrder(AVAILABLE_DRIVER, "OUT_FOR_DELIVERY")],
  };
  assert.equal(isDriverAvailableForOffers(withActive, available), false);
});

// 12 -------------------------------------------------------------------------

test("read-only: смена доступности не трогает orders и остальных водителей", () => {
  const state = createDefaultState();
  const ordersRef = state.orders;
  const res = setDriverAvailability(state, OFFLINE_DRIVER, true);
  assert.equal(res.state.orders, ordersRef, "orders не пересобраны");
  // Другие водители не затронуты.
  assert.equal(statusOf(res.state, AVAILABLE_DRIVER), statusOf(state, AVAILABLE_DRIVER));
  assert.equal(statusOf(res.state, "driver-2"), statusOf(state, "driver-2"));
  // Исходный state не мутирован (driver-3 всё ещё OFFLINE в оригинале).
  assert.equal(statusOf(state, OFFLINE_DRIVER), "OFFLINE");
});
