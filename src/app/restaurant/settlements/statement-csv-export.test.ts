import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStatementCsvExport } from "./statement-csv-export.ts";
import type { StatementSnapshot } from "./statement-snapshot.ts";
import type { RestaurantStatementViewResult } from "../../../prototype/restaurant-statement-view.ts";

const RID = "restaurant-1";
const TZ = "Europe/Chisinau";
const ASOF = "2026-07-18T09:30:00.000Z";

function okView(): RestaurantStatementViewResult {
  return {
    ok: true,
    error: null,
    view: {
      restaurantName: "Ресторан 1",
      startLocalDate: "2026-07-01",
      endLocalDate: "2026-07-31",
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
): StatementSnapshot<RestaurantStatementViewResult> {
  return { restaurantId, timeZone, asOfIso: ASOF, result };
}

// 1 --------------------------------------------------------------------------

test("успешный видимый snapshot даёт CSV-файл", () => {
  const file = buildStatementCsvExport(snap(okView()), RID, TZ);
  assert.ok(file);
  assert.equal(file.mimeType, "text/csv;charset=utf-8");
  assert.equal(file.fileName, "direct-statement-2026-07-01_2026-07-31.csv");
  assert.equal(file.content.charCodeAt(0), 0xfeff);
});

// 2 --------------------------------------------------------------------------

test("отсутствующий snapshot → нет экспорта", () => {
  assert.equal(buildStatementCsvExport(null, RID, TZ), null);
});

// 3 --------------------------------------------------------------------------

test("failed result → нет экспорта", () => {
  const failed: RestaurantStatementViewResult = {
    ok: false,
    error: "Некорректная начальная дата.",
    view: null,
  };
  assert.equal(buildStatementCsvExport(snap(failed), RID, TZ), null);
});

// 4 --------------------------------------------------------------------------

test("stale snapshot (сменился restaurantId) → нет экспорта", () => {
  const file = buildStatementCsvExport(snap(okView(), "restaurant-2", TZ), RID, TZ);
  assert.equal(file, null, "старый ресторан не экспортируется");
});

// 5 --------------------------------------------------------------------------

test("stale snapshot (сменился timeZone) → нет экспорта", () => {
  const file = buildStatementCsvExport(snap(okView(), RID, "UTC"), RID, TZ);
  assert.equal(file, null, "старый пояс не экспортируется");
});

// 6 --------------------------------------------------------------------------

test("ok=true но view=null → нет экспорта (перестраховка)", () => {
  const weird: RestaurantStatementViewResult = { ok: true, error: null, view: null };
  assert.equal(buildStatementCsvExport(snap(weird), RID, TZ), null);
});
