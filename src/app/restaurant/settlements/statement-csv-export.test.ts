import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStatementCsvExport } from "./statement-csv-export.ts";
import type { StatementSnapshot } from "./statement-snapshot.ts";
import type { RestaurantStatementViewResult } from "../../../prototype/restaurant-statement-view.ts";

const RID = "restaurant-1";
const TZ = "Europe/Chisinau";
const ASOF = "2026-07-18T09:30:00.000Z";
const START = "2026-07-01";
const END = "2026-07-31";

function okView(
  startLocalDate = START,
  endLocalDate = END,
): RestaurantStatementViewResult {
  return {
    ok: true,
    error: null,
    view: {
      restaurantName: "Ресторан 1",
      startLocalDate,
      endLocalDate,
      timeZone: TZ,
      currencySections: [],
      recognitionRows: [],
      resolutionRows: [],
      integritySummary: [],
      hasIntegrityWarnings: false,
    },
  };
}

function snap(
  result: RestaurantStatementViewResult,
  restaurantId = RID,
  timeZone = TZ,
  startLocalDate = START,
  endLocalDate = END,
): StatementSnapshot<RestaurantStatementViewResult> {
  return { restaurantId, timeZone, startLocalDate, endLocalDate, asOfIso: ASOF, result };
}

// 1 --------------------------------------------------------------------------

test("успешный видимый snapshot даёт CSV-файл", () => {
  const file = buildStatementCsvExport(snap(okView()), RID, TZ, START, END);
  assert.ok(file);
  assert.equal(file.mimeType, "text/csv;charset=utf-8");
  assert.equal(file.fileName, "direct-statement-2026-07-01_2026-07-31.csv");
  assert.equal(file.content.charCodeAt(0), 0xfeff);
});

// 2 --------------------------------------------------------------------------

test("отсутствующий snapshot → нет экспорта", () => {
  assert.equal(buildStatementCsvExport(null, RID, TZ, START, END), null);
});

// 3 --------------------------------------------------------------------------

test("failed result → нет экспорта", () => {
  const failed: RestaurantStatementViewResult = {
    ok: false,
    error: "Некорректная начальная дата.",
    view: null,
  };
  assert.equal(buildStatementCsvExport(snap(failed), RID, TZ, START, END), null);
});

// 4 --------------------------------------------------------------------------

test("stale snapshot (сменился restaurantId) → нет экспорта", () => {
  const file = buildStatementCsvExport(snap(okView(), "restaurant-2", TZ), RID, TZ, START, END);
  assert.equal(file, null, "старый ресторан не экспортируется");
});

// 5 --------------------------------------------------------------------------

test("stale snapshot (сменился timeZone) → нет экспорта", () => {
  const file = buildStatementCsvExport(snap(okView(), RID, "UTC"), RID, TZ, START, END);
  assert.equal(file, null, "старый пояс не экспортируется");
});

// 6 --------------------------------------------------------------------------

test("stale snapshot (изменился период) → нет экспорта", () => {
  // Snapshot за 07-01..07-31, а форма показывает уже другой период.
  const s = snap(okView(), RID, TZ, "2026-07-01", "2026-07-31");
  assert.equal(
    buildStatementCsvExport(s, RID, TZ, "2026-07-02", "2026-07-31"),
    null,
    "старый период не экспортируется",
  );
  assert.equal(
    buildStatementCsvExport(s, RID, TZ, "2026-07-01", "2026-07-30"),
    null,
  );
});

// 7 --------------------------------------------------------------------------

test("после нового snapshot с новым периодом CSV снова доступен", () => {
  const s = snap(okView("2026-06-01", "2026-06-30"), RID, TZ, "2026-06-01", "2026-06-30");
  const file = buildStatementCsvExport(s, RID, TZ, "2026-06-01", "2026-06-30");
  assert.ok(file, "актуальный период экспортируется");
  assert.equal(file.fileName, "direct-statement-2026-06-01_2026-06-30.csv");
});

// 8 --------------------------------------------------------------------------

test("ok=true но view=null → нет экспорта (перестраховка)", () => {
  const weird: RestaurantStatementViewResult = { ok: true, error: null, view: null };
  assert.equal(buildStatementCsvExport(snap(weird), RID, TZ, START, END), null);
});
