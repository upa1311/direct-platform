import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  getKitchenAwaitingPaymentOrders,
  getKitchenPreparingOrders,
} from "./selectors.ts";
import type {
  Order,
  OrderStatus,
  PrototypeState,
  RestaurantOrderWorkflowMode,
} from "./models.ts";

const RID = "restaurant-2";

/** Минимальный заказ: kitchen-селектор читает только restaurant.id и status. */
function order(id: string, status: OrderStatus, createdAt: string): Order {
  return {
    id,
    status,
    createdAt,
    restaurant: { id: RID, name: "Ресторан 2", address: "", zoneId: "zone-1" },
  } as unknown as Order;
}

function stateWith(
  mode: RestaurantOrderWorkflowMode,
  orders: Order[],
): PrototypeState {
  const base = createDefaultState();
  return {
    ...base,
    restaurants: base.restaurants.map((r) =>
      r.id === RID ? { ...r, orderWorkflowMode: mode } : r,
    ),
    orders,
  };
}

// 1 --------------------------------------------------------------------------

test("SPLIT: неоплаченный заказ не виден отдельной кухне (пустой массив)", () => {
  const state = stateWith("SPLIT_OPERATOR_KITCHEN", [
    order("A", "AWAITING_PAYMENT", "2026-07-18T10:00:00.000Z"),
  ]);
  assert.deepEqual(getKitchenAwaitingPaymentOrders(state, RID), []);
});

// 2 --------------------------------------------------------------------------

test("COMBINED: неоплаченный заказ возвращается как раньше", () => {
  const state = stateWith("COMBINED", [
    order("A", "AWAITING_PAYMENT", "2026-07-18T10:00:00.000Z"),
  ]);
  const result = getKitchenAwaitingPaymentOrders(state, RID);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "A");
});

// 3 --------------------------------------------------------------------------

test("COMBINED: сортировка нескольких AWAITING_PAYMENT сохраняется (по createdAt возр.)", () => {
  const state = stateWith("COMBINED", [
    order("late", "AWAITING_PAYMENT", "2026-07-18T12:00:00.000Z"),
    order("early", "AWAITING_PAYMENT", "2026-07-18T09:00:00.000Z"),
    order("mid", "AWAITING_PAYMENT", "2026-07-18T10:30:00.000Z"),
  ]);
  assert.deepEqual(
    getKitchenAwaitingPaymentOrders(state, RID).map((o) => o.id),
    ["early", "mid", "late"],
  );
});

// 4 --------------------------------------------------------------------------

test("SPLIT: после перехода в PREPARING заказ доступен через getKitchenPreparingOrders", () => {
  const state = stateWith("SPLIT_OPERATOR_KITCHEN", [
    order("A", "PREPARING", "2026-07-18T10:00:00.000Z"),
  ]);
  // Неоплаченной полосы нет...
  assert.deepEqual(getKitchenAwaitingPaymentOrders(state, RID), []);
  // ...но готовящийся заказ виден кухне как раньше (режим на PREPARING не влияет).
  const preparing = getKitchenPreparingOrders(state, RID);
  assert.equal(preparing.length, 1);
  assert.equal(preparing[0].id, "A");
});

// 5 --------------------------------------------------------------------------

test("selector не мутирует state и orders", () => {
  const state = stateWith("COMBINED", [
    order("B", "AWAITING_PAYMENT", "2026-07-18T11:00:00.000Z"),
    order("A", "AWAITING_PAYMENT", "2026-07-18T09:00:00.000Z"),
  ]);
  const snapshot = JSON.stringify(state);
  const ordersRef = state.orders;
  getKitchenAwaitingPaymentOrders(state, RID);
  getKitchenAwaitingPaymentOrders(stateWith("SPLIT_OPERATOR_KITCHEN", state.orders), RID);
  assert.equal(JSON.stringify(state), snapshot, "state неизменен");
  assert.equal(state.orders, ordersRef, "массив orders не пересобран");
});

// 6 --------------------------------------------------------------------------

test("fail-safe: отсутствующий ресторан → COMBINED-совместимое поведение", () => {
  // Аналогично getKitchenNewOrders: неизвестный ресторан трактуется как COMBINED.
  const state = stateWith("COMBINED", [
    order("A", "AWAITING_PAYMENT", "2026-07-18T10:00:00.000Z"),
  ]);
  const result = getKitchenAwaitingPaymentOrders(state, "restaurant-нет");
  // Заказов этого ресторана нет, но без падения и без SPLIT-гейта.
  assert.deepEqual(result, []);
});
