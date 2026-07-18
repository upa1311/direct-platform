import type {
  CurrencyCode,
  PrototypeState,
  RestaurantAccountingDirection,
  RestaurantAccountingEntry,
  RestaurantAccountingResolutionEvent,
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
  | "RESOLUTION_BEFORE_RECOGNITION"
  | "DUPLICATE_RESOLUTION_EVENT"
  | "FUTURE_EVENT_EXCLUDED";

export interface RestaurantStatementIntegrityIssue {
  kind: RestaurantStatementIssueKind;
  /** Внутренний ключ для диагностики (не для пользовательского текста). */
  entryKey: string;
}

/** Денежный итог за период по одной валюте (валюты не смешиваются). */
export interface RestaurantStatementCurrencySummary {
  currencyCode: CurrencyCode;
  /** Позиция на начало периода (исторический replay до startCutoff). */
  openingRestaurantOwesDirectCents: number;
  openingDirectOwesRestaurantCents: number;
  openingNetCents: number;
  recognizedRestaurantOwesDirectCents: number;
  recognizedDirectOwesRestaurantCents: number;
  settledRestaurantOwesDirectCents: number;
  settledDirectOwesRestaurantCents: number;
  waivedRestaurantOwesDirectCents: number;
  /** Direct должен ресторану минус ресторан должен Direct (по признанным). */
  recognizedNetCents: number;
  /** Позиция на конец периода (исторический replay до endExclusive и asOf). */
  closingRestaurantOwesDirectCents: number;
  closingDirectOwesRestaurantCents: number;
  closingNetCents: number;
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
    openingRestaurantOwesDirectCents: 0,
    openingDirectOwesRestaurantCents: 0,
    openingNetCents: 0,
    recognizedRestaurantOwesDirectCents: 0,
    recognizedDirectOwesRestaurantCents: 0,
    settledRestaurantOwesDirectCents: 0,
    settledDirectOwesRestaurantCents: 0,
    waivedRestaurantOwesDirectCents: 0,
    recognizedNetCents: 0,
    closingRestaurantOwesDirectCents: 0,
    closingDirectOwesRestaurantCents: 0,
    closingNetCents: 0,
  };
}

// --- Основная сборка --------------------------------------------------------

