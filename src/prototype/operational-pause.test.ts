import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  addCartItem,
  createOrderFromCart,
  pauseCategoryItems,
  pauseRestaurantOrders,
  restoreCategoryItems,
  restoreMenuItemAvailability,
  resumeExpiredOperationalPauses,
  resumeRestaurantOrders,
  setMenuItemOperationallyUnavailable,
  setRestaurantAcceptingOrders,
  updateCartAddress,
} from "./actions.ts";
import {
  computeNextOpeningIso,
  getRestaurant,
  isMenuItemAvailableAt,
  isRestaurantAcceptingOrdersAt,
} from "./selectors.ts";
import { normalizePrototypeState, upgradeToV6 } from "./prototype-store.ts";
import {
  WEEKDAY_ORDER,
  type PrototypeState,
  type WeeklySchedule,
} from "./models.ts";

const ADDR = { street: "Тестовая улица 1", house: "1" };

function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

// =============================== §23: пауза ресторана ========================

test("§23: пауза ставит isAcceptingOrders=false и создаёт orderPause", () => {
  const s = createDefaultState();
  const res = pauseRestaurantOrders(s, "restaurant-2", "Кухня перегружена", "MANUAL", null, "RESTAURANT");
  assert.equal(res.result.ok, true);
  const r = getRestaurant(res.state, "restaurant-2");
  assert.equal(r?.isAcceptingOrders, false);
  assert.ok(r?.orderPause);
  assert.equal(r?.orderPause?.reason, "Кухня перегружена");
  assert.equal(res.state.operationalEvents.length, 1);
});

test("§23: причина обязательна", () => {
  const s = createDefaultState();
  const res = pauseRestaurantOrders(s, "restaurant-2", "  ", "MANUAL", null, "RESTAURANT");
  assert.equal(res.result.ok, false);
});

test("§23: UNTIL_TIME требует будущий resumeAt", () => {
  const s = createDefaultState();
  const past = pauseRestaurantOrders(s, "restaurant-2", "проблема", "UNTIL_TIME", new Date(Date.now() - 1000).toISOString(), "RESTAURANT");
  assert.equal(past.result.ok, false);
  const ok = pauseRestaurantOrders(s, "restaurant-2", "проблема", "UNTIL_TIME", futureIso(15), "RESTAURANT");
  assert.equal(ok.result.ok, true);
});

test("§23: MANUAL имеет resumeAt=null", () => {
  const s = createDefaultState();
  const res = pauseRestaurantOrders(s, "restaurant-2", "проблема", "MANUAL", null, "RESTAURANT");
  assert.equal(getRestaurant(res.state, "restaurant-2")?.orderPause?.resumeAt, null);
});

test("§23: другой ресторан не меняется", () => {
  const s = createDefaultState();
  const res = pauseRestaurantOrders(s, "restaurant-2", "проблема", "MANUAL", null, "RESTAURANT");
  assert.equal(getRestaurant(res.state, "restaurant-1")?.isAcceptingOrders, true);
  assert.equal(getRestaurant(res.state, "restaurant-1")?.orderPause, null);
});

test("§23: активные заказы, snapshots и settlement не меняются при паузе", () => {
  let s = createDefaultState();
  s = updateCartAddress(s, ADDR);
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart(s);
  s = created.state;
  const orderId = created.result.orderId as string;
  const orderBefore = JSON.stringify(s.orders.find((o) => o.id === orderId));
  const settlementsBefore = JSON.stringify(s.settlements);
  const cartBefore = JSON.stringify(s.cart);

  const paused = pauseRestaurantOrders(s, "restaurant-2", "проблема", "MANUAL", null, "RESTAURANT").state;
  assert.equal(JSON.stringify(paused.orders.find((o) => o.id === orderId)), orderBefore);
  assert.equal(JSON.stringify(paused.settlements), settlementsBefore);
  assert.equal(JSON.stringify(paused.cart), cartBefore);
});

