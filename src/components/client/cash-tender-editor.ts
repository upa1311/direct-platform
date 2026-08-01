// Импорты относительные: модуль проверяется node:test, где alias «@/» не
// резолвится. ЧИСТАЯ editor state machine наличной сдачи (без React/DOM):
// authoritative `cart.cashTenderIntent` — единственный persisted источник, а
// editor — только локальный UI-draft со строгим ack-протоколом. Позволяет
// проверить mutation-failure / cross-tab / rapid-typing переходы поведенчески.
import type { CashTenderIntent } from "../../prototype/models";
import { parseMoneyInput } from "../menu/dish-builder-form";
import {
  cashTenderIntentKey,
  isCashTenderIntentValidForTotal,
  isSafeCents,
  tenderCentsToText,
} from "./cash-tender-checkout-view";

export type CashTenderEditorStatus = "CLEAN" | "DIRTY" | "SAVING" | "ERROR";

export interface CashTenderEditorState {
  /** Локально выбранный режим (draft); в CLEAN отображение идёт из intent. */
  draftMode: "EXACT" | "CHANGE_FROM" | null;
  /** Черновой текст суммы CHANGE_FROM (только локально во время ввода). */
  draftText: string;
  /** Отпечаток authoritative intent, на котором построен editor (cross-tab). */
  baseIntentKey: string;
  /** Intent, отправленный на сохранение (SAVING/ожидание подтверждения). */
  expectedIntent: CashTenderIntent;
  status: CashTenderEditorStatus;
  error: string | null;
  /** Нейтральное сообщение о cross-tab изменении, иначе null. */
  notice: string | null;
}

export const CASH_TENDER_CROSS_TAB_NOTICE =
  "Выбор наличной оплаты изменён в другой вкладке.";

export function initCashTenderEditor(
  intent: CashTenderIntent,
): CashTenderEditorState {
  return {
    draftMode: null,
    draftText: "",
    baseIntentKey: cashTenderIntentKey(intent),
    expectedIntent: null,
    status: "CLEAN",
    error: null,
    notice: null,
  };
}

export type CashTenderCandidate =
  | { ok: true; intent: CashTenderIntent }
  | { ok: false; error: string };

/** Кандидат-intent из текущего draft относительно итога (fail-closed). */
export function cashTenderCandidateFromDraft(
  state: CashTenderEditorState,
  customerTotalCents: number | null,
): CashTenderCandidate {
  if (state.draftMode === "EXACT") {
    if (
      customerTotalCents === null ||
      !isSafeCents(customerTotalCents) ||
      customerTotalCents <= 0
    ) {
      return { ok: false, error: "Не удалось рассчитать заказ." };
    }
    return { ok: true, intent: { mode: "EXACT" } };
  }
  if (state.draftMode === "CHANGE_FROM") {
    const parsed = parseMoneyInput(state.draftText, {
      required: true,
      allowZero: false,
      label: "сумму",
    });
    if (!parsed.ok || parsed.cents === null) {
      return { ok: false, error: parsed.ok ? "Укажите сумму." : parsed.error };
    }
    if (customerTotalCents === null) {
      return { ok: false, error: "Не удалось рассчитать заказ." };
    }
    if (parsed.cents <= customerTotalCents) {
      return { ok: false, error: "Сумма должна быть больше суммы заказа." };
    }
    return { ok: true, intent: { mode: "CHANGE_FROM", tenderCents: parsed.cents } };
  }
  return { ok: false, error: "Выберите способ оплаты наличными." };
}

export type CashTenderEditorAction =
  | { type: "SELECT_EXACT" }
  | { type: "SELECT_CHANGE_FROM" }
  | { type: "EDIT_TEXT"; text: string }
  | { type: "CONFIRM" }
  | { type: "SAVE_FAILED"; error: string }
  | { type: "SYNC"; intent: CashTenderIntent };

export interface CashTenderReduceResult {
  state: CashTenderEditorState;
  /** true → компонент обязан запустить сохранение saveIntent по ack-протоколу. */
  shouldSave: boolean;
  saveIntent: CashTenderIntent;
}

