import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canSubmitCashTender,
  cashTenderEditorView,
  initCashTenderEditor,
  reduceCashTenderEditor,
  type CashTenderEditorAction,
} from "./cash-tender-editor.ts";
import type { CashTenderIntent } from "../../prototype/models.ts";

/**
 * Behavioral tests for the cash-tender editor state machine
 * (`fix: serialize cash tender editor state`). Модель воспроизводит реальные
 * переходы: draft/save separation, ack-протокол, cross-tab, rapid typing,
 * double-save. Source-string проверок здесь нет.
 */

const TOTAL = 1600;

/**
 * Мини-драйвер: применяет действия к редактору, эмулируя async-ack как явные
 * шаги. Считает число реальных save-эффектов (mutation spy). authoritative
 * intent обновляется вызовом applyIntent (эмулирует incoming persisted prop).
 */
function makeDriver(initialIntent: CashTenderIntent, total: number | null = TOTAL) {
  let intent = initialIntent;
  let state = initCashTenderEditor(intent);
  const saves: CashTenderIntent[] = [];

  const ctx = () => ({ intent, customerTotalCents: total });

  const dispatch = (action: CashTenderEditorAction) => {
    const result = reduceCashTenderEditor(state, action, ctx());
    state = result.state;
    if (result.shouldSave) saves.push(result.saveIntent);
    return result;
  };
  // Эмуляция прихода нового authoritative intent (save ack ok / cross-tab).
  const applyIntent = (next: CashTenderIntent) => {
    intent = next;
    state = reduceCashTenderEditor(state, { type: "SYNC", intent }, ctx()).state;
  };
  // Эмуляция провала сохранения.
  const failSave = (error: string) => {
    state = reduceCashTenderEditor(state, { type: "SAVE_FAILED", error }, ctx()).state;
  };

  return {
    get state() {
      return state;
    },
    get intent() {
      return intent;
    },
    get saveCount() {
      return saves.length;
    },
    get lastSave() {
      return saves[saves.length - 1];
    },
    view: () => cashTenderEditorView(state, intent, total),
    canSubmit: () => canSubmitCashTender(state, intent, total),
    dispatch,
    applyIntent,
    failSave,
  };
}

// --- 1–2: CLEAN persisted rendering ------------------------------------------

test("1: CLEAN persisted EXACT рендерит EXACT", () => {
  const d = makeDriver({ mode: "EXACT" });
  const v = d.view();
  assert.equal(v.selectedMode, "EXACT");
  assert.equal(v.showChangeInput, false);
  assert.equal(d.canSubmit(), true);
});

test("2: CLEAN persisted CHANGE_FROM рендерит сохранённую сумму", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  const v = d.view();
  assert.equal(v.selectedMode, "CHANGE_FROM");
  assert.equal(v.changeAmountText, "20.00");
  assert.equal(v.previewChangeCents, 400);
  assert.equal(d.canSubmit(), true);
});

// --- 3–5: DIRTY draft blocks submit ------------------------------------------

test("3: правка создаёт DIRTY draft и блокирует submit", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_CHANGE_FROM" });
  d.dispatch({ type: "EDIT_TEXT", text: "25" });
  assert.equal(d.state.status, "DIRTY");
  assert.equal(d.canSubmit(), false);
  assert.equal(d.saveCount, 0);
});

test("4: DIRTY draft не даёт submit по старому валидному intent", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  assert.equal(d.canSubmit(), true); // сначала CLEAN валиден
  d.dispatch({ type: "EDIT_TEXT", text: "30" }); // начали править
  assert.equal(d.state.status, "DIRTY");
  assert.equal(d.canSubmit(), false); // нельзя submit по старому $20
});

test("5: старый $20 + draft $25 → submit false", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  d.dispatch({ type: "EDIT_TEXT", text: "25" });
  assert.equal(d.view().changeAmountText, "25");
  assert.equal(d.canSubmit(), false);
});

// --- 6–9: save ack protocol --------------------------------------------------

test("6: провал сохранения оставляет draft, ERROR, submit false", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_CHANGE_FROM" });
  d.dispatch({ type: "EDIT_TEXT", text: "25" });
  d.dispatch({ type: "CONFIRM" });
  assert.equal(d.state.status, "SAVING");
  assert.equal(d.saveCount, 1);
  d.failSave("Не удалось сохранить выбор.");
  assert.equal(d.state.status, "ERROR");
  assert.equal(d.view().changeAmountText, "25"); // draft виден
  assert.equal(d.canSubmit(), false);
});

test("7: успешный ack без совпадения incoming prop остаётся SAVING", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_CHANGE_FROM" });
  d.dispatch({ type: "EDIT_TEXT", text: "25" });
  d.dispatch({ type: "CONFIRM" });
  // Promise ok, но authoritative intent ещё не пришёл → не CLEAN.
  assert.equal(d.state.status, "SAVING");
  assert.equal(d.canSubmit(), false);
});

test("8: incoming intent совпал с expected → CLEAN", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_CHANGE_FROM" });
  d.dispatch({ type: "EDIT_TEXT", text: "25" });
  d.dispatch({ type: "CONFIRM" });
  d.applyIntent({ mode: "CHANGE_FROM", tenderCents: 2500 }); // save landed
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.view().changeAmountText, "25.00");
  assert.equal(d.canSubmit(), true);
});

