// Импорты относительные: модуль проверяется node:test, где alias «@/» не
// резолвится. ЧИСТАЯ editor state machine наличной сдачи (без React/DOM).
//
// authoritative `cart.cashTenderIntent` — единственный persisted источник. Editor
// — локальный UI-draft со строгим ack-протоколом поверх compare-and-set записи:
//  - ввод меняет только draft (без provider-мутации);
//  - сохранение считается подтверждённым ТОЛЬКО когда И mutation ack success, И
//    authoritative intent фактически стал ожидаемым (или идемпотентный no-op с
//    changed:false, когда authoritative уже равен ожидаемому);
//  - у каждой попытки уникальный attemptId; поздний ответ старой попытки (после
//    конфликта/сброса/новой попытки) полностью игнорируется;
//  - cross-tab конфликт принимает incoming intent и инвалидирует попытку.
import type { CashTenderIntent } from "../../prototype/models";
import { cashTenderIntentKey } from "../../prototype/cash-tender-intent";
import { parseMoneyInput } from "../menu/dish-builder-form";
import {
  isCashTenderIntentValidForTotal,
  isSafeCents,
  tenderCentsToText,
} from "./cash-tender-checkout-view";

export type CashTenderEditorStatus = "CLEAN" | "DIRTY" | "SAVING" | "ERROR";

/** Активная попытка сохранения (compare-and-set) — только в статусе SAVING. */
export interface CashTenderSaveAttempt {
  id: number;
  /** Отпечаток authoritative intent, на котором строится CAS (expectedIntentKey). */
  casBaseKey: string;
  /** Сохраняемое намерение (не null). */
  nextIntent: CashTenderIntent;
  nextKey: string;
  /** Пришёл ли успешный ack сохранения для этой попытки. */
  ackReceived: boolean;
  /** Замечен ли authoritative intent, равный ожидаемому. */
  authoritativeMatched: boolean;
}

export interface CashTenderEditorState {
  status: CashTenderEditorStatus;
  draftMode: "EXACT" | "CHANGE_FROM" | null;
  draftText: string;
  /** authoritative отпечаток, с которым синхронизирован editor. */
  baseIntentKey: string;
  attempt: CashTenderSaveAttempt | null;
  error: string | null;
  notice: string | null;
}

export const CASH_TENDER_CROSS_TAB_NOTICE =
  "Выбор наличной оплаты изменён в другой вкладке.";

export function initCashTenderEditor(
  intent: CashTenderIntent,
): CashTenderEditorState {
  return {
    status: "CLEAN",
    draftMode: null,
    draftText: "",
    baseIntentKey: cashTenderIntentKey(intent),
    attempt: null,
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
  | { type: "SELECT_EXACT"; attemptId: number }
  | { type: "SELECT_CHANGE_FROM" }
  | { type: "EDIT_TEXT"; text: string }
  | { type: "CONFIRM"; attemptId: number }
  | {
      type: "SAVE_ACK";
      attemptId: number;
      ok: boolean;
      conflict: boolean;
      changed: boolean;
      error: string | null;
    }
  | { type: "SYNC"; intent: CashTenderIntent };

/** Побочный эффект: запустить compare-and-set сохранение через provider. */
export interface CashTenderSaveEffect {
  attemptId: number;
  expectedIntentKey: string;
  nextIntent: CashTenderIntent;
}

export interface CashTenderReduceResult {
  state: CashTenderEditorState;
  save: CashTenderSaveEffect | null;
}

export interface CashTenderReduceContext {
  intent: CashTenderIntent;
  customerTotalCents: number | null;
}

function noSave(state: CashTenderEditorState): CashTenderReduceResult {
  return { state, save: null };
}

/** Пытается начать сохранение: валидный кандидат → SAVING+effect, иначе ERROR. */
function startSave(
  state: CashTenderEditorState,
  attemptId: number,
  customerTotalCents: number | null,
): CashTenderReduceResult {
  const candidate = cashTenderCandidateFromDraft(state, customerTotalCents);
  if (!candidate.ok) {
    return noSave({
      ...state,
      status: "ERROR",
      error: candidate.error,
      attempt: null,
      notice: null,
    });
  }
  const attempt: CashTenderSaveAttempt = {
    id: attemptId,
    casBaseKey: state.baseIntentKey,
    nextIntent: candidate.intent,
    nextKey: cashTenderIntentKey(candidate.intent),
    ackReceived: false,
    authoritativeMatched: false,
  };
  return {
    state: { ...state, status: "SAVING", attempt, error: null, notice: null },
    save: {
      attemptId,
      expectedIntentKey: attempt.casBaseKey,
      nextIntent: candidate.intent,
    },
  };
}

function syncIntent(
  state: CashTenderEditorState,
  intent: CashTenderIntent,
): CashTenderEditorState {
  const incomingKey = cashTenderIntentKey(intent);
  if (incomingKey === state.baseIntentKey) return state; // внешних изменений нет

  if (state.attempt !== null) {
    // SAVING: authoritative может стать ожидаемым (наш save) или другим (конфликт).
    if (incomingKey === state.attempt.nextKey) {
      if (state.attempt.ackReceived) {
        return initCashTenderEditor(intent); // оба условия выполнены → CLEAN
      }
      // authoritative совпал; ждём ack. База обновляется, чтобы SYNC не повторялся.
      return {
        ...state,
        baseIntentKey: incomingKey,
        attempt: { ...state.attempt, authoritativeMatched: true },
      };
    }
    // Конфликт: пришло иное намерение — принимаем incoming, попытку инвалидируем.
    return { ...initCashTenderEditor(intent), notice: CASH_TENDER_CROSS_TAB_NOTICE };
  }

  if (state.status === "DIRTY" || state.status === "ERROR") {
    // Локальный draft устарел относительно нового authoritative intent.
    return { ...initCashTenderEditor(intent), notice: CASH_TENDER_CROSS_TAB_NOTICE };
  }
  return initCashTenderEditor(intent); // CLEAN → сразу отражаем новый intent
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
        attempt: null,
        error: null,
        notice: null,
      };
      return startSave(dirty, action.attemptId, ctx.customerTotalCents);
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
        attempt: null,
        error: null,
        notice: null,
      });
    }
    case "EDIT_TEXT":
      // Ввод меняет ТОЛЬКО локальный draft — без provider-мутации на символ.
      return noSave({
        ...state,
        draftMode: "CHANGE_FROM",
        draftText: action.text,
        status: "DIRTY",
        attempt: null,
        error: null,
        notice: null,
      });
    case "CONFIRM":
      if (state.status === "SAVING") return noSave(state); // защита от двойного save
      return startSave(state, action.attemptId, ctx.customerTotalCents);
    case "SAVE_ACK": {
      // Поздний ответ чужой/устаревшей попытки полностью игнорируется.
      if (state.attempt === null || state.attempt.id !== action.attemptId) {
        return noSave(state);
      }
      if (!action.ok) {
        return noSave({
          ...state,
          status: "ERROR",
          error: action.error ?? "Не удалось сохранить выбор.",
          attempt: null,
          notice: null,
        });
      }
      if (!action.changed) {
        // Идемпотентный no-op: authoritative уже равен ожидаемому → CLEAN.
        return noSave(initCashTenderEditor(state.attempt.nextIntent));
      }
      if (state.attempt.authoritativeMatched) {
        return noSave(initCashTenderEditor(state.attempt.nextIntent)); // оба → CLEAN
      }
      // Ack есть, ждём фактического совпадения authoritative intent.
      return noSave({
        ...state,
        attempt: { ...state.attempt, ackReceived: true },
      });
    }
    case "SYNC":
      return noSave(syncIntent(state, action.intent));
    default:
      return noSave(state);
  }
}

