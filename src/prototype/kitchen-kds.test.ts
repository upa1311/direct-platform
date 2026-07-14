import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { pauseRestaurantOrders } from "./actions.ts";
import {
  getKitchenAcceptanceState,
  getRestaurant,
  getRestaurantResumeHint,
} from "./selectors.ts";
import type { OperationalPause, Restaurant, WeeklySchedule } from "./models.ts";
import { WEEKDAY_ORDER } from "./models.ts";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

function restaurantWith(overrides: Partial<Restaurant>): Restaurant {
  return { ...getRestaurant(createDefaultState(), "restaurant-2")!, ...overrides };
}

function pausedRestaurant(
  timeZone: string,
  pause: OperationalPause | null,
): Restaurant {
  return {
    ...getRestaurant(createDefaultState(), "restaurant-2")!,
    timeZone,
    orderPause: pause,
  };
}

const resumeAt = "2026-07-13T12:30:00.000Z";
const now = Date.parse("2026-07-13T12:00:00.000Z");

test("§16.1: подсказка возобновления использует timeZone ресторана", () => {
  const pause: OperationalPause = {
    startedAt: "2026-07-13T11:00:00.000Z",
    reason: "Кухня перегружена",
    mode: "UNTIL_TIME",
    resumeAt,
    startedBy: "RESTAURANT",
  };
  // Кишинёв (июль UTC+3): 12:30Z → 15:30.
  assert.equal(
    getRestaurantResumeHint(pausedRestaurant("Europe/Chisinau", pause), now),
    "Приём заказов возобновится примерно в 15:30.",
  );
  // UTC: 12:30.
  assert.equal(
    getRestaurantResumeHint(pausedRestaurant("UTC", pause), now),
    "Приём заказов возобновится примерно в 12:30.",
  );
});

test("§16.2: MANUAL-пауза не показывает время (null)", () => {
  const manual: OperationalPause = {
    startedAt: "2026-07-13T11:00:00.000Z",
    reason: "Техническая проблема",
    mode: "MANUAL",
    resumeAt: null,
    startedBy: "RESTAURANT",
  };
  assert.equal(
    getRestaurantResumeHint(pausedRestaurant("Europe/Chisinau", manual), now),
    null,
  );
});

test("§16.5: UNTIL_NEXT_OPEN без рабочих дней → ошибка, а не ложный успех", () => {
  const noDays = WEEKDAY_ORDER.reduce((acc, day) => {
    acc[day] = { enabled: false, openTime: "", closeTime: "" };
    return acc;
  }, {} as WeeklySchedule);
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === "restaurant-2" ? { ...r, weeklySchedule: noDays } : r,
    ),
  };
  const res = pauseRestaurantOrders(
    s,
    "restaurant-2",
    "Скоро закрытие",
    "UNTIL_NEXT_OPEN",
    null,
    "RESTAURANT",
  );
  assert.equal(res.result.ok, false);
  assert.ok(res.result.error?.includes("До ручного включения"));
  // Ресторан не поставлен на паузу (состояние не изменилось ложно).
  assert.equal(getRestaurant(res.state, "restaurant-2")?.orderPause, null);
  assert.equal(getRestaurant(res.state, "restaurant-2")?.isAcceptingOrders, true);
});

test("§16.6: доменная пауза/возобновление продолжают работать (без изменений логики)", () => {
  const s = createDefaultState();
  const res = pauseRestaurantOrders(s, "restaurant-2", "Кухня перегружена", "MANUAL", null, "RESTAURANT");
  assert.equal(res.result.ok, true);
  assert.equal(getRestaurant(res.state, "restaurant-2")?.isAcceptingOrders, false);
});

// --- Единое состояние приёма кухни (getKitchenAcceptanceState) --------------

test("состояние приёма: isAcceptingOrders=true, orderPause=null → ACCEPTING", () => {
  const r = restaurantWith({ isAcceptingOrders: true, orderPause: null });
  assert.equal(getKitchenAcceptanceState(r, NOW), "ACCEPTING");
});

test("состояние приёма: активная пауза → OPERATIONAL_PAUSE", () => {
  const r = restaurantWith({
    isAcceptingOrders: false,
    orderPause: {
      startedAt: "2026-07-14T11:50:00.000Z",
      reason: "Кухня перегружена",
      mode: "UNTIL_TIME",
      resumeAt: "2026-07-14T12:15:00.000Z", // в будущем
      startedBy: "RESTAURANT",
    },
  });
  assert.equal(getKitchenAcceptanceState(r, NOW), "OPERATIONAL_PAUSE");
});

test("состояние приёма: истёкшая пауза до sweep → ACCEPTING", () => {
  const r = restaurantWith({
    isAcceptingOrders: false, // sweep ещё не нормализовал
    orderPause: {
      startedAt: "2026-07-14T11:00:00.000Z",
      reason: "Кухня перегружена",
      mode: "UNTIL_TIME",
      resumeAt: "2026-07-14T11:55:00.000Z", // уже в прошлом
      startedBy: "RESTAURANT",
    },
  });
  assert.equal(getKitchenAcceptanceState(r, NOW), "ACCEPTING");
});

test("состояние приёма: isAcceptingOrders=false, orderPause=null → ADMIN_DISABLED", () => {
  const r = restaurantWith({ isAcceptingOrders: false, orderPause: null });
  assert.equal(getKitchenAcceptanceState(r, NOW), "ADMIN_DISABLED");
});

test("ADMIN_DISABLED никогда не выводится как ACCEPTING", () => {
  const r = restaurantWith({ isAcceptingOrders: false, orderPause: null });
  const state = getKitchenAcceptanceState(r, NOW);
  assert.notEqual(state, "ACCEPTING");
  assert.notEqual(state, "OPERATIONAL_PAUSE");
  assert.equal(state, "ADMIN_DISABLED");
});

test("getKitchenAcceptanceState не мутирует данные (финансы/заказы/события)", () => {
  const s = createDefaultState();
  const before = JSON.stringify(s);
  getKitchenAcceptanceState(getRestaurant(s, "restaurant-2")!, NOW);
  assert.equal(JSON.stringify(s), before);
  assert.equal(s.operationalEvents.length, 0);
  assert.equal(s.settlements.length, 0);
});
