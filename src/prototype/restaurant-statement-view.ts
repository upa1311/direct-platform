import type { CurrencyCode, PrototypeState } from "./models";
import {
  ACCOUNTING_DIRECTION_LABELS,
  ACCOUNTING_SOURCE_LABELS,
  ACCOUNTING_TYPE_LABELS,
} from "./restaurant-accounting";
import {
  buildRestaurantStatementMovements,
  type RestaurantStatementCurrencySummary,
  type RestaurantStatementIssueKind,
  type RestaurantStatementRange,
} from "./restaurant-statements";

/**
 * Read-only presentation-model выписки ресторана. Полностью делегирует расчёт
 * buildRestaurantStatementMovements и НЕ пересчитывает периоды, суммы,
 * opening/closing, canonical resolution или валютные итоги — только переводит
 * готовый результат в безопасную русскую пользовательскую модель без внутренних
 * идентификаторов и сырых enum. Ничего не мутирует.
 */

// --- Публичные модели -------------------------------------------------------

export interface RestaurantStatementCurrencySection {
  currencyCode: CurrencyCode;
  openingRestaurantOwesDirectCents: number;
  openingDirectOwesRestaurantCents: number;
  openingNetCents: number;
  recognizedRestaurantOwesDirectCents: number;
  recognizedDirectOwesRestaurantCents: number;
  settledRestaurantOwesDirectCents: number;
  settledDirectOwesRestaurantCents: number;
  waivedRestaurantOwesDirectCents: number;
  closingRestaurantOwesDirectCents: number;
  closingDirectOwesRestaurantCents: number;
  closingNetCents: number;
  /** Сходятся ли closing-позиции с opening + движениями (без подгонки сумм). */
  isReconciled: boolean;
}

export interface RestaurantStatementRecognitionViewRow {
  publicNumber: string | null;
  /** Публичный номер заказа либо «Старое начисление». */
  orderLabel: string;
  recognizedAt: string;
  directionLabel: string;
  typeLabel: string;
  amountCents: number;
  currencyCode: CurrencyCode;
  sourceLabel: string;
}

export interface RestaurantStatementResolutionViewRow {
  publicNumber: string | null;
  orderLabel: string;
  occurredAt: string;
  decisionLabel: string;
  directionLabel: string;
  typeLabel: string;
  amountCents: number;
  currencyCode: CurrencyCode;
  note: string;
  externalReference: string | null;
}

/** Безопасная группа integrity-проблем: русское сообщение + счётчик. */
export interface RestaurantStatementIntegrityGroup {
  message: string;
  count: number;
}

export interface RestaurantStatementView {
  restaurantName: string;
  startLocalDate: string;
  endLocalDate: string;
  timeZone: string;
  currencySections: RestaurantStatementCurrencySection[];
  recognitionRows: RestaurantStatementRecognitionViewRow[];
  resolutionRows: RestaurantStatementResolutionViewRow[];
  integritySummary: RestaurantStatementIntegrityGroup[];
  hasIntegrityWarnings: boolean;
}

export interface RestaurantStatementViewResult {
  ok: boolean;
  error: string | null;
  view: RestaurantStatementView | null;
}

// --- Русские подписи --------------------------------------------------------

const ORPHAN_ORDER_LABEL = "Старое начисление";

const DECISION_LABELS: Record<"SETTLED" | "WAIVED", string> = {
  SETTLED: "Расчёт подтверждён",
  WAIVED: "Комиссия Direct списана",
};

/** Сообщения integrity-проблем. */
const ISSUE_MESSAGES: Record<RestaurantStatementIssueKind, string> = {
  INVALID_RECOGNIZED_AT: "Не удалось прочитать дату признания обязательства.",
  INVALID_RESOLUTION_AT: "Не удалось прочитать дату решения по обязательству.",
  RESOLUTION_ENTRY_NOT_FOUND: "Решение связано с отсутствующим обязательством.",
  RESOLUTION_RESTAURANT_MISMATCH:
    "Ресторан в решении не совпадает с рестораном обязательства.",
  RESOLUTION_BEFORE_RECOGNITION:
    "Решение датировано раньше признания обязательства.",
  INVALID_RESOLUTION_OUTCOME: "Обнаружен недопустимый результат решения.",
  DUPLICATE_RESOLUTION_EVENT:
    "Обнаружено несколько решений по одному обязательству.",
  FUTURE_EVENT_EXCLUDED:
    "Событие после момента формирования выписки исключено.",
};

/** Фиксированный порядок групп integrity в выписке (не порядок массива issues). */
const ISSUE_ORDER: readonly RestaurantStatementIssueKind[] = [
  "INVALID_RECOGNIZED_AT",
  "INVALID_RESOLUTION_AT",
  "RESOLUTION_ENTRY_NOT_FOUND",
  "RESOLUTION_RESTAURANT_MISMATCH",
  "RESOLUTION_BEFORE_RECOGNITION",
  "INVALID_RESOLUTION_OUTCOME",
  "DUPLICATE_RESOLUTION_EVENT",
  "FUTURE_EVENT_EXCLUDED",
];

