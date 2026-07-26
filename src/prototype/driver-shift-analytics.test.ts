import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { parseStoredState, finalizeMutation, driverOperationalEventId } from "./prototype-store.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type {
  DriverOffer,
  DriverOperationalEvent,
  DriverStatus,
  PrototypeState,
  ZoneId,
} from "./models.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  assignDriverToOrder,
  changeDriverZone,
  confirmDriverZone,
  createOrderFromCart,
  goDriverOffline,
  goDriverOnline,
  markOrderReady,
  pauseDriver,
  resumeDriver,
  simulateSuccessfulOnlinePayment,
  unassignDriverFromOrder,
  updateCartAddress,
  updateDriverStatusNote,
} from "./actions.ts";
import {
  markDriverArrivedAtRestaurant,
  markDriverArrivingToCustomer,
  markDriverDeliveredOrder,
  markDriverPickedUpOrder,
} from "./driver-delivery.ts";
import { createDriverPayoutBatch } from "./driver-payouts.ts";
import { getDriverSettlementPeriodView } from "./driver-earnings.ts";
import {
  getDriverShiftAnalyticsView,
  getAdminDriverShiftAnalyticsView,
} from "./driver-shift-analytics.ts";
import {
  getLocalDateParts,
  localMidnightToUtcMs,
  shiftCalendarDate,
} from "./local-calendar.ts";

/**
 * Driver Shift Analytics (v28): операционный журнал водителя, автоматически
 * пишущийся в finalizeMutation, и read-model рабочего времени. Источник времени —
 * только реальные изменения status/currentZoneId, без GPS/heartbeat/Date.now в
 * read-model. Проверяем создание событий, строгую цепочку, периоды/длительности,
 * зоны, предложения, метрики и персистентность.
 */

const DRIVER = "driver-1";
const TZ = "Europe/Chisinau";
const MIN = 60_000;

const evId = (rev: number) => driverOperationalEventId(DRIVER, rev);

function mkEvent(
  revision: number,
  occurredAt: string,
  statusBefore: DriverStatus,
  statusAfter: DriverStatus,
  zoneBefore: ZoneId | null,
  zoneAfter: ZoneId | null,
): DriverOperationalEvent {
  return {
    id: evId(revision),
    revision,
    driverId: DRIVER,
    occurredAt,
    statusBefore,
    statusAfter,
    currentZoneIdBefore: zoneBefore,
    currentZoneIdAfter: zoneAfter,
  };
}

/** Состояние с ручным журналом; профиль driver-1 = последнее событие (если нет override). */
function analyticsState(
  events: DriverOperationalEvent[],
  override?: { status?: DriverStatus; currentZoneId?: ZoneId | null },
): PrototypeState {
  const base = createDefaultState();
  const last = events[events.length - 1];
  const status = override?.status ?? last?.statusAfter ?? "OFFLINE";
  const currentZoneId =
    override && "currentZoneId" in override
      ? (override.currentZoneId ?? null)
      : (last?.currentZoneIdAfter ?? null);
  const drivers = base.drivers.map((d) =>
    d.id === DRIVER ? { ...d, status, currentZoneId } : d,
  );
  const maxRev = events.reduce((m, e) => Math.max(m, e.revision), base.revision);
  return {
    ...base,
    drivers,
    driverOperationalEvents: events,
    revision: maxRev + 1,
  };
}

const view = (
  state: PrototypeState,
  period: Parameters<typeof getDriverShiftAnalyticsView>[2],
  nowIso: string,
) => getDriverShiftAnalyticsView(state, DRIVER, period, nowIso, TZ);

/** Завершает один ONLINE-заказ водителем driver-1 (реальные действия, real time). */
function completeOnlineOrder(state: PrototypeState): {
  state: PrototypeState;
  orderId: string;
} {
  let s = updateCartAddress(state, {
    street: "Садовый переулок",
    house: "5",
    apartment: "12",
  });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, orderId);
  s = markOrderReady(s, orderId);
  s = assignDriverToOrder(s, orderId, DRIVER).state;
  const a = new Date();
  const iso = (offset: number) => new Date(a.getTime() + offset).toISOString();
  s = markDriverArrivedAtRestaurant(s, DRIVER, orderId, iso(1000)).state;
  s = markDriverPickedUpOrder(s, DRIVER, orderId, iso(2000)).state;
  s = markDriverArrivingToCustomer(s, DRIVER, orderId, iso(3000)).state;
  const r = markDriverDeliveredOrder(s, DRIVER, orderId, iso(4000), {
    cashCollectionConfirmed: false,
  });
  assert.equal(r.result.ok, true, r.result.error ?? "");
  return { state: r.state, orderId };
}

