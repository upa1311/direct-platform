import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialReadySoundState,
  readyOrderIds,
  reduceReadySound,
  type ReadySoundState,
} from "./order-ready-sound.ts";
import type { Order, OrderStatus } from "../../prototype/models.ts";

const RID = "restaurant-1";

function order(id: string, status: OrderStatus, restaurantId = RID): Order {
  return {
    id,
    status,
    restaurant: { id: restaurantId, name: "R", address: "", zoneId: "zone-1" },
  } as unknown as Order;
}

/** Прогоняет одно наблюдение через редьюсер, возвращая {state, play}. */
function step(
  state: ReadySoundState,
  readyIds: string[],
  enabled = true,
  restaurantId = RID,
) {
  const { next, play } = reduceReadySound(state, { restaurantId, enabled, readyIds });
  return { state: next, play };
}

// readyOrderIds ------------------------------------------------------------

test("readyOrderIds: только READY/READY_FOR_PICKUP выбранного ресторана", () => {
  const orders = [
    order("a", "READY"),
    order("b", "READY_FOR_PICKUP"),
    order("c", "PREPARING"),
    order("d", "DELIVERED"),
    order("e", "READY", "restaurant-2"),
  ];
  assert.deepEqual(readyOrderIds(orders, RID).sort(), ["a", "b"]);
});

// 1 -----------------------------------------------------------------------

test("первый baseline с READY → звука нет", () => {
  const r = step(initialReadySoundState(), ["a"]);
  assert.equal(r.play, false);
  assert.deepEqual(r.state.knownReadyIds, ["a"]);
});

// 2 -----------------------------------------------------------------------

test("PREPARING → READY: один звук", () => {
  let s = step(initialReadySoundState(), []); // baseline: нет готовых
  assert.equal(s.play, false);
  s = step(s.state, ["a"]); // появился готовый
  assert.equal(s.play, true);
});

// 3 -----------------------------------------------------------------------

test("PREPARING → READY_FOR_PICKUP: один звук", () => {
  // readyOrderIds уравнивает оба статуса; здесь важен факт нового id.
  const orders = [order("a", "READY_FOR_PICKUP")];
  let s = step(initialReadySoundState(), readyOrderIds([], RID)); // baseline []
  s = step(s.state, readyOrderIds(orders, RID));
  assert.equal(s.play, true);
});

// 4 -----------------------------------------------------------------------

test("READY остаётся READY: повторного звука нет", () => {
  let s = step(initialReadySoundState(), []);
  s = step(s.state, ["a"]);
  assert.equal(s.play, true);
  s = step(s.state, ["a"]); // тот же готовый на следующем тике
  assert.equal(s.play, false);
});

// 5 -----------------------------------------------------------------------

test("три заказа готовы в одном обновлении: один звук", () => {
  let s = step(initialReadySoundState(), []);
  s = step(s.state, ["a", "b", "c"]);
  assert.equal(s.play, true, "ровно один сигнал, а не три");
});

// 6 -----------------------------------------------------------------------

test("enabled=false: звука нет; backlog не звучит после включения; новый READY звучит", () => {
  let s = step(initialReadySoundState(), [], false); // baseline
  // Пока выключено — появился готовый: звука нет, но baseline обновился.
  s = step(s.state, ["a"], false);
  assert.equal(s.play, false);
  assert.deepEqual(s.state.knownReadyIds, ["a"]);
  // Включили звук: старый готовый «a» не должен прозвучать.
  s = step(s.state, ["a"], true);
  assert.equal(s.play, false, "backlog после включения не звучит");
  // Новый готовый после включения — звучит.
  s = step(s.state, ["a", "b"], true);
  assert.equal(s.play, true);
});

// 7 -----------------------------------------------------------------------

test("смена restaurantId: готовые нового ресторана становятся baseline без звука", () => {
  let s = step(initialReadySoundState(), ["a"], true, "restaurant-1");
  // Переключились на другой ресторан, где уже есть готовый заказ x.
  s = step(s.state, ["x"], true, "restaurant-2");
  assert.equal(s.play, false, "backlog нового ресторана не озвучивается");
  assert.equal(s.state.restaurantId, "restaurant-2");
  assert.deepEqual(s.state.knownReadyIds, ["x"]);
  // Дальнейший новый готовый уже озвучивается.
  s = step(s.state, ["x", "y"], true, "restaurant-2");
  assert.equal(s.play, true);
});

// 8 -----------------------------------------------------------------------

test("COMBINED (enabled=false всегда): дополнительного звука нет", () => {
  let s = step(initialReadySoundState(), [], false);
  s = step(s.state, ["a"], false);
  assert.equal(s.play, false);
  s = step(s.state, ["a", "b", "c"], false);
  assert.equal(s.play, false, "в общем режиме сигнал готовности не звучит");
});