// --- Чистые хелперы ---------------------------------------------------------

/**
 * Сходится ли валютная секция: closing = opening + признано − закрыто. Только
 * проверка существующих summary-полей, без исправления или подгонки сумм.
 */
export function isCurrencySummaryReconciled(
  summary: RestaurantStatementCurrencySummary,
): boolean {
  const receivableOk =
    summary.closingRestaurantOwesDirectCents ===
    summary.openingRestaurantOwesDirectCents +
      summary.recognizedRestaurantOwesDirectCents -
      summary.settledRestaurantOwesDirectCents -
      summary.waivedRestaurantOwesDirectCents;
  const payableOk =
    summary.closingDirectOwesRestaurantCents ===
    summary.openingDirectOwesRestaurantCents +
      summary.recognizedDirectOwesRestaurantCents -
      summary.settledDirectOwesRestaurantCents;
  return receivableOk && payableOk;
}

const orderLabelOf = (publicNumber: string | null): string =>
  publicNumber ?? ORPHAN_ORDER_LABEL;

// --- Основная сборка --------------------------------------------------------

/**
 * Строит безопасную выписку ресторана за период. Делегирует расчёт statement
 * core; при его fail возвращает безопасную русскую ошибку и view = null (без
 * частичной выписки). State не мутируется.
 */
export function buildRestaurantStatementView(
  state: PrototypeState,
  restaurantId: string,
  range: RestaurantStatementRange,
): RestaurantStatementViewResult {
  const core = buildRestaurantStatementMovements(state, restaurantId, range);
  if (!core.ok || !core.movements) {
    return { ok: false, error: core.error, view: null };
  }
  const movements = core.movements;

  const restaurantName =
    state.restaurants.find((r) => r.id === restaurantId)?.name ?? "Ресторан";

  const currencySections: RestaurantStatementCurrencySection[] =
    movements.summaries.map((s) => ({
      currencyCode: s.currencyCode,
      openingRestaurantOwesDirectCents: s.openingRestaurantOwesDirectCents,
      openingDirectOwesRestaurantCents: s.openingDirectOwesRestaurantCents,
      openingNetCents: s.openingNetCents,
      recognizedRestaurantOwesDirectCents: s.recognizedRestaurantOwesDirectCents,
      recognizedDirectOwesRestaurantCents: s.recognizedDirectOwesRestaurantCents,
      settledRestaurantOwesDirectCents: s.settledRestaurantOwesDirectCents,
      settledDirectOwesRestaurantCents: s.settledDirectOwesRestaurantCents,
      waivedRestaurantOwesDirectCents: s.waivedRestaurantOwesDirectCents,
      closingRestaurantOwesDirectCents: s.closingRestaurantOwesDirectCents,
      closingDirectOwesRestaurantCents: s.closingDirectOwesRestaurantCents,
      closingNetCents: s.closingNetCents,
      isReconciled: isCurrencySummaryReconciled(s),
    }));

  const recognitionRows: RestaurantStatementRecognitionViewRow[] =
    movements.recognitions.map((row) => ({
      publicNumber: row.publicNumber,
      orderLabel: orderLabelOf(row.publicNumber),
      recognizedAt: row.recognizedAt,
      directionLabel: ACCOUNTING_DIRECTION_LABELS[row.direction],
      typeLabel: ACCOUNTING_TYPE_LABELS[row.type],
      amountCents: row.amountCents,
      currencyCode: row.currencyCode,
      sourceLabel: ACCOUNTING_SOURCE_LABELS[row.source],
    }));

  const resolutionRows: RestaurantStatementResolutionViewRow[] =
    movements.resolutions.map((row) => ({
      publicNumber: row.publicNumber,
      orderLabel: orderLabelOf(row.publicNumber),
      occurredAt: row.occurredAt,
      decisionLabel: DECISION_LABELS[row.outcome],
      directionLabel: ACCOUNTING_DIRECTION_LABELS[row.direction],
      typeLabel: ACCOUNTING_TYPE_LABELS[row.type],
      amountCents: row.amountCents,
      currencyCode: row.currencyCode,
      note: row.note,
      externalReference: row.externalReference,
    }));

  // Группировка issues по kind в фиксированном порядке; внутренние entryKey в
  // публичную модель не выводятся.
  const countByKind = new Map<RestaurantStatementIssueKind, number>();
  for (const issue of movements.issues) {
    countByKind.set(issue.kind, (countByKind.get(issue.kind) ?? 0) + 1);
  }
  const integritySummary: RestaurantStatementIntegrityGroup[] = ISSUE_ORDER.flatMap(
    (kind) => {
      const count = countByKind.get(kind) ?? 0;
      return count > 0 ? [{ message: ISSUE_MESSAGES[kind], count }] : [];
    },
  );

  return {
    ok: true,
    error: null,
    view: {
      restaurantName,
      startLocalDate: movements.startLocalDate,
      endLocalDate: movements.endLocalDate,
      timeZone: range.timeZone,
      currencySections,
      recognitionRows,
      resolutionRows,
      integritySummary,
      hasIntegrityWarnings: integritySummary.length > 0,
    },
  };
}