test("§23: addCartItem блокируется во время паузы", () => {
  let s = createDefaultState();
  s = pauseRestaurantOrders(s, "restaurant-2", "проблема", "MANUAL", null, "RESTAURANT").state;
  const res = addCartItem(s, "restaurant-2-item-1");
  assert.equal(res.result, "RESTAURANT_UNAVAILABLE");
});

test("§23: createOrderFromCart блокируется во время паузы", () => {
  let s = createDefaultState();
  s = updateCartAddress(s, ADDR);
  s = addCartItem(s, "restaurant-2-item-1").state;
  s = pauseRestaurantOrders(s, "restaurant-2", "проблема", "MANUAL", null, "RESTAURANT").state;
  const res = createOrderFromCart(s);
  assert.equal(res.result.orderId, null);
  assert.ok(res.result.error?.includes("временно не принимает"));
});

test("§23: временная пауза активна до resumeAt и снимается на границе", () => {
  const s = createDefaultState();
  const resumeAt = futureIso(15);
  const paused = pauseRestaurantOrders(s, "restaurant-2", "проблема", "UNTIL_TIME", resumeAt, "RESTAURANT").state;
  const r = getRestaurant(paused, "restaurant-2")!;
  const before = Date.parse(resumeAt) - 1000;
  assert.equal(isRestaurantAcceptingOrdersAt(r, before), false);
  // Ровно на границе (resumeAt) — уже принимает.
  assert.equal(isRestaurantAcceptingOrdersAt(r, Date.parse(resumeAt)), true);
});

test("§23: resumeExpired снимает истёкшую паузу, идемпотентно", () => {
  const s = createDefaultState();
  const resumeAt = futureIso(15);
  const paused = pauseRestaurantOrders(s, "restaurant-2", "проблема", "UNTIL_TIME", resumeAt, "RESTAURANT").state;
  const before = resumeExpiredOperationalPauses(paused, new Date(Date.parse(resumeAt) - 1000).toISOString());
  assert.equal(before, paused); // ничего не истекло — та же ссылка
  const after = resumeExpiredOperationalPauses(paused, resumeAt);
  const r = getRestaurant(after, "restaurant-2")!;
  assert.equal(r.isAcceptingOrders, true);
  assert.equal(r.orderPause, null);
  // Повторный вызов идемпотентен.
  assert.equal(resumeExpiredOperationalPauses(after, futureIso(60)), after);
});

test("§23: MANUAL пауза не снимается автоматически", () => {
  let s = createDefaultState();
  s = pauseRestaurantOrders(s, "restaurant-2", "проблема", "MANUAL", null, "RESTAURANT").state;
  const after = resumeExpiredOperationalPauses(s, futureIso(600));
  assert.equal(after, s);
});

test("§23: ручное возобновление очищает orderPause", () => {
  let s = createDefaultState();
  s = pauseRestaurantOrders(s, "restaurant-2", "проблема", "MANUAL", null, "RESTAURANT").state;
  s = resumeRestaurantOrders(s, "restaurant-2", "RESTAURANT").state;
  const r = getRestaurant(s, "restaurant-2")!;
  assert.equal(r.isAcceptingOrders, true);
  assert.equal(r.orderPause, null);
});

test("§23: setRestaurantAcceptingOrders очищает stale orderPause (§21)", () => {
  let s = createDefaultState();
  s = pauseRestaurantOrders(s, "restaurant-2", "проблема", "MANUAL", null, "RESTAURANT").state;
  s = setRestaurantAcceptingOrders(s, "restaurant-2", true);
  assert.equal(getRestaurant(s, "restaurant-2")?.orderPause, null);
});

test("§23: старое состояние получает orderPause=null (миграция)", () => {
  const legacy = upgradeToV6({
    schemaVersion: 6,
    revision: 1,
    nextOrderNumber: 5,
    restaurants: [{ id: "restaurant-9", name: "Старый", status: "PUBLISHED" }],
    orders: [],
  });
  assert.equal(legacy.restaurants[0].orderPause, null);
  assert.deepEqual(legacy.operationalEvents, []);
});

