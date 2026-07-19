import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialPreparingSoundState,
  preparingOrderIds,
  reducePreparingSound,
  type PreparingSoundState,
} from "./split-kitchen-preparing-sound.ts";
import type { Order, OrderStatus } from "../../prototype/models.ts";

const RID = "restaurant-1";

function order(id: string, status: OrderStatus, restaurantId = RID): Order {
  return {
    id,
    status,
    restaurant: { id: restaurantId, name: "R", address: "", zoneId: "zone-1" },
  } as unknown as Order;
}

function step(
  state: PreparingSoundState,
  preparingIds: string[],
  enabled = true,
  restaurantId = RID,
) {
  const { next, play } = reducePreparingSound(state, {
    restaurantId,
    enabled,
    preparingIds,
  });
  return { state: next, play };
}

// preparingOrderIds --------------------------------------------------------

test("preparingOrderIds: только PREPARING выбранного ресторана", () => {
  const orders = [
    order("a", "PREPARING"),
    order("b", "AWAITING_PAYMENT"),
    order("c", "READY"),
    order("d", "RESTAURANT_REVIEW"),
    order("e", "PREPARING", "restaurant-2"),
  ];
  assert.deepEqual(preparingOrderIds(orders, RID), ["a"]);
});

// 1 -----------------------------------------------------------------------

test("первый baseline с существующими PREPARING → звука нет", () => {
  const r = step(initialPreparingSoundState(), ["a", "b"]);
  assert.equal(r.play, false);
  assert.deepEqual(r.state.knownPreparingIds, ["a", "b"]);
});

// 2 -----------------------------------------------------------------------

test("пусто → один PREPARING: один сигнал", () => {
  let s = step(initialPreparingSoundState(), []);
  assert.equal(s.play, false);
  s = step(s.state, ["a"]);
  assert.equal(s.play, true);
});

// 3 -----------------------------------------------------------------------

test("один PREPARING → добавилось ещё два: один сигнал", () => {
  let s = step(initialPreparingSoundState(), []);
  s = step(s.state, ["a"]);
  assert.equal(s.play, true);
  s = step(s.state, ["a", "b", "c"]);
  assert.equal(s.play, true, "ровно один сигнал на двух новых");
});

// 4 -----------------------------------------------------------------------

test("появился только AWAITING_PAYMENT: сигнала нет", () => {
  // preparingOrderIds исключает AWAITING_PAYMENT — набор не меняется.
  const before = preparingOrderIds([order("a", "PREPARING")], RID);
  let s = step(initialPreparingSoundState(), before); // baseline ["a"]
  const after = preparingOrderIds(
    [order("a", "PREPARING"), order("b", "AWAITING_PAYMENT")],
    RID,
  );
  s = step(s.state, after);
  assert.equal(s.play, false, "AWAITING_PAYMENT не считается");
  assert.deepEqual(s.state.knownPreparingIds, ["a"]);
});

// 5 -----------------------------------------------------------------------

test("AWAITING_PAYMENT → PREPARING: один сигнал", () => {
  // Онлайн-заказ: сначала AWAITING (в набор не входит), затем PREPARING.
  let s = step(
    initialPreparingSoundState(),
    preparingOrderIds([order("a", "AWAITING_PAYMENT")], RID), // []
  );
  assert.equal(s.play, false);
  s = step(s.state, preparingOrderIds([order("a", "PREPARING")], RID)); // ["a"]
  assert.equal(s.play, true, "после подтверждения оплаты — один сигнал");
});

// 6 -----------------------------------------------------------------------

test("PREPARING остаётся PREPARING: повторного сигнала нет", () => {
  let s = step(initialPreparingSoundState(), []);
  s = step(s.state, ["a"]);
  assert.equal(s.play, true);
  s = step(s.state, ["a"]);
  assert.equal(s.play, false);
});

// 7 -----------------------------------------------------------------------

test("enabled=false: звука нет; backlog после включения не звучит; новый PREPARING звучит", () => {
  let s = step(initialPreparingSoundState(), [], false);
  s = step(s.state, ["a"], false);
  assert.equal(s.play, false);
  assert.deepEqual(s.state.knownPreparingIds, ["a"]);
  s = step(s.state, ["a"], true);
  assert.equal(s.play, false, "backlog после включения не звучит");
  s = step(s.state, ["a", "b"], true);
  assert.equal(s.play, true);
});

// 8 -----------------------------------------------------------------------

test("смена ресторана: текущие PREPARING нового ресторана становятся baseline", () => {
  let s = step(initialPreparingSoundState(), ["a"], true, "restaurant-1");
  s = step(s.state, ["x"], true, "restaurant-2");
  assert.equal(s.play, false, "backlog нового ресторана не озвучивается");
  assert.equal(s.state.restaurantId, "restaurant-2");
  assert.deepEqual(s.state.knownPreparingIds, ["x"]);
  s = step(s.state, ["x", "y"], true, "restaurant-2");
  assert.equal(s.play, true);
});

// 9 -----------------------------------------------------------------------

test("COMBINED (enabled=false всегда): дополнительный сигнал PREPARING отключён", () => {
  let s = step(initialPreparingSoundState(), [], false);
  s = step(s.state, ["a"], false);
  assert.equal(s.play, false);
  s = step(s.state, ["a", "b", "c"], false);
  assert.equal(s.play, false, "в общем режиме сигнал начала приготовления не звучит");
});
