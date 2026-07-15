import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { addCartItem, createOrderFromCart } from "./actions.ts";
import {
  getAvailablePlatformDeliveryFeeCents,
  getClientRestaurantAvailabilityAt,
  getClientRestaurantScheduleSummary,
  getRestaurantAvailabilityStateAt,
  sortPublishedRestaurants,
} from "./selectors.ts";
import type {
  DaySchedule,
  OperationalPause,
  PrototypeState,
  Restaurant,
  WeeklySchedule,
} from "./models.ts";

const CLOSED: DaySchedule = { enabled: false, openTime: "", closeTime: "" };
const OPEN_9_22: DaySchedule = { enabled: true, openTime: "09:00", closeTime: "22:00" };
const NIGHT_18_02: DaySchedule = { enabled: true, openTime: "18:00", closeTime: "02:00" };

function week(over: Partial<Record<keyof WeeklySchedule, DaySchedule>>): WeeklySchedule {
  const base: WeeklySchedule = {
    monday: CLOSED, tuesday: CLOSED, wednesday: CLOSED, thursday: CLOSED,
    friday: CLOSED, saturday: CLOSED, sunday: CLOSED,
  };
  return { ...base, ...over };
}

function restaurant(over: Partial<Restaurant> = {}): Restaurant {
  return {
    status: "PUBLISHED",
    paymentMethods: ["ONLINE"],
    deliveryModes: ["PLATFORM_DRIVER"],
    isAcceptingOrders: true,
    orderPause: null,
    timeZone: "UTC",
    weeklySchedule: week({
      monday: OPEN_9_22, tuesday: OPEN_9_22, wednesday: OPEN_9_22,
      thursday: OPEN_9_22, friday: OPEN_9_22, saturday: OPEN_9_22, sunday: OPEN_9_22,
    }),
    ...over,
  } as unknown as Restaurant;
}

// Понедельник 12:00 UTC — рабочее время для OPEN_9_22.
const MON_NOON = Date.parse("2021-01-04T12:00:00Z");
const activePause: OperationalPause = {
  reason: "перегрузка",
  mode: "UNTIL_TIME",
  startedAt: "2021-01-04T11:00:00Z",
  resumeAt: "2021-01-04T13:00:00Z",
} as unknown as OperationalPause;
const expiredPause: OperationalPause = {
  reason: "перегрузка",
  mode: "UNTIL_TIME",
  startedAt: "2021-01-04T09:00:00Z",
  resumeAt: "2021-01-04T10:00:00Z",
} as unknown as OperationalPause;

// --- §14: единое availability state ------------------------------------------

test("1. график открыт + приём включён + нет паузы → ACCEPTING", () => {
  assert.equal(getRestaurantAvailabilityStateAt(restaurant(), MON_NOON), "ACCEPTING");
});

test("2. график закрыт + isAcceptingOrders=true → CLOSED_SCHEDULE", () => {
  const r = restaurant({ weeklySchedule: week({}) });
  assert.equal(getRestaurantAvailabilityStateAt(r, MON_NOON), "CLOSED_SCHEDULE");
});

test("3. график открыт + активная пауза → OPERATIONAL_PAUSE", () => {
  const r = restaurant({ orderPause: activePause });
  assert.equal(getRestaurantAvailabilityStateAt(r, MON_NOON), "OPERATIONAL_PAUSE");
});

test("4. график открыт + ручной приём выключен → ADMIN_DISABLED", () => {
  const r = restaurant({ isAcceptingOrders: false });
  assert.equal(getRestaurantAvailabilityStateAt(r, MON_NOON), "ADMIN_DISABLED");
});

test("5. истёкшая пауза + график открыт → ACCEPTING", () => {
  const r = restaurant({ orderPause: expiredPause, isAcceptingOrders: false });
  assert.equal(getRestaurantAvailabilityStateAt(r, MON_NOON), "ACCEPTING");
});

test("6. истёкшая пауза + график закрыт → CLOSED_SCHEDULE", () => {
  const r = restaurant({ orderPause: expiredPause, weeklySchedule: week({}) });
  assert.equal(getRestaurantAvailabilityStateAt(r, MON_NOON), "CLOSED_SCHEDULE");
});

test("7. ночной интервал до полуночи → ACCEPTING", () => {
  const r = restaurant({ weeklySchedule: week({ saturday: NIGHT_18_02 }) });
  const sat20 = Date.parse("2021-01-09T20:00:00Z");
  assert.equal(getRestaurantAvailabilityStateAt(r, sat20), "ACCEPTING");
});

test("8. ночной интервал после полуночи → ACCEPTING", () => {
  const r = restaurant({ weeklySchedule: week({ saturday: NIGHT_18_02 }) });
  const sun01 = Date.parse("2021-01-10T01:00:00Z"); // вс, продолжается сб-интервал
  assert.equal(getRestaurantAvailabilityStateAt(r, sun01), "ACCEPTING");
});

