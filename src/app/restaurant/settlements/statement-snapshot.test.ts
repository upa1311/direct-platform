import assert from "node:assert/strict";
import { test } from "node:test";

import {
  visibleStatementSnapshot,
  type StatementSnapshot,
} from "./statement-snapshot.ts";
import { defaultStatementRange } from "./statement-range.ts";

const TZ = "Europe/Chisinau";
const START = "2026-07-01";
const END = "2026-07-31";

function snap(
  restaurantId: string,
  timeZone: string,
  startLocalDate = START,
  endLocalDate = END,
  result = "RESULT",
): StatementSnapshot<string> {
  return {
    restaurantId,
    timeZone,
    startLocalDate,
    endLocalDate,
    asOfIso: "2026-07-18T10:00:00.000Z",
    result,
  };
}

const visible = (
  s: StatementSnapshot<string> | null,
  rid: string,
  tz: string,
  start = START,
  end = END,
) => visibleStatementSnapshot(s, rid, tz, start, end);

// 1 --------------------------------------------------------------------------

test("snapshot с тем же restaurantId/timeZone/period актуален", () => {
  const a = snap("restaurant-1", TZ);
  const v = visible(a, "restaurant-1", TZ);
  assert.ok(v);
  assert.equal(v!.result, "RESULT");
  assert.equal(v!.asOfIso, "2026-07-18T10:00:00.000Z");
  assert.equal(visible(null, "restaurant-1", TZ), null);
});

// 2 --------------------------------------------------------------------------

test("изменилась startLocalDate → snapshot stale (невидим)", () => {
  const a = snap("restaurant-1", TZ, "2026-07-01", "2026-07-31");
  assert.equal(visible(a, "restaurant-1", TZ, "2026-07-02", "2026-07-31"), null);
});

// 3 --------------------------------------------------------------------------

test("изменилась endLocalDate → snapshot stale (невидим)", () => {
  const a = snap("restaurant-1", TZ, "2026-07-01", "2026-07-31");
  assert.equal(visible(a, "restaurant-1", TZ, "2026-07-01", "2026-07-30"), null);
});

// 4 --------------------------------------------------------------------------

test("изменился restaurantId → snapshot невидим", () => {
  const a = snap("restaurant-1", TZ);
  assert.equal(visible(a, "restaurant-2", TZ), null);
});

// 5 --------------------------------------------------------------------------

test("изменился timeZone → snapshot невидим", () => {
  const a = snap("restaurant-1", TZ);
  assert.equal(visible(a, "restaurant-1", "America/New_York"), null);
});

// 6 --------------------------------------------------------------------------

test("совпадение по всем полям, но обе даты изменены → stale", () => {
  const a = snap("restaurant-1", TZ, "2026-07-01", "2026-07-31");
  assert.equal(visible(a, "restaurant-1", TZ, "2026-06-01", "2026-06-30"), null);
});

// 7 --------------------------------------------------------------------------

test("старый result/asOf не возвращаются после смены периода или контекста", () => {
  const a = snap("restaurant-1", TZ, START, END, "OLD_RESULT");
  const afterStart = visible(a, "restaurant-1", TZ, "2026-07-05", END);
  assert.equal(afterStart?.result ?? null, null);
  assert.equal(afterStart?.asOfIso ?? null, null);
  const afterRestaurant = visible(a, "restaurant-2", TZ);
  assert.equal(afterRestaurant?.result ?? null, null);
  const afterZone = visible(a, "restaurant-1", "UTC");
  assert.equal(afterZone?.result ?? null, null);
});

// 8 --------------------------------------------------------------------------

test("смена контекста создаёт новый default range для нового timeZone", () => {
  // Момент 2026-07-21T00:30Z: Chisinau (EEST+3) — 21 июля, Гонолулу (UTC-10) — 20 июля.
  const ms = Date.parse("2026-07-21T00:30:00.000Z");
  const chisinau = defaultStatementRange(ms, "Europe/Chisinau");
  const honolulu = defaultStatementRange(ms, "Pacific/Honolulu");
  assert.equal(chisinau.endLocalDate, "2026-07-21");
  assert.equal(honolulu.endLocalDate, "2026-07-20");
  assert.notDeepEqual(chisinau, honolulu);
});

// 9 --------------------------------------------------------------------------

test("проверка видимости не мутирует snapshot", () => {
  const a = snap("restaurant-1", TZ);
  const before = JSON.stringify(a);
  visible(a, "restaurant-1", TZ);
  visible(a, "restaurant-1", TZ, "2026-08-01", "2026-08-31");
  assert.equal(JSON.stringify(a), before);
});
