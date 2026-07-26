import type {
  DriverOperationalEvent,
  DriverProfile,
  DriverStatus,
  PrototypeState,
  ZoneId,
} from "./models";
import { addChecked } from "./bank-fee";
import {
  getLocalDateParts,
  localMidnightToUtcMs,
  shiftCalendarDate,
} from "./local-calendar";
import {
  getDriverSettlementPeriodView,
  type DriverEarningsPeriod,
} from "./driver-earnings";

/**
 * Driver Shift Analytics (v28) — чистый read-model рабочего времени водителя.
 *
 * Источник времени ТОЛЬКО append-only DriverOperationalEvent (реальные изменения
 * DriverProfile.status/currentZoneId). Без GPS, мыши, вкладки, heartbeat, без
 * Date.now (момент приходит аргументом nowIso) и без синтеза прошлого. Доставки и
 * заработок берутся из существующего getDriverSettlementPeriodView, поэтому
 * «Расчёты» и Shift Analytics не расходятся. Все длительности — целые мс,
 * неотрицательные, checked arithmetic; при конфликте цепочки/переполнении —
 * временные итоги null (без правдоподобных нулей).
 */

const HOUR_MS = 3_600_000;

export type DriverShiftAnalyticsPeriod =
  | "TODAY"
  | "LAST_7_DAYS"
  | "CURRENT_MONTH"
  | "ALL_TIME";

export interface DriverZoneDuration {
  zoneId: ZoneId;
  durationMs: number;
}

export interface DriverShiftAnalyticsView {
  driverId: string;
  period: DriverShiftAnalyticsPeriod;

  coverageStartedAt: string | null;
  coverageIncomplete: boolean;

  shiftDurationMs: number | null;
  onlineDurationMs: number | null;
  waitingDurationMs: number | null;
  deliveryDurationMs: number | null;
  pausedDurationMs: number | null;
  zoneConfirmationDurationMs: number | null;

  zoneDurations: DriverZoneDuration[];
  unassignedZoneDurationMs: number | null;

  completedDeliveryCount: number;
  earnedCents: number | null;

  acceptedOfferCount: number;
  declinedOfferCount: number;
  expiredOfferCount: number;

  averageResponseTimeMs: number | null;

  utilizationBps: number | null;
  earningsPerOnlineHourCents: number | null;
  deliveriesPerOnlineHourMilli: number | null;

  reviewRequired: boolean;
}

export interface AdminDriverShiftAnalyticsRow {
  driverId: string;
  driverName: string;
  status: DriverStatus;
  currentZoneId: ZoneId | null;
  statusNote: string | null;
  analytics: DriverShiftAnalyticsView;
}

// --- Вспомогательные --------------------------------------------------------

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Целочисленное деление с округлением до ближайшего; null при небезопасных входах. */
function roundedDiv(numerator: number, denominator: number): number | null {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator === 0
  ) {
    return null;
  }
  const result = Math.round(numerator / denominator);
  return Number.isSafeInteger(result) ? result : null;
}

/**
 * Начало выбранного календарного периода в мс (Europe/Chisinau). Для ALL_TIME
 * календарной нижней границы нет (null) — она определяется покрытием событий.
 */
function calendarStartMs(
  period: DriverShiftAnalyticsPeriod,
  nowMs: number,
  timeZone: string,
): number | null {
  const now = getLocalDateParts(nowMs, timeZone);
  switch (period) {
    case "TODAY":
      return localMidnightToUtcMs(now, timeZone);
    case "LAST_7_DAYS":
      // Сегодня и шесть предыдущих локальных календарных дней (не 168 часов).
      return localMidnightToUtcMs(shiftCalendarDate(now, -6), timeZone);
    case "CURRENT_MONTH":
      return localMidnightToUtcMs(
        { year: now.year, month: now.month, day: 1 },
        timeZone,
      );
    case "ALL_TIME":
      return null;
    default:
      return null;
  }
}

// --- Строгая проверка цепочки событий (§11) ---------------------------------

interface ChainResult {
  ok: boolean;
  sorted: DriverOperationalEvent[];
  coverageStartedAt: string | null;
  coverageStartedAtMs: number | null;
}

