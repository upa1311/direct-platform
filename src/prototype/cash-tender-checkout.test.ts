import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  addCartItem,
  createOrderFromCart,
  setCartCashTenderIntent,
  setCartFulfillmentChoice,
  setCartPaymentMethod,
  updateCartAddress,
} from "./actions.ts";
import { calculateCartPricing } from "./selectors.ts";
import type { CashTenderIntent, PrototypeState } from "./models.ts";

/**
 * Cash Tender & Change Snapshot V1 — корзина, оформление и создание заказа (v31).
 * Наличный клиентский путь включается флагом platformDriverCashEnabled (DEC-094/
 * 097/114 — при выключенном флаге CASH заблокирован в логике). Экономика заказа
 * не меняется: снимок сдачи строится поверх существующего механизма расчёта.
 */

const ADDR = { street: "Садовый переулок", house: "1" };

/** Наличная корзина ресторана-2 (DIRECT, PLATFORM_DRIVER) с включённым флагом. */
function cashCartBase(qty = 2): PrototypeState {
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
  return setCartPaymentMethod(s, "CASH");
}

function withIntent(state: PrototypeState, intent: CashTenderIntent): PrototypeState {
  return setCartCashTenderIntent(state, intent);
}

// --- 9–17: cart / checkout intent + order creation ----------------------------

test("checkout-9: CASH без явного намерения → создание заблокировано", () => {
  const s = cashCartBase();
  assert.equal(s.cart.cashTenderIntent, null);
  const r = createOrderFromCart(s);
  assert.equal(r.result.orderId, null);
  assert.ok(r.result.error);
});

test("checkout-10: EXACT → заказ создаётся со снимком (без сдачи)", () => {
  const s = withIntent(cashCartBase(), { mode: "EXACT" });
  const total = calculateCartPricing(s).customerTotalCents as number;
  const r = createOrderFromCart(s);
  assert.ok(r.result.orderId);
  const order = r.state.orders.find((o) => o.id === r.result.orderId);
  assert.ok(order);
  assert.equal(order.paymentMethod, "CASH");
  assert.equal(order.paymentStatus, "CASH_ON_DELIVERY");
  assert.deepEqual(order.financials.platformDriverCashTender, {
    mode: "EXACT",
    tenderCents: total,
    changeDueCents: 0,
  });
  assert.ok(order.financials.platformDriverCash);
});

test("checkout-11: CHANGE_FROM → заказ создаётся с правильной сдачей", () => {
  const base = cashCartBase();
  const total = calculateCartPricing(base).customerTotalCents as number;
  const s = withIntent(base, { mode: "CHANGE_FROM", tenderCents: total + 500 });
  const r = createOrderFromCart(s);
  assert.ok(r.result.orderId);
  const order = r.state.orders.find((o) => o.id === r.result.orderId);
  assert.deepEqual(order?.financials.platformDriverCashTender, {
    mode: "CHANGE_FROM",
    tenderCents: total + 500,
    changeDueCents: 500,
  });
});

test("checkout-12: смена способа оплаты очищает наличное намерение", () => {
  const s = withIntent(cashCartBase(), { mode: "EXACT" });
  assert.deepEqual(s.cart.cashTenderIntent, { mode: "EXACT" });
  const online = setCartPaymentMethod(s, "ONLINE");
  assert.equal(online.cart.paymentMethod, "ONLINE");
  assert.equal(online.cart.cashTenderIntent, null);
});

test("checkout-13: возврат на CASH требует нового выбора", () => {
  const s = withIntent(cashCartBase(), { mode: "EXACT" });
  const online = setCartPaymentMethod(s, "ONLINE");
  const backToCash = setCartPaymentMethod(online, "CASH");
  assert.equal(backToCash.cart.paymentMethod, "CASH");
  assert.equal(backToCash.cart.cashTenderIntent, null);
});

test("checkout-13b: смена способа получения очищает намерение", () => {
  const s = withIntent(cashCartBase(), { mode: "EXACT" });
  const pickup = setCartFulfillmentChoice(s, "PICKUP");
  assert.equal(pickup.cart.cashTenderIntent, null);
  assert.equal(pickup.cart.paymentMethod, "ONLINE");
});

test("checkout-14: cart total вырос выше tender → создание заблокировано", () => {
  const base = cashCartBase(2);
  const total = calculateCartPricing(base).customerTotalCents as number;
  // tender только чуть выше текущего total.
  let s = withIntent(base, { mode: "CHANGE_FROM", tenderCents: total + 100 });
  // Добавляем ещё позиции — total превышает tender.
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const newTotal = calculateCartPricing(s).customerTotalCents as number;
  assert.ok(newTotal > total + 100);
  const r = createOrderFromCart(s);
  assert.equal(r.result.orderId, null);
  assert.ok(r.result.error);
});

