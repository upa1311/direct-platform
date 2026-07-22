import type {
  RestaurantAccountingEntry,
  RestaurantSettlementExecution,
  RestaurantSettlementMethod,
  RestaurantSettlementNetDirection,
  RestaurantSettlementRecord,
} from "./models";
import {
  ACCOUNTING_RESOLUTION_NOTE_MAX,
  ACCOUNTING_RESOLUTION_REFERENCE_MAX,
} from "./restaurant-accounting";

/**
 * Чистая intrinsic-валидация финансовых сущностей расчёта. Не зависит от
 * PrototypeState, ничего не мутирует и ничего не пересчитывает: сохранённая
 * запись либо полностью валидна, либо отклоняется. Используется и доменным
 * действием (defensive invariant перед мутацией), и normalization при чтении
 * сохранённого состояния — один канон вместо двух похожих проверок.
 */

/**
 * Единственно допустимые пары «направление + основание» обязательства. Ровно
 * три: комиссия Direct и перечисление ресторана (v13) всегда идут от ресторана
 * к Direct, выплата — от Direct ресторану. Проверять направление и тип
 * независимо нельзя: смешанная пара (например, выплата в сторону Direct) —
 * повреждённые данные, а не редкий бизнес-случай.
 */
const ALLOWED_DIRECTION_TYPE: Record<
  RestaurantAccountingEntry["direction"],
  readonly RestaurantAccountingEntry["type"][]
> = {
  RESTAURANT_OWES_DIRECT: ["PLATFORM_COMMISSION", "RESTAURANT_REMITTANCE"],
  DIRECT_OWES_RESTAURANT: ["RESTAURANT_PAYOUT"],
};

/** Единый текст отказа: частичный расчёт пока не поддерживается. */
export const PARTIAL_SETTLEMENT_ERROR =
  "Частичный расчёт пока не поддерживается. Фактическая сумма должна совпадать с итогом расчёта.";

export const SETTLEMENT_DIRECTION_TYPE_ERROR =
  "Тип обязательства не соответствует направлению.";

/** Совместимы ли направление и основание обязательства. */
export function isAllowedDirectionTypePair(
  direction: unknown,
  type: unknown,
): boolean {
  if (direction !== "RESTAURANT_OWES_DIRECT" && direction !== "DIRECT_OWES_RESTAURANT") {
    return false;
  }
  return ALLOWED_DIRECTION_TYPE[direction].some(
    (allowed) => allowed === type,
  );
}

/**
 * Канонический ISO-8601 timestamp финансовой операции: полная дата, время с
 * секундами, необязательные дробные секунды и ОБЯЗАТЕЛЬНЫЙ часовой пояс (Z
 * либо ±HH:MM). Дата без времени и время без пояса — не канон: момент такой
 * строки зависит от интерпретатора, а финансовая операция обязана быть
 * однозначной.
 */
const CANONICAL_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Дней в месяце с учётом високосного года (григорианский календарь). */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Единый validator времени финансовых операций расчёта. Проверяет и ФОРМУ
 * (полный ISO-8601 с обязательным поясом), и реальность календарной даты и
 * времени, и итоговую парсируемость в конкретный момент.
 *
 * Нормализация запрещена: «2026-07-20» не превращается в полночь UTC, пояс не
 * добавляется автоматически — неканоническое значение отклоняется fail-closed.
 * Исходная строка не переписывается: timestamp со смещением сохраняется как
 * есть и в UTC не конвертируется.
 */
export function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CANONICAL_ISO_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8];

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  // Секунда 60 (leap second) в момент не парсится — время должно быть реальным.
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  // Форма верна — убеждаемся, что строка действительно даёт валидный момент.
  return !Number.isNaN(Date.parse(value));
}

/** Известные способы фактического расчёта (v14). */
const SETTLEMENT_METHODS: readonly RestaurantSettlementMethod[] = [
  "BANK_TRANSFER",
  "CASH",
  "OTHER",
  "NETTING",
];