const driverOf = (s: PrototypeState) => s.drivers.find((d) => d.id === DRIVER)!;
const eventsOf = (s: PrototypeState) =>
  s.driverOperationalEvents.filter((e) => e.driverId === DRIVER);

// --- §27 создание событий -----------------------------------------------------

test("1/2/3: схема 28, default events пусты, schema27 мигрирует пустым журналом", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 28);
  assert.deepEqual(createDefaultState().driverOperationalEvents, []);
  const parsed = parseStoredState(
    JSON.stringify({ ...createDefaultState(), schemaVersion: 27 }),
  );
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, 28);
  assert.deepEqual(parsed.driverOperationalEvents, []);
});

test("4: OFFLINE → AVAILABLE создаёт событие", () => {
  const s = goDriverOnline(createDefaultState(), DRIVER, "zone-1").state;
  const ev = eventsOf(s);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].statusBefore, "OFFLINE");
  assert.equal(ev[0].statusAfter, "AVAILABLE");
  assert.equal(ev[0].currentZoneIdAfter, "zone-1");
  assert.equal(ev[0].driverId, DRIVER);
  assert.equal(ev[0].revision, s.revision);
});

test("5/6: AVAILABLE → PAUSED и PAUSED → AVAILABLE создают события", () => {
  let s = goDriverOnline(createDefaultState(), DRIVER, "zone-1").state;
  s = pauseDriver(s, DRIVER).state;
  let ev = eventsOf(s);
  assert.equal(ev.length, 2);
  assert.equal(ev[1].statusBefore, "AVAILABLE");
  assert.equal(ev[1].statusAfter, "PAUSED");
  s = resumeDriver(s, DRIVER).state;
  ev = eventsOf(s);
  assert.equal(ev.length, 3);
  assert.equal(ev[2].statusBefore, "PAUSED");
  assert.equal(ev[2].statusAfter, "AVAILABLE");
});

test("7: AVAILABLE → OFFLINE создаёт событие", () => {
  let s = goDriverOnline(createDefaultState(), DRIVER, "zone-1").state;
  s = goDriverOffline(s, DRIVER).state;
  const ev = eventsOf(s);
  assert.equal(ev[ev.length - 1].statusAfter, "OFFLINE");
});

test("8: смена currentZoneId при одинаковом статусе создаёт событие", () => {
  let s = goDriverOnline(createDefaultState(), DRIVER, "zone-1").state;
  const before = eventsOf(s).length;
  s = changeDriverZone(s, DRIVER, "zone-3").state;
  const ev = eventsOf(s);
  assert.equal(ev.length, before + 1);
  const last = ev[ev.length - 1];
  assert.equal(last.statusBefore, "AVAILABLE");
  assert.equal(last.statusAfter, "AVAILABLE");
  assert.equal(last.currentZoneIdBefore, "zone-1");
  assert.equal(last.currentZoneIdAfter, "zone-3");
});

test("9/10/11: назначение → BUSY, доставка → ZONE_CONFIRMATION, подтверждение → AVAILABLE", () => {
  const online = goDriverOnline(createDefaultState(), DRIVER, "zone-2").state;
  const { state: delivered } = completeOnlineOrder(online);
  const ev = eventsOf(delivered);
  const statuses = ev.map((e) => e.statusAfter);
  assert.ok(statuses.includes("BUSY_DIRECT"));
  assert.ok(statuses.includes("ZONE_CONFIRMATION_REQUIRED"));
  assert.equal(driverOf(delivered).status, "ZONE_CONFIRMATION_REQUIRED");
  const confirmed = confirmDriverZone(
    delivered,
    DRIVER,
    driverOf(delivered).suggestedZoneId as ZoneId,
    "AVAILABLE",
  ).state;
  assert.equal(driverOf(confirmed).status, "AVAILABLE");
  assert.equal(eventsOf(confirmed).at(-1)?.statusAfter, "AVAILABLE");
});

test("12: снятие назначения освобождает водителя и создаёт событие", () => {
  const online = goDriverOnline(createDefaultState(), DRIVER, "zone-2").state;
  // Создаём и назначаем заказ, затем снимаем назначение.
  let s = updateCartAddress(online, { street: "Садовый переулок", house: "5", apartment: "12" });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, orderId);
  s = markOrderReady(s, orderId);
  s = assignDriverToOrder(s, orderId, DRIVER).state;
  assert.equal(driverOf(s).status, "BUSY_DIRECT");
  const beforeCount = eventsOf(s).length;
  const released = unassignDriverFromOrder(s, orderId, "analytics test").state;
  assert.notEqual(driverOf(released).status, "BUSY_DIRECT");
  assert.ok(eventsOf(released).length > beforeCount);
});

