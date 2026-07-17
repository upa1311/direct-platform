import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  adjustOrderEtaFromIntent,
  createOrderFromCart,
  setCartFulfillmentChoice,
} from "./actions.ts";
import {
  comparePreparingByReadyAt,
  formatKitchenCountdown,
} from "./selectors.ts";
import type {
  Order,
  PrototypeState,
  RestaurantOrderWorkflowMode,
} from "./models.ts";

/**
 * Тайминг кухни, который оператор видит в PREPARING. Проверяется общая с кухней
 * чистая логика (formatKitchenCountdown, comparePreparingByReadyAt) — тот же
 * источник истины, без второй формулы просрочки.
 */

function splitOrder(
  mode: RestaurantOrderWorkflowMode = "SPLIT_OPERATOR_KITCHEN",
): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === "restaurant-2" ? { ...r, orderWorkflowMode: mode } : r,
    ),
  };
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

const getOrder = (state: PrototypeState, orderId: string): Order => {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
};

/** Заказ в PREPARING с явным expectedReadyAt (без зависимости от реального времени). */
function preparingWithReadyAt(expectedReadyAt: string): Order {
  const { state, orderId } = splitOrder();
  const accepted = acceptRestaurantOrderWithResult(
    state,
    orderId,
    25,
    "RESTAURANT",
    "OPERATOR",
  ).state;
  const order = getOrder(accepted, orderId);
  assert.equal(order.status, "PREPARING");
  return { ...order, expectedReadyAt };
}

test("PREPARING с будущим expectedReadyAt: не overdue, корректный обратный отсчёт", () => {
  const nowMs = Date.parse("2026-07-17T18:28:00.000Z");
  const order = preparingWithReadyAt("2026-07-17T18:40:00.000Z");

  const countdown = formatKitchenCountdown(order.expectedReadyAt, nowMs);
  assert.equal(countdown.overdue, false);
  assert.equal(countdown.text, "12 мин");

  // Секундный обратный отсчёт под минутой.
  const nearNow = Date.parse("2026-07-17T18:39:18.000Z");
  const near = formatKitchenCountdown(order.expectedReadyAt, nearNow);
  assert.equal(near.overdue, false);
  assert.equal(near.text, "0:42");
});

test("PREPARING с прошедшим expectedReadyAt: overdue и текст «Просрочено на …»", () => {
  const nowMs = Date.parse("2026-07-17T18:47:00.000Z");
  const order = preparingWithReadyAt("2026-07-17T18:40:00.000Z");

  const countdown = formatKitchenCountdown(order.expectedReadyAt, nowMs);
  assert.equal(countdown.overdue, true);
  assert.equal(countdown.text, "Просрочено на 7 мин");
});

test("preparationMinutes выставлено оператором при принятии", () => {
  const { state, orderId } = splitOrder();
  const accepted = acceptRestaurantOrderWithResult(
    state,
    orderId,
    25,
    "RESTAURANT",
    "OPERATOR",
  ).state;
  const order = getOrder(accepted, orderId);
  assert.equal(order.preparationMinutes, 25);
  assert.ok(order.expectedReadyAt);
});

test("отображается именно последняя причина корректировки ETA", () => {
  const { state, orderId } = splitOrder();
  let s = acceptRestaurantOrderWithResult(
    state,
    orderId,
    25,
    "RESTAURANT",
    "OPERATOR",
  ).state;

  const firstNow = getOrder(s, orderId).updatedAt;
  s = adjustOrderEtaFromIntent(
    s,
    orderId,
    { kind: "FROM_NOW", minutes: 10 },
    "Кухня перегружена",
    "RESTAURANT",
    new Date(Date.parse(firstNow) + 1_000).toISOString(),
    "KITCHEN",
  ).state;
  const secondNow = getOrder(s, orderId).updatedAt;
  s = adjustOrderEtaFromIntent(
    s,
    orderId,
    { kind: "FROM_NOW", minutes: 15 },
    "Закончился ингредиент",
    "RESTAURANT",
    new Date(Date.parse(secondNow) + 1_000).toISOString(),
    "KITCHEN",
  ).state;

  const order = getOrder(s, orderId);
  assert.equal(order.etaAdjustments.length, 2);
  // Оператор показывает последнюю корректировку.
  assert.equal(order.etaAdjustments.at(-1)?.reason, "Закончился ингредиент");
});

test("сортировка: просроченные первыми, затем ближайшие, null ETA последними", () => {
  const mk = (id: string, expectedReadyAt: string | null): Order =>
    ({ id, expectedReadyAt }) as unknown as Order;

  const overdue = mk("overdue", "2026-07-17T18:30:00.000Z");
  const soon = mk("soon", "2026-07-17T18:45:00.000Z");
  const later = mk("later", "2026-07-17T19:10:00.000Z");
  const noEta = mk("none", null);

  const sorted = [noEta, later, soon, overdue]
    .slice()
    .sort(comparePreparingByReadyAt)
    .map((o) => o.id);

  assert.deepEqual(sorted, ["overdue", "soon", "later", "none"]);
});

test("read-only: расчёт тайминга не меняет заказ и state", () => {
  const { state, orderId } = splitOrder();
  const accepted = acceptRestaurantOrderWithResult(
    state,
    orderId,
    25,
    "RESTAURANT",
    "OPERATOR",
  ).state;

  const before = JSON.stringify(accepted);
  const order = getOrder(accepted, orderId);
  const revisionBefore = accepted.revision;
  const historyBefore = order.history.length;
  const etaBefore = order.etaAdjustments.length;

  // Чтение тайминга и сортировки не должно ничего мутировать.
  formatKitchenCountdown(order.expectedReadyAt, Date.parse("2026-07-17T18:40:00.000Z"));
  [...accepted.orders].sort(comparePreparingByReadyAt);

  assert.equal(JSON.stringify(accepted), before);
  assert.equal(accepted.revision, revisionBefore);
  assert.equal(getOrder(accepted, orderId).history.length, historyBefore);
  assert.equal(getOrder(accepted, orderId).etaAdjustments.length, etaBefore);
});
