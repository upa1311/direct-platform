import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeFreeUnitCount,
  computePaidUnitsBeforeNextFree,
} from "./pricing-engine.ts";
import { createDefaultState } from "./default-state.ts";
import { addCartItem } from "./actions.ts";
import { calculateCartPricing } from "./selectors.ts";
import { normalizePrototypeState } from "./prototype-store.ts";
import type { PrototypeState } from "./models.ts";

const CONFIG = { buyQuantity: 3, freeQuantity: 1, repeat: true };

function cartWithPizzas(
  count: number,
  variantId: string = "size-standard",
): PrototypeState {
  let s = createDefaultState();
  for (let i = 0; i < count; i += 1) {
    s = addCartItem(s, "restaurant-2-item-1", variantId).state;
  }
  return s;
}

// --- Чистая функция: платные пиццы до следующей бесплатной (§1, §6) ---------

test("computePaidUnitsBeforeNextFree: таблица 1–12 для акции 3+1", () => {
  const expected: Record<number, number | null> = {
    0: null,
    1: 2,
    2: 1,
    3: 0,
    4: 3,
    5: 2,
    6: 1,
    7: 0,
    8: 3,
    9: 2,
    10: 1,
    11: 0,
    12: 3,
  };
  for (const [unitsStr, want] of Object.entries(expected)) {
    const units = Number(unitsStr);
    assert.equal(
      computePaidUnitsBeforeNextFree(units, CONFIG),
      want,
      `units=${units}`,
    );
  }
});

test("computePaidUnitsBeforeNextFree: неповторяющаяся акция 3+1 (§1)", () => {
  const once = { buyQuantity: 3, freeQuantity: 1, repeat: false };
  // До первого срабатывания прогресс показывается.
  assert.equal(computePaidUnitsBeforeNextFree(1, once), 2);
  assert.equal(computePaidUnitsBeforeNextFree(2, once), 1);
  // 3 участвующих — следующая уже бесплатная.
  assert.equal(computePaidUnitsBeforeNextFree(3, once), 0);
  // 4 и больше — акция уже дала свой единственный подарок: null.
  assert.equal(computePaidUnitsBeforeNextFree(4, once), null);
  assert.equal(computePaidUnitsBeforeNextFree(5, once), null);
  assert.equal(computePaidUnitsBeforeNextFree(12, once), null);
});

test("computePaidUnitsBeforeNextFree: repeat=true при 4 единицах → 3 (§1)", () => {
  // Повторяющаяся акция: после подарка прогресс продолжается (ещё 3 платные).
  assert.equal(computePaidUnitsBeforeNextFree(4, CONFIG), 3);
});

// --- Поле CartPricing через реальную корзину (§6) ---------------------------

test("CartPricing.promotionPaidUnitsBeforeNextFree по количеству пицц", () => {
  const cases: Array<[number, number | null]> = [
    [1, 2],
    [2, 1],
    [3, 0],
    [4, 3],
    [5, 2],
    [6, 1],
    [7, 0],
    [8, 3],
    [12, 3],
  ];
  for (const [count, want] of cases) {
    const pricing = calculateCartPricing(cartWithPizzas(count));
    assert.equal(
      pricing.promotionPaidUnitsBeforeNextFree,
      want,
      `pizzas=${count}`,
    );
  }
});

test("0 пицц — прогресс не показывается (поле null)", () => {
  const pricing = calculateCartPricing(createDefaultState());
  assert.equal(pricing.promotionPaidUnitsBeforeNextFree, null);
});

// --- Финансовая механика акции не изменилась (§6, §8) -----------------------

test("при 4 пиццах — одна бесплатная (скидка = базовая цена)", () => {
  const pricing = calculateCartPricing(cartWithPizzas(4));
  assert.equal(pricing.promotionFreeUnitCount, 1);
  // Базовая цена Маргариты 800; скидка = одна самая дешёвая базовая.
  assert.equal(pricing.promotionDiscountCents, 800);
});

