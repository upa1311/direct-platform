import assert from "node:assert/strict";
import { test } from "node:test";

import {
  visibleStatementSnapshot,
  type StatementSnapshot,
} from "./statement-snapshot.ts";
import { defaultStatementRange } from "./statement-range.ts";

function snap(
  restaurantId: string,
  timeZone: string,
  result = "RESULT",
): StatementSnapshot<string> {
  return {
    restaurantId,
    timeZone,
    asOfIso: "2026-07-18T10:00:00.000Z",
    result,
  };
}

// 1 --------------------------------------------------------------------------

test("snapshot ресторана A невидим при выбранном ресторане B", () => {
  const a = snap("restaurant-1", "Europe/Chisinau");
  assert.equal(visibleStatementSnapshot(a, "restaurant-2", "Europe/Chisinau"), null);
});

// 2 --------------------------------------------------------------------------

test("snapshot A невидим при изменённом timeZone того же ресторана", () => {
  const a = snap("restaurant-1", "Europe/Chisinau");
  assert.equal(visibleStatementSnapshot(a, "restaurant-1", "America/New_York"), null);
});

// 3 --------------------------------------------------------------------------

test("snapshot видим только при точном совпадении restaurantId + timeZone", () => {
  const a = snap("restaurant-1", "Europe/Chisinau");
  const visible = visibleStatementSnapshot(a, "restaurant-1", "Europe/Chisinau");
  assert.ok(visible);
  assert.equal(visible!.result, "RESULT");
  assert.equal(visible!.asOfIso, "2026-07-18T10:00:00.000Z");
  // null-snapshot → null.
  assert.equal(visibleStatementSnapshot(null, "restaurant-1", "Europe/Chisinau"), null);
});

// 4 --------------------------------------------------------------------------

test("смена контекста создаёт новый default range для нового timeZone", () => {
  // Момент 2026-07-21T00:30Z: Chisinau (EEST+3) — 21 июля, Гонолулу (UTC-10) — 20 июля.
  const ms = Date.parse("2026-07-21T00:30:00.000Z");
  const chisinau = defaultStatementRange(ms, "Europe/Chisinau");
  const honolulu = defaultStatementRange(ms, "Pacific/Honolulu");
  assert.equal(chisinau.endLocalDate, "2026-07-21");
  assert.equal(honolulu.endLocalDate, "2026-07-20");
  assert.notDeepEqual(chisinau, honolulu);
});

// 5 --------------------------------------------------------------------------

test("старый result/asOf не возвращаются после смены контекста", () => {
  const a = snap("restaurant-1", "Europe/Chisinau", "OLD_RESULT");
  // Смена ресторана.
  const afterRestaurant = visibleStatementSnapshot(a, "restaurant-2", "Europe/Chisinau");
  assert.equal(afterRestaurant?.result ?? null, null);
  assert.equal(afterRestaurant?.asOfIso ?? null, null);
  // Смена пояса.
  const afterZone = visibleStatementSnapshot(a, "restaurant-1", "UTC");
  assert.equal(afterZone?.result ?? null, null);
  assert.equal(afterZone?.asOfIso ?? null, null);
});
