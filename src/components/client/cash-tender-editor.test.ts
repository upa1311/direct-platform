import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canSubmitCashTender,
  cashTenderEditorView,
  initCashTenderEditor,
  reduceCashTenderEditor,
  type CashTenderEditorAction,
  type CashTenderSaveEffect,
} from "./cash-tender-editor.ts";
import type { CashTenderIntent } from "../../prototype/models.ts";

/**
 * Behavioral tests for the cash-tender editor state machine
 * (`fix: make cash tender saves compare-and-set`). Модель воспроизводит реальные
 * переходы: attempt identity, two-condition ack (ack success AND authoritative
 * match), idempotent no-op, cross-tab конфликт, late-response suppression, retry,
 * double-save. Source-string проверок здесь нет.
 */

const TOTAL = 1600;

function makeDriver(initialIntent: CashTenderIntent, total: number | null = TOTAL) {
  let intent = initialIntent;
  let state = initCashTenderEditor(intent);
  let attemptSeq = 0;
  const saves: CashTenderSaveEffect[] = [];
  const ctx = () => ({ intent, customerTotalCents: total });

  const dispatch = (action: CashTenderEditorAction) => {
    const r = reduceCashTenderEditor(state, action, ctx());
    state = r.state;
    if (r.save) saves.push(r.save);
    return r;
  };
  const nextAttempt = () => {
    attemptSeq += 1;
    return attemptSeq;
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
    selectExact: () => dispatch({ type: "SELECT_EXACT", attemptId: nextAttempt() }),
    selectChangeFrom: () => dispatch({ type: "SELECT_CHANGE_FROM" }),
    edit: (text: string) => dispatch({ type: "EDIT_TEXT", text }),
    confirm: () => dispatch({ type: "CONFIRM", attemptId: nextAttempt() }),
    // provider ack для указанной (по умолчанию — последней) попытки.
    ack: (opts: {
      ok: boolean;
      changed?: boolean;
      conflict?: boolean;
      error?: string | null;
      attemptId?: number;
    }) =>
      dispatch({
        type: "SAVE_ACK",
        attemptId: opts.attemptId ?? saves[saves.length - 1].attemptId,
        ok: opts.ok,
        changed: opts.changed ?? false,
        conflict: opts.conflict ?? false,
        error: opts.error ?? null,
      }),
    // приход нового authoritative intent (применённый save / другая вкладка).
    incoming: (next: CashTenderIntent) => {
      intent = next;
      dispatch({ type: "SYNC", intent });
    },
  };
}

// --- 1–3: same-value / idempotent --------------------------------------------

test("1: same-value CHANGE_FROM save → success/CLEAN (changed:false)", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  d.edit("20"); // тот же $20
  d.confirm();
  assert.equal(d.state.status, "SAVING");
  d.ack({ ok: true, changed: false }); // idempotent no-op
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.canSubmit(), true);
});

test("2: same-value EXACT save → success/CLEAN", () => {
  const d = makeDriver({ mode: "EXACT" });
  d.selectExact();
  assert.equal(d.state.status, "SAVING");
  d.ack({ ok: true, changed: false });
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.view().selectedMode, "EXACT");
});

test("3: idempotent no-op ack достаточно (без incoming) → CLEAN", () => {
  const d = makeDriver({ mode: "EXACT" });
  d.selectExact();
  d.ack({ ok: true, changed: false });
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.state.attempt, null);
});

// --- 4–5: CAS effect payload -------------------------------------------------

test("4: CAS effect несёт expected base key и next intent", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  d.edit("25");
  d.confirm();
  assert.equal(d.lastSave.expectedIntentKey, "CHANGE_FROM:2000"); // текущий authoritative
  assert.deepEqual(d.lastSave.nextIntent, { mode: "CHANGE_FROM", tenderCents: 2500 });
});

test("5: невалидный draft не запускает save (ERROR, 0 mutations)", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  d.edit("5"); // < total 1600 → invalid
  d.confirm();
  assert.equal(d.saveCount, 0);
  assert.equal(d.state.status, "ERROR");
  assert.equal(d.canSubmit(), false);
});

// --- 6–9: two-condition ack --------------------------------------------------

test("6: incoming expected ДО ack → остаётся SAVING", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  d.edit("25");
  d.confirm();
  d.incoming({ mode: "CHANGE_FROM", tenderCents: 2500 }); // authoritative совпал
  assert.equal(d.state.status, "SAVING"); // ack ещё не пришёл
  assert.equal(d.canSubmit(), false);
});

test("7: ack ДО incoming expected → остаётся SAVING", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  d.edit("25");
  d.confirm();
  d.ack({ ok: true, changed: true }); // ack есть, authoritative ещё нет
  assert.equal(d.state.status, "SAVING");
  assert.equal(d.canSubmit(), false);
});

test("8: ack + incoming expected (любой порядок) → CLEAN", () => {
  const a = makeDriver(null);
  a.selectChangeFrom();
  a.edit("25");
  a.confirm();
  a.ack({ ok: true, changed: true });
  a.incoming({ mode: "CHANGE_FROM", tenderCents: 2500 });
  assert.equal(a.state.status, "CLEAN");
  assert.equal(a.canSubmit(), true);

  const b = makeDriver(null);
  b.selectChangeFrom();
  b.edit("25");
  b.confirm();
  b.incoming({ mode: "CHANGE_FROM", tenderCents: 2500 });
  b.ack({ ok: true, changed: true });
  assert.equal(b.state.status, "CLEAN");
});