test("при 8 пиццах — две бесплатные", () => {
  const pricing = calculateCartPricing(cartWithPizzas(8));
  assert.equal(pricing.promotionFreeUnitCount, 2);
  assert.equal(pricing.promotionDiscountCents, 1600);
});

test("при 12 пиццах — три бесплатные", () => {
  const pricing = calculateCartPricing(cartWithPizzas(12));
  assert.equal(pricing.promotionFreeUnitCount, 3);
});

test("computeFreeUnitCount не изменился (4→1, 8→2, 12→3)", () => {
  assert.equal(computeFreeUnitCount(4, CONFIG), 1);
  assert.equal(computeFreeUnitCount(8, CONFIG), 2);
  assert.equal(computeFreeUnitCount(12, CONFIG), 3);
});

test("доплата за большой размер остаётся платной (скидка только с базовой)", () => {
  // 4 «Большие» Маргариты: база 800 + доплата 200 = 1000 каждая.
  const pricing = calculateCartPricing(cartWithPizzas(4, "size-large"));
  assert.equal(pricing.promotionFreeUnitCount, 1);
  // Бесплатна только базовая цена (800), доплата 200 за размер остаётся платной.
  assert.equal(pricing.promotionDiscountCents, 800);
  assert.ok(pricing.variantSurchargeSubtotalCents > 0);
});

// --- Точечная нормализация названия seed-акции (§3) --------------------------

test("новое состояние: название seed-акции обновлено", () => {
  const promo = createDefaultState().promotions.find(
    (p) => p.id === "promo-restaurant-2-pizza",
  );
  assert.equal(promo?.title, "Каждая 4-я пицца — бесплатно");
  assert.equal(promo?.displayText, "Каждая 4-я пицца — бесплатно");
});

test("старое стандартное название seed-акции нормализуется", () => {
  const s = createDefaultState();
  const legacy: PrototypeState = {
    ...s,
    promotions: s.promotions.map((p) =>
      p.id === "promo-restaurant-2-pizza"
        ? {
            ...p,
            title: "Закажи 3 пиццы и получи четвёртую бесплатно",
            displayText: "Закажи 3 пиццы и получи четвёртую бесплатно",
          }
        : p,
    ),
  };
  const normalized = normalizePrototypeState(legacy);
  const promo = normalized.promotions.find(
    (p) => p.id === "promo-restaurant-2-pizza",
  );
  assert.equal(promo?.title, "Каждая 4-я пицца — бесплатно");
  assert.equal(promo?.displayText, "Каждая 4-я пицца — бесплатно");
});

test("прочие прежние стандартные названия seed-акции нормализуются (§2)", () => {
  const oldNames = [
    "Купи 3 пиццы и получи четвёртую в подарок",
    "3 пиццы + четвёртая в подарок",
    "3 пиццы + 4-я в подарок",
    "3 + 1 в подарок",
  ];
  for (const oldName of oldNames) {
    const s = createDefaultState();
    const legacy: PrototypeState = {
      ...s,
      promotions: s.promotions.map((p) =>
        p.id === "promo-restaurant-2-pizza"
          ? { ...p, title: oldName, displayText: oldName }
          : p,
      ),
    };
    const promo = normalizePrototypeState(legacy).promotions.find(
      (p) => p.id === "promo-restaurant-2-pizza",
    );
    assert.equal(promo?.title, "Каждая 4-я пицца — бесплатно", oldName);
    assert.equal(promo?.displayText, "Каждая 4-я пицца — бесплатно", oldName);
  }
});

test("пользовательское название seed-акции не перезаписывается", () => {
  const s = createDefaultState();
  const custom: PrototypeState = {
    ...s,
    promotions: s.promotions.map((p) =>
      p.id === "promo-restaurant-2-pizza"
        ? { ...p, title: "Моя особая акция", displayText: "Моя особая акция" }
        : p,
    ),
  };
  const normalized = normalizePrototypeState(custom);
  const promo = normalized.promotions.find(
    (p) => p.id === "promo-restaurant-2-pizza",
  );
  assert.equal(promo?.title, "Моя особая акция");
  assert.equal(promo?.displayText, "Моя особая акция");
});
