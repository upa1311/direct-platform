import assert from "node:assert/strict";
import { test } from "node:test";

import { serializeRestaurantStatementCsv } from "./restaurant-statement-csv.ts";
import type {
  RestaurantStatementCurrencySection,
  RestaurantStatementRecognitionViewRow,
  RestaurantStatementResolutionViewRow,
  RestaurantStatementView,
} from "./restaurant-statement-view.ts";

const TZ = "Europe/Chisinau";
const ASOF = "2026-07-18T09:30:00.000Z";

function section(
  o: Partial<RestaurantStatementCurrencySection> & { currencyCode: string },
): RestaurantStatementCurrencySection {
  return {
    openingRestaurantOwesDirectCents: 0,
    openingDirectOwesRestaurantCents: 0,
    openingNetCents: 0,
    recognizedRestaurantOwesDirectCents: 0,
    recognizedDirectOwesRestaurantCents: 0,
    settledRestaurantOwesDirectCents: 0,
    settledDirectOwesRestaurantCents: 0,
    waivedRestaurantOwesDirectCents: 0,
    closingRestaurantOwesDirectCents: 0,
    closingDirectOwesRestaurantCents: 0,
    closingNetCents: 0,
    isReconciled: true,
    ...o,
  } as RestaurantStatementCurrencySection;
}

function recognition(
  o: Partial<RestaurantStatementRecognitionViewRow>,
): RestaurantStatementRecognitionViewRow {
  return {
    publicNumber: "DIR-100",
    orderLabel: "DIR-100",
    recognizedAt: "2026-07-15T10:00:00.000Z",
    directionLabel: "Ресторан должен Direct",
    typeLabel: "Комиссия платформы",
    amountCents: 800,
    currencyCode: "USD",
    sourceLabel: "Снимок заказа",
    ...o,
  };
}

function resolution(
  o: Partial<RestaurantStatementResolutionViewRow>,
): RestaurantStatementResolutionViewRow {
  return {
    publicNumber: "DIR-100",
    orderLabel: "DIR-100",
    occurredAt: "2026-07-16T10:00:00.000Z",
    decisionLabel: "Расчёт подтверждён",
    directionLabel: "Ресторан должен Direct",
    typeLabel: "Комиссия платформы",
    amountCents: 800,
    currencyCode: "USD",
    note: "основание",
    externalReference: null,
    ...o,
  };
}

function makeView(o: Partial<RestaurantStatementView> = {}): RestaurantStatementView {
  return {
    restaurantName: "Ресторан 1",
    startLocalDate: "2026-07-01",
    endLocalDate: "2026-07-31",
    timeZone: TZ,
    currencySections: [],
    recognitionRows: [],
    resolutionRows: [],
    integritySummary: [],
    hasIntegrityWarnings: false,
    ...o,
  };
}

// 1 --------------------------------------------------------------------------

test("детерминированный результат при одинаковом view/asOf/timeZone", () => {
  const view = makeView({
    currencySections: [section({ currencyCode: "USD", openingRestaurantOwesDirectCents: 800 })],
    recognitionRows: [recognition({})],
    resolutionRows: [resolution({})],
  });
  const a = serializeRestaurantStatementCsv(view, ASOF, TZ);
  const b = serializeRestaurantStatementCsv(view, ASOF, TZ);
  assert.deepEqual(a, b);
  assert.equal(a.content, b.content);
  assert.equal(a.fileName, "direct-statement-2026-07-01_2026-07-31.csv");
  assert.equal(a.mimeType, "text/csv;charset=utf-8");
});

// 2 --------------------------------------------------------------------------

test("UTF-8 BOM в начале файла", () => {
  const csv = serializeRestaurantStatementCsv(makeView(), ASOF, TZ);
  assert.equal(csv.content.charCodeAt(0), 0xfeff, "первый символ — BOM");
});

// 3 --------------------------------------------------------------------------

test("переносы строк CRLF", () => {
  const csv = serializeRestaurantStatementCsv(makeView(), ASOF, TZ);
  assert.ok(csv.content.includes("\r\n"), "есть CRLF");
  // Нет «голых» LF без предшествующего CR.
  assert.ok(!/(^|[^\r])\n/.test(csv.content), "нет LF без CR");
});

// 4 --------------------------------------------------------------------------

