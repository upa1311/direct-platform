import type {
  RestaurantStatementCurrencySection,
  RestaurantStatementRecognitionViewRow,
  RestaurantStatementResolutionViewRow,
  RestaurantStatementView,
} from "./restaurant-statement-view";

/**
 * RESTAURANT STATEMENT CSV — чистый сериализатор уже сформированной выписки.
 *
 * Модуль НЕ знает про PrototypeState, statement core, pricing, accounting-
 * селекторы, финансовые формулы и Date.now(). Он принимает только готовую
 * presentation-model (RestaurantStatementView), зафиксированный момент
 * формирования (asOfIso) и часовой пояс — и детерминированно превращает их в
 * CSV-файл. Денежные значения берутся из view-model «как есть» (только
 * форматирование валюты, без пересчёта). Валюты между собой не суммируются:
 * каждая строка сводки печатается в собственной валюте. Все пользовательские
 * текстовые поля защищены от CSV formula injection; всё экранирование —
 * RFC 4180-совместимое (CRLF, кавычки, запятые, переносы строк). Ничего не
 * мутирует.
 */

export interface RestaurantStatementCsvFile {
  fileName: string;
  mimeType: "text/csv;charset=utf-8";
  content: string;
}

const BOM = "﻿";
const CRLF = "\r\n";
const MIME_TYPE = "text/csv;charset=utf-8" as const;

// --- Чистое форматирование --------------------------------------------------

/**
 * Человекочитаемая сумма в валюте строки. Идентична presentation-форматированию
 * (Intl, en-US, style=currency) — просто печатает уже готовые центы, ничего не
 * пересчитывает. Инлайним, чтобы не тянуть селекторы в чистый сериализатор.
 */
function formatMoney(cents: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    }).format(cents / 100);
  } catch {
    // Неизвестный код валюты — безопасный детерминированный fallback.
    return `${(cents / 100).toFixed(2)} ${currencyCode}`;
  }
}

/** «YYYY-MM-DD» → «DD.MM.YYYY» без пересчёта пояса (локальная дата ресторана). */
function formatLocalDate(localDate: string): string {
  const [y, m, d] = localDate.split("-");
  if (!y || !m || !d) return localDate;
  return `${d}.${m}.${y}`;
}

/** ISO-момент → «DD.MM.YYYY, HH:MM» в заданном поясе, ru-RU. Детерминированно. */
function formatInZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timeZone || "UTC",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// --- CSV-примитивы ----------------------------------------------------------

/**
 * Защита от CSV formula injection. Если после начальных ПРОБЕЛОВ поле начинается
 * с =, +, -, @, TAB или CR — префиксуем безопасным апострофом. Применяется только
 * к пользовательским текстовым полям (не к числовым суммам и не к системным
 * подписям, которые формируются нами и заведомо безопасны).
 */
function guardFormulaInjection(value: string): string {
  const withoutLeadingSpaces = value.replace(/^ +/, "");
  const first = withoutLeadingSpaces.charAt(0);
  if (
    first === "=" ||
    first === "+" ||
    first === "-" ||
    first === "@" ||
    first === "\t" ||
    first === "\r"
  ) {
    return `'${value}`;
  }
  return value;
}

/** RFC 4180-экранирование поля: кавычки удваиваются, спецсимволы → в кавычках. */
function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Системная подпись/дата/код — только экранирование, без injection-guard. */
function labelCell(value: string): string {
  return escapeField(value);
}

/** Пользовательский текст — сначала injection-guard, затем экранирование. */
function textCell(value: string): string {
  return escapeField(guardFormulaInjection(value));
}

/** Денежная сумма — форматируется и экранируется, но НЕ повреждается guard'ом. */
function moneyCell(cents: number, currencyCode: string): string {
  return escapeField(formatMoney(cents, currencyCode));
}

const row = (cells: string[]): string => cells.join(",");

// --- Сборка секций ----------------------------------------------------------

function metadataLines(
  view: RestaurantStatementView,
  asOfIso: string,
  timeZone: string,
): string[] {
  return [
    row([labelCell("Выписка по взаимным обязательствам Direct и ресторана")]),
    row([labelCell("Ресторан"), textCell(view.restaurantName)]),
    row([
      labelCell("Период"),
      labelCell(
        `${formatLocalDate(view.startLocalDate)} — ${formatLocalDate(view.endLocalDate)}`,
      ),
    ]),
    row([labelCell("Часовой пояс"), labelCell(timeZone)]),
    row([labelCell("Момент формирования"), labelCell(formatInZone(asOfIso, timeZone))]),
    row([
      labelCell("Назначение"),
      labelCell(
        "Документ предназначен для сверки и не подтверждает банковский перевод, " +
          "списание со счёта или автоматический взаимозачёт.",
      ),
    ]),
  ];
}