test("13/14: изменение заметки и payout-действие событий не создают", () => {
  const online = goDriverOnline(createDefaultState(), DRIVER, "zone-1").state;
  const noteCount = eventsOf(online).length;
  const noted = updateDriverStatusNote(online, DRIVER, "Жду заказ", "2026-07-22T10:00:00.000Z").state;
  assert.equal(eventsOf(noted).length, noteCount);
  // Payout действие на состоянии без eligible earnings — отклоняется, событий нет.
  const payout = createDriverPayoutBatch(
    online,
    { driverId: DRIVER, earningEntryIds: ["nope"], method: "BANK_TRANSFER", externalReference: null, note: null },
    "2026-07-22T10:00:00.000Z",
  );
  assert.equal(eventsOf(payout.state).length, noteCount);
});

test("15: no-op action событие не создаёт (тот же state, без роста ревизии)", () => {
  const online = goDriverOnline(createDefaultState(), DRIVER, "zone-1").state;
  const again = goDriverOnline(online, DRIVER, "zone-1"); // no-op: уже AVAILABLE в zone-1
  assert.equal(again.state, online);
  assert.equal(eventsOf(again.state).length, eventsOf(online).length);
});

test("16/18/19/20: одно событие на driver/revision, атомарно, один bump, occurredAt=updatedAt", () => {
  const base = createDefaultState();
  const s = goDriverOnline(base, DRIVER, "zone-1").state;
  const ev = eventsOf(s);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].revision, s.revision); // атомарно с той же ревизией
  assert.equal(s.revision, base.revision + 1); // ровно один рост ревизии
  assert.equal(ev[0].occurredAt, s.updatedAt); // occurredAt === updatedAt
  assert.equal(ev[0].id, driverOperationalEventId(DRIVER, s.revision));
});

test("17: несколько водителей в одной ревизии получают разные id, один occurredAt", () => {
  const base = createDefaultState();
  const now = "2026-07-22T10:00:00.000Z";
  const next = finalizeMutation(
    base,
    {
      ...base,
      drivers: base.drivers.map((d, i) =>
        i < 2 ? { ...d, status: "AVAILABLE" as const, currentZoneId: "zone-1" as ZoneId } : d,
      ),
    },
    now,
  );
  const created = next.driverOperationalEvents;
  assert.equal(created.length, 2);
  assert.equal(created[0].revision, created[1].revision);
  assert.equal(created[0].occurredAt, now);
  assert.equal(created[1].occurredAt, now);
  assert.notEqual(created[0].id, created[1].id);
});

// --- §28 строгая цепочка ------------------------------------------------------

// Валидная базовая цепочка: online zone-1, затем offline.
function validChain(): DriverOperationalEvent[] {
  return [
    mkEvent(2, "2026-07-22T10:00:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-1"),
    mkEvent(3, "2026-07-22T10:30:00.000Z", "AVAILABLE", "OFFLINE", "zone-1", null),
  ];
}
const CHAIN_NOW = "2026-07-22T11:00:00.000Z";

test("21: валидная цепочка принимается (без review, время посчитано)", () => {
  const v = view(analyticsState(validChain()), "ALL_TIME", CHAIN_NOW);
  assert.equal(v.reviewRequired, false);
  assert.equal(v.waitingDurationMs, 30 * MIN);
  assert.notEqual(v.shiftDurationMs, null);
});

test("22/23: дубликат id / driver+revision → review, время null", () => {
  const dup = [
    mkEvent(2, "2026-07-22T10:00:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-1"),
    mkEvent(2, "2026-07-22T10:30:00.000Z", "AVAILABLE", "PAUSED", "zone-1", "zone-1"),
  ];
  const v = view(analyticsState(dup, { status: "AVAILABLE", currentZoneId: "zone-1" }), "ALL_TIME", CHAIN_NOW);
  assert.equal(v.reviewRequired, true);
  assert.equal(v.shiftDurationMs, null);
});

test("24: ревизия назад → review", () => {
  const back = [
    mkEvent(5, "2026-07-22T10:00:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-1"),
    mkEvent(3, "2026-07-22T10:30:00.000Z", "AVAILABLE", "OFFLINE", "zone-1", null),
  ];
  // Отсортируется как rev3, rev5 → statusBefore rev5 (AVAILABLE) != after rev3 (OFFLINE).
  assert.equal(view(analyticsState(back).reviewOrder ? analyticsState(back) : analyticsState(back), "ALL_TIME", CHAIN_NOW).reviewRequired, true);
});