test("9: конфликтный incoming во время SAVING → принять incoming, без ложного успеха", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_CHANGE_FROM" });
  d.dispatch({ type: "EDIT_TEXT", text: "25" });
  d.dispatch({ type: "CONFIRM" }); // expected 2500
  d.applyIntent({ mode: "EXACT" }); // другая вкладка сохранила EXACT
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.view().selectedMode, "EXACT"); // incoming, не expected
  assert.ok(d.state.notice); // нейтральное сообщение о конфликте
});

// --- 10–12: cross-tab reconciliation -----------------------------------------

test("10: внешний null во время DIRTY очищает stale draft", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  d.dispatch({ type: "EDIT_TEXT", text: "30" }); // DIRTY draft 30
  d.applyIntent(null); // другая вкладка сняла выбор
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.view().selectedMode, null);
  assert.ok(d.state.notice);
});

test("11: внешний EXACT во время DIRTY отражает EXACT", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_CHANGE_FROM" });
  d.dispatch({ type: "EDIT_TEXT", text: "25" });
  d.applyIntent({ mode: "EXACT" });
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.view().selectedMode, "EXACT");
});

test("12: внешний CHANGE_FROM $30 при draft $25 отражает $30", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  d.dispatch({ type: "EDIT_TEXT", text: "25" }); // draft 25
  d.applyIntent({ mode: "CHANGE_FROM", tenderCents: 3000 });
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.view().changeAmountText, "30.00");
});

// --- 13–15: typing / save effects --------------------------------------------

test("13: rapid typing меняет только draft; save count 0", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_CHANGE_FROM" });
  for (const t of ["2", "25", "25.0", "25.00"]) {
    d.dispatch({ type: "EDIT_TEXT", text: t });
  }
  assert.equal(d.view().changeAmountText, "25.00");
  assert.equal(d.saveCount, 0);
});

test("14: явный Save вызывает mutation один раз с финальными 2500", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_CHANGE_FROM" });
  for (const t of ["2", "25", "25.0", "25.00"]) {
    d.dispatch({ type: "EDIT_TEXT", text: t });
  }
  d.dispatch({ type: "CONFIRM" });
  assert.equal(d.saveCount, 1);
  assert.deepEqual(d.lastSave, { mode: "CHANGE_FROM", tenderCents: 2500 });
});

test("15: двойной Save вызывает mutation один раз", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_CHANGE_FROM" });
  d.dispatch({ type: "EDIT_TEXT", text: "25" });
  d.dispatch({ type: "CONFIRM" }); // SAVING, save #1
  d.dispatch({ type: "CONFIRM" }); // guard: SAVING → no-op
  assert.equal(d.saveCount, 1);
});

// --- 16: reset on payment method (CASH→ONLINE→CASH) --------------------------

test("16: CASH→ONLINE→CASH очищает редактор и требует нового выбора", () => {
  // Возврат к CASH заново инициализирует редактор из свежего (очищенного) intent.
  const reset = initCashTenderEditor(null);
  const v = cashTenderEditorView(reset, null, TOTAL);
  assert.equal(v.selectedMode, null);
  assert.equal(canSubmitCashTender(reset, null, TOTAL), false);
});

// --- 17–18: total changes ----------------------------------------------------

test("17: persisted tender стал невалидным после роста итога → submit false", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 }, 2500);
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.canSubmit(), false);
  assert.notEqual(d.view().error, null); // явная ошибка
  assert.equal(d.view().changeAmountText, "20.00"); // сумма показана
});

test("18: EXACT остаётся валидным после изменения итога", () => {
  const d = makeDriver({ mode: "EXACT" }, 2500);
  assert.equal(d.canSubmit(), true);
});

// --- 19–20: submit/order-creation safety -------------------------------------

test("19: mutation failure со старым валидным intent не даёт submit", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  d.dispatch({ type: "EDIT_TEXT", text: "25" });
  d.dispatch({ type: "CONFIRM" });
  d.failSave("Ошибка сохранения.");
  // Старый persisted intent = $20 всё ещё валиден для итога, НО редактор не CLEAN.
  assert.equal(
    canSubmitCashTender(d.state, { mode: "CHANGE_FROM", tenderCents: 2000 }, TOTAL),
    false,
  );
});

test("20: при submit=true показанное и submitted намерение совпадают", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  assert.equal(d.canSubmit(), true);
  const v = d.view();
  // authoritative intent, который использует order creation, = $20; показанное = $20.
  assert.equal(v.changeAmountText, "20.00");
  assert.equal(
    (d.intent as { tenderCents: number }).tenderCents,
    2000,
  );
});

// EXACT save protocol (ack) --------------------------------------------------

test("EXACT save: select запускает save, submit заблокирован до подтверждения", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_EXACT" });
  assert.equal(d.state.status, "SAVING");
  assert.equal(d.saveCount, 1);
  assert.deepEqual(d.lastSave, { mode: "EXACT" });
  assert.equal(d.canSubmit(), false);
  d.failSave("нет сети"); // провал не показывает ложный сохранённый EXACT
  assert.equal(d.canSubmit(), false);
  assert.equal(d.state.status, "ERROR");
});

test("EXACT save: success подтверждается только при incoming EXACT", () => {
  const d = makeDriver(null);
  d.dispatch({ type: "SELECT_EXACT" });
  assert.equal(d.state.status, "SAVING");
  d.applyIntent({ mode: "EXACT" });
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.canSubmit(), true);
});
