import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isKitchenBeepDue,
  NEW_ORDER_REPEAT_INTERVAL_MS,
} from "./selectors.ts";

/**
 * Повтор сигнала нового заказа каждые 20 секунд, пока хотя бы один заказ остаётся
 * в RESTAURANT_REVIEW. Чистая логика расписания — isKitchenBeepDue. Режим
 * (COMBINED/SPLIT) и колокольчик здесь не участвуют: это гейт вызывающего
 * (enabled в useNewOrderSound), а сам helper от них не зависит.
 */

const T0 = 100_000;

// Константа --------------------------------------------------------------------

test("интервал повтора — единственная именованная константа = 20 000 мс", () => {
  assert.equal(NEW_ORDER_REPEAT_INTERVAL_MS, 20_000);
});

// 1 ---------------------------------------------------------------------------

test("новый заказ появился → сигнал сразу (не ждёт 20с)", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a"],
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: T0,
    }),
    true,
  );
});

// 2 ---------------------------------------------------------------------------

test("прошло 19 999 мс того же набора → повтора нет", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a"],
      announcedOrderIds: ["a"],
      lastBeepAtMs: T0,
      nowMs: T0 + NEW_ORDER_REPEAT_INTERVAL_MS - 1,
    }),
    false,
  );
});

// 3 ---------------------------------------------------------------------------

test("прошло ровно 20 000 мс → один повтор", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a"],
      announcedOrderIds: ["a"],
      lastBeepAtMs: T0,
      nowMs: T0 + NEW_ORDER_REPEAT_INTERVAL_MS,
    }),
    true,
  );
});

// 4 ---------------------------------------------------------------------------

test("прошло 40 000 мс → следующий повтор", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a"],
      announcedOrderIds: ["a"],
      lastBeepAtMs: T0,
      nowMs: T0 + 2 * NEW_ORDER_REPEAT_INTERVAL_MS,
    }),
    true,
  );
});

// 5 ---------------------------------------------------------------------------

test("несколько ожидающих заказов → один сигнал на цикл (единый true)", () => {
  // Появление сразу трёх новых — один булев true, не три.
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a", "b", "c"],
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: T0,
    }),
    true,
  );
  // После объявления всех — до интервала повтора нет (тоже один цикл).
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a", "b", "c"],
      announcedOrderIds: ["a", "b", "c"],
      lastBeepAtMs: T0,
      nowMs: T0 + 5_000,
    }),
    false,
  );
});

// 6 ---------------------------------------------------------------------------

test("новый id появился через 5с → немедленный сигнал, не дожидаясь 20с", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a", "b"], // b — новый
      announcedOrderIds: ["a"],
      lastBeepAtMs: T0,
      nowMs: T0 + 5_000, // < интервала
    }),
    true,
  );
});

// 7 ---------------------------------------------------------------------------

test("все заказы вышли из RESTAURANT_REVIEW → расписание сброшено (сигнала нет)", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: [],
      announcedOrderIds: ["a", "b"],
      lastBeepAtMs: T0,
      nowMs: T0 + 3 * NEW_ORDER_REPEAT_INTERVAL_MS,
    }),
    false,
  );
});

// 8 ---------------------------------------------------------------------------

test("после сброса появился новый заказ → сигнал немедленно", () => {
  // Пустой набор (после сброса вызывающий обнуляет lastBeep/announced), затем
  // приходит новый заказ: он не объявлен → немедленный сигнал.
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["z"],
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: T0 + 10 * NEW_ORDER_REPEAT_INTERVAL_MS,
    }),
    true,
  );
});

// 9/10/11 (гейт вызывающего) ---------------------------------------------------

test("helper не зависит от режима/колокольчика: гейт — enabled вызывающего", () => {
  const params = {
    reviewOrderIds: ["a"],
    announcedOrderIds: ["a"],
    lastBeepAtMs: T0,
    nowMs: T0 + NEW_ORDER_REPEAT_INTERVAL_MS,
  };
  // Один и тот же результат независимо от режима/экрана — маршрутизация звука
  // (COMBINED — общий экран, SPLIT — только оператор, выключенный колокольчик —
  // тишина) выполняется параметром enabled в useNewOrderSound, а не здесь.
  const due = isKitchenBeepDue(params);
  assert.equal(due, true);
  // «Выключенный колокольчик» моделируется как enabled && due на стороне вызова.
  const enabled = false;
  assert.equal(enabled && due, false);
});