test("checkout-15: EXACT использует НОВЫЙ итог после изменения корзины", () => {
  const base = cashCartBase(2);
  const total2 = calculateCartPricing(base).customerTotalCents as number;
  let s = withIntent(base, { mode: "EXACT" });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const total3 = calculateCartPricing(s).customerTotalCents as number;
  assert.ok(total3 > total2);
  const r = createOrderFromCart(s);
  const order = r.state.orders.find((o) => o.id === r.result.orderId);
  assert.equal(order?.financials.platformDriverCashTender?.tenderCents, total3);
  assert.equal(order?.financials.platformDriverCashTender?.changeDueCents, 0);
});

test("checkout-16: успешное создание очищает намерение и корзину", () => {
  const s = withIntent(cashCartBase(), { mode: "EXACT" });
  const r = createOrderFromCart(s);
  assert.ok(r.result.orderId);
  assert.equal(r.state.cart.cashTenderIntent, null);
  assert.equal(r.state.cart.items.length, 0);
});

test("checkout-17: неудачное создание НЕ очищает намерение/корзину", () => {
  const base = cashCartBase();
  const total = calculateCartPricing(base).customerTotalCents as number;
  // tender == total при CHANGE_FROM — невалидно → fail-closed.
  const s = withIntent(base, { mode: "CHANGE_FROM", tenderCents: total });
  const r = createOrderFromCart(s);
  assert.equal(r.result.orderId, null);
  assert.deepEqual(r.state.cart.cashTenderIntent, {
    mode: "CHANGE_FROM",
    tenderCents: total,
  });
  assert.ok(r.state.cart.items.length > 0);
  assert.equal(r.state.revision, s.revision);
});

// --- 46–50: свежесть/провал/дубли ---------------------------------------------

test("checkout-46: создание использует наличное намерение из переданного state", () => {
  // createOrderFromCart читает cart из своего аргумента (свежий persisted state),
  // а не из внешнего кэша: снимок строится из текущего cart.cashTenderIntent.
  const s = withIntent(cashCartBase(), { mode: "EXACT" });
  const r = createOrderFromCart(s);
  assert.equal(
    r.state.orders.find((o) => o.id === r.result.orderId)?.financials
      .platformDriverCashTender?.mode,
    "EXACT",
  );
});

test("checkout-49: создание наличного заказа наращивает nextOrderNumber ровно один раз", () => {
  const s = withIntent(cashCartBase(), { mode: "EXACT" });
  const r = createOrderFromCart(s);
  assert.equal(r.state.nextOrderNumber, s.nextOrderNumber + 1);
  assert.equal(r.state.orders.length, s.orders.length + 1);
});

test("checkout-47,48: провайдер создаёт заказ строго под общей сериализованной мутацией", () => {
  // Провайдер оборачивает createOrder в runSerializedActionMutation (общий Web
  // Lock): write failure не даёт ложного успеха, а вторая вкладка перечитывает
  // свежий cart. Проверяем контракт по источнику (render-harness нет).
  const provider = readFileSync(
    "src/prototype/prototype-provider.tsx",
    "utf8",
  );
  const start = provider.indexOf("const createOrder = useCallback");
  assert.notEqual(start, -1);
  const block = provider.slice(start, start + 400);
  assert.ok(block.includes("runSerializedActionMutation"));
  assert.ok(block.includes("createOrderFromCart"));
});

test("checkout-50: снимок сдачи не зависит от notification/connection модулей", () => {
  // Снимок строится только из cart + канонических сумм; связь с водительскими
  // уведомлениями и статусом соединения отсутствует.
  const actions = readFileSync("src/prototype/actions.ts", "utf8");
  const start = actions.indexOf("buildPlatformDriverCashTenderSnapshot({");
  assert.notEqual(start, -1);
  const block = actions.slice(start, start + 400);
  assert.ok(!/notification|connection|navigator|BroadcastChannel/i.test(block));
});

// --- флаг выключен: наличные заблокированы в логике (DEC-094/114) --------------

test("checkout-flag-off: без флага CASH не выбирается, создание требует ONLINE", () => {
  let s = createDefaultState();
  s = { ...s, customer: { ...s.customer, phoneVerified: true } };
  s = updateCartAddress(s, ADDR);
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const attempted = setCartPaymentMethod(s, "CASH");
  // Флаг выключен → способ оплаты остаётся ONLINE (мутация игнорируется).
  assert.equal(attempted.cart.paymentMethod, "ONLINE");
});
