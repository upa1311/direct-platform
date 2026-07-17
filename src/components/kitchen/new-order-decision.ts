// Импорт относительный: модуль проверяется node:test, где alias «@/» не
// резолвится. Типы стираются при стриппинге, значения — нет.
import { RESTAURANT_RESPONSE_TIMEOUT_MS } from "../../prototype/actions";

/**
 * Общие для обоих экранов части решения по новому заказу (RESTAURANT_REVIEW).
 *
 * Кто именно принимает — зависит от режима: в COMBINED это общий экран кухни,
 * в SPLIT — оператор. Сам семиминутный отсчёт, пороги внимания и срочности и
 * набор вариантов времени одни и те же, поэтому живут здесь, а не дублируются
 * на двух страницах.
 */

/** Варианты первоначального времени приготовления. */
export const PREP_OPTIONS = [10, 15, 20, 25, 30, 40] as const;

/** Безопасный fallback, если у ресторана нет допустимого значения. */
export const DEFAULT_PREP_MINUTES = 25;

const ATTENTION_THRESHOLD_MS = 2 * 60 * 1000;
const URGENT_THRESHOLD_MS = 60 * 1000;

/** Первоначальное время из настроек ресторана либо безопасный fallback. */
export function defaultPrep(value: number | undefined): number {
  return PREP_OPTIONS.includes(value as (typeof PREP_OPTIONS)[number])
    ? (value as number)
    : DEFAULT_PREP_MINUTES;
}

export interface NewOrderAutoClose {
  text: string;
  needsAttention: boolean;
  urgent: boolean;
}

/**
 * Обратный отсчёт до автозакрытия неотвеченного заказа (§3). Считается от
 * order.createdAt, а не от момента открытия экрана: показ таймера у оператора
 * вместо кухни ничего в отсчёте не меняет.
 */
export function formatAutoClose(
  createdAtIso: string,
  nowMs: number,
): NewOrderAutoClose {
  if (nowMs === 0) {
    return { text: "—", needsAttention: false, urgent: false };
  }
  const elapsed = nowMs - Date.parse(createdAtIso);
  const remainingMs = RESTAURANT_RESPONSE_TIMEOUT_MS - elapsed;
  const remSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const mmss = `${Math.floor(remSec / 60)}:${String(remSec % 60).padStart(2, "0")}`;
  const urgent = remainingMs <= URGENT_THRESHOLD_MS;
  return {
    text: urgent
      ? `Заказ будет автоматически закрыт через ${mmss}`
      : `До автоматического закрытия: ${mmss}`,
    needsAttention: elapsed >= ATTENTION_THRESHOLD_MS,
    urgent,
  };
}
