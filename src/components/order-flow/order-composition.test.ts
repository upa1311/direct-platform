import assert from "node:assert/strict";
import { test } from "node:test";

import { getBriefOrderComposition } from "./order-composition.ts";

function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    menuItemId: `menu-item-${i + 1}`,
    name: `Блюдо ${i + 1}`,
    quantity: i + 1,
  }));
}

test("§2: 0 позиций — безопасный fallback", () => {
  const out = getBriefOrderComposition([]);
  assert.equal(out.primaryText, "—");
  assert.equal(out.remainingCount, 0);
});

test("§2: 1 позиция", () => {
  const out = getBriefOrderComposition([{ name: "Пицца", quantity: 2 }]);
  assert.equal(out.primaryText, "Пицца × 2");
  assert.equal(out.remainingCount, 0);
});

test("§2: 2 позиции — показаны обе, без «Ещё»", () => {
  const out = getBriefOrderComposition([
    { name: "Пицца", quantity: 4 },
    { name: "Лимонад", quantity: 2 },
  ]);
  assert.equal(out.primaryText, "Пицца × 4, Лимонад × 2");
  assert.equal(out.remainingCount, 0);
});

test("§2: 3 позиции → ещё 1", () => {
  const out = getBriefOrderComposition(items(3));
  assert.equal(out.primaryText, "Блюдо 1 × 1, Блюдо 2 × 2");
  assert.equal(out.remainingCount, 1);
});

test("§2: 10 позиций → ещё 8 (считаются строки, не quantity)", () => {
  const out = getBriefOrderComposition(items(10));
  assert.equal(out.remainingCount, 8);
});

test("§2: технические ID не показываются", () => {
  const out = getBriefOrderComposition(items(10));
  assert.ok(!out.primaryText.includes("menu-item"));
});
