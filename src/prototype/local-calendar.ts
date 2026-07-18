/**
 * Чистая календарная арифметика локальных дат ресторана, корректная через DST.
 * Вынесено из restaurant-settlements без изменения поведения, чтобы все периоды
 * (сверка и statements) считались одной проверенной логикой. Локальные сутки НЕ
 * считаются фиксированными 24 часами; UTC-полночь НЕ приравнивается к локальной.
 */

/** Календарная дата (год-месяц-день) без времени и часового пояса. */
export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

/** Смещение часового пояса (мс) для момента utcMs. */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utcMs));
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    const asIfUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second),
    );
    return asIfUtc - utcMs;
  } catch {
    return 0;
  }
}

/** Календарная дата момента utcMs в часовом поясе ресторана. */
export function getLocalDateParts(
  utcMs: number,
  timeZone: string,
): LocalDateParts {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(utcMs));
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
    };
  } catch {
    const dt = new Date(utcMs);
    return {
      year: dt.getUTCFullYear(),
      month: dt.getUTCMonth() + 1,
      day: dt.getUTCDate(),
    };
  }
}

/**
 * Сдвиг КАЛЕНДАРНОЙ даты на deltaDays. Date.UTC используется только для
 * нормализации переполнения дня через границы месяца/года — локальные сутки НЕ
 * считаются фиксированными 24 часами (мы оперируем номерами дат, а не мс).
 */
export function shiftCalendarDate(
  parts: LocalDateParts,
  deltaDays: number,
): LocalDateParts {
  const normalized = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays),
  );
  return {
    year: normalized.getUTCFullYear(),
    month: normalized.getUTCMonth() + 1,
    day: normalized.getUTCDate(),
  };
}

/**
 * UTC-инстант локальной полуночи заданной календарной даты в часовом поясе
 * ресторана. Двухпроходное разрешение offset: устойчиво к смене UTC-offset
 * (DST), когда полночь целевой даты и «догадка» лежат по разные стороны перехода.
 */
export function localMidnightToUtcMs(
  parts: LocalDateParts,
  timeZone: string,
): number {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0);
  const off1 = tzOffsetMs(guess, timeZone);
  let instant = guess - off1;
  const off2 = tzOffsetMs(instant, timeZone);
  if (off2 !== off1) instant = guess - off2;
  return instant;
}

/**
 * Разбор строки локальной даты «YYYY-MM-DD» в календарные части. Возвращает null
 * при неверном формате или несуществующей календарной дате (например 2026-02-30).
 */
export function parseLocalDate(value: string): LocalDateParts | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  // Проверяем реальность даты round-trip через Date.UTC (номера, не мс суток).
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() + 1 !== month ||
    normalized.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** true, если строка — валидный IANA-часовой пояс, принимаемый Intl. */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Сравнение календарных дат: <0, 0, >0. */
export function compareLocalDate(a: LocalDateParts, b: LocalDateParts): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}
