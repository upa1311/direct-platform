import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KITCHEN_START_REPEAT_INTERVAL_MS,
  preparingAwaitingKitchenStartIds,
} from "./split-kitchen-preparing-sound.ts";
import { isKitchenBeepDue } from "../../prototype/selectors.ts";
import type { Order, OrderStatus } from "../../prototype/models.ts";

/**
 * Кухонный сигнал ожидания подтверждения начала приготовления (SPLIT): пока в
 * PREPARING есть заказ с kitchenStartedAt === null, сигнал повторяется каждые
 * KITCHEN_START_REPEAT_INTERVAL_MS. Кандидатов отбирает preparingAwaitingKitchenStartIds,
 * расписание считает общий isKitchenBeepDue — здесь проверяем обе чистые части.
 */

const RID = "restaurant-1";
const T0 = 100_000;

function order(
  id: string,
  status: OrderStatus,
  kitchenStartedAt: string | null,
  restaurantId = RID,
): Order {
  return {
    id,
    status,
    kitchenStartedAt,
    restaurant: { id: restaurantId, name: "R", address: "", zoneId: "zone-1" },
  } as unknown as Order;
}

// Константа --------------------------------------------------------------------

test("интервал повтора — именованная константа = 20 000 мс", () => {
  assert.equal(KITCHEN_START_REPEAT_INTERVAL_MS, 20_000);
});

// preparingAwaitingKitchenStartIds --------------------------------------------

test("кандидаты: только PREPARING с kitchenStartedAt===null выбранного ресторана", () => {
  const orders = [
    order("a", "PREPARING", null), // ждёт подтверждения — кандидат
    order("b", "PREPARING", "2026-07-19T10:00:00.000Z"), // уже начат — не кандидат
    order("c", "AWAITING_PAYMENT", null), // не PREPARING
    order("d", "READY", null), // не PREPARING
    order("e", "PREPARING", null, "restaurant-2"), // другой ресторан
  ];
  assert.deepEqual(preparingAwaitingKitchenStartIds(orders, RID), ["a"]);
});

test("после подтверждения начала заказ выпадает из набора", () => {
  const waiting = [order("a", "PREPARING", null)];
  assert.deepEqual(preparingAwaitingKitchenStartIds(waiting, RID), ["a"]);
  const started = [order("a", "PREPARING", "2026-07-19T10:00:00.000Z")];
  assert.deepEqual(preparingAwaitingKitchenStartIds(started, RID), []);
});

// Расписание (isKitchenBeepDue + интервал начала) ------------------------------

// 8 --------------------------------------------------------------------------

test("первый кандидат появился → сигнал сразу", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a"],
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: T0,
      intervalMs: KITCHEN_START_REPEAT_INTERVAL_MS,
    }),
    true,
  );
});

// 9 --------------------------------------------------------------------------

test("через 19 999 мс того же набора → тишина", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a"],
      announcedOrderIds: ["a"],
      lastBeepAtMs: T0,
      nowMs: T0 + KITCHEN_START_REPEAT_INTERVAL_MS - 1,
      intervalMs: KITCHEN_START_REPEAT_INTERVAL_MS,
    }),
    false,
  );
});

// 10 -------------------------------------------------------------------------

test("через 20 000 мс → повтор", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a"],
      announcedOrderIds: ["a"],
      lastBeepAtMs: T0,
      nowMs: T0 + KITCHEN_START_REPEAT_INTERVAL_MS,
      intervalMs: KITCHEN_START_REPEAT_INTERVAL_MS,
    }),
    true,
  );
});

// 11 -------------------------------------------------------------------------

test("после kitchenStartedAt повторы прекращаются (пустой набор → сигнала нет)", () => {
  // Кандидат подтверждён и выпал из набора — расписание сбрасывается.
  assert.equal(preparingAwaitingKitchenStartIds([order("a", "PREPARING", "2026-07-19T10:00:00.000Z")], RID).length, 0);
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: [],
      announcedOrderIds: ["a"],
      lastBeepAtMs: T0,
      nowMs: T0 + 3 * KITCHEN_START_REPEAT_INTERVAL_MS,
      intervalMs: KITCHEN_START_REPEAT_INTERVAL_MS,
    }),
    false,
  );
});

// 12 -------------------------------------------------------------------------

test("несколько ожидающих заказов → один сигнал на цикл", () => {
  // Три ожидающих сразу — один булев true, не три.
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a", "b", "c"],
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: T0,
      intervalMs: KITCHEN_START_REPEAT_INTERVAL_MS,
    }),
    true,
  );
  // После объявления всех — до интервала повтора нет.
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a", "b", "c"],
      announcedOrderIds: ["a", "b", "c"],
      lastBeepAtMs: T0,
      nowMs: T0 + 5_000,
      intervalMs: KITCHEN_START_REPEAT_INTERVAL_MS,
    }),
    false,
  );
});

// 13 -------------------------------------------------------------------------

test("новый ожидающий id между циклами → немедленный сигнал", () => {
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: ["a", "b"], // b — новый ожидающий
      announcedOrderIds: ["a"],
      lastBeepAtMs: T0,
      nowMs: T0 + 5_000, // < интервала
      intervalMs: KITCHEN_START_REPEAT_INTERVAL_MS,
    }),
    true,
  );
});
