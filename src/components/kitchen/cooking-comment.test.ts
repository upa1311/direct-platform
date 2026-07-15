import assert from "node:assert/strict";
import { test } from "node:test";

import { getVisibleCookingComment } from "./cooking-comment.ts";

test("§13.1: пустой cookingComment не создаёт отображаемый комментарий", () => {
  assert.equal(getVisibleCookingComment(""), null);
});

test("§13.2: строка из пробелов не создаёт отображаемый комментарий", () => {
  assert.equal(getVisibleCookingComment("   \n\t "), null);
});

test("§13.2b: отсутствующий комментарий (старый заказ) даёт null", () => {
  assert.equal(getVisibleCookingComment(undefined), null);
  assert.equal(getVisibleCookingComment(null), null);
});

test("§13.3: «Без лука» отображается после trim", () => {
  assert.equal(getVisibleCookingComment("  Без лука  "), "Без лука");
});

test("§13.4: длинный комментарий не обрезается логически", () => {
  const long =
    "Пожалуйста, не добавляйте острый соус, положите соус отдельно, " +
    "разрежьте пополам и сильнее прожарьте корочку по краям заказа 1234567890";
  assert.equal(getVisibleCookingComment(long), long.trim());
  assert.equal(getVisibleCookingComment(long)?.length, long.trim().length);
});

test("§13.5: комментарий остаётся связан с конкретной позицией", () => {
  const items = [
    { name: "Пицца Маргарита", cookingComment: "Без лука" },
    { name: "Картофель фри", cookingComment: "" },
    { name: "Бургер", cookingComment: "Соус положить отдельно" },
  ];
  const visible = items.map((i) => ({
    name: i.name,
    comment: getVisibleCookingComment(i.cookingComment),
  }));
  assert.equal(visible[0].comment, "Без лука");
  assert.equal(visible[1].comment, null);
  assert.equal(visible[2].comment, "Соус положить отдельно");
});

test("§13.6: состав заказа и cookingComment не мутируются", () => {
  const item = { name: "Бургер", cookingComment: "  Сильнее прожарить  " };
  const snapshot = JSON.stringify(item);
  const out = getVisibleCookingComment(item.cookingComment);
  assert.equal(out, "Сильнее прожарить");
  // Исходное значение не изменено (trim применяется только к результату).
  assert.equal(JSON.stringify(item), snapshot);
  assert.equal(item.cookingComment, "  Сильнее прожарить  ");
});
