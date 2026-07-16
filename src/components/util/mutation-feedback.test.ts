import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MUTATION_FALLBACK_ERROR,
  addItemFeedbackMessage,
  feedbackFromAck,
} from "./mutation-feedback.ts";

/**
 * Исправления 5–6: чистые UI-хелперы feedback (UI-фреймворка для тестов нет —
 * поведение страниц проверяется browser-тестом, а формирование сообщений
 * тестируется здесь unit-тестами).
 */

test("Тест 14: ошибка сохранения тарифов не приводит к success-feedback", () => {
  const feedback = feedbackFromAck(
    { ok: false, error: "Не удалось сохранить тарифы.", changed: false },
    "Тарифы сохранены и уже используются в клиентской корзине.",
  );
  assert.equal(feedback.kind, "error");
  assert.equal(feedback.text, "Не удалось сохранить тарифы.");
  assert.ok(!feedback.text.includes("сохранены и уже используются"));
});

test("Тест 15: ошибка сохранения размеров не показывает «Сохранено»", () => {
  const feedback = feedbackFromAck(
    { ok: false, error: "Не удалось сохранить размеры.", changed: false },
    "Сохранено",
  );
  assert.equal(feedback.kind, "error");
  assert.notEqual(feedback.text, "Сохранено");
});

test("Тест 16: ошибка создания акции не показывает «Акция создана»", () => {
  const feedback = feedbackFromAck(
    { ok: false, error: "Не удалось создать акцию.", changed: false },
    "Акция создана (выключена). Настройте ниже.",
  );
  assert.equal(feedback.kind, "error");
  assert.ok(!feedback.text.includes("Акция создана"));
});

test("Тест 20: успех показывается только при ok:true; без текста ошибки — fallback", () => {
  const success = feedbackFromAck(
    { ok: true, error: null, changed: true },
    "Сохранено",
  );
  assert.deepEqual(success, { kind: "success", text: "Сохранено" });

  const noText = feedbackFromAck({ ok: false, error: null, changed: false }, "Сохранено");
  assert.equal(noText.kind, "error");
  assert.equal(noText.text, MUTATION_FALLBACK_ERROR);
});

test("Тест 18: add item infrastructure error не превращается в unavailable item", () => {
  const saveFailed = addItemFeedbackMessage("SAVE_FAILED");
  assert.equal(
    saveFailed,
    "Не удалось сохранить изменение. Обновите страницу и повторите.",
  );
  assert.notEqual(saveFailed, addItemFeedbackMessage("NOT_AVAILABLE"));
  assert.equal(
    addItemFeedbackMessage("NOT_AVAILABLE"),
    "Блюдо сейчас недоступно.",
  );
});

test("Тест 19: отсутствие Web Locks показывает правильную ошибку клиенту", () => {
  assert.equal(
    addItemFeedbackMessage("SYNC_UNAVAILABLE"),
    "Безопасная синхронизация вкладок недоступна в этом браузере.",
  );
});

test("Доменные статусы добавления: успех и конфликт ресторана", () => {
  assert.equal(addItemFeedbackMessage("ADDED"), "Блюдо добавлено в корзину.");
  // Конфликт корзины обрабатывается отдельным confirm-диалогом.
  assert.equal(addItemFeedbackMessage("RESTAURANT_CONFLICT"), null);
  assert.ok(
    (addItemFeedbackMessage("RESTAURANT_UNAVAILABLE") ?? "").includes(
      "не принимает заказы",
    ),
  );
});