test("escaping запятой, кавычек и многострочного комментария", () => {
  const view = makeView({
    resolutionRows: [
      resolution({ note: "строка1\r\nстрока2, с запятой и \"кавычками\"" }),
    ],
  });
  const csv = serializeRestaurantStatementCsv(view, ASOF, TZ);
  // Поле обёрнуто в кавычки, внутренние кавычки удвоены, CRLF/запятая внутри.
  assert.ok(
    csv.content.includes('"строка1\r\nстрока2, с запятой и ""кавычками"""'),
    "многострочный note экранирован по RFC 4180",
  );
});

// 5 --------------------------------------------------------------------------

test("formula-injection защита для =, +, -, @, TAB и CR", () => {
  const cases = ["=1+1", "+1", "-1", "@cmd", "\tTAB", "\rCR"];
  for (const payload of cases) {
    const view = makeView({ resolutionRows: [resolution({ note: payload })] });
    const csv = serializeRestaurantStatementCsv(view, ASOF, TZ);
    // Значение должно быть префиксовано апострофом (возможно внутри кавычек).
    assert.ok(
      csv.content.includes(`'${payload.charAt(0)}`) ||
        csv.content.includes(`"'${payload}`) ||
        csv.content.includes(`'${payload}`),
      `injection payload ${JSON.stringify(payload)} защищён апострофом`,
    );
  }
  // Ведущие пробелы не мешают распознаванию.
  const spaced = makeView({ resolutionRows: [resolution({ note: "   =DANGER" })] });
  const csvSpaced = serializeRestaurantStatementCsv(spaced, ASOF, TZ);
  assert.ok(csvSpaced.content.includes("'   =DANGER"), "поле с ведущими пробелами защищено");
  // Обычный текст не искажается.
  const safe = makeView({ resolutionRows: [resolution({ note: "обычный комментарий" })] });
  const csvSafe = serializeRestaurantStatementCsv(safe, ASOF, TZ);
  assert.ok(!csvSafe.content.includes("'обычный"), "безопасный текст без апострофа");
});

// 6 --------------------------------------------------------------------------

test("суммы разных валют остаются отдельными и не смешиваются", () => {
  const view = makeView({
    currencySections: [
      section({ currencyCode: "USD", openingRestaurantOwesDirectCents: 1000 }),
      section({ currencyCode: "EUR", openingRestaurantOwesDirectCents: 2000 }),
    ],
  });
  const csv = serializeRestaurantStatementCsv(view, ASOF, TZ);
  const lines = csv.content.split("\r\n");
  const usdLine = lines.find((l) => l.startsWith("USD,"));
  const eurLine = lines.find((l) => l.startsWith("EUR,"));
  assert.ok(usdLine && usdLine.includes("$10.00"), "USD в долларах");
  assert.ok(eurLine && eurLine.includes("€20.00"), "EUR в евро");
  // Разные валюты — разные строки, суммы не складываются.
  assert.notEqual(usdLine, eurLine);
});

// 7 --------------------------------------------------------------------------

test("opening/movements/closing экспортируются без пересчёта", () => {
  const s = section({
    currencyCode: "USD",
    openingRestaurantOwesDirectCents: 800,
    openingDirectOwesRestaurantCents: 5100,
    openingNetCents: 4300,
    recognizedRestaurantOwesDirectCents: 300,
    recognizedDirectOwesRestaurantCents: 2000,
    settledRestaurantOwesDirectCents: 100,
    settledDirectOwesRestaurantCents: 700,
    waivedRestaurantOwesDirectCents: 50,
    closingRestaurantOwesDirectCents: 950,
    closingDirectOwesRestaurantCents: 6400,
    closingNetCents: 5450,
    isReconciled: false,
  });
  const csv = serializeRestaurantStatementCsv(makeView({ currencySections: [s] }), ASOF, TZ);
  const line = csv.content.split("\r\n").find((l) => l.startsWith("USD,"))!;
  // Значения из view-model «как есть», в порядке колонок сводки.
  for (const money of ["$8.00", "$51.00", "$43.00", "$3.00", "$20.00", "$1.00", "$7.00", "$0.50", "$9.50", "$64.00", "$54.50"]) {
    assert.ok(line.includes(money), `${money} присутствует без пересчёта`);
  }
  assert.ok(line.endsWith(",Нет"), "признак сходимости из isReconciled");
});

