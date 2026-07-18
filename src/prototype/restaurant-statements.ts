import type {
  CurrencyCode,
  PrototypeState,
  RestaurantAccountingDirection,
  RestaurantAccountingType,
} from "./models";
import {
  compareLocalDate,
  isValidTimeZone,
  localMidnightToUtcMs,
  parseLocalDate,
  shiftCalendarDate,
} from "./local-calendar";

/**
 * RESTAURANT STATEMENTS V1 — read-only ядро движений за период.
 *
 * Чистая функция строит список ПРИЗНАННЫХ (recognition) и ЗАКРЫВАЮЩИХ
 * (resolution) движений двустороннего журнала по локальным календарным датам
 * ресторана. Ничего не мутирует, финансы не пересчитывает: суммы берутся ТОЛЬКО
 * из неизменяемых RestaurantAccountingEntry.amountCents. Повреждённые события не
 * роняют statement и не попадают в денежные totals — они фиксируются отдельным
 * списком integrity issues. Разные валюты никогда не суммируются вместе.
 */

// --- Модели -----------------------------------------------------------------

export interface RestaurantStatementRange {
  /** Начальная локальная дата ресторана «YYYY-MM-DD» (включительно). */
  startLocalDate: string;
  /** Конечная локальная дата ресторана «YYYY-MM-DD» (включительно). */
  endLocalDate: string;
  timeZone: string;
  /** Момент «сейчас»: события позже него не включаются (будущее). */
  asOfIso: string;
}

export interface RestaurantStatementRecognitionRow {
  /** Внутренний ключ; будущему пользовательскому UI не показывать. */
  entryKey: string;
  publicNumber: string | null;
  recognizedAt: string;
  direction: RestaurantAccountingDirection;
  type: RestaurantAccountingType;
  amountCents: number;
  currencyCode: CurrencyCode;
  source: "ORDER_FINANCIAL_SNAPSHOT" | "LEGACY_COMMISSION_SETTLEMENT";
  hasOrder: boolean;
}

export interface RestaurantStatementResolutionRow {
  entryKey: string;
  publicNumber: string | null;
  occurredAt: string;
  outcome: "SETTLED" | "WAIVED";
  direction: RestaurantAccountingDirection;
  type: RestaurantAccountingType;
  amountCents: number;
  currencyCode: CurrencyCode;
  note: string;
  externalReference: string | null;
  hasOrder: boolean;
}

export type RestaurantStatementIssueKind =
  | "INVALID_RECOGNIZED_AT"
  | "INVALID_RESOLUTION_AT"
  | "RESOLUTION_ENTRY_NOT_FOUND"
  | "RESOLUTION_RESTAURANT_MISMATCH"
  | "FUTURE_EVENT_EXCLUDED";

export interface RestaurantStatementIntegrityIssue {
  kind: RestaurantStatementIssueKind;
  /** Внутренний ключ для диагностики (не для пользовательского текста). */
  entryKey: string;
}

/** Денежный итог за период по одной валюте (валюты не смешиваются). */
export interface RestaurantStatementCurrencySummary {
  currencyCode: CurrencyCode;
  recognizedRestaurantOwesDirectCents: number;
  recognizedDirectOwesRestaurantCents: number;
  settledRestaurantOwesDirectCents: number;
  settledDirectOwesRestaurantCents: number;
  waivedRestaurantOwesDirectCents: number;
  /** Direct должен ресторану минус ресторан должен Direct (по признанным). */
  recognizedNetCents: number;
}

export interface RestaurantStatementMovements {
  restaurantId: string;
  startLocalDate: string;
  endLocalDate: string;
  recognitions: RestaurantStatementRecognitionRow[];
  resolutions: RestaurantStatementResolutionRow[];
  summaries: RestaurantStatementCurrencySummary[];
  issues: RestaurantStatementIntegrityIssue[];
}

export interface RestaurantStatementResult {
  ok: boolean;
  error: string | null;
  movements: RestaurantStatementMovements | null;
}

// --- Внутренние аккумуляторы валют ------------------------------------------

function emptySummary(currencyCode: CurrencyCode): RestaurantStatementCurrencySummary {
  return {
    currencyCode,
    recognizedRestaurantOwesDirectCents: 0,
    recognizedDirectOwesRestaurantCents: 0,
    settledRestaurantOwesDirectCents: 0,
    settledDirectOwesRestaurantCents: 0,
    waivedRestaurantOwesDirectCents: 0,
    recognizedNetCents: 0,
  };
}