test("25: время назад при возрастающей ревизии → review", () => {
  const back = [
    mkEvent(2, "2026-07-22T10:30:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-1"),
    mkEvent(3, "2026-07-22T10:00:00.000Z", "AVAILABLE", "OFFLINE", "zone-1", null),
  ];
  assert.equal(view(analyticsState(back), "ALL_TIME", CHAIN_NOW).reviewRequired, true);
});

test("26: statusBefore не совпадает с предыдущим after → review", () => {
  const bad = [
    mkEvent(2, "2026-07-22T10:00:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-1"),
    mkEvent(3, "2026-07-22T10:30:00.000Z", "PAUSED", "OFFLINE", "zone-1", null),
  ];
  assert.equal(view(analyticsState(bad), "ALL_TIME", CHAIN_NOW).reviewRequired, true);
});

test("27: zoneBefore не совпадает с предыдущим after → review", () => {
  const bad = [
    mkEvent(2, "2026-07-22T10:00:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-1"),
    mkEvent(3, "2026-07-22T10:30:00.000Z", "AVAILABLE", "OFFLINE", "zone-2", null),
  ];
  assert.equal(view(analyticsState(bad), "ALL_TIME", CHAIN_NOW).reviewRequired, true);
});

test("28/29: последний статус/зона не совпадают с профилем → review", () => {
  const chain = validChain();
  const wrongStatus = view(analyticsState(chain, { status: "AVAILABLE", currentZoneId: null }), "ALL_TIME", CHAIN_NOW);
  assert.equal(wrongStatus.reviewRequired, true);
  const wrongZone = view(analyticsState(chain, { status: "OFFLINE", currentZoneId: "zone-4" }), "ALL_TIME", CHAIN_NOW);
  assert.equal(wrongZone.reviewRequired, true);
});

test("30/31: nowIso раньше последнего события → review, время null", () => {
  const v = view(analyticsState(validChain()), "ALL_TIME", "2026-07-22T10:15:00.000Z");
  assert.equal(v.reviewRequired, true);
  assert.equal(v.onlineDurationMs, null);
});

// --- §29 периоды и длительности ----------------------------------------------

// Канонический день (все mid-day UTC → тот же локальный день Chisinau 2026-07-22).
function fullDayChain(): DriverOperationalEvent[] {
  return [
    mkEvent(2, "2026-07-22T10:00:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-1"),
    mkEvent(3, "2026-07-22T10:30:00.000Z", "AVAILABLE", "BUSY_DIRECT", "zone-1", "zone-1"),
    mkEvent(4, "2026-07-22T11:00:00.000Z", "BUSY_DIRECT", "ZONE_CONFIRMATION_REQUIRED", "zone-1", null),
    mkEvent(5, "2026-07-22T11:10:00.000Z", "ZONE_CONFIRMATION_REQUIRED", "AVAILABLE", null, "zone-2"),
    mkEvent(6, "2026-07-22T11:40:00.000Z", "AVAILABLE", "PAUSED", "zone-2", "zone-2"),
    mkEvent(7, "2026-07-22T12:00:00.000Z", "PAUSED", "OFFLINE", "zone-2", null),
  ];
}
const DAY_NOW = "2026-07-22T12:30:00.000Z";

test("39/40/41/42/43/44: категории времени и итоговые равенства", () => {
  const v = view(analyticsState(fullDayChain()), "ALL_TIME", DAY_NOW);
  assert.equal(v.waitingDurationMs, 60 * MIN); // 30 zone-1 + 30 zone-2
  assert.equal(v.deliveryDurationMs, 30 * MIN);
  assert.equal(v.pausedDurationMs, 20 * MIN);
  assert.equal(v.zoneConfirmationDurationMs, 10 * MIN);
  assert.equal(v.onlineDurationMs, 90 * MIN); // waiting + delivery
  assert.equal(v.shiftDurationMs, 120 * MIN); // online + paused + zoneConf (OFFLINE не входит)
  // Итоговые равенства.
  assert.equal(v.onlineDurationMs, (v.waitingDurationMs as number) + (v.deliveryDurationMs as number));
  assert.equal(
    v.shiftDurationMs,
    (v.onlineDurationMs as number) + (v.pausedDurationMs as number) + (v.zoneConfirmationDurationMs as number),
  );
});

test("38: последний интервал длится до nowIso", () => {
  // Один AVAILABLE, ещё не закрыт: длительность = now - start.
  const open = [mkEvent(2, "2026-07-22T10:00:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-1")];
  const v = view(analyticsState(open), "ALL_TIME", "2026-07-22T10:45:00.000Z");
  assert.equal(v.waitingDurationMs, 45 * MIN);
});

