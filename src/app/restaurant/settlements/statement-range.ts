import {
  getLocalDateParts,
  shiftCalendarDate,
  type LocalDateParts,
} from "../../../prototype/local-calendar";

/**
 * Дефолтный диапазон выписки: последние 30 ВКЛЮЧИТЕЛЬНЫХ локальных календарных
 * дней ресторана (текущий локальный день + 29 предыдущих). Чистая функция:
 * использует календарную арифметику local-calendar (без вычитания фиксированных
 * 24-часовых суток), поэтому корректна через границы месяца/года и DST. Часовой
 * пояс берётся у ресторана, не хардкодится.
 */

function formatLocalDateIso(parts: LocalDateParts): string {
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}

export interface StatementDefaultRange {
  startLocalDate: string;
  endLocalDate: string;
}

export function defaultStatementRange(
  nowMs: number,
  timeZone: string,
): StatementDefaultRange {
  const end = getLocalDateParts(nowMs, timeZone);
  const start = shiftCalendarDate(end, -29); // 30 включительных дней
  return {
    startLocalDate: formatLocalDateIso(start),
    endLocalDate: formatLocalDateIso(end),
  };
}
