import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KITCHEN_ALERT_DURATION_SECONDS,
  KITCHEN_ALERT_PATTERN,
  kitchenAlertPatternEndSeconds,
} from "./kitchen-sound.ts";
import {
  getAudibleKitchenReviewOrders,
  isKitchenBeepDue,
  KITCHEN_REVIEW_TIMEOUT_MS,
} from "../../prototype/selectors.ts";
import type { PrototypeState } from "../../prototype/models.ts";

// --- Структура сигнала (§11.1–7) --------------------------------------------

test("§11.1: длительность сигнала >= 2.0 секунды", () => {
  assert.ok(kitchenAlertPatternEndSeconds() >= 2.0);
});

test("§11.2: последний импульс заканчивается не раньше DURATION − 0.05", () => {
  assert.ok(
    kitchenAlertPatternEndSeconds() >= KITCHEN_ALERT_DURATION_SECONDS - 0.05,
  );
});

test("§11.3: минимум четыре импульса", () => {
  assert.ok(KITCHEN_ALERT_PATTERN.length >= 4);
});

test("§11.4: минимум три различные частоты", () => {
  const freqs = new Set(
    KITCHEN_ALERT_PATTERN.flatMap((p) => p.frequenciesHz),
  );
  assert.ok(freqs.size >= 3);
});

test("§11.5: частоты в безопасном диапазоне 750–1450 Гц", () => {
  for (const pulse of KITCHEN_ALERT_PATTERN) {
    for (const f of pulse.frequenciesHz) {
      assert.ok(f >= 750 && f <= 1450, `частота ${f} вне диапазона`);
    }
  }
});

test("§11.6: peakGain каждого импульса в допустимых пределах (0..1]", () => {
  for (const pulse of KITCHEN_ALERT_PATTERN) {
    assert.ok(pulse.peakGain > 0 && pulse.peakGain <= 1);
  }
});

test("§11.7: pattern не пустой", () => {
  assert.ok(KITCHEN_ALERT_PATTERN.length > 0);
});

// --- Поведение уведомлений не изменилось (§11.8–10) -------------------------

test("§11.8: интервал уведомления остаётся 20 секунд", () => {
  const common = {
    reviewOrderIds: ["a"],
    announcedOrderIds: ["a"],
    lastBeepAtMs: 100_000,
  };
  // < 20с после прошлого сигнала — не звучит.
  assert.equal(
    isKitchenBeepDue({ ...common, nowMs: 100_000 + 19_000 }),
    false,
  );
  // Ровно 20с — звучит снова.
  assert.equal(
    isKitchenBeepDue({ ...common, nowMs: 100_000 + 20_000 }),
    true,
  );
});

function reviewState(orders: { id: string; createdAt: string }[]): PrototypeState {
  return {
    orders: orders.map((o) => ({
      id: o.id,
      restaurant: { id: "restaurant-2" },
      status: "RESTAURANT_REVIEW",
      createdAt: o.createdAt,
    })),
  } as unknown as PrototypeState;
}

test("§11.9: на границе 7 минут заказ больше не звучит", () => {
  const created = "2026-07-14T10:00:00.000Z";
  const at = (offset: number) => Date.parse(created) + offset;
  const state = reviewState([{ id: "a", createdAt: created }]);
  // До границы — звучит.
  assert.equal(
    getAudibleKitchenReviewOrders(state, "restaurant-2", at(KITCHEN_REVIEW_TIMEOUT_MS - 1000)).length,
    1,
  );
  // Ровно на 7 минутах — больше не участвует в звуке.
  assert.equal(
    getAudibleKitchenReviewOrders(state, "restaurant-2", at(KITCHEN_REVIEW_TIMEOUT_MS)).length,
    0,
  );
});

test("§11.10: несколько новых заказов дают один общий сигнал", () => {
  const created = "2026-07-14T10:00:00.000Z";
  const now = Date.parse(created) + 30_000;
  const state = reviewState([
    { id: "a", createdAt: created },
    { id: "b", createdAt: "2026-07-14T10:00:15.000Z" },
  ]);
  const audible = getAudibleKitchenReviewOrders(state, "restaurant-2", now);
  assert.equal(audible.length, 2);
  // isKitchenBeepDue возвращает единый boolean — один combined alert.
  assert.equal(
    isKitchenBeepDue({
      reviewOrderIds: audible.map((o) => o.id),
      announcedOrderIds: [],
      lastBeepAtMs: null,
      nowMs: now,
    }),
    true,
  );
});