test("36/37: интервал обрезается началом и концом периода (TODAY)", () => {
  // AVAILABLE с 22:00 (пред. локального дня) до 03:00 локального дня-цели.
  // now в середине дня-цели. TODAY считает только часть после локальной полуночи.
  const nowIso = "2026-07-22T09:00:00.000Z"; // локально 12:00 Chisinau 2026-07-22
  const nowMs = Date.parse(nowIso);
  const todayMidnight = localMidnightToUtcMs(getLocalDateParts(nowMs, TZ), TZ);
  const startMs = todayMidnight - 2 * 60 * MIN; // за 2 часа до полуночи
  const events = [
    mkEvent(2, new Date(startMs).toISOString(), "OFFLINE", "AVAILABLE", null, "zone-1"),
  ];
  const v = view(analyticsState(events), "TODAY", nowIso);
  // TODAY: от полуночи до now.
  assert.equal(v.waitingDurationMs, nowMs - todayMidnight);
  assert.equal(v.coverageIncomplete, false); // цепочка уже существовала на момент начала TODAY
  // ALL_TIME: от первого события (полный интервал).
  const all = view(analyticsState(events), "ALL_TIME", nowIso);
  assert.equal(all.waitingDurationMs, nowMs - startMs);
  assert.equal(all.coverageIncomplete, false);
});

function oneOpenEvent(atMs: number): PrototypeState {
  return analyticsState([
    mkEvent(2, new Date(atMs).toISOString(), "OFFLINE", "AVAILABLE", null, "zone-1"),
  ]);
}

test("coverage TODAY: первый event до начала дня → complete", () => {
  const nowMs = Date.parse("2026-07-22T09:00:00.000Z");
  const start = localMidnightToUtcMs(getLocalDateParts(nowMs, TZ), TZ);
  assert.equal(view(oneOpenEvent(start - MIN), "TODAY", new Date(nowMs).toISOString()).coverageIncomplete, false);
});

test("coverage TODAY: первый event точно в локальную полночь → complete", () => {
  const nowMs = Date.parse("2026-07-22T09:00:00.000Z");
  const start = localMidnightToUtcMs(getLocalDateParts(nowMs, TZ), TZ);
  assert.equal(view(oneOpenEvent(start), "TODAY", new Date(nowMs).toISOString()).coverageIncomplete, false);
});

test("coverage TODAY: первый event после полуночи → incomplete", () => {
  const nowMs = Date.parse("2026-07-22T09:00:00.000Z");
  const start = localMidnightToUtcMs(getLocalDateParts(nowMs, TZ), TZ);
  assert.equal(view(oneOpenEvent(start + 60 * MIN), "TODAY", new Date(nowMs).toISOString()).coverageIncomplete, true);
});

test("coverage TODAY: при позднем первом event duration начинается с event", () => {
  const nowMs = Date.parse("2026-07-22T09:00:00.000Z");
  const start = localMidnightToUtcMs(getLocalDateParts(nowMs, TZ), TZ);
  const firstEvent = start + 60 * MIN;
  assert.equal(view(oneOpenEvent(firstEvent), "TODAY", new Date(nowMs).toISOString()).waitingDurationMs, nowMs - firstEvent);
});

test("coverage LAST_7_DAYS: event до нижней границы → complete", () => {
  const nowMs = Date.parse("2026-07-22T09:00:00.000Z");
  const start = localMidnightToUtcMs(shiftCalendarDate(getLocalDateParts(nowMs, TZ), -6), TZ);
  assert.equal(view(oneOpenEvent(start - MIN), "LAST_7_DAYS", new Date(nowMs).toISOString()).coverageIncomplete, false);
});

test("coverage LAST_7_DAYS: event после нижней границы → incomplete", () => {
  const nowMs = Date.parse("2026-07-22T09:00:00.000Z");
  const start = localMidnightToUtcMs(shiftCalendarDate(getLocalDateParts(nowMs, TZ), -6), TZ);
  assert.equal(view(oneOpenEvent(start + MIN), "LAST_7_DAYS", new Date(nowMs).toISOString()).coverageIncomplete, true);
});

test("coverage CURRENT_MONTH: event до или на первом числе → complete", () => {
  const nowMs = Date.parse("2026-07-22T09:00:00.000Z");
  const local = getLocalDateParts(nowMs, TZ);
  const start = localMidnightToUtcMs({ year: local.year, month: local.month, day: 1 }, TZ);
  assert.equal(view(oneOpenEvent(start - MIN), "CURRENT_MONTH", new Date(nowMs).toISOString()).coverageIncomplete, false);
  assert.equal(view(oneOpenEvent(start), "CURRENT_MONTH", new Date(nowMs).toISOString()).coverageIncomplete, false);
});