/**
 * Строит движения statement за период плюс исторические opening/closing позиции
 * по каждой валюте. Окно движений: локальная полночь startLocalDate <= событие <
 * локальная полночь дня ПОСЛЕ endLocalDate (границы по календарным датам, DST-
 * корректно). События позже asOfIso исключаются (FUTURE_EVENT_EXCLUDED).
 *
 * Opening/closing вычисляются ИСТОРИЧЕСКИМ replay recognition/resolution, а не из
 * текущего entry.status: обязательство открыто, пока его CANONICAL resolution не
 * закрыл его валидно раньше соответствующей границы (и не позже asOf). На одну
 * запись учитывается не более одного canonical resolution — он же используется в
 * движениях, так totals и balances согласованы. Fail (типизированная ошибка, без
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

  // --- Canonical resolution на обязательство ---
  // Сначала собираем ВАЛИДНЫЕ resolution-кандидаты по каждой записи выбранного
  // ресторана и попутно фиксируем per-event повреждения. Канонический resolution
  // (самый ранний по occurredAt, tie-break по event.id) используется одновременно
  // для движений, opening и closing — чтобы balances не расходились с движениями.
  const validCandidatesByEntry = new Map<
    string,
    RestaurantAccountingResolutionEvent[]
  >();
  for (const event of state.restaurantAccountingResolutionEvents) {
    const entry = entryById.get(event.accountingEntryId);
    const eventSelected = event.restaurantId === restaurantId;
    const entrySelected = entry?.restaurantId === restaurantId;

    if (!entry) {
      if (eventSelected) {
        issues.push({
          kind: "RESOLUTION_ENTRY_NOT_FOUND",
          entryKey: event.accountingEntryId,
        });
      }
      continue;
    }
    if (event.restaurantId !== entry.restaurantId) {
      // Двунаправленный mismatch: issue, если хотя бы одна сторона — выбранный.
      if (eventSelected || entrySelected) {
        issues.push({
          kind: "RESOLUTION_RESTAURANT_MISMATCH",
          entryKey: entry.id,
        });
      }
      continue;
    }
    // event.restaurantId === entry.restaurantId. Чужой согласованный — пропуск.
    if (!eventSelected) continue;

    const occMs = Date.parse(event.occurredAt);
    if (Number.isNaN(occMs)) {
      issues.push({ kind: "INVALID_RESOLUTION_AT", entryKey: entry.id });
      continue;
    }
    const recMs = Date.parse(entry.recognizedAt);
    // Запись с невалидной датой признания уже помечена INVALID_RECOGNIZED_AT и не
    // признаётся; её resolution ничего не закрывает.
    if (Number.isNaN(recMs)) continue;
    if (occMs < recMs) {
      issues.push({ kind: "RESOLUTION_BEFORE_RECOGNITION", entryKey: entry.id });
      continue;
    }
    const list = validCandidatesByEntry.get(entry.id);
    if (list) list.push(event);
    else validCandidatesByEntry.set(entry.id, [event]);
  }

  const canonicalByEntry = new Map<string, RestaurantAccountingResolutionEvent>();
  for (const [entryId, list] of validCandidatesByEntry) {
    list.sort((a, b) => {
      const d = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
      if (d !== 0) return d;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    canonicalByEntry.set(entryId, list[0]);
    if (list.length > 1) {
      issues.push({ kind: "DUPLICATE_RESOLUTION_EVENT", entryKey: entryId });
    }
  }

  // Валидное закрытие: SETTLED закрывает оба направления; WAIVED — только
  // требование ресторана перед Direct (receivable).
  const isValidClosure = (
    event: RestaurantAccountingResolutionEvent,
    entry: RestaurantAccountingEntry,
  ): boolean =>
    event.nextStatus === "SETTLED" ||
    (event.nextStatus === "WAIVED" &&
      entry.direction === "RESTAURANT_OWES_DIRECT");

  // --- Закрывающие движения (только canonical) ---
  for (const [entryId, canonical] of canonicalByEntry) {
    const entry = entryById.get(entryId)!;
    const occMs = Date.parse(canonical.occurredAt);
    if (!inWindow(occMs)) continue;
    if (occMs > asOfMs) {
      issues.push({ kind: "FUTURE_EVENT_EXCLUDED", entryKey: entryId });
      continue;
    }
    const publicNumber = publicNumberByOrderId.get(entry.orderId) ?? null;
    resolutions.push({
      entryKey: entry.id,
      publicNumber,
      occurredAt: canonical.occurredAt,
      outcome: canonical.nextStatus,
      direction: entry.direction,
      type: entry.type,
      amountCents: entry.amountCents,
      currencyCode: entry.currencyCode,
      note: canonical.note,
      externalReference: canonical.externalReference,
      hasOrder: publicNumber !== null,
    });
    const s = bucket(entry.currencyCode);
    // Классифицируем строго по (outcome, direction); повреждённые сочетания не
    // переклассифицируем (WAIVED для payout доменно невозможен).
    if (canonical.nextStatus === "SETTLED") {
      if (entry.direction === "RESTAURANT_OWES_DIRECT") {
        s.settledRestaurantOwesDirectCents += entry.amountCents;
      } else {
        s.settledDirectOwesRestaurantCents += entry.amountCents;
      }
    } else if (
      canonical.nextStatus === "WAIVED" &&
      entry.direction === "RESTAURANT_OWES_DIRECT"
    ) {
      s.waivedRestaurantOwesDirectCents += entry.amountCents;
    }
  }

  // --- Исторические позиции opening/closing (replay, не текущий status) ---
  for (const entry of state.restaurantAccountingEntries) {
    if (entry.restaurantId !== restaurantId) continue;
    const recMs = Date.parse(entry.recognizedAt);
    if (Number.isNaN(recMs)) continue; // невалидная дата признания — уже помечена
    if (recMs > asOfMs) continue; // не признано на момент asOf
    const canonical = canonicalByEntry.get(entry.id);
    // Обязательство валидно закрыто до момента x, если canonical — валидное
    // закрытие своей стороны, произошло строго раньше x и не позже asOf.
    const closedBefore = (x: number): boolean => {
      if (!canonical || !isValidClosure(canonical, entry)) return false;
      const occMs = Date.parse(canonical.occurredAt);
      return occMs < x && occMs <= asOfMs;
    };
    const s = bucket(entry.currencyCode);
    // Opening: признано строго до начала периода и ещё не закрыто к началу.
    if (recMs < startMs && !closedBefore(startMs)) {
      if (entry.direction === "RESTAURANT_OWES_DIRECT") {
        s.openingRestaurantOwesDirectCents += entry.amountCents;
      } else {
        s.openingDirectOwesRestaurantCents += entry.amountCents;
      }
    }
    // Closing: признано до конца периода и ещё не закрыто к концу (и не позже asOf).
    if (recMs < endExclusiveMs && !closedBefore(endExclusiveMs)) {
      if (entry.direction === "RESTAURANT_OWES_DIRECT") {
        s.closingRestaurantOwesDirectCents += entry.amountCents;
      } else {
        s.closingDirectOwesRestaurantCents += entry.amountCents;
      }
    }
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
      // net = Direct должен ресторану − ресторан должен Direct.
      openingNetCents:
        s.openingDirectOwesRestaurantCents -
        s.openingRestaurantOwesDirectCents,
      recognizedNetCents:
        s.recognizedDirectOwesRestaurantCents -
        s.recognizedRestaurantOwesDirectCents,
      closingNetCents:
        s.closingDirectOwesRestaurantCents -
        s.closingRestaurantOwesDirectCents,
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
