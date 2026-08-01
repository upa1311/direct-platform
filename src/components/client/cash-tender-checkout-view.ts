// Импорты относительные: модуль проверяется node:test, где alias «@/» не
// резолвится. Модуль ЧИСТЫЙ (без React/DOM): общие примитивы наличной сдачи для
// checkout-редактора и submit-гейта, проверяемые без render-harness.
import type { CashTenderIntent } from "../../prototype/models";

/** Целые безопасные центы: конечное неотрицательное целое ≤ MAX_SAFE_INTEGER. */
export function isSafeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** cents → «20.00» для поля ввода. */
export function tenderCentsToText(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Отпечаток authoritative intent для сверки вкладок и подтверждения сохранения:
 * NULL | EXACT | CHANGE_FROM:<cents>. Разные суммы CHANGE_FROM различимы.
 */
export function cashTenderIntentKey(intent: CashTenderIntent): string {
  if (intent === null) return "NULL";
  return intent.mode === "EXACT" ? "EXACT" : `CHANGE_FROM:${intent.tenderCents}`;
}

/**
 * Готов ли сохранённый intent к отправке при данном итоге (часть submit-гейта).
 * EXACT всегда означает НОВЫЙ полный итог заказа; CHANGE_FROM обязан строго
 * превышать итог. null/некорректный итог → false (fail-closed).
 */
export function isCashTenderIntentValidForTotal(
  intent: CashTenderIntent,
  customerTotalCents: number | null,
): boolean {
  if (
    customerTotalCents === null ||
    !isSafeCents(customerTotalCents) ||
    customerTotalCents <= 0
  ) {
    return false;
  }
  if (intent === null) return false;
  if (intent.mode === "EXACT") return true;
  return isSafeCents(intent.tenderCents) && intent.tenderCents > customerTotalCents;
}