/** Поля, допустимые внутри execution каждого dataStatus. */
const COMPLETE_EXECUTION_KEYS: readonly string[] = [
  "dataStatus",
  "method",
  "transferredAmountCents",
  "remainingOpenEntryCount",
  "remainingRestaurantOwesDirectCents",
  "remainingDirectOwesRestaurantCents",
  "remainingNetDirection",
  "remainingNetAmountCents",
];

export type SettlementExecutionValidationResult =
  | { ok: true; execution: RestaurantSettlementExecution }
  | { ok: false; error: string };

/**
 * Валидация деталей исполнения расчёта (v14).
 *
 * COMPLETE обязан быть полным и согласованным с самим расчётом: при нулевом
 * итоге допустим ТОЛЬКО взаимозачёт с нулевой переданной суммой, при ненулевом
 * — только внешний способ, сумма СТРОГО равная итогу (частичный расчёт не
 * поддерживается) и внешняя ссылка. Остаток проверяется на внутреннюю
 * согласованность: направление и модуль обязаны следовать из gross-сторон.
 *
 * LEGACY_UNKNOWN — исторический маркер: любое дополнительное поле означает,
 * что кто-то попытался додумать несохранённые детали, и отклоняется.
 */
export function validateSettlementExecution(
  value: unknown,
  netDirection: RestaurantSettlementNetDirection,
  netAmountCents: number,
  externalReference: string | null,
): SettlementExecutionValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Детали расчёта повреждены." };
  }
  const raw = value as Record<string, unknown>;

  if (raw.dataStatus === "LEGACY_UNKNOWN") {
    if (Object.keys(raw).length !== 1) {
      return {
        ok: false,
        error: "Архивная запись не может содержать детали исполнения.",
      };
    }
    return { ok: true, execution: { dataStatus: "LEGACY_UNKNOWN" } };
  }
  if (raw.dataStatus !== "COMPLETE") {
    return { ok: false, error: "Неизвестный статус деталей расчёта." };
  }
  for (const key of Object.keys(raw)) {
    if (!COMPLETE_EXECUTION_KEYS.includes(key)) {
      return { ok: false, error: "Детали расчёта содержат лишние поля." };
    }
  }
  if (Object.keys(raw).length !== COMPLETE_EXECUTION_KEYS.length) {
    return { ok: false, error: "Детали расчёта неполные." };
  }

  const method = raw.method;
  if (!SETTLEMENT_METHODS.includes(method as RestaurantSettlementMethod)) {
    return { ok: false, error: "Неизвестный способ расчёта." };
  }
  if (!isValidCents(raw.transferredAmountCents)) {
    return { ok: false, error: "Некорректная фактически переданная сумма." };
  }
  const transferredAmountCents = raw.transferredAmountCents;

  // Согласованность способа, переданной суммы и итога расчёта.
  if (netDirection === "BALANCED") {
    if (method !== "NETTING") {
      return {
        ok: false,
        error: "При нулевом итоге возможен только взаимозачёт.",
      };
    }
    if (transferredAmountCents !== 0) {
      return {
        ok: false,
        error: "При взаимозачёте фактически переданная сумма равна нулю.",
      };
    }
  } else {
    if (method === "NETTING") {
      return {
        ok: false,
        error: "Взаимозачёт возможен только при нулевом итоге расчёта.",
      };
    }
    // Частичные расчёты не поддерживаются: сумма обязана совпасть точно.
    if (transferredAmountCents !== netAmountCents) {
      return { ok: false, error: PARTIAL_SETTLEMENT_ERROR };
    }
    if (transferredAmountCents <= 0) {
      return { ok: false, error: PARTIAL_SETTLEMENT_ERROR };
    }
    if (externalReference === null) {
      return { ok: false, error: "Расчёт с ненулевым итогом без внешней ссылки." };
    }
  }

  // Остаток открытой позиции: счётчик и обе стороны — безопасные значения.
  if (!isValidCents(raw.remainingOpenEntryCount)) {
    return { ok: false, error: "Некорректное число оставшихся обязательств." };
  }
  if (
    !isValidCents(raw.remainingRestaurantOwesDirectCents) ||
    !isValidCents(raw.remainingDirectOwesRestaurantCents)
  ) {
    return { ok: false, error: "Некорректные суммы остатка расчёта." };
  }
  const remainingRestaurantOwesDirectCents = raw.remainingRestaurantOwesDirectCents;
  const remainingDirectOwesRestaurantCents = raw.remainingDirectOwesRestaurantCents;
  if (!isValidCents(raw.remainingNetAmountCents)) {
    return { ok: false, error: "Некорректный остаток расчёта." };
  }
  const expectedRemainingNet = Math.abs(
    remainingDirectOwesRestaurantCents - remainingRestaurantOwesDirectCents,
  );
  if (!Number.isSafeInteger(expectedRemainingNet)) {
    return { ok: false, error: "Остаток расчёта вне безопасного диапазона." };
  }
  if (raw.remainingNetAmountCents !== expectedRemainingNet) {
    return { ok: false, error: "Остаток расчёта не соответствует суммам сторон." };
  }
  const expectedRemainingDirection = expectedNetDirection(
    remainingRestaurantOwesDirectCents,
    remainingDirectOwesRestaurantCents,
  );
  if (raw.remainingNetDirection !== expectedRemainingDirection) {
    return {
      ok: false,
      error: "Направление остатка не соответствует суммам сторон.",
    };
  }

  return {
    ok: true,
    execution: {
      dataStatus: "COMPLETE",
      method: method as RestaurantSettlementMethod,
      transferredAmountCents,
      remainingOpenEntryCount: raw.remainingOpenEntryCount,
      remainingRestaurantOwesDirectCents,
      remainingDirectOwesRestaurantCents,
      remainingNetDirection: expectedRemainingDirection,
      remainingNetAmountCents: raw.remainingNetAmountCents,
    },
  };
}

