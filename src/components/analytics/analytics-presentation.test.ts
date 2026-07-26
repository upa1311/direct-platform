import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  checkedSumIntegers,
  formatAnalyticsDuration,
  formatDeliveriesPerHour,
  formatResponseTime,
  formatUtilization,
  sumAvailableDurations,
} from "./analytics-presentation.ts";

const read = (path: string) => readFileSync(path, "utf8");
const DRIVER_PAGE = read("src/app/driver/statistics/page.tsx");
const DRIVER_CSS = read("src/app/driver/statistics/statistics.module.css");
const ADMIN_PAGE = read("src/app/admin/driver-analytics/page.tsx");
const ADMIN_CSS = read("src/app/admin/driver-analytics/driver-analytics.module.css");
const PERIOD = read("src/components/analytics/period-selector.tsx");
const PERIOD_CSS = read("src/components/analytics/period-selector.module.css");
const DRIVER_HEADER = read("src/components/workspaces/driver-header.tsx");
const ADMIN_NAV = read("src/components/workspaces/admin-navigation.ts");
const ADMIN_HOME = read("src/app/admin/page.tsx");
const SETTLEMENTS = read("src/app/driver/settlements/page.tsx");

test("форматы duration, response time, utilization и deliveries/hour", () => {
  assert.equal(formatAnalyticsDuration(null), "—");
  assert.equal(formatAnalyticsDuration(0), "0 мин");
  assert.equal(formatAnalyticsDuration(1), "< 1 мин");
  assert.equal(formatAnalyticsDuration(25 * 60_000), "25 мин");
  assert.equal(formatAnalyticsDuration(60 * 60_000), "1 ч");
  assert.equal(formatAnalyticsDuration(85 * 60_000), "1 ч 25 мин");
  assert.equal(formatAnalyticsDuration(8 * 60 * 60_000), "8 ч");
  assert.equal(formatResponseTime(null), "—");
  assert.equal(formatResponseTime(500), "< 1 сек");
  assert.equal(formatResponseTime(15_000), "15 сек");
  assert.equal(formatResponseTime(70_000), "1 мин 10 сек");
  assert.equal(formatUtilization(3333), "33.3%");
  assert.equal(formatUtilization(10000), "100%");
  assert.equal(formatDeliveriesPerHour(500), "0.5");
  assert.equal(formatDeliveriesPerHour(1500), "1.5");
  assert.equal(formatDeliveriesPerHour(2000), "2");
});

test("checked presentation sums отклоняют null, unsafe values и overflow", () => {
  assert.equal(sumAvailableDurations([10, 20, 30]), 60);
  assert.equal(sumAvailableDurations([10, null, 30]), null);
  assert.equal(checkedSumIntegers([2, 3, 5]), 10);
  assert.equal(checkedSumIntegers([Number.MAX_SAFE_INTEGER, 1]), null);
  assert.equal(checkedSumIntegers([1.5]), null);
});

test("водительская навигация и route используют только authenticated driver id", () => {
  assert.ok(DRIVER_HEADER.includes('{ href: "/driver/statistics", label: "Статистика" }'));
  assert.ok(DRIVER_PAGE.includes("useAuthenticatedDriverId"));
  assert.ok(DRIVER_PAGE.includes("getDriverShiftAnalyticsView(state, driverId"));
  assert.ok(DRIVER_PAGE.includes("state, isHydrated"));
  assert.ok(DRIVER_PAGE.includes("!isHydrated || nowMs === 0"));
  assert.ok(!DRIVER_PAGE.includes("searchParams"));
  assert.ok(DRIVER_PAGE.includes("if (driverId === null)"));
});

test("единый period selector доступен и контрастен", () => {
  for (const id of ["TODAY", "LAST_7_DAYS", "CURRENT_MONTH", "ALL_TIME"]) assert.ok(PERIOD.includes(id));
  assert.ok(PERIOD.includes('role="group"'));
  assert.ok(PERIOD.includes("aria-pressed"));
  assert.ok(PERIOD_CSS.includes("background: var(--kds-action"));
  assert.ok(PERIOD_CSS.includes("color: #fff"));
  assert.ok(PERIOD_CSS.includes("flex-wrap: wrap"));
});

