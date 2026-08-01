import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  addCartItem,
  createOrderFromCart,
  saveCartCashTenderIntent,
  setCartPaymentMethod,
  updateCartAddress,
} from "./actions.ts";
import { cashTenderIntentKey } from "./cash-tender-intent.ts";
import { calculateCartPricing } from "./selectors.ts";
import type { CashTenderIntent, PrototypeState } from "./models.ts";

/**
 * Compare-and-set сохранение наличного намерения (domain, v31). Проверяет CAS над
 * РАЗНЫМИ base states: применение при совпадении отпечатка, отказ при
 * рассинхроне/сбросе без мутации, идемпотентный no-op, и что проигравший queued
 * save не перезаписывает выигравшее incoming намерение (create order его и берёт).
 */

const ADDR = { street: "Садовый переулок", house: "1" };

function cashBase(intent: CashTenderIntent, qty = 2): PrototypeState {
  let s = createDefaultState();
  s = {
    ...s,
    platformSettings: { ...s.platformSettings, platformDriverCashEnabled: true },
    customer: { ...s.customer, phoneVerified: true },
  };
  s = updateCartAddress(s, ADDR);
  for (let i = 0; i < qty; i += 1) {
    s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  }
  s = setCartPaymentMethod(s, "CASH");
  return { ...s, cart: { ...s.cart, cashTenderIntent: intent } };
}

test("cas-1: matching base применяет next intent (revision +1)", () => {
  const base = cashBase({ mode: "EXACT" });
  const r = saveCartCashTenderIntent(base, "EXACT", {
    mode: "CHANGE_FROM",
    tenderCents: 2500,
  });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.conflict, false);
  assert.deepEqual(r.state.cart.cashTenderIntent, {
    mode: "CHANGE_FROM",
    tenderCents: 2500,
  });
  assert.equal(r.state.revision, base.revision + 1);
});

test("cas-2: stale base отклоняется без мутации (conflict)", () => {
  const base = cashBase({ mode: "EXACT" });
  const r = saveCartCashTenderIntent(base, "NULL", { mode: "EXACT" });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.conflict, true);
  assert.deepEqual(r.state.cart.cashTenderIntent, { mode: "EXACT" }); // не изменён
  assert.equal(r.state.revision, base.revision); // revision не растёт
});

test("cas-3: same-value CHANGE_FROM → idempotent ok, no revision", () => {
  const base = cashBase({ mode: "CHANGE_FROM", tenderCents: 2000 });
  const r = saveCartCashTenderIntent(base, "CHANGE_FROM:2000", {
    mode: "CHANGE_FROM",
    tenderCents: 2000,
  });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.conflict, false);
  assert.equal(r.state.revision, base.revision); // no-op
  assert.equal(r.state, base); // тот же state → committed:false у провайдера
});

test("cas-4: same-value EXACT → idempotent ok, no revision", () => {
  const base = cashBase({ mode: "EXACT" });
  const r = saveCartCashTenderIntent(base, "EXACT", { mode: "EXACT" });
  assert.equal(r.result.ok, true);
  assert.equal(r.state.revision, base.revision);
});

test("cas-5: payment method не CASH → conflict без мутации", () => {
  const base = cashBase({ mode: "EXACT" });
  const online: PrototypeState = {
    ...base,
    cart: { ...base.cart, paymentMethod: "ONLINE", cashTenderIntent: null },
  };
  const r = saveCartCashTenderIntent(online, "NULL", { mode: "EXACT" });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.conflict, true);
  assert.equal(r.state.revision, online.revision);
});

test("cas-6: проигравший queued save не перезаписывает выигравшее incoming", () => {
  // Другая вкладка уже сохранила $30; наш queued save основан на устаревшем $20.
  const winning = cashBase({ mode: "CHANGE_FROM", tenderCents: 3000 });
  const total = calculateCartPricing(winning).customerTotalCents as number;
  assert.ok(3000 > total);
  const r = saveCartCashTenderIntent(winning, "CHANGE_FROM:2000", {
    mode: "CHANGE_FROM",
    tenderCents: 2500,
  });
  assert.equal(r.result.conflict, true);
  assert.deepEqual(r.state.cart.cashTenderIntent, {
    mode: "CHANGE_FROM",
    tenderCents: 3000,
  });
});

test("cas-7: create order после проигранного queued save берёт выигравшее намерение", () => {
  const winning = cashBase({ mode: "CHANGE_FROM", tenderCents: 3000 });
  const total = calculateCartPricing(winning).customerTotalCents as number;
  const stale = saveCartCashTenderIntent(winning, "CHANGE_FROM:2000", {
    mode: "CHANGE_FROM",
    tenderCents: 2500,
  });
  // Заказ создаётся из состояния после проигранного save → intent = $30.
  const created = createOrderFromCart(stale.state);
  assert.ok(created.result.orderId);
  const order = created.state.orders.find((o) => o.id === created.result.orderId);
  assert.deepEqual(order?.financials.platformDriverCashTender, {
    mode: "CHANGE_FROM",
    tenderCents: 3000,
    changeDueCents: 3000 - total,
  });
});

test("cas-8: cashTenderIntentKey — отпечаток для CAS", () => {
  assert.equal(cashTenderIntentKey(null), "NULL");
  assert.equal(cashTenderIntentKey({ mode: "EXACT" }), "EXACT");
  assert.equal(
    cashTenderIntentKey({ mode: "CHANGE_FROM", tenderCents: 3000 }),
    "CHANGE_FROM:3000",
  );
});
