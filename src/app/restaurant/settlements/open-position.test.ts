import assert from "node:assert/strict";
import { test } from "node:test";

import { describeOpenPosition } from "./open-position.ts";

// money-форматтер, echo'ящий центы: value === переданные центы (строкой).
const money = (cents: number) => String(cents);

// 1 --------------------------------------------------------------------------

test("net > 0 → Direct должен ресторану, положительная сумма", () => {
  const r = describeOpenPosition({ receivable: 0, payable: 500, net: 500 }, money);
  assert.equal(r.label, "Direct должен ресторану");
  assert.equal(r.value, "500");
});

// 2 --------------------------------------------------------------------------

test("net < 0 → Ресторан должен Direct, используется абсолютная положительная сумма", () => {
  const r = describeOpenPosition({ receivable: 800, payable: 0, net: -800 }, money);
  assert.equal(r.label, "Ресторан должен Direct");
  assert.equal(r.value, "800", "модуль от net, без минуса");
  assert.ok(!r.value.startsWith("-"), "никогда не отрицательная сумма");
});

// 3 --------------------------------------------------------------------------

test("net = 0 и обе суммы 0 → Открытых обязательств нет", () => {
  const r = describeOpenPosition({ receivable: 0, payable: 0, net: 0 }, money);
  assert.equal(r.label, "Открытых обязательств нет");
  assert.equal(r.value, "0");
});

// 4 --------------------------------------------------------------------------

test("net = 0, но обе стороны должны равную ненулевую сумму → Обязательства сторон равны", () => {
  const r = describeOpenPosition({ receivable: 700, payable: 700, net: 0 }, money);
  assert.equal(r.label, "Обязательства сторон равны");
  assert.equal(r.value, "0", "чистая позиция ноль, но не «нет обязательств»");
});

// 5 --------------------------------------------------------------------------

test("никогда не показывает отрицательную сумму при любом знаке net", () => {
  for (const net of [-1, -999, -100000]) {
    const r = describeOpenPosition({ receivable: Math.abs(net), payable: 0, net }, money);
    assert.ok(!r.value.startsWith("-"), `net=${net} → значение не отрицательное`);
  }
});

// 6 --------------------------------------------------------------------------

test("UI не пересчитывает net: используется переданное значение как есть", () => {
  // Даже при «несогласованных» receivable/payable результат определяется знаком net.
  const r = describeOpenPosition({ receivable: 1000, payable: 200, net: 300 }, money);
  assert.equal(r.label, "Direct должен ресторану");
  assert.equal(r.value, "300", "берётся именно net, а не payable-receivable");
});
