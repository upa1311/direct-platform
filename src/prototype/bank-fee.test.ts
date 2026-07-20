import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allocateBankFee,
  BANK_CARD_FEE_RATE_BPS,
  type BankFeeInput,
} from "./bank-fee.ts";

/**
 * Канонический банковский 1%: детерминированные проверки распределения между
 * рестораном и Direct. Функция чистая: получает уже рассчитанные суммы и не
 * меняет ни их, ни клиентскую сумму.
 */

function okFee(input: BankFeeInput) {
  const result = allocateBankFee(input);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) throw new Error("unreachable");
  // Инвариант всегда: сумма частей равна общей комиссии.
  assert.equal(
    result.fee.restaurantBankFeeCents + result.fee.directBankFeeCents,
    result.fee.totalBankFeeCents,
  );
  return result.fee;
}

const directCardOrder = (
  foodSubtotalCents: number,
  customerTotalCents: number,
): BankFeeInput => ({
  deliveryMode: "PLATFORM_DRIVER",
  moneyCollector: "DIRECT",
  paymentInstrument: "CARD",
  foodSubtotalCents,
  customerTotalCents,
});

// 1 — доставка Direct онлайн ---------------------------------------------------

test("доставка Direct онлайн: еда $100, доставка $5 → банк $1.05, ресторан $1, Direct $0.05", () => {
  const fee = okFee(directCardOrder(10_000, 10_500));
  assert.equal(fee.totalBankFeeCents, 105);
  assert.equal(fee.restaurantBankFeeCents, 100);
  assert.equal(fee.directBankFeeCents, 5);
});

// 2 — доставка Direct со small-order fee ---------------------------------------

test("доставка Direct со small-order fee: доплата входит в часть Direct", () => {
  // Еда 800, доставка 500, small-order fee 150 → клиент платит 1450.
  const fee = okFee(directCardOrder(800, 1_450));
  assert.equal(fee.totalBankFeeCents, 15); // round(14.5)
  assert.equal(fee.restaurantBankFeeCents, 8);
  assert.equal(fee.directBankFeeCents, 7);
});

// 3 — самовывоз картой ---------------------------------------------------------

test("самовывоз картой: весь 1% несёт ресторан, Direct — 0", () => {
  const fee = okFee({
    deliveryMode: "PICKUP",
    moneyCollector: "RESTAURANT",
    paymentInstrument: "CARD",
    foodSubtotalCents: 10_000,
    customerTotalCents: 10_000,
  });
  assert.equal(fee.totalBankFeeCents, 100);
  assert.equal(fee.restaurantBankFeeCents, 100);
  assert.equal(fee.directBankFeeCents, 0);
});

// 4/5 — наличные ---------------------------------------------------------------

test("самовывоз наличными: банковская комиссия равна нулю", () => {
  const fee = okFee({
    deliveryMode: "PICKUP",
    moneyCollector: "RESTAURANT",
    paymentInstrument: "CASH",
    foodSubtotalCents: 10_000,
    customerTotalCents: 10_000,
  });
  assert.deepEqual(fee, {
    totalBankFeeCents: 0,
    restaurantBankFeeCents: 0,
    directBankFeeCents: 0,
  });
});

test("курьер ресторана наличными: банковская комиссия равна нулю", () => {
  const fee = okFee({
    deliveryMode: "RESTAURANT_DELIVERY",
    moneyCollector: "RESTAURANT",
    paymentInstrument: "CASH",
    foodSubtotalCents: 1_420,
    customerTotalCents: 1_770,
  });
  assert.deepEqual(fee, {
    totalBankFeeCents: 0,
    restaurantBankFeeCents: 0,
    directBankFeeCents: 0,
  });
});

// 6 — округление ---------------------------------------------------------------

test("нечётные суммы округляются до цента, инвариант сохраняется", () => {
  // 10501 → 105.01 → 105; еда 9999 → 99.99 → 100; Direct 5.
  const a = okFee(directCardOrder(9_999, 10_501));
  assert.equal(a.totalBankFeeCents, 105);
  assert.equal(a.restaurantBankFeeCents, 100);
  assert.equal(a.directBankFeeCents, 5);
  // Половина цента округляется вверх: 1050 → 10.5 → 11.
  const b = okFee(directCardOrder(1_049, 1_050));
  assert.equal(b.totalBankFeeCents, 11);
  assert.equal(b.restaurantBankFeeCents, 10);
  assert.equal(b.directBankFeeCents, 1);
  // Самовывоз картой с нечётной суммой: 1049 → 10.49 → 10, всё ресторану.
  const c = okFee({
    deliveryMode: "PICKUP",
    moneyCollector: "RESTAURANT",
    paymentInstrument: "CARD",
    foodSubtotalCents: 1_049,
    customerTotalCents: 1_049,
  });
  assert.equal(c.totalBankFeeCents, 10);
  assert.equal(c.restaurantBankFeeCents, 10);
});

// 7 — сумма частей -------------------------------------------------------------