export interface CashTenderReduceContext {
  intent: CashTenderIntent;
  customerTotalCents: number | null;
}

function noSave(state: CashTenderEditorState): CashTenderReduceResult {
  return { state, shouldSave: false, saveIntent: null };
}

/** Пытается перейти в SAVING: валидный кандидат → SAVING+save, иначе ERROR. */
function startSave(
  state: CashTenderEditorState,
  customerTotalCents: number | null,
): CashTenderReduceResult {
  const candidate = cashTenderCandidateFromDraft(state, customerTotalCents);
  if (!candidate.ok) {
    return noSave({
      ...state,
      status: "ERROR",
      error: candidate.error,
      expectedIntent: null,
      notice: null,
    });
  }
  return {
    state: {
      ...state,
      status: "SAVING",
      expectedIntent: candidate.intent,
      error: null,
      notice: null,
    },
    shouldSave: true,
    saveIntent: candidate.intent,
  };
}

/** Сверка editor с входящим authoritative intent (cross-tab / приход save). */
function syncIntent(
  state: CashTenderEditorState,
  intent: CashTenderIntent,
): CashTenderEditorState {
  const incomingKey = cashTenderIntentKey(intent);
  if (incomingKey === state.baseIntentKey) return state; // внешних изменений нет

  if (state.status === "SAVING") {
    if (
      state.expectedIntent !== null &&
      incomingKey === cashTenderIntentKey(state.expectedIntent)
    ) {
      // Наша попытка сохранения подтверждена фактическим incoming state → CLEAN.
      return initCashTenderEditor(intent);
    }
    // Пришёл ДРУГОЙ intent: попытка проиграла конфликт — принимаем incoming,
    // локальный pending завершаем, expected не считаем сохранённым.
    return { ...initCashTenderEditor(intent), notice: CASH_TENDER_CROSS_TAB_NOTICE };
  }

  if (state.status === "DIRTY" || state.status === "ERROR") {
    // Локальный draft устарел относительно нового authoritative intent.
    return { ...initCashTenderEditor(intent), notice: CASH_TENDER_CROSS_TAB_NOTICE };
  }

  // CLEAN → сразу отражаем новый intent.
  return initCashTenderEditor(intent);
}

export function reduceCashTenderEditor(
  state: CashTenderEditorState,
  action: CashTenderEditorAction,
  ctx: CashTenderReduceContext,
): CashTenderReduceResult {
  switch (action.type) {
    case "SELECT_EXACT": {
      // Вводить нечего — EXACT подтверждается сразу по ack-протоколу.
      const dirty: CashTenderEditorState = {
        ...state,
        draftMode: "EXACT",
        draftText: "",
        status: "DIRTY",
        error: null,
        notice: null,
        expectedIntent: null,
      };
      return startSave(dirty, ctx.customerTotalCents);
    }
    case "SELECT_CHANGE_FROM": {
      const text =
        ctx.intent !== null && ctx.intent.mode === "CHANGE_FROM"
          ? tenderCentsToText(ctx.intent.tenderCents)
          : "";
      return noSave({
        ...state,
        draftMode: "CHANGE_FROM",
        draftText: text,
        status: "DIRTY",
        error: null,
        notice: null,
        expectedIntent: null,
      });
    }
    case "EDIT_TEXT":
      // Ввод меняет ТОЛЬКО локальный draft — без provider-мутации на символ.
      return noSave({
        ...state,
        draftMode: "CHANGE_FROM",
        draftText: action.text,
        status: "DIRTY",
        error: null,
        notice: null,
        expectedIntent: null,
      });
    case "CONFIRM":
      if (state.status === "SAVING") return noSave(state); // защита от двойного save
      return startSave(state, ctx.customerTotalCents);
    case "SAVE_FAILED":
      // Authoritative intent не изменён; draft остаётся видимым как несохранённый.
      return noSave({
        ...state,
        status: "ERROR",
        error: action.error,
        expectedIntent: null,
        notice: null,
      });
    case "SYNC":
      return noSave(syncIntent(state, action.intent));
    default:
      return noSave(state);
  }
}