test("9. расчёт в часовом поясе ресторана (Нью-Йорк)", () => {
  // Пн 02:00 UTC = вс 21:00 в Нью-Йорке (EST). Открыт только воскресенье 09–22 → закрыто в 21:00? 21:00<=22:00 → открыт.
  const r = restaurant({
    timeZone: "America/New_York",
    weeklySchedule: week({ sunday: OPEN_9_22 }),
  });
  const instant = Date.parse("2021-01-04T02:00:00Z");
  assert.equal(getRestaurantAvailabilityStateAt(r, instant), "ACCEPTING");
});

// --- §14.10–12: доменные преграды -------------------------------------------

function closeRestaurantSchedule(
  state: PrototypeState,
  restaurantId: string,
): PrototypeState {
  return {
    ...state,
    restaurants: state.restaurants.map((r) =>
      r.id === restaurantId ? { ...r, weeklySchedule: week({}) } : r,
    ),
  };
}

test("10. CLOSED_SCHEDULE блокирует addCartItem", () => {
  const closed = closeRestaurantSchedule(createDefaultState(), "restaurant-1");
  const res = addCartItem(closed, "restaurant-1-item-1", "size-standard");
  assert.equal(res.result, "RESTAURANT_UNAVAILABLE");
});

test("11. CLOSED_SCHEDULE блокирует createOrderFromCart", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-1-item-1", "size-standard").state; // 24/7 seed → открыт
  s = closeRestaurantSchedule(s, "restaurant-1");
  s = { ...s, customer: { ...s.customer, name: "Тест", phone: "0691234567" } };
  const res = createOrderFromCart(s);
  assert.equal(res.result.orderId, null);
});

test("12. OPERATIONAL_PAUSE блокирует создание заказа", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-1-item-1", "size-standard").state;
  s = {
    ...s,
    customer: { ...s.customer, name: "Тест", phone: "0691234567" },
    restaurants: s.restaurants.map((r) =>
      r.id === "restaurant-1"
        ? {
            ...r,
            orderPause: {
              reason: "перегрузка",
              mode: "UNTIL_MANUAL",
              startedAt: "2026-07-12T00:00:00.000Z",
              resumeAt: null,
            } as unknown as OperationalPause,
          }
        : r,
    ),
  };
  const res = createOrderFromCart(s);
  assert.equal(res.result.orderId, null);
});

// --- §14.13–15 --------------------------------------------------------------

test("13. сортировка OPEN ставит фактически принимающие первыми", () => {
  const closed = closeRestaurantSchedule(createDefaultState(), "restaurant-1");
  const sorted = sortPublishedRestaurants(closed, "OPEN", MON_NOON);
  // Закрытый по графику restaurant-1 не должен быть первым; первым — принимающий.
  assert.equal(
    getRestaurantAvailabilityStateAt(sorted[0], MON_NOON),
    "ACCEPTING",
  );
  const firstClosedIndex = sorted.findIndex(
    (r) => getRestaurantAvailabilityStateAt(r, MON_NOON) !== "ACCEPTING",
  );
  const lastOpenIndex = sorted.reduce(
    (acc, r, i) =>
      getRestaurantAvailabilityStateAt(r, MON_NOON) === "ACCEPTING" ? i : acc,
    -1,
  );
  assert.ok(firstClosedIndex === -1 || firstClosedIndex > lastOpenIndex);
});

test("14. закрытый по графику ресторан не получает «Выгодную доставку»", () => {
  const state = createDefaultState();
  const direct = state.restaurants.find(
    (r) => r.deliveryProvider === "DIRECT" &&
      r.deliveryModes.includes("PLATFORM_DRIVER"),
  );
  assert.ok(direct);
  const closedState = closeRestaurantSchedule(state, direct.id);
  const closed = closedState.restaurants.find((r) => r.id === direct.id)!;
  // Закрытый по графику → тарифа нет (бейдж «Выгодная доставка» не появится).
  assert.equal(
    getAvailablePlatformDeliveryFeeCents(closedState, closed, MON_NOON),
    null,
  );
  // До гидратации (nowMs=0) — тоже null (ложный бейдж не показываем).
  const open = state.restaurants.find((r) => r.id === direct.id)!;
  assert.equal(getAvailablePlatformDeliveryFeeCents(state, open, 0), null);
});

test("15. клиентская подпись не противоречит schedule summary", () => {
  // График открыт, но активная пауза: summary.isOpen=true, но клиент НЕ «открыто».
  const r = restaurant({ orderPause: activePause });
  const summary = getClientRestaurantScheduleSummary(r, new Date(MON_NOON));
  const client = getClientRestaurantAvailabilityAt(r, MON_NOON);
  assert.equal(summary.isOpen, true); // по чистому графику открыт
  assert.equal(client.canAcceptOrders, false); // но заказ нельзя
  assert.equal(client.shortLabel, "Временно не принимает заказы");
  assert.ok(!/Открыто|Сейчас открыто/.test(client.shortLabel)); // не зелёный «открыто»
  assert.equal(client.tone, "paused");

  // Закрытый по графику: и summary, и клиент согласованно «закрыто».
  const closed = restaurant({ weeklySchedule: week({}) });
  const c2 = getClientRestaurantAvailabilityAt(closed, MON_NOON);
  assert.equal(c2.state, "CLOSED_SCHEDULE");
  assert.equal(c2.canAcceptOrders, false);
});
