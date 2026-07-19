import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStatementPrintModel } from "./statement-print.ts";
import type { StatementSnapshot } from "./statement-snapshot.ts";
import type {
  RestaurantStatementView,
  RestaurantStatementViewResult,
} from "../../../prototype/restaurant-statement-view.ts";

const RID = "restaurant-1";
const TZ = "Europe/Chisinau";
const ASOF = "2026-07-18T09:30:00.000Z";
const START = "2026-07-01";
const END = "2026-07-31";

function view(): RestaurantStatementView {
  return {
    restaurantName: "Ресторан 1",
    startLocalDate: START,
    endLocalDate: END,
    timeZone: TZ,
    currencySections: [
      {
        currencyCode: "USD",
        openingRestaurantOwesDirectCents: 800,
        openingDirectOwesRestaurantCents: 0,
        openingNetCents: -800,
        recognizedRestaurantOwesDirectCents: 0,
        recognizedDirectOwesRestaurantCents: 0,
        settledRestaurantOwesDirectCents: 0,
        settledDirectOwesRestaurantCents: 0,
        waivedRestaurantOwesDirectCents: 0,
        closingRestaurantOwesDirectCents: 800,
        closingDirectOwesRestaurantCents: 0,
        closingNetCents: -800,
        isReconciled: true,
      },
    ],
    recognitionRows: [
      {
        publicNumber: "DIR-100",
        orderLabel: "DIR-100",
        recognizedAt: "2026-07-15T10:00:00.000Z",
        directionLabel: "Ресторан должен Direct",
        typeLabel: "Комиссия платформы",
        amountCents: 800,
        currencyCode: "USD",
        sourceLabel: "Снимок заказа",
      },
    ],
    resolutionRows: [],
    integritySummary: [],
    hasIntegrityWarnings: false,
  };
}

function okResult(): RestaurantStatementViewResult {
  return { ok: true, error: null, view: view() };
}

function snap(
  result: RestaurantStatementViewResult,
  restaurantId = RID,
  timeZone = TZ,
  startLocalDate = START,
  endLocalDate = END,
  asOfIso = ASOF,
): StatementSnapshot<RestaurantStatementViewResult> {
  return { restaurantId, timeZone, startLocalDate, endLocalDate, asOfIso, result };
}

// 1 --------------------------------------------------------------------------

test("текущий успешный snapshot разрешает печать", () => {
  const model = buildStatementPrintModel(snap(okResult()), RID, TZ, START, END);
  assert.ok(model);
  assert.equal(model.timeZone, TZ);
  assert.equal(model.view.restaurantName, "Ресторан 1");
});

// 2 --------------------------------------------------------------------------

test("snapshot другого restaurantId не разрешает печать", () => {
  assert.equal(buildStatementPrintModel(snap(okResult(), "restaurant-2", TZ), RID, TZ, START, END), null);
});

// 3 --------------------------------------------------------------------------

test("snapshot старого timeZone не разрешает печать", () => {
  assert.equal(buildStatementPrintModel(snap(okResult(), RID, "UTC"), RID, TZ, START, END), null);
});

// 4 --------------------------------------------------------------------------

test("failed result не разрешает печать", () => {
  const failed: RestaurantStatementViewResult = {
    ok: false,
    error: "Некорректная начальная дата.",
    view: null,
  };
  assert.equal(buildStatementPrintModel(snap(failed), RID, TZ, START, END), null);
});

// 5 --------------------------------------------------------------------------

test("ok=true + view=null не разрешает печать", () => {
  const weird: RestaurantStatementViewResult = { ok: true, error: null, view: null };
  assert.equal(buildStatementPrintModel(snap(weird), RID, TZ, START, END), null);
});

// 6 --------------------------------------------------------------------------

test("зафиксированный asOf передаётся без замены", () => {
  const model = buildStatementPrintModel(
    snap(okResult(), RID, TZ, START, END, ASOF),
    RID,
    TZ,
    START,
    END,
  );
  assert.ok(model);
  assert.equal(model.asOfIso, ASOF, "asOf берётся из envelope как есть");
});

// 7 --------------------------------------------------------------------------

test("печатные данные берутся только из RestaurantStatementView", () => {
  const result = okResult();
  const model = buildStatementPrintModel(snap(result), RID, TZ, START, END);
  assert.ok(model);
  // Модель отдаёт ровно тот же view-объект (без пересчёта/подмены полей).
  assert.equal(model.view, result.view);
  assert.deepEqual(model.view.currencySections, result.view!.currencySections);
  assert.deepEqual(model.view.recognitionRows, result.view!.recognitionRows);
});

// 8 --------------------------------------------------------------------------

test("в печатной модели отсутствуют internal IDs и PII", () => {
  const model = buildStatementPrintModel(snap(okResult()), RID, TZ, START, END);
  assert.ok(model);
  const serialized = JSON.stringify(model.view).toLowerCase();
  for (const forbidden of [
    "restaurantid",
    "orderid",
    "entrykey",
    "accountingentryid",
    "customer",
    "phone",
    "address",
    "pickupcode",
    "paymentmethod",
    "actor",
  ]) {
    assert.ok(!serialized.includes(forbidden), `view не содержит ${forbidden}`);
  }
});

// 9 --------------------------------------------------------------------------

test("snapshot и view не мутируются построением печатной модели", () => {
  const s = snap(okResult());
  const before = JSON.stringify(s);
  buildStatementPrintModel(s, RID, TZ, START, END);
  buildStatementPrintModel(s, RID, TZ, START, END);
  assert.equal(JSON.stringify(s), before, "snapshot неизменен");
});

// 10 -------------------------------------------------------------------------

test("stale snapshot (изменился период) не разрешает печать", () => {
  const s = snap(okResult(), RID, TZ, "2026-07-01", "2026-07-31");
  assert.equal(buildStatementPrintModel(s, RID, TZ, "2026-07-02", "2026-07-31"), null);
  assert.equal(buildStatementPrintModel(s, RID, TZ, "2026-07-01", "2026-07-30"), null);
  // Актуальный период снова разрешает печать.
  assert.ok(buildStatementPrintModel(s, RID, TZ, "2026-07-01", "2026-07-31"));
});