export type SettlementRecordValidationResult =
  | { ok: true; record: RestaurantSettlementRecord }
  | { ok: false; error: string };

function invalid(error: string): SettlementRecordValidationResult {
  return { ok: false, error };
}

/** Непустая после trim строка. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Целые неотрицательные центы в безопасном диапазоне. */
function isValidCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

/** Ожидаемое направление итога по gross-суммам сторон. */
function expectedNetDirection(
  restaurantOwesDirectCents: number,
  directOwesRestaurantCents: number,
): RestaurantSettlementNetDirection {
  if (directOwesRestaurantCents > restaurantOwesDirectCents) {
    return "DIRECT_OWES_RESTAURANT";
  }
  if (restaurantOwesDirectCents > directOwesRestaurantCents) {
    return "RESTAURANT_OWES_DIRECT";
  }
  return "BALANCED";
}

/**
 * Полная проверка одной записи закрытого расчёта: identity, валюта, состав
 * обязательств, gross-суммы, соответствие сохранённых net-значений реальным
 * gross, момент и автор, основание и внешняя ссылка (обязательна при
 * ненулевом итоге — подтверждается внешний платёж; при чистом взаимозачёте
 * допустим null).
 *
 * Значения НЕ исправляются и не пересчитываются: расхождение сохранённого net
 * с gross — признак повреждения, а не повод «дочинить» запись. При успехе
 * возвращается новый объект с явно перечисленными полями — blind cast
 * непроверенного значения не выполняется.
 */