test("coverage CURRENT_MONTH: event после начала месяца → incomplete", () => {
  const nowMs = Date.parse("2026-07-22T09:00:00.000Z");
  const local = getLocalDateParts(nowMs, TZ);
  const start = localMidnightToUtcMs({ year: local.year, month: local.month, day: 1 }, TZ);
  assert.equal(view(oneOpenEvent(start + MIN), "CURRENT_MONTH", new Date(nowMs).toISOString()).coverageIncomplete, true);
});

test("coverage ALL_TIME: валидная непустая цепочка → complete", () => {
  assert.equal(view(analyticsState(validChain()), "ALL_TIME", CHAIN_NOW).coverageIncomplete, false);
});

test("coverage: пустой журнал → incomplete", () => {
  assert.equal(view(analyticsState([], { status: "OFFLINE", currentZoneId: null }), "ALL_TIME", DAY_NOW).coverageIncomplete, true);
});

test("coverage: повреждённая цепочка → incomplete", () => {
  const broken = [
    mkEvent(2, "2026-07-22T10:00:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-1"),
    mkEvent(3, "2026-07-22T10:30:00.000Z", "PAUSED", "OFFLINE", "zone-1", null),
  ];
  assert.equal(view(analyticsState(broken), "ALL_TIME", CHAIN_NOW).coverageIncomplete, true);
});

test("45/46: пустой журнал → время null (не нули), coverageIncomplete", () => {
  const v = view(analyticsState([], { status: "OFFLINE", currentZoneId: null }), "ALL_TIME", DAY_NOW);
  assert.equal(v.shiftDurationMs, null);
  assert.equal(v.onlineDurationMs, null);
  assert.equal(v.coverageStartedAt, null);
  assert.equal(v.coverageIncomplete, true);
});

// --- §30 зоны -----------------------------------------------------------------

test("47/48/49/51/52: время по зонам только для AVAILABLE/BUSY, делится по событию", () => {
  const v = view(analyticsState(fullDayChain()), "ALL_TIME", DAY_NOW);
  const byZone = new Map(v.zoneDurations.map((z) => [z.zoneId, z.durationMs]));
  assert.equal(byZone.get("zone-1"), 60 * MIN); // 30 waiting + 30 busy
  assert.equal(byZone.get("zone-2"), 30 * MIN); // 30 waiting (после подтверждения)
  // PAUSED в zone-2 НЕ входит в zone active duration.
  // Сумма зон + unassigned = online.
  const sum = v.zoneDurations.reduce((a, z) => a + z.durationMs, 0);
  assert.equal(sum + (v.unassignedZoneDurationMs as number), v.onlineDurationMs);
});

test("50: интервал без подтверждённой зоны идёт в unassigned, не в зону", () => {
  const events = [
    mkEvent(2, "2026-07-22T10:00:00.000Z", "OFFLINE", "AVAILABLE", null, null),
    mkEvent(3, "2026-07-22T10:20:00.000Z", "AVAILABLE", "OFFLINE", null, null),
  ];
  const v = view(analyticsState(events), "ALL_TIME", DAY_NOW);
  assert.equal(v.unassignedZoneDurationMs, 20 * MIN);
  assert.deepEqual(v.zoneDurations, []);
  assert.equal(v.onlineDurationMs, 20 * MIN);
});

// --- §31 аналитика: предложения, utilization, per-hour ------------------------

function offer(
  id: string,
  status: DriverOffer["status"],
  offeredAt: string,
  resolvedAt: string | null,
): DriverOffer {
  return {
    id,
    orderId: `o-${id}`,
    driverId: DRIVER,
    status,
    offeredAt,
    expiresAt: new Date(Date.parse(offeredAt) + 30_000).toISOString(),
    resolvedAt,
    cashReserveConfirmedAt: null,
  } as unknown as DriverOffer;
}

test("55/56/57: accepted/declined/expired; OPEN/CANCELED не считаются; avg response", () => {
  const offers: DriverOffer[] = [
    offer("a", "ACCEPTED", "2026-07-22T10:00:00.000Z", "2026-07-22T10:00:10.000Z"),
    offer("d", "DECLINED", "2026-07-22T10:05:00.000Z", "2026-07-22T10:05:20.000Z"),
    offer("e", "EXPIRED", "2026-07-22T10:10:00.000Z", "2026-07-22T10:10:30.000Z"),
    offer("o", "OPEN", "2026-07-22T10:15:00.000Z", null),
    offer("c", "CANCELED", "2026-07-22T10:20:00.000Z", "2026-07-22T10:20:05.000Z"),
  ];
  const state = { ...analyticsState(validChain()), driverOffers: offers };
  const v = view(state, "ALL_TIME", CHAIN_NOW);
  assert.equal(v.acceptedOfferCount, 1);
  assert.equal(v.declinedOfferCount, 1);
  assert.equal(v.expiredOfferCount, 1);
  // avg по ACCEPTED (10s) + DECLINED (20s) = 15s.
  assert.equal(v.averageResponseTimeMs, 15_000);
});

