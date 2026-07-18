import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultStatementRange } from "./statement-range.ts";
import {
  getLocalDateParts,
  localMidnightToUtcMs,
  shiftCalendarDate,
} from "../../../prototype/local-calendar.ts";

/** Число включительных календарных дней между двумя YYYY-MM-DD (UTC-нумерация). */
function inclusiveDayCount(startIso: string, endIso: string): number {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

const TZ = "Europe/Chisinau";

// 1 --------------------------------------------------------------------------

test("дефолтный диапазон — 30 включительных локальных календарных дней", () => {
  const nowMs = Date.parse("2026-07-20T12:00:00.000Z");
  const { startLocalDate, endLocalDate } = defaultStatementRange(nowMs, TZ);
  // Конец — текущая локальная дата ресторана.
  assert.equal(endLocalDate, "2026-07-20");
  assert.equal(inclusiveDayCount(startLocalDate, endLocalDate), 30);
  assert.equal(startLocalDate, "2026-06-21"); // 20 июля минус 29 дней
});

// 2 --------------------------------------------------------------------------

test("дефолтный диапазон корректен через границу месяца и года", () => {
  // Начало января — сдвиг -29 уходит в декабрь предыдущего года.
  const jan = defaultStatementRange(Date.parse("2026-01-05T12:00:00.000Z"), TZ);
  assert.equal(jan.endLocalDate, "2026-01-05");
  assert.equal(jan.startLocalDate, "2025-12-07");
  assert.equal(inclusiveDayCount(jan.startLocalDate, jan.endLocalDate), 30);

  // Начало марта — сдвиг через февраль (28 дней в 2026).
  const mar = defaultStatementRange(Date.parse("2026-03-10T12:00:00.000Z"), TZ);
  assert.equal(mar.endLocalDate, "2026-03-10");
  assert.equal(inclusiveDayCount(mar.startLocalDate, mar.endLocalDate), 30);
  assert.equal(mar.startLocalDate, "2026-02-09");
});

// 3 --------------------------------------------------------------------------

test("дефолтный диапазон не использует фиксированные UTC-сутки и корректен около DST", () => {
  // Chisinau: осенний переход 25 октября 2026. Диапазон, покрывающий переход,
  // всё равно ровно 30 календарных дат.
  const fall = defaultStatementRange(Date.parse("2026-11-05T12:00:00.000Z"), TZ);
  assert.equal(fall.endLocalDate, "2026-11-05");
  assert.equal(inclusiveDayCount(fall.startLocalDate, fall.endLocalDate), 30);

  // UTC-полночь конца локального дня относится к правильной дате: 20 июля 23:30
  // местного (лето, EEST+3) = 20:30Z того же дня.
  const late = defaultStatementRange(Date.parse("2026-07-20T20:30:00.000Z"), TZ);
  assert.equal(late.endLocalDate, "2026-07-20");

  // Начало диапазона в мс через локальную полночь совпадает с календарным сдвигом.
  const end = getLocalDateParts(Date.parse("2026-07-20T12:00:00.000Z"), TZ);
  const start = shiftCalendarDate(end, -29);
  const startMs = localMidnightToUtcMs(start, TZ);
  assert.ok(!Number.isNaN(startMs));
});

// 4 --------------------------------------------------------------------------

test("разные часовые пояса дают диапазон из своего локального дня", () => {
  // Момент 2026-07-21T00:30:00Z: в Chisinau (EEST+3) это уже 03:30 21 июля,
  // а в UTC — всё ещё 21 июля 00:30; в Гонолулу (UTC-10) — 20 июля 14:30.
  const ms = Date.parse("2026-07-21T00:30:00.000Z");
  assert.equal(defaultStatementRange(ms, "Europe/Chisinau").endLocalDate, "2026-07-21");
  assert.equal(defaultStatementRange(ms, "Pacific/Honolulu").endLocalDate, "2026-07-20");
  // Оба — по 30 включительных дней в своём поясе.
  assert.equal(
    inclusiveDayCount(
      defaultStatementRange(ms, "Pacific/Honolulu").startLocalDate,
      defaultStatementRange(ms, "Pacific/Honolulu").endLocalDate,
    ),
    30,
  );
});