test("9: конфликтный incoming во время SAVING → принять incoming, notice", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  d.edit("25");
  d.confirm(); // expected CHANGE_FROM:2500
  d.incoming({ mode: "EXACT" }); // другая вкладка сохранила EXACT
  assert.equal(d.state.status, "CLEAN");
  assert.equal(d.view().selectedMode, "EXACT");
  assert.ok(d.state.notice);
});

// --- 10–13: late-response suppression ----------------------------------------

test("10: late failure после конфликта игнорируется", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  d.edit("25");
  d.confirm();
  const staleAttempt = d.lastSave.attemptId;
  d.incoming({ mode: "EXACT" }); // конфликт → attempt инвалидирован
  d.ack({ ok: false, error: "boom", attemptId: staleAttempt }); // поздний провал
  assert.equal(d.state.status, "CLEAN"); // не ERROR
  assert.equal(d.view().selectedMode, "EXACT");
});

test("11: late success после конфликта игнорируется", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  d.edit("25");
  d.confirm();
  const staleAttempt = d.lastSave.attemptId;
  d.incoming({ mode: "CHANGE_FROM", tenderCents: 9999 }); // конфликт (иная сумма)
  d.ack({ ok: true, changed: true, attemptId: staleAttempt }); // поздний успех
  assert.equal(d.view().changeAmountText, "99.99"); // incoming, не наш 25
});

test("12: late response после сброса editor игнорируется", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  d.edit("25");
  d.confirm();
  const staleAttempt = d.lastSave.attemptId;
  // Эмуляция payment-method reset: редактор пересоздан из свежего intent.
  const fresh = initCashTenderEditor(null);
  const after = reduceCashTenderEditor(
    fresh,
    {
      type: "SAVE_ACK",
      attemptId: staleAttempt,
      ok: true,
      changed: true,
      conflict: false,
      error: null,
    },
    { intent: null, customerTotalCents: TOTAL },
  );
  assert.equal(after.state.status, "CLEAN");
  assert.equal(after.state.attempt, null);
});

// --- 13: rapid typing --------------------------------------------------------

test("13: rapid typing меняет только draft; 0 mutations", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  for (const t of ["2", "25", "25.0", "25.00"]) d.edit(t);
  assert.equal(d.view().changeAmountText, "25.00");
  assert.equal(d.saveCount, 0);
});

// --- 14–18: retry / double save ----------------------------------------------

test("14: failed CHANGE_FROM save оставляет draft и даёт retry", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  d.edit("25");
  d.confirm();
  d.ack({ ok: false, error: "нет сети" });
  assert.equal(d.state.status, "ERROR");
  assert.equal(d.view().changeAmountText, "25"); // draft виден
  assert.equal(d.view().retryEnabled, true);
  assert.equal(d.canSubmit(), false);
});

test("15: retry CHANGE_FROM запускает ровно одну новую mutation", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  d.edit("25");
  d.confirm(); // save #1
  d.ack({ ok: false, error: "нет сети" });
  d.confirm(); // retry → save #2
  assert.equal(d.saveCount, 2);
  assert.equal(d.state.status, "SAVING");
  assert.deepEqual(d.lastSave.nextIntent, { mode: "CHANGE_FROM", tenderCents: 2500 });
});

test("16: failed EXACT save даёт явный retry", () => {
  const d = makeDriver(null);
  d.selectExact();
  d.ack({ ok: false, error: "нет сети" });
  assert.equal(d.state.status, "ERROR");
  assert.equal(d.view().retryEnabled, true);
});

test("17: retry EXACT работает", () => {
  const d = makeDriver(null);
  d.selectExact(); // save #1
  d.ack({ ok: false, error: "нет сети" });
  d.confirm(); // retry EXACT → save #2
  assert.equal(d.saveCount, 2);
  assert.deepEqual(d.lastSave.nextIntent, { mode: "EXACT" });
});

test("18: двойной Save запускает максимум одну mutation", () => {
  const d = makeDriver(null);
  d.selectChangeFrom();
  d.edit("25");
  d.confirm(); // SAVING, save #1
  d.confirm(); // guard: SAVING → no-op
  assert.equal(d.saveCount, 1);
});

// --- 19–22: submit gate / fingerprint parity ---------------------------------

test("19: старый валидный persisted intent + провал нового draft → submit false", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  d.edit("25");
  d.confirm();
  d.ack({ ok: false, error: "нет сети" });
  assert.equal(d.state.status, "ERROR");
  assert.equal(d.canSubmit(), false); // нельзя submit по старому $20
});

test("20: EXACT остаётся валидным после изменения итога", () => {
  const d = makeDriver({ mode: "EXACT" }, 2500);
  assert.equal(d.canSubmit(), true);
});

test("21: persisted tender стал невалидным после роста итога → submit false", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 }, 2500);
  assert.equal(d.canSubmit(), false);
  assert.notEqual(d.view().error, null);
  assert.equal(d.view().changeAmountText, "20.00");
});

test("22: при submit=true показанное = authoritative fingerprint", () => {
  const d = makeDriver({ mode: "CHANGE_FROM", tenderCents: 2000 });
  assert.equal(d.canSubmit(), true);
  assert.equal(d.view().changeAmountText, "20.00");
  assert.equal((d.intent as { tenderCents: number }).tenderCents, 2000);
  // editor base совпадает с authoritative — часть submit-гейта.
  assert.equal(d.state.baseIntentKey, "CHANGE_FROM:2000");
});

test("23: CASH→ONLINE→CASH — свежий editor требует нового выбора", () => {
  const reset = initCashTenderEditor(null);
  assert.equal(cashTenderEditorView(reset, null, TOTAL).selectedMode, null);
  assert.equal(canSubmitCashTender(reset, null, TOTAL), false);
});
