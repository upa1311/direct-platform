import type {
  RestaurantAccountingEntry,
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
 * Единственно допустимые пары «направление + основание» обязательства:
 * комиссия Direct всегда идёт от ресторана к Direct, выплата — от Direct
 * ресторану. Проверять их независимо нельзя: смешанная пара — повреждённые
 * данные, а не редкий бизнес-случай.
 */
const ALLOWED_DIRECTION_TYPE: Record<
  RestaurantAccountingEntry["direction"],
  RestaurantAccountingEntry["type"]
> = {
  RESTAURANT_OWES_DIRECT: "PLATFORM_COMMISSION",
  DIRECT_OWES_RESTAURANT: "RESTAURANT_PAYOUT",
};

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
  return ALLOWED_DIRECTION_TYPE[direction] === type;
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

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
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

  if (!isValidIso(raw.settledAt)) {
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
    },
  };
}