test("58: повреждённая хронология ответа → avg null + review, counts сохранены", () => {
  const offers: DriverOffer[] = [
    offer("a", "ACCEPTED", "2026-07-22T10:00:00.000Z", "2026-07-22T10:00:10.000Z"),
    // resolvedAt раньше offeredAt.
    offer("d", "DECLINED", "2026-07-22T10:05:30.000Z", "2026-07-22T10:05:00.000Z"),
  ];
  const state = { ...analyticsState(validChain()), driverOffers: offers };
  const v = view(state, "ALL_TIME", CHAIN_NOW);
  assert.equal(v.averageResponseTimeMs, null);
  assert.equal(v.reviewRequired, true);
  assert.equal(v.acceptedOfferCount, 1);
  assert.equal(v.declinedOfferCount, 1);
});

test("offer corruption: closed offers без валидного resolvedAt не считаются", () => {
  const invalidAccepted = {
    ...offer("bad-a", "ACCEPTED", "2026-07-22T10:00:00.000Z", null),
    resolvedAt: 123,
  } as unknown as DriverOffer;
  const nullDeclined = offer("bad-d", "DECLINED", "2026-07-22T10:05:00.000Z", null);
  const invalidExpired = offer("bad-e", "EXPIRED", "2026-07-22T10:10:00.000Z", "not-an-iso");
  const validAccepted = offer("good-a", "ACCEPTED", "2026-07-22T10:15:00.000Z", "2026-07-22T10:15:10.000Z");
  const state = {
    ...analyticsState(validChain()),
    driverOffers: [invalidAccepted, nullDeclined, invalidExpired, validAccepted],
  };
  const v = view(state, "ALL_TIME", CHAIN_NOW);
  assert.equal(v.acceptedOfferCount, 1);
  assert.equal(v.declinedOfferCount, 0);
  assert.equal(v.expiredOfferCount, 0);
  assert.equal(v.averageResponseTimeMs, null);
  assert.equal(v.reviewRequired, true);
});

test("offer corruption: invalid resolvedAt не уничтожает counts валидных offers", () => {
  const offers = [
    offer("good-a", "ACCEPTED", "2026-07-22T10:00:00.000Z", "2026-07-22T10:00:10.000Z"),
    offer("good-d", "DECLINED", "2026-07-22T10:05:00.000Z", "2026-07-22T10:05:20.000Z"),
    offer("bad-e", "EXPIRED", "2026-07-22T10:10:00.000Z", "invalid"),
  ];
  const v = view({ ...analyticsState(validChain()), driverOffers: offers }, "ALL_TIME", CHAIN_NOW);
  assert.equal(v.acceptedOfferCount, 1);
  assert.equal(v.declinedOfferCount, 1);
  assert.equal(v.expiredOfferCount, 0);
  assert.equal(v.averageResponseTimeMs, null);
  assert.equal(v.reviewRequired, true);
});

test("offer corruption: OPEN/CANCELED без resolvedAt не являются ошибкой", () => {
  const offers = [
    offer("open", "OPEN", "2026-07-22T10:00:00.000Z", null),
    offer("canceled", "CANCELED", "2026-07-22T10:05:00.000Z", null),
  ];
  const v = view({ ...analyticsState(validChain()), driverOffers: offers }, "ALL_TIME", CHAIN_NOW);
  assert.equal(v.acceptedOfferCount, 0);
  assert.equal(v.declinedOfferCount, 0);
  assert.equal(v.expiredOfferCount, 0);
  assert.equal(v.reviewRequired, false);
});

test("59/60: utilization в bps (0–10000); нулевой знаменатель → null", () => {
  const v = view(analyticsState(fullDayChain()), "ALL_TIME", DAY_NOW);
  // delivery 30 / (waiting 60 + delivery 30) = 30/90 = 3333 bps.
  assert.equal(v.utilizationBps, 3333);
  assert.ok((v.utilizationBps as number) >= 0 && (v.utilizationBps as number) <= 10000);
  // Только PAUSED — online 0 → utilization null.
  const paused = [
    mkEvent(2, "2026-07-22T10:00:00.000Z", "OFFLINE", "PAUSED", null, null),
    mkEvent(3, "2026-07-22T10:30:00.000Z", "PAUSED", "OFFLINE", null, null),
  ];
  assert.equal(view(analyticsState(paused), "ALL_TIME", DAY_NOW).utilizationBps, null);
});