function currencySummaryLines(
  sections: readonly RestaurantStatementCurrencySection[],
): string[] {
  const header = row([
    labelCell("Валюта"),
    labelCell("Начало: ресторан должен Direct"),
    labelCell("Начало: Direct должен ресторану"),
    labelCell("Начало: чистая позиция"),
    labelCell("Признано: ресторан должен Direct"),
    labelCell("Признано: Direct должен ресторану"),
    labelCell("Подтверждено: ресторан должен Direct"),
    labelCell("Подтверждено: Direct должен ресторану"),
    labelCell("Списанная комиссия"),
    labelCell("Конец: ресторан должен Direct"),
    labelCell("Конец: Direct должен ресторану"),
    labelCell("Конец: чистая позиция"),
    labelCell("Сходимость"),
  ]);
  // Каждая валюта — отдельная строка в СОБСТВЕННОЙ валюте; суммы не смешиваются.
  const lines = sections.map((s) =>
    row([
      labelCell(s.currencyCode),
      moneyCell(s.openingRestaurantOwesDirectCents, s.currencyCode),
      moneyCell(s.openingDirectOwesRestaurantCents, s.currencyCode),
      moneyCell(s.openingNetCents, s.currencyCode),
      moneyCell(s.recognizedRestaurantOwesDirectCents, s.currencyCode),
      moneyCell(s.recognizedDirectOwesRestaurantCents, s.currencyCode),
      moneyCell(s.settledRestaurantOwesDirectCents, s.currencyCode),
      moneyCell(s.settledDirectOwesRestaurantCents, s.currencyCode),
      moneyCell(s.waivedRestaurantOwesDirectCents, s.currencyCode),
      moneyCell(s.closingRestaurantOwesDirectCents, s.currencyCode),
      moneyCell(s.closingDirectOwesRestaurantCents, s.currencyCode),
      moneyCell(s.closingNetCents, s.currencyCode),
      labelCell(s.isReconciled ? "Да" : "Нет"),
    ]),
  );
  return [row([labelCell("Сводка по валютам")]), header, ...lines];
}

function recognitionLines(
  rows: readonly RestaurantStatementRecognitionViewRow[],
  timeZone: string,
): string[] {
  const header = row([
    labelCell("Дата"),
    labelCell("Заказ"),
    labelCell("Кто кому должен"),
    labelCell("Основание"),
    labelCell("Сумма"),
    labelCell("Валюта"),
    labelCell("Источник"),
  ]);
  const lines = rows.map((r) =>
    row([
      labelCell(formatInZone(r.recognizedAt, timeZone)),
      textCell(r.orderLabel),
      labelCell(r.directionLabel),
      labelCell(r.typeLabel),
      moneyCell(r.amountCents, r.currencyCode),
      labelCell(r.currencyCode),
      labelCell(r.sourceLabel),
    ]),
  );
  return [row([labelCell("Признанные обязательства")]), header, ...lines];
}

function resolutionLines(
  rows: readonly RestaurantStatementResolutionViewRow[],
  timeZone: string,
): string[] {
  const header = row([
    labelCell("Дата"),
    labelCell("Заказ"),
    labelCell("Решение"),
    labelCell("Кто кому должен"),
    labelCell("Основание"),
    labelCell("Сумма"),
    labelCell("Валюта"),
    labelCell("Комментарий"),
    labelCell("Внешняя ссылка"),
  ]);
  const lines = rows.map((r) =>
    row([
      labelCell(formatInZone(r.occurredAt, timeZone)),
      textCell(r.orderLabel),
      labelCell(r.decisionLabel),
      labelCell(r.directionLabel),
      labelCell(r.typeLabel),
      moneyCell(r.amountCents, r.currencyCode),
      labelCell(r.currencyCode),
      // Пустые note/externalReference → пустое поле (не "undefined"/"null").
      textCell(r.note ?? ""),
      textCell(r.externalReference ?? ""),
    ]),
  );
  return [row([labelCell("Решения по обязательствам")]), header, ...lines];
}

function integrityLines(view: RestaurantStatementView): string[] {
  const header = row([labelCell("Предупреждение"), labelCell("Количество")]);
  const lines = view.integritySummary.map((g) =>
    // Только безопасное message + count; без entryKey/orderId (их нет в модели).
    row([labelCell(g.message), labelCell(String(g.count))]),
  );
  return [row([labelCell("Требуется проверка данных")]), header, ...lines];
}

// --- Публичный вход ---------------------------------------------------------

/**
 * Детерминированно сериализует уже сформированную выписку в CSV. Один и тот же
 * (view, asOfIso, timeZone) всегда даёт идентичный файл. Ничего не пересчитывает
 * и не мутирует.
 */
export function serializeRestaurantStatementCsv(
  view: RestaurantStatementView,
  asOfIso: string,
  timeZone: string,
): RestaurantStatementCsvFile {
  const blocks: string[][] = [
    metadataLines(view, asOfIso, timeZone),
    currencySummaryLines(view.currencySections),
    recognitionLines(view.recognitionRows, timeZone),
    resolutionLines(view.resolutionRows, timeZone),
    integrityLines(view),
  ];

  // Пустая строка-разделитель между секциями; все переносы — CRLF; UTF-8 BOM.
  const body = blocks.map((lines) => lines.join(CRLF)).join(CRLF + CRLF);
  const content = BOM + body + CRLF;

  const fileName = `direct-statement-${view.startLocalDate}_${view.endLocalDate}.csv`;

  return { fileName, mimeType: MIME_TYPE, content };
}