// 8 --------------------------------------------------------------------------

test("recognition/resolution используют только публичные поля view-model", () => {
  const view = makeView({
    recognitionRows: [
      recognition({ orderLabel: "Старое начисление", publicNumber: null, amountCents: 1234 }),
    ],
    resolutionRows: [
      resolution({ decisionLabel: "Комиссия Direct списана", note: "", externalReference: "BANK-9" }),
    ],
  });
  const csv = serializeRestaurantStatementCsv(view, ASOF, TZ);
  assert.ok(csv.content.includes("Старое начисление"));
  assert.ok(csv.content.includes("$12.34"));
  assert.ok(csv.content.includes("Комиссия Direct списана"));
  assert.ok(csv.content.includes("BANK-9"));
});

// 9 --------------------------------------------------------------------------

test("integrity export содержит message + count без entryKey/orderId", () => {
  const view = makeView({
    integritySummary: [
      { message: "Обнаружен заказ с противоречивыми данными о получателе оплаты.", count: 2 },
    ],
    hasIntegrityWarnings: true,
  });
  const csv = serializeRestaurantStatementCsv(view, ASOF, TZ);
  assert.ok(csv.content.includes("Обнаружен заказ с противоречивыми данными о получателе оплаты."));
  const line = csv.content
    .split("\r\n")
    .find((l) => l.startsWith("Обнаружен заказ"))!;
  assert.ok(line.endsWith(",2"), "count присутствует");
  assert.ok(!csv.content.toLowerCase().includes("entrykey"));
  assert.ok(!csv.content.toLowerCase().includes("orderid"));
});

// 10 -------------------------------------------------------------------------

test("в файле нет внутренних ID и клиентских PII", () => {
  const view = makeView({
    restaurantName: "Ресторан 1",
    currencySections: [section({ currencyCode: "USD", openingRestaurantOwesDirectCents: 800 })],
    recognitionRows: [recognition({})],
    resolutionRows: [resolution({ externalReference: "BANK-1" })],
    integritySummary: [{ message: "Проверьте данные.", count: 1 }],
    hasIntegrityWarnings: true,
  });
  const csv = serializeRestaurantStatementCsv(view, ASOF, TZ);
  const lower = csv.content.toLowerCase();
  for (const forbidden of [
    "restaurant-1",
    "restaurantid",
    "orderid",
    "entrykey",
    "accountingentryid",
    "admin",
    "pickupcode",
    "phone",
  ]) {
    assert.ok(!lower.includes(forbidden), `не содержит ${forbidden}`);
  }
});

// 11 -------------------------------------------------------------------------

test("пустые note/externalReference → пустое поле, не undefined/null", () => {
  const view = makeView({
    resolutionRows: [resolution({ note: "", externalReference: null })],
  });
  const csv = serializeRestaurantStatementCsv(view, ASOF, TZ);
  assert.ok(!csv.content.includes("undefined"));
  assert.ok(!csv.content.toLowerCase().includes("null"));
  // Строка решения заканчивается двумя пустыми полями (note и внешняя ссылка).
  const line = csv.content.split("\r\n").find((l) => l.includes("Расчёт подтверждён"))!;
  assert.ok(line.endsWith(",,"), "две пустые концевые ячейки");
});

// 12 -------------------------------------------------------------------------

test("restaurantName пользовательский текст защищён от injection", () => {
  const view = makeView({ restaurantName: "=CMD()" });
  const csv = serializeRestaurantStatementCsv(view, ASOF, TZ);
  assert.ok(csv.content.includes("'=CMD()"), "имя ресторана защищено");
});

// 13 -------------------------------------------------------------------------

test("view не мутируется сериализацией", () => {
  const view = makeView({
    currencySections: [section({ currencyCode: "USD", openingRestaurantOwesDirectCents: 800 })],
    recognitionRows: [recognition({})],
    resolutionRows: [resolution({})],
    integritySummary: [{ message: "Проверьте данные.", count: 1 }],
  });
  const snapshot = JSON.stringify(view);
  serializeRestaurantStatementCsv(view, ASOF, TZ);
  serializeRestaurantStatementCsv(view, ASOF, TZ);
  assert.equal(JSON.stringify(view), snapshot, "view неизменен");
});