export function validateRestaurantSettlementRecord(
  value: unknown,
): SettlementRecordValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Запись расчёта повреждена.");
  }
  const raw = value as Record<string, unknown>;

  if (!isNonEmptyString(raw.id)) {
    return invalid("Некорректный идентификатор расчёта.");
  }
  if (!isNonEmptyString(raw.restaurantId)) {
    return invalid("Некорректный ресторан расчёта.");
  }
  if (raw.currencyCode !== "USD") {
    return invalid("Валюта расчёта не поддерживается.");
  }

  if (!Array.isArray(raw.accountingEntryIds) || raw.accountingEntryIds.length === 0) {
    return invalid("В расчёте нет обязательств.");
  }
  const entryIds: string[] = [];
  const seenEntryIds = new Set<string>();
  for (const entryId of raw.accountingEntryIds) {
    if (!isNonEmptyString(entryId)) {
      return invalid("Некорректное обязательство в расчёте.");
    }
    if (seenEntryIds.has(entryId)) {
      return invalid("Обязательство указано в расчёте несколько раз.");
    }
    seenEntryIds.add(entryId);
    entryIds.push(entryId);
  }

  if (!isValidCents(raw.restaurantOwesDirectCents) || !isValidCents(raw.directOwesRestaurantCents)) {
    return invalid("Некорректные суммы сторон расчёта.");
  }
  const restaurantOwesDirectCents = raw.restaurantOwesDirectCents;
  const directOwesRestaurantCents = raw.directOwesRestaurantCents;
  if (restaurantOwesDirectCents === 0 && directOwesRestaurantCents === 0) {
    return invalid("Расчёт без сумм обязательств.");
  }

  if (!isValidCents(raw.netAmountCents)) {
    return invalid("Некорректный итог расчёта.");
  }
  const expectedNetAmount = Math.abs(
    directOwesRestaurantCents - restaurantOwesDirectCents,
  );
  if (!Number.isSafeInteger(expectedNetAmount)) {
    return invalid("Итог расчёта вне безопасного диапазона.");
  }
  if (raw.netAmountCents !== expectedNetAmount) {
    return invalid("Итог расчёта не соответствует суммам сторон.");
  }

  const netDirection = expectedNetDirection(
    restaurantOwesDirectCents,
    directOwesRestaurantCents,
  );
  if (
    raw.netDirection !== "DIRECT_OWES_RESTAURANT" &&
    raw.netDirection !== "RESTAURANT_OWES_DIRECT" &&
    raw.netDirection !== "BALANCED"
  ) {
    return invalid("Неизвестное направление итога расчёта.");
  }
  if (raw.netDirection !== netDirection) {
    return invalid("Направление итога не соответствует суммам сторон.");
  }

  // Момент расчёта — только полный ISO-8601 с часовым поясом: дата без времени
  // или время без пояса делают момент неоднозначным.
  if (!isCanonicalIsoTimestamp(raw.settledAt)) {
    return invalid("Некорректная дата расчёта.");
  }
  if (raw.actor !== "ADMIN") {
    return invalid("Неизвестный автор расчёта.");
  }

  if (typeof raw.note !== "string" || raw.note.trim().length === 0) {
    return invalid("Расчёт без основания.");
  }
  if (raw.note.length > ACCOUNTING_RESOLUTION_NOTE_MAX) {
    return invalid("Основание расчёта слишком длинное.");
  }

  if (raw.externalReference !== null) {
    if (!isNonEmptyString(raw.externalReference)) {
      // Пустая/пробельная ссылка в сохранённой записи — повреждение: доменное
      // действие нормализует такую ссылку в null ещё до записи.
      return invalid("Некорректная внешняя ссылка расчёта.");
    }
    if (raw.externalReference.length > ACCOUNTING_RESOLUTION_REFERENCE_MAX) {
      return invalid("Внешняя ссылка расчёта слишком длинная.");
    }
  } else if (raw.netAmountCents > 0) {
    // Ненулевой итог означает внешний платёж одной из сторон.
    return invalid("Расчёт с ненулевым итогом без внешней ссылки.");
  }

  // v14: детали фактического исполнения обязательны и проверяются вместе с
  // самим расчётом (способ, точная сумма, остаток открытой позиции).
  const executionResult = validateSettlementExecution(
    raw.execution,
    netDirection,
    raw.netAmountCents,
    raw.externalReference as string | null,
  );
  if (!executionResult.ok) {
    return invalid(executionResult.error);
  }

  return {
    ok: true,
    record: {
      id: raw.id,
      restaurantId: raw.restaurantId,
      currencyCode: "USD",
      accountingEntryIds: entryIds,
      restaurantOwesDirectCents,
      directOwesRestaurantCents,
      netDirection,
      netAmountCents: raw.netAmountCents,
      settledAt: raw.settledAt,
      actor: "ADMIN",
      note: raw.note,
      externalReference: raw.externalReference as string | null,
      execution: executionResult.execution,
    },
  };
}
