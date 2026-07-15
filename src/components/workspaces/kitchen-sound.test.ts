import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIRECT_KDS_CHIME,
  KITCHEN_FILE_GAIN,
  KITCHEN_SOUND_FILE_URL,
  directKdsChimeDurationSeconds,
  KDS_MASTER_GAIN,
  KDS_MAX_FREQUENCY_HZ,
  KDS_WAVEFORMS,
  KITCHEN_ALERT_DURATION_SECONDS,
} from "./kitchen-sound.ts";
import {
  getAudibleKitchenReviewOrders,
  isKitchenBeepDue,
  KITCHEN_REVIEW_TIMEOUT_MS,
} from "../../prototype/selectors.ts";
import type { PrototypeState } from "../../prototype/models.ts";

// --- Структура новой мелодии Direct KDS (§8) --------------------------------

test("§8: ровно 9 нот", () => {
  assert.equal(DIRECT_KDS_CHIME.length, 9);
});

test("§8: частоты в мягком диапазоне и не выше безопасного максимума", () => {
  for (const tone of DIRECT_KDS_CHIME) {
    assert.ok(
      tone.frequency >= 440 && tone.frequency <= KDS_MAX_FREQUENCY_HZ,
      `частота ${tone.frequency} вне диапазона`,
    );
  }
  assert.ok(KDS_MAX_FREQUENCY_HZ <= 850);
});

test("§8: нет square/sawtooth — только sine и triangle", () => {
  assert.ok(!KDS_WAVEFORMS.includes("square"));
  assert.ok(!KDS_WAVEFORMS.includes("sawtooth"));
  for (const w of KDS_WAVEFORMS) {
    assert.ok(w === "sine" || w === "triangle", `недопустимая форма ${w}`);
  }
});

test("§8: полная длительность в пределах 2.2–3.0 секунды", () => {
  const seconds = directKdsChimeDurationSeconds();
  assert.ok(seconds >= 2.2, `слишком коротко: ${seconds}`);
  assert.ok(seconds < 3.0, `слишком длинно: ${seconds}`);
});

test("§8: master gain ниже прежнего (0.38)", () => {
  assert.ok(KDS_MASTER_GAIN < 0.38);
  assert.ok(KDS_MASTER_GAIN >= 0.18 && KDS_MASTER_GAIN <= 0.24);
});

test("§8: первая и последняя группы имеют один узнаваемый ритм", () => {
  const first = DIRECT_KDS_CHIME.slice(0, 3);
  const last = DIRECT_KDS_CHIME.slice(6, 9);
  // Одинаковый частотный рисунок пик-пик-пик: [560, 560, 620].
  assert.deepEqual(
    first.map((t) => t.frequency),
    last.map((t) => t.frequency),
  );
  assert.deepEqual(
    first.map((t) => t.frequency),
    [560, 560, 620],
  );
  // Первые два коротких сигнала обеих групп одинаковой длительности.
  assert.equal(first[0].durationMs, last[0].durationMs);
  assert.equal(first[1].durationMs, last[1].durationMs);
});

test("§8: окно защиты от наложения короче 20-сек интервала и меньше 3 сек", () => {
  assert.ok(KITCHEN_ALERT_DURATION_SECONDS < 3);
  assert.ok(KITCHEN_ALERT_DURATION_SECONDS < 20);
  assert.ok(KITCHEN_ALERT_DURATION_SECONDS >= directKdsChimeDurationSeconds());
});

test("§8: средняя мелодическая часть не громче коротких сигналов", () => {
  const middle = DIRECT_KDS_CHIME.slice(3, 6);
  for (const tone of middle) {
    assert.ok((tone.gain ?? 0.2) <= 0.2);
  }
});

// --- Поведение уведомлений не изменилось (§8: сохранённые тесты) -------------

test("интервал уведомления остаётся 20 секунд", () => {
  const common = {
    reviewOrderIds: ["a"],
    announcedOrderIds: ["a"],
    lastBeepAtMs: 100_000,
  };
  // < 20с после прошлого сигнала — не звучит.
  assert.equal(isKitchenBeepDue({ ...common, nowMs: 100_000 + 19_000 }), false);
  // Ровно 20с — звучит снова.
  assert.equal(isKitchenBeepDue({ ...common, nowMs: 100_000 + 20_000 }), true);
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

test("на границе 7 минут заказ больше не звучит", () => {
  const created = "2026-07-14T10:00:00.000Z";
  const at = (offset: number) => Date.parse(created) + offset;
  const state = reviewState([{ id: "a", createdAt: created }]);
  assert.equal(
    getAudibleKitchenReviewOrders(state, "restaurant-2", at(KITCHEN_REVIEW_TIMEOUT_MS - 1000)).length,
    1,
  );
  assert.equal(
    getAudibleKitchenReviewOrders(state, "restaurant-2", at(KITCHEN_REVIEW_TIMEOUT_MS)).length,
    0,
  );
});

test("несколько новых заказов дают один общий сигнал", () => {
  const created = "2026-07-14T10:00:00.000Z";
  const now = Date.parse(created) + 30_000;
  const state = reviewState([
    { id: "a", createdAt: created },
    { id: "b", createdAt: "2026-07-14T10:00:15.000Z" },
  ]);
  const audible = getAudibleKitchenReviewOrders(state, "restaurant-2", now);
  assert.equal(audible.length, 2);
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

// --- Пользовательский mp3-сигнал ---------------------------------------------

test("основной сигнал — пользовательский mp3 из public/sounds", () => {
  assert.equal(KITCHEN_SOUND_FILE_URL, "/sounds/kitchen-new-order.mp3");
});

test("громкость mp3 в безопасных пределах, синтезированный fallback сохранён", () => {
  assert.ok(KITCHEN_FILE_GAIN > 0 && KITCHEN_FILE_GAIN <= 1);
  // Fallback-мелодия по-прежнему валидна (кухня не останется без звука).
  assert.equal(DIRECT_KDS_CHIME.length, 9);
});