// =============================== §24: следующее открытие =====================

function scheduleAll(open: string, close: string): WeeklySchedule {
  return WEEKDAY_ORDER.reduce((acc, day) => {
    acc[day] = { enabled: true, openTime: open, closeTime: close };
    return acc;
  }, {} as WeeklySchedule);
}

function chisinauRestaurant(schedule: WeeklySchedule) {
  return {
    ...getRestaurant(createDefaultState(), "restaurant-1")!,
    timeZone: "Europe/Chisinau",
    weeklySchedule: schedule,
  };
}

function localHM(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Chisinau",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

test("§24: закрыт до сегодняшнего открытия → сегодняшнее открытие", () => {
  const r = chisinauRestaurant(scheduleAll("09:00", "22:00"));
  // 2026-07-13 06:00Z = Кишинёв 09:00? Июль UTC+3 → 09:00 — граница. Возьмём 05:00Z = 08:00 местного (до открытия).
  const now = Date.parse("2026-07-13T05:00:00Z");
  const next = computeNextOpeningIso(r, now);
  assert.ok(next);
  assert.ok(Date.parse(next!) > now);
  assert.equal(localHM(next!), "09:00");
});

test("§24: после закрытия → следующее рабочее открытие", () => {
  const r = chisinauRestaurant(scheduleAll("09:00", "22:00"));
  // 20:00Z = Кишинёв 23:00 (после закрытия) → завтра 09:00.
  const now = Date.parse("2026-07-13T20:00:00Z");
  const next = computeNextOpeningIso(r, now);
  assert.ok(next);
  assert.equal(localHM(next!), "09:00");
  assert.ok(Date.parse(next!) - now > 8 * 3600_000); // на следующий день
});

test("§24: выключенный день пропускается", () => {
  const schedule = scheduleAll("09:00", "22:00");
  // 2026-07-14 — вторник; выключим вторник, после закрытия понедельника → среда.
  schedule.tuesday = { enabled: false, openTime: "", closeTime: "" };
  const r = chisinauRestaurant(schedule);
  const now = Date.parse("2026-07-13T20:00:00Z"); // пн вечер
  const next = computeNextOpeningIso(r, now);
  assert.ok(next);
  // Должно быть не во вторник: разница > 24ч.
  assert.ok(Date.parse(next!) - now > 24 * 3600_000);
  assert.equal(localHM(next!), "09:00");
});

test("§24: нет рабочих дней → null, weeklySchedule не мутируется", () => {
  const schedule = WEEKDAY_ORDER.reduce((acc, day) => {
    acc[day] = { enabled: false, openTime: "", closeTime: "" };
    return acc;
  }, {} as WeeklySchedule);
  const r = chisinauRestaurant(schedule);
  const snapshot = JSON.stringify(schedule);
  assert.equal(computeNextOpeningIso(r, Date.now()), null);
  assert.equal(JSON.stringify(schedule), snapshot);
});

test("§24: используется timezone ресторана, а не UTC", () => {
  const r = chisinauRestaurant(scheduleAll("09:00", "22:00"));
  const now = Date.parse("2026-07-13T05:00:00Z");
  const next = computeNextOpeningIso(r, now)!;
  // Инстант соответствует 09:00 в Кишинёве = 06:00Z (июль UTC+3).
  assert.equal(new Date(next).toISOString(), "2026-07-13T06:00:00.000Z");
});

// =============================== §25: доступность блюда ======================

test("§25: отключается только нужное блюдо, цена и variants не меняются", () => {
  const s = createDefaultState();
  const before = s.menuItems.find((m) => m.id === "restaurant-2-item-1")!;
  const priceBefore = before.priceCents;
  const variantsBefore = JSON.stringify(before.variants);
  const res = setMenuItemOperationallyUnavailable(s, "restaurant-2", "restaurant-2-item-1", "Закончилось блюдо", "MANUAL", null, "RESTAURANT");
  const item = res.state.menuItems.find((m) => m.id === "restaurant-2-item-1")!;
  assert.equal(item.available, false);
  assert.ok(item.availabilityPause);
  assert.equal(item.priceCents, priceBefore);
  assert.equal(JSON.stringify(item.variants), variantsBefore);
  // другое блюдо того же ресторана не тронуто
  assert.equal(res.state.menuItems.find((m) => m.id === "restaurant-2-item-2")?.available, true);
});

test("§25: блюдо другого ресторана нельзя отключить через чужой restaurantId", () => {
  const s = createDefaultState();
  const res = setMenuItemOperationallyUnavailable(s, "restaurant-1", "restaurant-2-item-1", "причина", "MANUAL", null, "RESTAURANT");
  assert.equal(res.result.ok, false);
});

test("§25: исторический snapshot заказа не меняется при отключении блюда", () => {
  let s = createDefaultState();
  s = updateCartAddress(s, ADDR);
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart(s);
  s = created.state;
  const orderId = created.result.orderId as string;
  const snapBefore = JSON.stringify(s.orders.find((o) => o.id === orderId)!.items);
  const finBefore = JSON.stringify(s.orders.find((o) => o.id === orderId)!.financials);
  s = setMenuItemOperationallyUnavailable(s, "restaurant-2", "restaurant-2-item-1", "причина", "MANUAL", null, "RESTAURANT").state;
  const order = s.orders.find((o) => o.id === orderId)!;
  assert.equal(JSON.stringify(order.items), snapBefore);
  assert.equal(JSON.stringify(order.financials), finBefore);
  assert.equal(s.settlements.length, 0);
});

test("§25: addCartItem возвращает NOT_AVAILABLE для отключённого блюда", () => {
  let s = createDefaultState();
  s = setMenuItemOperationallyUnavailable(s, "restaurant-2", "restaurant-2-item-1", "причина", "MANUAL", null, "RESTAURANT").state;
  assert.equal(addCartItem(s, "restaurant-2-item-1").result, "NOT_AVAILABLE");
});

test("§25: createOrderFromCart отклоняет корзину с отключённым блюдом, корзина не очищается", () => {
  let s = createDefaultState();
  s = updateCartAddress(s, ADDR);
  s = addCartItem(s, "restaurant-2-item-1").state;
  s = setMenuItemOperationallyUnavailable(s, "restaurant-2", "restaurant-2-item-1", "причина", "MANUAL", null, "RESTAURANT").state;
  const cartBefore = JSON.stringify(s.cart);
  const res = createOrderFromCart(s);
  assert.equal(res.result.orderId, null);
  assert.equal(JSON.stringify(res.state.cart), cartBefore);
});

test("§25: временная недоступность снимается на границе resumeAt, MANUAL — нет", () => {
  const s = createDefaultState();
  const resumeAt = futureIso(30);
  const temp = setMenuItemOperationallyUnavailable(s, "restaurant-2", "restaurant-2-item-1", "причина", "UNTIL_TIME", resumeAt, "RESTAURANT").state;
  const item = temp.menuItems.find((m) => m.id === "restaurant-2-item-1")!;
  assert.equal(isMenuItemAvailableAt(item, Date.parse(resumeAt) - 1000), false);
  assert.equal(isMenuItemAvailableAt(item, Date.parse(resumeAt)), true);
  // sweep снимает
  const swept = resumeExpiredOperationalPauses(temp, resumeAt);
  assert.equal(swept.menuItems.find((m) => m.id === "restaurant-2-item-1")?.available, true);
  // MANUAL не снимается
  const manual = setMenuItemOperationallyUnavailable(s, "restaurant-2", "restaurant-2-item-1", "причина", "MANUAL", null, "RESTAURANT").state;
  assert.equal(resumeExpiredOperationalPauses(manual, futureIso(600)), manual);
});

test("§25: ручное возвращение очищает availabilityPause, повтор идемпотентен", () => {
  let s = createDefaultState();
  s = setMenuItemOperationallyUnavailable(s, "restaurant-2", "restaurant-2-item-1", "причина", "MANUAL", null, "RESTAURANT").state;
  s = restoreMenuItemAvailability(s, "restaurant-2", "restaurant-2-item-1", "RESTAURANT").state;
  const item = s.menuItems.find((m) => m.id === "restaurant-2-item-1")!;
  assert.equal(item.available, true);
  assert.equal(item.availabilityPause, null);
  // повтор ничего не создаёт
  const again = restoreMenuItemAvailability(s, "restaurant-2", "restaurant-2-item-1", "RESTAURANT");
  assert.equal(again.state, s);
});

test("§25: старое available=false остаётся false, availabilityPause=null после миграции", () => {
  const legacy = normalizePrototypeState({
    ...createDefaultState(),
    menuItems: [
      {
        id: "x-1",
        restaurantId: "restaurant-1",
        category: "Основное",
        name: "Старое",
        description: "",
        priceCents: 500,
        currencyCode: "USD",
        available: false,
      } as unknown as PrototypeState["menuItems"][number],
    ],
  });
  const item = legacy.menuItems.find((m) => m.id === "x-1")!;
  assert.equal(item.available, false);
  assert.equal(item.availabilityPause, null);
});

// =============================== §26: массовая категория =====================

test("§26: массовое отключение меняет только доступные блюда категории", () => {
  const s = createDefaultState();
  // Сначала одно блюдо «Пиццы» уже отключим вручную с поздним сроком.
  const pre = setMenuItemOperationallyUnavailable(s, "restaurant-2", "restaurant-2-item-3", "закончилось", "MANUAL", null, "RESTAURANT").state;
  const preSnapshot = JSON.stringify(pre.menuItems.find((m) => m.id === "restaurant-2-item-3")!.availabilityPause);

  const res = pauseCategoryItems(pre, "restaurant-2", "Пиццы", "Кухня перегружена", "MANUAL", null, "RESTAURANT");
  assert.equal(res.result.ok, true);
  // item-1 и item-2 были доступны → отключены (2), item-3 уже был недоступен → не тронут.
  assert.equal(res.result.affected, 2);
  assert.equal(res.state.menuItems.find((m) => m.id === "restaurant-2-item-1")?.available, false);
  assert.equal(res.state.menuItems.find((m) => m.id === "restaurant-2-item-2")?.available, false);
  assert.equal(
    JSON.stringify(res.state.menuItems.find((m) => m.id === "restaurant-2-item-3")!.availabilityPause),
    preSnapshot,
  );
  // Другая категория «Напитки» не тронута.
  assert.equal(res.state.menuItems.find((m) => m.id === "restaurant-2-item-4")?.available, true);
  // Другой ресторан не тронут.
  assert.equal(res.state.menuItems.find((m) => m.id === "restaurant-1-item-1")?.available, true);
  // Одно событие на каждое изменённое блюдо.
  const pausedEvents = res.state.operationalEvents.filter((e) => e.action === "MENU_ITEM_UNAVAILABLE");
  assert.equal(pausedEvents.length, 3); // 1 ручное + 2 массовых
});

test("§26: массовый возврат меняет только недоступные блюда категории", () => {
  let s = createDefaultState();
  s = pauseCategoryItems(s, "restaurant-2", "Пиццы", "причина", "MANUAL", null, "RESTAURANT").state;
  const res = restoreCategoryItems(s, "restaurant-2", "Пиццы", "RESTAURANT");
  assert.equal(res.result.affected, 3);
  assert.equal(res.state.menuItems.find((m) => m.id === "restaurant-2-item-1")?.available, true);
  // Повторный возврат ничего не меняет.
  const again = restoreCategoryItems(res.state, "restaurant-2", "Пиццы", "RESTAURANT");
  assert.equal(again.result.affected, 0);
});