// --- Основная сборка --------------------------------------------------------

/**
 * Строит движения statement за период. Окно: локальная полночь startLocalDate
 * <= событие < локальная полночь дня ПОСЛЕ endLocalDate (границы по календарным
 * датам ресторана, корректно через DST). События позже asOfIso исключаются и
 * фиксируются как FUTURE_EVENT_EXCLUDED. Fail (с типизированной ошибкой, без
 * мутаций) при невалидных датах/поясе/asOf, start>end или отсутствии ресторана.
 */
export function buildRestaurantStatementMovements(
  state: PrototypeState,
  restaurantId: string,
  range: RestaurantStatementRange,
): RestaurantStatementResult {
  const fail = (error: string): RestaurantStatementResult => ({
    ok: false,
    error,
    movements: null,
  });

  const { startLocalDate, endLocalDate, timeZone, asOfIso } = range;

  if (!state.restaurants.some((r) => r.id === restaurantId)) {
    return fail("Ресторан не найден.");
  }
  if (!isValidTimeZone(timeZone)) {
    return fail("Некорректный часовой пояс.");
  }
  const start = parseLocalDate(startLocalDate);
  if (!start) return fail("Некорректная начальная дата.");
  const end = parseLocalDate(endLocalDate);
  if (!end) return fail("Некорректная конечная дата.");
  // Порядок дат сравниваем ПО КАЛЕНДАРЮ, а не через границы окна: соседний
  // перевёрнутый диапазон (start = день после end) иначе прошёл бы, т.к. его
  // startMs равен endExclusiveMs. Одинаковая дата валидна (compare == 0).
  if (compareLocalDate(start, end) > 0) {
    return fail("Начальная дата позже конечной.");
  }
  const startMs = localMidnightToUtcMs(start, timeZone);
  const endExclusiveMs = localMidnightToUtcMs(
    shiftCalendarDate(end, 1),
    timeZone,
  );
  const asOfMs = Date.parse(asOfIso);
  if (typeof asOfIso !== "string" || Number.isNaN(asOfMs)) {
    return fail("Некорректное время среза.");
  }

  const publicNumberByOrderId = new Map<string, string>();
  for (const order of state.orders) {
    publicNumberByOrderId.set(order.id, order.publicNumber);
  }
  const entryById = new Map(
    state.restaurantAccountingEntries.map((e) => [e.id, e]),
  );

  const recognitions: RestaurantStatementRecognitionRow[] = [];
  const resolutions: RestaurantStatementResolutionRow[] = [];
  const issues: RestaurantStatementIntegrityIssue[] = [];
  const summaryByCurrency = new Map<
    string,
    RestaurantStatementCurrencySummary
  >();
  const bucket = (currencyCode: CurrencyCode) => {
    let s = summaryByCurrency.get(currencyCode);
    if (!s) {
      s = emptySummary(currencyCode);
      summaryByCurrency.set(currencyCode, s);
    }
    return s;
  };

  // Попадает ли момент в окно периода (без учёта asOf). null если вне окна.
  const inWindow = (ms: number): boolean =>
    ms >= startMs && ms < endExclusiveMs;

  // --- Признанные движения ---
  for (const entry of state.restaurantAccountingEntries) {
    if (entry.restaurantId !== restaurantId) continue;
    const ms = Date.parse(entry.recognizedAt);
    if (Number.isNaN(ms)) {
      issues.push({ kind: "INVALID_RECOGNIZED_AT", entryKey: entry.id });
      continue;
    }
    if (!inWindow(ms)) continue;
    if (ms > asOfMs) {
      issues.push({ kind: "FUTURE_EVENT_EXCLUDED", entryKey: entry.id });
      continue;
    }
    const publicNumber = publicNumberByOrderId.get(entry.orderId) ?? null;
    recognitions.push({
      entryKey: entry.id,
      publicNumber,
      recognizedAt: entry.recognizedAt,
      direction: entry.direction,
      type: entry.type,
      amountCents: entry.amountCents,
      currencyCode: entry.currencyCode,
      source: entry.source,
      hasOrder: publicNumber !== null,
    });
    const s = bucket(entry.currencyCode);
    if (entry.direction === "RESTAURANT_OWES_DIRECT") {
      s.recognizedRestaurantOwesDirectCents += entry.amountCents;
    } else {
      s.recognizedDirectOwesRestaurantCents += entry.amountCents;
    }
  }

  // --- Закрывающие движения ---
  for (const event of state.restaurantAccountingResolutionEvents) {
    const entry = entryById.get(event.accountingEntryId);
    const eventSelected = event.restaurantId === restaurantId;
    const entrySelected = entry?.restaurantId === restaurantId;

    if (!entry) {
      // Entry отсутствует. Фиксируем только если само событие относится к
      // выбранному ресторану; чужое повреждённое событие пропускаем.
      if (eventSelected) {
        issues.push({
          kind: "RESOLUTION_ENTRY_NOT_FOUND",
          entryKey: event.accountingEntryId,
        });
      }
      continue;
    }

    if (event.restaurantId !== entry.restaurantId) {
      // Несовпадение ресторанов события и записи. Fail-safe: сумму не учитываем,
      // строку не создаём. Issue — если хотя бы одна сторона относится к
      // выбранному ресторану (двунаправленно). Если обе стороны чужие — не наша
      // проблема, пропускаем без issue.
      if (eventSelected || entrySelected) {
        issues.push({
          kind: "RESOLUTION_RESTAURANT_MISMATCH",
          entryKey: entry.id,
        });
      }
      continue;
    }

    // Здесь event.restaurantId === entry.restaurantId. Если это не выбранный
    // ресторан — согласованное чужое движение, просто пропускаем.
    if (!eventSelected) continue;

    const ms = Date.parse(event.occurredAt);
    if (Number.isNaN(ms)) {
      issues.push({ kind: "INVALID_RESOLUTION_AT", entryKey: entry.id });
      continue;
    }
    if (!inWindow(ms)) continue;
    if (ms > asOfMs) {
      issues.push({ kind: "FUTURE_EVENT_EXCLUDED", entryKey: entry.id });
      continue;
    }
    const publicNumber = publicNumberByOrderId.get(entry.orderId) ?? null;
    resolutions.push({
      entryKey: entry.id,
      publicNumber,
      occurredAt: event.occurredAt,
      outcome: event.nextStatus,
      direction: entry.direction,
      type: entry.type,
      amountCents: entry.amountCents,
      currencyCode: entry.currencyCode,
      note: event.note,
      externalReference: event.externalReference,
      hasOrder: publicNumber !== null,
    });
    const s = bucket(entry.currencyCode);
    // Классифицируем строго по фактическим (outcome, direction) — повреждённые
    // сочетания не переклассифицируем в чужой bucket.
    if (event.nextStatus === "SETTLED") {
      if (entry.direction === "RESTAURANT_OWES_DIRECT") {
        s.settledRestaurantOwesDirectCents += entry.amountCents;
      } else {
        s.settledDirectOwesRestaurantCents += entry.amountCents;
      }
    } else if (
      event.nextStatus === "WAIVED" &&
      entry.direction === "RESTAURANT_OWES_DIRECT"
    ) {
      s.waivedRestaurantOwesDirectCents += entry.amountCents;
    }
    // WAIVED для DIRECT_OWES_RESTAURANT доменно невозможно; при повреждении сумма
    // не добавляется ни в один bucket (fail-safe, без переклассификации).
  }

  // Сортировка: новые сверху, детерминированный tie-breaker по entryKey.
  recognitions.sort((a, b) => {
    const d = Date.parse(b.recognizedAt) - Date.parse(a.recognizedAt);
    if (d !== 0) return d;
    return a.entryKey < b.entryKey ? -1 : a.entryKey > b.entryKey ? 1 : 0;
  });
  resolutions.sort((a, b) => {
    const d = Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
    if (d !== 0) return d;
    return a.entryKey < b.entryKey ? -1 : a.entryKey > b.entryKey ? 1 : 0;
  });

  const summaries = [...summaryByCurrency.values()]
    .map((s) => ({
      ...s,
      recognizedNetCents:
        s.recognizedDirectOwesRestaurantCents -
        s.recognizedRestaurantOwesDirectCents,
    }))
    .sort((a, b) =>
      a.currencyCode < b.currencyCode
        ? -1
        : a.currencyCode > b.currencyCode
          ? 1
          : 0,
    );

  return {
    ok: true,
    error: null,
    movements: {
      restaurantId,
      startLocalDate,
      endLocalDate,
      recognitions,
      resolutions,
      summaries,
      issues,
    },
  };
}