export interface CashTenderEditorView {
  selectedMode: "EXACT" | "CHANGE_FROM" | null;
  changeAmountText: string;
  showChangeInput: boolean;
  previewChangeCents: number | null;
  error: string | null;
  notice: string | null;
  saving: boolean;
  /** Доступна ли кнопка «Подтвердить сумму» (валидный CHANGE_FROM в DIRTY). */
  confirmEnabled: boolean;
  /** Разрешена ли отправка заказа для наличных (CLEAN + валидно для итога). */
  canSubmit: boolean;
}

/**
 * Отправка наличного заказа разрешена ТОЛЬКО когда editor CLEAN и сохранённый
 * intent валиден для текущего итога. В CLEAN отображение выводится из intent,
 * поэтому «показанное = authoritative» и pending отсутствует автоматически;
 * DIRTY/SAVING/ERROR или устаревший intent → false.
 */
export function canSubmitCashTender(
  state: CashTenderEditorState,
  intent: CashTenderIntent,
  customerTotalCents: number | null,
): boolean {
  return (
    state.status === "CLEAN" &&
    isCashTenderIntentValidForTotal(intent, customerTotalCents)
  );
}

/** Чистое представление редактора для рендера. */
export function cashTenderEditorView(
  state: CashTenderEditorState,
  intent: CashTenderIntent,
  customerTotalCents: number | null,
): CashTenderEditorView {
  const clean = state.status === "CLEAN";
  const saving = state.status === "SAVING";

  let selectedMode: "EXACT" | "CHANGE_FROM" | null;
  let changeAmountText = "";
  if (clean) {
    selectedMode = intent === null ? null : intent.mode;
    if (intent !== null && intent.mode === "CHANGE_FROM") {
      changeAmountText = tenderCentsToText(intent.tenderCents);
    }
  } else {
    selectedMode = state.draftMode;
    if (selectedMode === "CHANGE_FROM") changeAmountText = state.draftText;
  }

  let error: string | null = null;
  let previewChangeCents: number | null = null;

  if (clean) {
    // Сохранённый intent, ставший невалидным после роста итога: показываем
    // сумму, явную ошибку и блокируем submit — нужно отредактировать заново.
    if (intent !== null && !isCashTenderIntentValidForTotal(intent, customerTotalCents)) {
      error =
        intent.mode === "CHANGE_FROM"
          ? "Сумма должна быть больше суммы заказа."
          : "Не удалось рассчитать заказ.";
    } else if (
      intent !== null &&
      intent.mode === "CHANGE_FROM" &&
      customerTotalCents !== null
    ) {
      previewChangeCents = intent.tenderCents - customerTotalCents;
    }
  } else if (state.status === "ERROR") {
    error = state.error;
    if (selectedMode === "CHANGE_FROM") {
      const candidate = cashTenderCandidateFromDraft(state, customerTotalCents);
      if (candidate.ok && candidate.intent !== null && candidate.intent.mode === "CHANGE_FROM" && customerTotalCents !== null) {
        previewChangeCents = candidate.intent.tenderCents - customerTotalCents;
      }
    }
  } else if (state.status === "DIRTY" && selectedMode === "CHANGE_FROM") {
    const candidate = cashTenderCandidateFromDraft(state, customerTotalCents);
    if (candidate.ok && candidate.intent !== null && candidate.intent.mode === "CHANGE_FROM" && customerTotalCents !== null) {
      previewChangeCents = candidate.intent.tenderCents - customerTotalCents;
    } else if (!candidate.ok && state.draftText.trim() !== "") {
      error = candidate.error;
    }
  }

  const confirmEnabled =
    state.status === "DIRTY" &&
    selectedMode === "CHANGE_FROM" &&
    cashTenderCandidateFromDraft(state, customerTotalCents).ok;

  return {
    selectedMode,
    changeAmountText,
    showChangeInput: selectedMode === "CHANGE_FROM",
    previewChangeCents,
    error,
    notice: state.notice,
    saving,
    confirmEnabled,
    canSubmit: canSubmitCashTender(state, intent, customerTotalCents),
  };
}