test("53/54/61/62: доставки/заработок = settlements; per-hour формулы", () => {
  const online = goDriverOnline(createDefaultState(), DRIVER, "zone-2").state;
  const { state: earned } = completeOnlineOrder(online);
  const driver = driverOf(earned);
  // Заменяем журнал на ручную цепочку с контролируемым онлайном (2 часа waiting),
  // последнее событие совпадает с фактическим профилем после доставки.
  const events = [
    mkEvent(100, "2026-07-22T08:00:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-2"),
    mkEvent(101, "2026-07-22T10:00:00.000Z", "AVAILABLE", driver.status, "zone-2", driver.currentZoneId),
  ];
  const state: PrototypeState = {
    ...earned,
    driverOperationalEvents: events,
    revision: Math.max(earned.revision, 101) + 1,
  };
  const nowIso = "2026-07-22T10:00:00.000Z"; // = последнее событие → онлайн = 2 часа
  const v = view(state, "ALL_TIME", nowIso);
  const settle = getDriverSettlementPeriodView(state, DRIVER, "ALL_TIME", nowIso, TZ);
  assert.equal(v.completedDeliveryCount, settle.completedDeliveryCount);
  assert.equal(v.completedDeliveryCount, 1);
  assert.equal(v.earnedCents, settle.earnedCents);
  assert.equal(v.onlineDurationMs, 120 * MIN);
  // earningsPerOnlineHour = earned * 3.6e6 / online(7.2e6) = earned / 2.
  assert.equal(v.earningsPerOnlineHourCents, Math.round((settle.earnedCents as number) / 2));
  // deliveries per online hour milli = 1 * 3.6e6 * 1000 / 7.2e6 = 500 (0.5/час).
  assert.equal(v.deliveriesPerOnlineHourMilli, 500);
});

test("64: admin aggregate использует тот же per-driver read-model и сортировку", () => {
  const state = analyticsState(fullDayChain());
  const rows = getAdminDriverShiftAnalyticsView(state, "ALL_TIME", DAY_NOW, TZ);
  assert.equal(rows.length, state.drivers.length);
  const row = rows.find((r) => r.driverId === DRIVER)!;
  const direct = view(state, "ALL_TIME", DAY_NOW);
  assert.equal(row.analytics.onlineDurationMs, direct.onlineDurationMs);
  assert.equal(row.analytics.shiftDurationMs, direct.shiftDurationMs);
  // reviewRequired-строки идут первыми.
  const firstReview = rows.findIndex((r) => r.analytics.reviewRequired);
  const firstOk = rows.findIndex((r) => !r.analytics.reviewRequired);
  if (firstReview !== -1 && firstOk !== -1) assert.ok(firstReview < firstOk);
});

// --- §32 персистентность ------------------------------------------------------

test("65/66/67: schema28 валидное событие сохраняется, round-trip идемпотентен", () => {
  const state = analyticsState(fullDayChain());
  const once = parseStoredState(JSON.stringify(state));
  assert.ok(once);
  assert.equal(once.driverOperationalEvents.length, fullDayChain().length);
  const twice = parseStoredState(JSON.stringify(once));
  assert.deepEqual(twice?.driverOperationalEvents, once.driverOperationalEvents);
  // Детерминированный id сохраняется.
  assert.equal(once.driverOperationalEvents[0].id, driverOperationalEventId(DRIVER, 2));
});

test("68/69/70/71: событие с неизвестным driver/zone/ISO/revision удаляется", () => {
  const good = mkEvent(2, "2026-07-22T10:00:00.000Z", "OFFLINE", "AVAILABLE", null, "zone-1");
  const state = analyticsState([good]);
  const raw = {
    ...state,
    driverOperationalEvents: [
      good,
      { ...good, id: "driver-operational:ghost:revision:3", revision: 3, driverId: "ghost" },
      { ...good, id: driverOperationalEventId(DRIVER, 4), revision: 4, currentZoneIdAfter: "zone-9" },
      { ...good, id: driverOperationalEventId(DRIVER, 5), revision: 5, occurredAt: "не-дата" },
      { ...good, id: driverOperationalEventId(DRIVER, 0), revision: 0 },
    ],
  };
  const parsed = parseStoredState(JSON.stringify(raw));
  assert.ok(parsed);
  const kept = parsed.driverOperationalEvents;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, driverOperationalEventId(DRIVER, 2));
});

test("72: legacy schema (≤27) не синтезирует ни одного события", () => {
  const withEvents = analyticsState(fullDayChain());
  const parsed = parseStoredState(
    JSON.stringify({ ...withEvents, schemaVersion: 27 }),
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.driverOperationalEvents, []);
});