/**
 * Отправка наличного заказа разрешена ТОЛЬКО когда: editor CLEAN, нет активной
 * попытки, base-отпечаток равен authoritative, и сохранённый intent валиден для
 * текущего итога. В CLEAN отображение выводится из intent, поэтому «показанное =
 * authoritative». Любой DIRTY/SAVING/ERROR/конфликт/устаревший итог → false.
 */
export function canSubmitCashTender(
  state: CashTenderEditorState,
  intent: CashTenderIntent,
  customerTotalCents: number | null,
): boolean {
  return (
    state.status === "CLEAN" &&
    state.attempt === null &&
    state.baseIntentKey === cashTenderIntentKey(intent) &&
    isCashTenderIntentValidForTotal(intent, customerTotalCents)
  );
}

export interface CashTenderEditorView {
  selectedMode: "EXACT" | "CHANGE_FROM" | null;
  changeAmountText: string;
  showChangeInput: boolean;
  previewChangeCents: number | null;
  error: string | null;
  notice: string | null;
  saving: boolean;
  /** Кнопка «Подтвердить сумму» (валидный CHANGE_FROM draft в DIRTY). */
  confirmEnabled: boolean;
  /** Кнопка «Повторить сохранение» (валидный draft в ERROR). */
  retryEnabled: boolean;
  canSubmit: boolean;
}

export function cashTenderEditorView(
  state: CashTenderEditorState,
  intent: CashTenderIntent,
  customerTotalCents: number | null,
): CashTenderEditorView {
  const clean = state.status === "CLEAN";
  const saving = state.status === "SAVING";
  const candidate = cashTenderCandidateFromDraft(state, customerTotalCents);

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
    if (
      intent !== null &&
      !isCashTenderIntentValidForTotal(intent, customerTotalCents)
    ) {
      // Сохранённый intent устарел после роста итога — явная ошибка, submit off.
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
  } else if (state.status === "DIRTY" && selectedMode === "CHANGE_FROM") {
    if (!candidate.ok && state.draftText.trim() !== "") error = candidate.error;
  }

  if (
    !clean &&
    selectedMode === "CHANGE_FROM" &&
    candidate.ok &&
    candidate.intent !== null &&
    candidate.intent.mode === "CHANGE_FROM" &&
    customerTotalCents !== null
  ) {
    previewChangeCents = candidate.intent.tenderCents - customerTotalCents;
  }

  const confirmEnabled =
    state.status === "DIRTY" && selectedMode === "CHANGE_FROM" && candidate.ok;
  const retryEnabled = state.status === "ERROR" && candidate.ok;

  return {
    selectedMode,
    changeAmountText,
    showChangeInput: selectedMode === "CHANGE_FROM",
    previewChangeCents,
    error,
    notice: state.notice,
    saving,
    confirmEnabled,
    retryEnabled,
    canSubmit: canSubmitCashTender(state, intent, customerTotalCents),
  };
}