/**
 * Сортирует события водителя (revision ASC, occurredAt ASC, id ASC) и строго
 * проверяет цепочку: возрастающие ревизии, неубывающее время, before === прежний
 * after (статус и зона), последнее состояние совпадает с текущим DriverProfile,
 * nowIso не раньше последнего события. Цепочка не «чинится» и правдоподобный
 * вариант не выбирается — при любом нарушении ok=false.
 */
function validateChain(
  events: DriverOperationalEvent[],
  driver: DriverProfile,
  nowMs: number,
): ChainResult {
  const sorted = [...events].sort((a, b) => {
    if (a.revision !== b.revision) return a.revision - b.revision;
    const ta = Date.parse(a.occurredAt);
    const tb = Date.parse(b.occurredAt);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (sorted.length === 0) {
    return { ok: true, sorted, coverageStartedAt: null, coverageStartedAtMs: null };
  }

  const first = sorted[0];
  const coverageStartedAt = first.occurredAt;
  const coverageStartedAtMs = Date.parse(coverageStartedAt);

  let ok = true;
  for (let i = 0; i < sorted.length; i += 1) {
    const ev = sorted[i];
    if (!isValidIso(ev.occurredAt)) ok = false;
    if (i > 0) {
      const prev = sorted[i - 1];
      // Строго возрастающие ревизии (ловит дубликаты driverId+revision и откат).
      if (ev.revision <= prev.revision) ok = false;
      // Неубывающее время.
      if (Date.parse(ev.occurredAt) < Date.parse(prev.occurredAt)) ok = false;
      // Непрерывность состояния.
      if (ev.statusBefore !== prev.statusAfter) ok = false;
      if (ev.currentZoneIdBefore !== prev.currentZoneIdAfter) ok = false;
    }
  }

  const last = sorted[sorted.length - 1];
  // Последнее состояние обязано совпадать с текущим профилем водителя.
  if (last.statusAfter !== driver.status) ok = false;
  if (last.currentZoneIdAfter !== driver.currentZoneId) ok = false;
  // nowIso не может быть раньше последнего события.
  if (Number.isNaN(coverageStartedAtMs) || nowMs < Date.parse(last.occurredAt)) {
    ok = false;
  }

  return { ok, sorted, coverageStartedAt, coverageStartedAtMs };
}

// --- Аккумуляция длительностей по интервалам (§13–§15) ----------------------

interface DurationAccumulator {
  waitingMs: number;
  deliveryMs: number;
  pausedMs: number;
  zoneConfirmationMs: number;
  unassignedZoneMs: number;
  zoneMap: Map<ZoneId, number>;
  overflow: boolean;
}

/**
 * Интервал `statusAfter` события действует от его occurredAt до следующего
 * события (для последнего — до nowMs), обрезается окном [windowStart, windowEnd].
 * OFFLINE в shift не входит. Зона считается только для активного онлайна
 * (AVAILABLE/BUSY_DIRECT); интервал без подтверждённой зоны идёт в unassigned.
 */
function accumulate(
  sorted: DriverOperationalEvent[],
  nowMs: number,
  windowStart: number,
  windowEnd: number,
): DurationAccumulator {
  const acc: DurationAccumulator = {
    waitingMs: 0,
    deliveryMs: 0,
    pausedMs: 0,
    zoneConfirmationMs: 0,
    unassignedZoneMs: 0,
    zoneMap: new Map<ZoneId, number>(),
    overflow: false,
  };
  const add = (current: number, delta: number): number => {
    const next = addChecked(current, delta);
    if (next === null) {
      acc.overflow = true;
      return current;
    }
    return next;
  };
  const addZone = (zone: ZoneId, delta: number): void => {
    const next = addChecked(acc.zoneMap.get(zone) ?? 0, delta);
    if (next === null) acc.overflow = true;
    else acc.zoneMap.set(zone, next);
  };

  for (let i = 0; i < sorted.length; i += 1) {
    const ev = sorted[i];
    const startMs = Date.parse(ev.occurredAt);
    const endMs =
      i + 1 < sorted.length ? Date.parse(sorted[i + 1].occurredAt) : nowMs;
    const clippedStart = Math.max(startMs, windowStart);
    const clippedEnd = Math.min(endMs, windowEnd);
    const durationMs = clippedEnd - clippedStart;
    if (durationMs <= 0) continue;
    if (!Number.isSafeInteger(durationMs)) {
      acc.overflow = true;
      continue;
    }
    const zone = ev.currentZoneIdAfter;
    switch (ev.statusAfter) {
      case "AVAILABLE":
        acc.waitingMs = add(acc.waitingMs, durationMs);
        if (zone === null) acc.unassignedZoneMs = add(acc.unassignedZoneMs, durationMs);
        else addZone(zone, durationMs);
        break;
      case "BUSY_DIRECT":
        acc.deliveryMs = add(acc.deliveryMs, durationMs);
        if (zone === null) acc.unassignedZoneMs = add(acc.unassignedZoneMs, durationMs);
        else addZone(zone, durationMs);
        break;
      case "PAUSED":
        acc.pausedMs = add(acc.pausedMs, durationMs);
        break;
      case "ZONE_CONFIRMATION_REQUIRED":
        acc.zoneConfirmationMs = add(acc.zoneConfirmationMs, durationMs);
        break;
      case "OFFLINE":
        break;
      default:
        break;
    }
  }
  return acc;
}

// --- Предложения заказов (§19) ----------------------------------------------

interface OfferAnalytics {
  acceptedOfferCount: number;
  declinedOfferCount: number;
  expiredOfferCount: number;
  averageResponseTimeMs: number | null;
  reviewRequired: boolean;
}

function computeOfferAnalytics(
  state: PrototypeState,
  driverId: string,
  nowMs: number,
  offerLowerMs: number | null,
): OfferAnalytics {
  let acceptedOfferCount = 0;
  let declinedOfferCount = 0;
  let expiredOfferCount = 0;
  let responseSum = 0;
  let responseCount = 0;
  let responseCorrupt = false;

  const inPeriod = (resolvedMs: number): boolean =>
    resolvedMs <= nowMs && (offerLowerMs === null || resolvedMs >= offerLowerMs);

  for (const offer of state.driverOffers) {
    if (offer.driverId !== driverId) continue;
    if (
      offer.status !== "ACCEPTED" &&
      offer.status !== "DECLINED" &&
      offer.status !== "EXPIRED"
    ) {
      continue; // OPEN и CANCELED не считаются.
    }
    if (!isValidIso(offer.resolvedAt)) {
      responseCorrupt = true;
      continue;
    }
    const resolvedMs = Date.parse(offer.resolvedAt as string);
    if (!inPeriod(resolvedMs)) continue;

    if (offer.status === "ACCEPTED") acceptedOfferCount += 1;
    else if (offer.status === "DECLINED") declinedOfferCount += 1;
    else expiredOfferCount += 1;

    // Время ответа — только для ACCEPTED и DECLINED.
    if (offer.status === "ACCEPTED" || offer.status === "DECLINED") {
      if (!isValidIso(offer.offeredAt)) {
        responseCorrupt = true;
        continue;
      }
      const offeredMs = Date.parse(offer.offeredAt);
      if (resolvedMs < offeredMs) {
        responseCorrupt = true;
        continue;
      }
      const next = addChecked(responseSum, resolvedMs - offeredMs);
      if (next === null) {
        responseCorrupt = true;
        continue;
      }
      responseSum = next;
      responseCount += 1;
    }
  }

  const averageResponseTimeMs =
    responseCorrupt || responseCount === 0
      ? null
      : roundedDiv(responseSum, responseCount);

  return {
    acceptedOfferCount,
    declinedOfferCount,
    expiredOfferCount,
    averageResponseTimeMs,
    reviewRequired: responseCorrupt,
  };
}

// --- Основной read-model ----------------------------------------------------

function nullTimeView(base: {
  driverId: string;
  period: DriverShiftAnalyticsPeriod;
  coverageStartedAt: string | null;
  coverageIncomplete: boolean;
  completedDeliveryCount: number;
  earnedCents: number | null;
  offers: OfferAnalytics;
  reviewRequired: boolean;
}): DriverShiftAnalyticsView {
  return {
    driverId: base.driverId,
    period: base.period,
    coverageStartedAt: base.coverageStartedAt,
    coverageIncomplete: base.coverageIncomplete,
    shiftDurationMs: null,
    onlineDurationMs: null,
    waitingDurationMs: null,
    deliveryDurationMs: null,
    pausedDurationMs: null,
    zoneConfirmationDurationMs: null,
    zoneDurations: [],
    unassignedZoneDurationMs: null,
    completedDeliveryCount: base.completedDeliveryCount,
    earnedCents: base.earnedCents,
    acceptedOfferCount: base.offers.acceptedOfferCount,
    declinedOfferCount: base.offers.declinedOfferCount,
    expiredOfferCount: base.offers.expiredOfferCount,
    averageResponseTimeMs: base.offers.averageResponseTimeMs,
    utilizationBps: null,
    earningsPerOnlineHourCents: null,
    deliveriesPerOnlineHourMilli: null,
    reviewRequired: base.reviewRequired,
  };
}

/**
 * Аналитика смены одного водителя за период. Доставки/заработок — из
 * getDriverSettlementPeriodView (единый источник с «Расчётами»); время — из
 * операционного журнала; предложения — из DriverOffer. Пустой журнал или
 * нарушенная цепочка → временные итоги null (не нули), но валидные доставки и
 * предложения сохраняются.
 */
export function getDriverShiftAnalyticsView(
  state: PrototypeState,
  driverId: string,
  period: DriverShiftAnalyticsPeriod,
  nowIso: string,
  timeZone: string,
): DriverShiftAnalyticsView {
  const nowMs = Date.parse(nowIso);
  const driver = state.drivers.find((d) => d.id === driverId) ?? null;

  // Доставки и заработок — единый settlement read-model (тот же период/tz).
  const settlement = getDriverSettlementPeriodView(
    state,
    driverId,
    period as DriverEarningsPeriod,
    nowIso,
    timeZone,
  );
  const completedDeliveryCount = settlement.completedDeliveryCount;
  const earnedCents = settlement.earnedCents;

  const offerLowerMs = Number.isNaN(nowMs)
    ? null
    : calendarStartMs(period, nowMs, timeZone);
  const offers = Number.isNaN(nowMs)
    ? {
        acceptedOfferCount: 0,
        declinedOfferCount: 0,
        expiredOfferCount: 0,
        averageResponseTimeMs: null,
        reviewRequired: true,
      }
    : computeOfferAnalytics(state, driverId, nowMs, offerLowerMs);

  const baseReview = settlement.reviewRequired || offers.reviewRequired;

  if (driver === null || Number.isNaN(nowMs)) {
    return nullTimeView({
      driverId,
      period,
      coverageStartedAt: null,
      coverageIncomplete: true,
      completedDeliveryCount,
      earnedCents,
      offers,
      reviewRequired: true,
    });
  }

  const driverEvents = state.driverOperationalEvents.filter(
    (e) => e.driverId === driverId,
  );

  // Пустой журнал: покрытия времени нет (но это не «сломанная» цепочка).
  if (driverEvents.length === 0) {
    return nullTimeView({
      driverId,
      period,
      coverageStartedAt: null,
      coverageIncomplete: true,
      completedDeliveryCount,
      earnedCents,
      offers,
      reviewRequired: baseReview,
    });
  }

  const chain = validateChain(driverEvents, driver, nowMs);
  if (!chain.ok || chain.coverageStartedAtMs === null) {
    return nullTimeView({
      driverId,
      period,
      coverageStartedAt: chain.coverageStartedAt,
      coverageIncomplete: true,
      completedDeliveryCount,
      earnedCents,
      offers,
      reviewRequired: true,
    });
  }

  // Окно анализа времени: ALL_TIME — от первого события; иначе — от начала
  // календарного периода, но не раньше покрытия. Конец всегда nowMs.
  const calendarStart = calendarStartMs(period, nowMs, timeZone);
  const timeWindowStart =
    period === "ALL_TIME"
      ? chain.coverageStartedAtMs
      : Math.max(calendarStart as number, chain.coverageStartedAtMs);
  const coverageIncomplete =
    period !== "ALL_TIME" &&
    (calendarStart as number) < chain.coverageStartedAtMs;

  const acc = accumulate(chain.sorted, nowMs, timeWindowStart, nowMs);

  const nullTime = () =>
    nullTimeView({
      driverId,
      period,
      coverageStartedAt: chain.coverageStartedAt,
      coverageIncomplete,
      completedDeliveryCount,
      earnedCents,
      offers,
      reviewRequired: true,
    });

  if (acc.overflow) return nullTime();

  // Производные итоги (по построению непересекающиеся): checked equality.
  const onlineDurationMs = addChecked(acc.waitingMs, acc.deliveryMs);
  const pausedPlusZoneConf = addChecked(acc.pausedMs, acc.zoneConfirmationMs);
  const shiftDurationMs =
    onlineDurationMs !== null && pausedPlusZoneConf !== null
      ? addChecked(onlineDurationMs, pausedPlusZoneConf)
      : null;
  if (onlineDurationMs === null || shiftDurationMs === null) return nullTime();

  // Сумма зон + unassigned обязана равняться онлайну (checked equality).
  let zoneSum = 0;
  const zoneDurations: DriverZoneDuration[] = [];
  for (const [zoneId, durationMs] of acc.zoneMap) {
    zoneDurations.push({ zoneId, durationMs });
    const next = addChecked(zoneSum, durationMs);
    if (next === null) return nullTime();
    zoneSum = next;
  }
  const zoneTotal = addChecked(zoneSum, acc.unassignedZoneMs);
  if (zoneTotal === null || zoneTotal !== onlineDurationMs) return nullTime();
  // Детерминированный порядок зон.
  zoneDurations.sort((a, b) =>
    a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0,
  );

  // utilization: delivery / (waiting + delivery) в bps (0–10000).
  const utilizationBps =
    onlineDurationMs === 0
      ? null
      : roundedDiv(acc.deliveryMs * 10000, onlineDurationMs);

  // Заработок за час активного онлайна.
  const earningsPerOnlineHourCents =
    earnedCents === null || onlineDurationMs === 0
      ? null
      : roundedDiv(earnedCents * HOUR_MS, onlineDurationMs);

  // Доставки за час активного онлайна ×1000 (1500 = 1.5 доставки/час).
  const deliveriesPerOnlineHourMilli =
    onlineDurationMs === 0
      ? null
      : roundedDiv(completedDeliveryCount * HOUR_MS * 1000, onlineDurationMs);

  return {
    driverId,
    period,
    coverageStartedAt: chain.coverageStartedAt,
    coverageIncomplete,
    shiftDurationMs,
    onlineDurationMs,
    waitingDurationMs: acc.waitingMs,
    deliveryDurationMs: acc.deliveryMs,
    pausedDurationMs: acc.pausedMs,
    zoneConfirmationDurationMs: acc.zoneConfirmationMs,
    zoneDurations,
    unassignedZoneDurationMs: acc.unassignedZoneMs,
    completedDeliveryCount,
    earnedCents,
    acceptedOfferCount: offers.acceptedOfferCount,
    declinedOfferCount: offers.declinedOfferCount,
    expiredOfferCount: offers.expiredOfferCount,
    averageResponseTimeMs: offers.averageResponseTimeMs,
    utilizationBps,
    earningsPerOnlineHourCents,
    deliveriesPerOnlineHourMilli,
    reviewRequired: baseReview,
  };
}

/**
 * Агрегат по всем водителям для администратора. Тот же per-driver read-model, без
 * UI. Сортировка: reviewRequired, затем сейчас BUSY_DIRECT, затем AVAILABLE,
 * затем onlineDurationMs DESC, затем имя, затем driverId.
 */
export function getAdminDriverShiftAnalyticsView(
  state: PrototypeState,
  period: DriverShiftAnalyticsPeriod,
  nowIso: string,
  timeZone: string,
): AdminDriverShiftAnalyticsRow[] {
  const rows: AdminDriverShiftAnalyticsRow[] = state.drivers.map((driver) => ({
    driverId: driver.id,
    driverName: driver.name,
    status: driver.status,
    currentZoneId: driver.currentZoneId,
    statusNote: driver.statusNote,
    analytics: getDriverShiftAnalyticsView(
      state,
      driver.id,
      period,
      nowIso,
      timeZone,
    ),
  }));

  const rank = (row: AdminDriverShiftAnalyticsRow): number => {
    if (row.analytics.reviewRequired) return 0;
    if (row.status === "BUSY_DIRECT") return 1;
    if (row.status === "AVAILABLE") return 2;
    return 3;
  };

  rows.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const oa = a.analytics.onlineDurationMs ?? -1;
    const ob = b.analytics.onlineDurationMs ?? -1;
    if (oa !== ob) return ob - oa;
    if (a.driverName !== b.driverName) return a.driverName < b.driverName ? -1 : 1;
    return a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : 0;
  });

  return rows;
}
