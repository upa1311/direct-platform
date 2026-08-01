// Импорты относительные: модуль проверяется node:test, где alias «@/» не
// резолвится. Модуль ЧИСТЫЙ (без React/DOM), чтобы поведение checkout-раскрытия
// наличной сдачи можно было проверить без render-harness.
import type { CashTenderIntent } from "../../prototype/models";
import { parseMoneyInput } from "../menu/dish-builder-form";

/**
 * Синхронизация отображаемого CASH tender с authoritative `cart.cashTenderIntent`.
 *
 * Источник истины — сохранённый intent (reload/cross-tab/сброс отражаются сразу).
 * Локальный черновик существует ТОЛЬКО пока пользователь активно вводит сумму для
 * CHANGE_FROM (когда сумма ещё невалидна и intent не может быть сохранён). Второй
 * persisted intent не создаётся; `changeDueCents` из UI не пишется — его считает
 * domain builder при создании заказа.
 */

/** Локальный черновик активного ввода суммы CHANGE_FROM; null — следуем intent. */
export interface CashTenderDraft {
  /** Сырой текст в поле «нужна сдача с суммы» во время активного ввода. */
  activeChangeFromText: string;
}

export interface CashTenderCheckoutView {
  /** Какой radio показать выбранным (из черновика, иначе из authoritative intent). */
  selectedMode: "EXACT" | "CHANGE_FROM" | null;
  /** Текст в поле CHANGE_FROM. */
  changeAmountText: string;
  /** Показать ли поле ввода суммы. */
  showChangeInput: boolean;
  /** Ошибка ввода (невалидная сумма / не покрывает итог), иначе null. */
  error: string | null;
  /** Неавторитетный предпросмотр сдачи, иначе null. */
  previewChangeCents: number | null;
  /**
   * Валиден ли ТЕКУЩИЙ отображаемый выбор (для локальной подсказки/ошибки). НЕ
   * источник для submit-гейта — им служит intentValidForTotal.
   */
  valid: boolean;
  /**
   * Готов ли authoritative intent к отправке при текущем итоге. Единственный
   * источник для блокировки кнопки отправки: зависит только от сохранённого
   * intent и итога, а не от локального черновика (провалившаяся мутация не даёт
   * ложного «сохранено»).
   */
  intentValidForTotal: boolean;
}

/** Целые безопасные центы: конечное неотрицательное целое ≤ MAX_SAFE_INTEGER. */
function isSafeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** cents → «20.00» для поля ввода. */
export function tenderCentsToText(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Готов ли сохранённый intent к отправке при данном итоге (submit-гейт).
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

/**
 * Чистое checkout-представление наличной сдачи из authoritative intent +
 * локального черновика + текущего итога. Приоритет отображения: активный
 * черновик (пользователь вводит), иначе — сохранённый intent. Гарантирует, что
 * валидный CHANGE_FROM никогда не показывается с пустым обязательным полем: без
 * черновика текст берётся из intent.tenderCents.
 */
export function computeCashTenderView(
  intent: CashTenderIntent,
  draft: CashTenderDraft | null,
  customerTotalCents: number | null,
): CashTenderCheckoutView {
  const intentMode = intent === null ? null : intent.mode;
  const selectedMode: "EXACT" | "CHANGE_FROM" | null = draft
    ? "CHANGE_FROM"
    : intentMode;

  let changeAmountText = "";
  if (selectedMode === "CHANGE_FROM") {
    if (draft) {
      changeAmountText = draft.activeChangeFromText;
    } else if (intent !== null && intent.mode === "CHANGE_FROM") {
      changeAmountText = tenderCentsToText(intent.tenderCents);
    }
  }

  let error: string | null = null;
  let previewChangeCents: number | null = null;
  let valid = false;

  if (selectedMode === "EXACT") {
    valid =
      customerTotalCents !== null &&
      isSafeCents(customerTotalCents) &&
      customerTotalCents > 0;
    if (!valid) error = "Не удалось рассчитать заказ.";
  } else if (selectedMode === "CHANGE_FROM") {
    const parsed = parseMoneyInput(changeAmountText, {
      required: true,
      allowZero: false,
      label: "сумму",
    });
    if (!parsed.ok || parsed.cents === null) {
      error = parsed.ok ? "Укажите сумму." : parsed.error;
    } else if (customerTotalCents === null) {
      error = "Не удалось рассчитать заказ.";
    } else if (parsed.cents <= customerTotalCents) {
      error = "Сумма должна быть больше суммы заказа.";
    } else {
      valid = true;
      previewChangeCents = parsed.cents - customerTotalCents;
    }
  }

  return {
    selectedMode,
    changeAmountText,
    showChangeInput: selectedMode === "CHANGE_FROM",
    error,
    previewChangeCents,
    valid,
    intentValidForTotal: isCashTenderIntentValidForTotal(intent, customerTotalCents),
  };
}

/**
 * Intent, который следует сохранить для введённого текста CHANGE_FROM: валидная
 * сумма → { CHANGE_FROM, tenderCents }, иначе null (fail-closed — не сохраняем
 * невалидное намерение). changeDueCents здесь НЕ вычисляется.
 */
export function intentForChangeFromText(
  amountText: string,
  customerTotalCents: number | null,
): CashTenderIntent {
  const parsed = parseMoneyInput(amountText, {
    required: true,
    allowZero: false,
    label: "сумму",
  });
  if (!parsed.ok || parsed.cents === null) return null;
  if (
    customerTotalCents === null ||
    !isSafeCents(customerTotalCents) ||
    parsed.cents <= customerTotalCents
  ) {
    return null;
  }
  return { mode: "CHANGE_FROM", tenderCents: parsed.cents };
}