test("driver analytics показывает честные состояния и принятые read-model metrics", () => {
  assert.ok(DRIVER_PAGE.includes("Учёт времени ещё не начался"));
  assert.ok(DRIVER_PAGE.includes("const hasCoverage"));
  assert.ok(DRIVER_PAGE.includes("showPaused"));
  assert.ok(DRIVER_PAGE.includes("view.pausedDurationMs !== null && view.pausedDurationMs > 0"));
  assert.ok(DRIVER_PAGE.includes("showZoneConfirmation"));
  assert.ok(DRIVER_PAGE.includes("Данные времени по зонам пока недоступны"));
  assert.ok(!DRIVER_PAGE.includes("view.unassignedZoneDurationMs ?? 0"));
  assert.ok(DRIVER_PAGE.includes("Подтверждённых данных о предложениях за период нет"));
  assert.ok(DRIVER_PAGE.includes("coverageIncomplete"));
  assert.ok(DRIVER_PAGE.includes("Некоторые данные требуют проверки Direct"));
  assert.ok(DRIVER_PAGE.includes("earningsPerOnlineHourCents"));
  assert.ok(DRIVER_PAGE.includes("averageResponseTimeMs"));
  assert.ok(DRIVER_PAGE.includes("getZoneButtonPresentation"));
  assert.ok(DRIVER_PAGE.includes("Без подтверждённой зоны"));
  assert.ok(DRIVER_CSS.includes("repeat(2, minmax(0, 1fr))"));
  assert.ok(!DRIVER_PAGE.includes("navigator.geolocation"));
});

test("admin navigation, route card и analytics route подключены", () => {
  const drivers = ADMIN_NAV.indexOf('href: "/admin/drivers"');
  const analytics = ADMIN_NAV.indexOf('href: "/admin/driver-analytics"');
  const payouts = ADMIN_NAV.indexOf('href: "/admin/driver-payouts"');
  assert.ok(drivers < analytics && analytics < payouts);
  assert.ok(ADMIN_HOME.includes('href: "/admin/driver-analytics"'));
  assert.ok(ADMIN_PAGE.includes("getAdminDriverShiftAnalyticsView"));
  assert.ok(ADMIN_PAGE.includes("state, isHydrated"));
  assert.ok(ADMIN_PAGE.includes("!isHydrated || nowMs === 0"));
  assert.ok(ADMIN_PAGE.includes("Водители не добавлены"));
  assert.ok(ADMIN_PAGE.includes("Недостаточно данных для полного итога"));
  assert.ok(ADMIN_PAGE.includes("checkedSumIntegers"));
  assert.ok(ADMIN_PAGE.includes("Учёт времени ещё не начался"));
  assert.ok(ADMIN_PAGE.includes("Учёт ведётся с"));
  assert.ok(ADMIN_PAGE.includes("Данные времени по зонам недоступны"));
  assert.ok(ADMIN_PAGE.includes("Активного времени в зонах нет"));
  assert.ok(!ADMIN_PAGE.includes("unassignedZoneDurationMs ?? 0"));
  assert.ok(ADMIN_PAGE.includes("DRIVER_STATUS_LABELS"));
  assert.ok(ADMIN_PAGE.includes("Неполный период"));
  assert.ok(ADMIN_PAGE.includes("Требует проверки"));
  assert.ok(ADMIN_PAGE.includes("<details"));
  assert.ok(ADMIN_PAGE.includes("getZoneButtonPresentation"));
  assert.ok(!ADMIN_PAGE.includes(".sort("));
  assert.ok(!ADMIN_PAGE.includes("geolocation"));
  assert.ok(!ADMIN_CSS.includes("table"));
});

test("settlements скрывает только нулевые payout rows", () => {
  assert.ok(SETTLEMENTS.includes("view.sentByDirectCents !== 0"));
  assert.ok(SETTLEMENTS.includes("view.receivedFromDirectCents !== 0"));
  assert.ok(SETTLEMENTS.includes("Direct должен вам"));
  assert.ok(SETTLEMENTS.includes("Получено из наличных заказов"));
  assert.ok(SETTLEMENTS.includes("payouts.batches"));
  assert.ok(SETTLEMENTS.includes("confirmDriverPayoutReceipt"));
});