test("сумма частей всегда равна общей комиссии (перебор сумм)", () => {
  for (let food = 0; food <= 3_000; food += 137) {
    for (const extra of [0, 1, 49, 50, 99, 150, 500, 1_049]) {
      const fee = okFee(directCardOrder(food, food + extra));
      assert.equal(
        fee.restaurantBankFeeCents + fee.directBankFeeCents,
        fee.totalBankFeeCents,
      );
      assert.ok(fee.restaurantBankFeeCents >= 0);
      assert.ok(fee.directBankFeeCents >= 0);
    }
  }
});

// 8 — fail-closed входные данные -----------------------------------------------

test("некорректные и отрицательные входные данные отклоняются", () => {
  const bad = [
    directCardOrder(-1, 1_000),
    directCardOrder(1_000, -1),
    directCardOrder(10.5, 1_000),
    directCardOrder(1_000, 1_000.5),
    directCardOrder(Number.NaN, 1_000),
    directCardOrder(1_000, Number.POSITIVE_INFINITY),
    // Еда больше карточной транзакции — распределение невозможно.
    directCardOrder(1_001, 1_000),
  ];
  for (const input of bad) {
    const result = allocateBankFee(input);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.length > 0);
  }
});

test("невозможные комбинации не маскируются нулями", () => {
  // Direct не собирает деньги при самовывозе.
  assert.equal(
    allocateBankFee({
      deliveryMode: "PICKUP",
      moneyCollector: "DIRECT",
      paymentInstrument: "CARD",
      foodSubtotalCents: 1_000,
      customerTotalCents: 1_000,
    }).ok,
    false,
  );
  // Ресторан не собирает деньги при доставке водителем Direct.
  assert.equal(
    allocateBankFee({
      deliveryMode: "PLATFORM_DRIVER",
      moneyCollector: "RESTAURANT",
      paymentInstrument: "CARD",
      foodSubtotalCents: 1_000,
      customerTotalCents: 1_500,
    }).ok,
    false,
  );
});

test("повреждённый paymentInstrument отклоняется, а не считается картой", () => {
  const corrupted = "BONUS" as unknown as BankFeeInput["paymentInstrument"];
  // PLATFORM_DRIVER: без явной проверки "BONUS" прошёл бы как карта.
  const platform = allocateBankFee({
    deliveryMode: "PLATFORM_DRIVER",
    moneyCollector: "DIRECT",
    paymentInstrument: corrupted,
    foodSubtotalCents: 10_000,
    customerTotalCents: 10_500,
  });
  assert.equal(platform.ok, false);
  assert.ok(!platform.ok && /канал оплаты/.test(platform.error));
  // PICKUP: тот же fail-closed.
  const pickup = allocateBankFee({
    deliveryMode: "PICKUP",
    moneyCollector: "RESTAURANT",
    paymentInstrument: corrupted,
    foodSubtotalCents: 10_000,
    customerTotalCents: 10_000,
  });
  assert.equal(pickup.ok, false);
  assert.ok(!pickup.ok && /канал оплаты/.test(pickup.error));
  // Ошибка возвращается ДО финансового расчёта: даже суммы, которые сами по
  // себе провалили бы валидацию, не достигаются — ошибка именно про канал.
  const beforeMath = allocateBankFee({
    deliveryMode: "PLATFORM_DRIVER",
    moneyCollector: "DIRECT",
    paymentInstrument: corrupted,
    foodSubtotalCents: Number.NaN,
    customerTotalCents: -1,
  });
  assert.equal(beforeMath.ok, false);
  assert.ok(!beforeMath.ok && /канал оплаты/.test(beforeMath.error));
});

// 9 — онлайн для курьера ресторана ---------------------------------------------

test("онлайн-оплата для собственного курьера ресторана отклоняется", () => {
  const result = allocateBankFee({
    deliveryMode: "RESTAURANT_DELIVERY",
    moneyCollector: "RESTAURANT",
    paymentInstrument: "CARD",
    foodSubtotalCents: 1_420,
    customerTotalCents: 1_770,
  });
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && /курьера ресторана/.test(result.error),
    "точная доменная ошибка, а не правдоподобный ноль",
  );
});

// 10 — функция чистая ----------------------------------------------------------

test("клиентская сумма и входные данные не изменяются функцией", () => {
  const input = Object.freeze(directCardOrder(10_000, 10_500));
  const before = { ...input };
  const result = allocateBankFee(input); // frozen input: мутация бросила бы
  assert.equal(result.ok, true);
  assert.deepEqual({ ...input }, before);
  // Банковская комиссия — распределение внутри уже уплаченной суммы: клиент
  // по-прежнему платит ровно customerTotalCents, наценки за банк нет.
  assert.ok(!result.ok || !("customerTotalCents" in result.fee));
});

// Ставка задана в одном месте.

test("ставка банковской комиссии — ровно 1%", () => {
  assert.equal(BANK_CARD_FEE_RATE_BPS, 100);
});
