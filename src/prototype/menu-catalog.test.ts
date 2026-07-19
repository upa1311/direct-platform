import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPublishedMenuItemFromSubmission,
  effectiveMenuItemVariantPortion,
  formatMenuPortion,
  normalizeOptionalCategory,
  validateMenuItemSubmission,
  validateMenuItemSubmissionVariants,
  validateMenuPortion,
} from "./menu-catalog.ts";
import type {
  MenuItemSubmission,
  MenuItemSubmissionVariant,
  MenuPortion,
} from "./models.ts";

/**
 * Чистое ядро каталога блюд: порция, необязательная категория, валидация заявки
 * и сборка опубликованного блюда. Без state и React.
 */

function submission(patch: Partial<MenuItemSubmission> = {}): MenuItemSubmission {
  return {
    id: "menu-submission-1",
    restaurantId: "restaurant-1",
    status: "DRAFT",
    name: "Паста Карбонара",
    description: "",
    priceCents: 750,
    currencyCode: "USD",
    category: null,
    imageMediaId: null,
    portion: null,
    variants: [],
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    publishedMenuItemId: null,
    reviewHistory: [],
    ...patch,
  };
}

function variant(
  patch: Partial<MenuItemSubmissionVariant> = {},
): MenuItemSubmissionVariant {
  return {
    id: "v1",
    name: "Стандартная",
    priceDeltaCents: 0,
    isDefault: true,
    portion: null,
    ...patch,
  };
}

// 3 — категория ---------------------------------------------------------------

test("категория: произвольная строка разрешена и обрезается", () => {
  for (const value of [
    "Пицца",
    "Суши",
    "Завтраки",
    "Авторские блюда",
    "Напитки",
    "Всё что угодно 123",
  ]) {
    assert.equal(normalizeOptionalCategory(value), value);
  }
  assert.equal(normalizeOptionalCategory("  Пицца  "), "Пицца");
});

test("категория: пустая строка и пробелы превращаются в null", () => {
  assert.equal(normalizeOptionalCategory(""), null);
  assert.equal(normalizeOptionalCategory("   "), null);
  assert.equal(normalizeOptionalCategory(null), null);
  assert.equal(normalizeOptionalCategory(undefined), null);
  assert.equal(normalizeOptionalCategory(42), null);
  // Строку «null» как значение категории не производим.
  assert.notEqual(normalizeOptionalCategory(""), "null");
});

// 5 — корректные порции -------------------------------------------------------

test("порция: null допустима, корректные значения проходят и форматируются", () => {
  assert.equal(validateMenuPortion(null), null);
  assert.equal(formatMenuPortion(null), null);

  const cases: [MenuPortion, string][] = [
    [{ value: 350, unit: "G" }, "350 г"],
    [{ value: 500, unit: "ML" }, "500 мл"],
    [{ value: 6, unit: "PCS" }, "6 шт."],
    [{ value: 30, unit: "CM" }, "30 см"],
    [{ value: 30.5, unit: "CM" }, "30.5 см"],
    [{ value: 30.25, unit: "CM" }, "30.25 см"],
  ];
  for (const [portion, expected] of cases) {
    assert.equal(validateMenuPortion(portion), null, JSON.stringify(portion));
    assert.equal(formatMenuPortion(portion), expected);
  }
});

// 6 — некорректные порции -----------------------------------------------------

test("порция: ноль, отрицательные, NaN и Infinity запрещены", () => {
  for (const value of [0, -1, -350, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const portion = { value, unit: "G" } as MenuPortion;
    assert.notEqual(validateMenuPortion(portion), null, String(value));
    assert.equal(formatMenuPortion(portion), null, String(value));
  }
});

test("порция: дробные G/ML/PCS запрещены", () => {
  for (const unit of ["G", "ML", "PCS"] as const) {
    assert.notEqual(
      validateMenuPortion({ value: 1.5, unit }),
      null,
      `${unit} дробное`,
    );
  }
});

test("порция: у СМ не более двух знаков после запятой", () => {
  assert.equal(validateMenuPortion({ value: 30.25, unit: "CM" }), null);
  assert.notEqual(validateMenuPortion({ value: 30.256, unit: "CM" }), null);
});

test("порция: неизвестная единица измерения запрещена", () => {
  assert.notEqual(
    validateMenuPortion({ value: 10, unit: "KG" } as unknown as MenuPortion),
    null,
  );
});

// Порция варианта -------------------------------------------------------------

test("порция варианта важнее базовой, иначе базовая, иначе null", () => {
  const base: MenuPortion = { value: 350, unit: "G" };
  const own: MenuPortion = { value: 500, unit: "G" };
  assert.deepEqual(effectiveMenuItemVariantPortion(base, own), own);
  assert.deepEqual(effectiveMenuItemVariantPortion(base, null), base);
  assert.equal(effectiveMenuItemVariantPortion(null, null), null);
  assert.deepEqual(effectiveMenuItemVariantPortion(null, own), own);
});

// 8 — обязательные поля заявки ------------------------------------------------

test("заявка: название и цена обязательны, остальное — нет", () => {
  assert.notEqual(validateMenuItemSubmission(submission({ name: "  " })), null);
  assert.notEqual(
    validateMenuItemSubmission(submission({ priceCents: null })),
    null,
  );
  assert.notEqual(validateMenuItemSubmission(submission({ priceCents: 0 })), null);
  assert.notEqual(
    validateMenuItemSubmission(submission({ priceCents: -100 })),
    null,
  );
  assert.notEqual(
    validateMenuItemSubmission(submission({ priceCents: 10.5 })),
    null,
  );
  // Только название и цена: без описания, категории, фото, порции и вариантов.
  assert.equal(
    validateMenuItemSubmission(
      submission({
        description: "",
        category: null,
        imageMediaId: null,
        portion: null,
        variants: [],
      }),
    ),
    null,
  );
});

// 15 — варианты ---------------------------------------------------------------

test("варианты: пустой список разрешён", () => {
  assert.equal(validateMenuItemSubmissionVariants([]), null);
});

test("варианты: ровно один default обязателен при отправке", () => {
  assert.equal(validateMenuItemSubmissionVariants([variant()]), null);
  // Ни одного default.
  assert.notEqual(
    validateMenuItemSubmissionVariants([variant({ isDefault: false })]),
    null,
  );
  // Два default.
  assert.notEqual(
    validateMenuItemSubmissionVariants([
      variant({ id: "v1", name: "A", isDefault: true }),
      variant({ id: "v2", name: "B", isDefault: true }),
    ]),
    null,
  );
});

test("варианты: черновик не требует default, но дубли всё равно запрещены", () => {
  assert.equal(
    validateMenuItemSubmissionVariants([variant({ isDefault: false })], false),
    null,
  );
  assert.notEqual(
    validateMenuItemSubmissionVariants(
      [variant({ id: "v1", name: "A" }), variant({ id: "v1", name: "B", isDefault: false })],
      false,
    ),
    null,
  );
});

test("варианты: дубли id и названий запрещены", () => {
  assert.notEqual(
    validateMenuItemSubmissionVariants([
      variant({ id: "v1", name: "A", isDefault: true }),
      variant({ id: "v1", name: "B", isDefault: false }),
    ]),
    null,
    "дубликат id",
  );
  // Сравнение по trim + регистру.
  assert.notEqual(
    validateMenuItemSubmissionVariants([
      variant({ id: "v1", name: "Большая", isDefault: true }),
      variant({ id: "v2", name: "  большая ", isDefault: false }),
    ]),
    null,
    "дубликат названия",
  );
});

test("варианты: отрицательная и дробная доплата запрещены, ноль разрешён", () => {
  assert.equal(
    validateMenuItemSubmissionVariants([variant({ priceDeltaCents: 0 })]),
    null,
  );
  assert.equal(
    validateMenuItemSubmissionVariants([variant({ priceDeltaCents: 250 })]),
    null,
  );
  assert.notEqual(
    validateMenuItemSubmissionVariants([variant({ priceDeltaCents: -1 })]),
    null,
  );
  assert.notEqual(
    validateMenuItemSubmissionVariants([variant({ priceDeltaCents: 10.5 })]),
    null,
  );
});

test("варианты: пустое название и некорректная порция запрещены", () => {
  assert.notEqual(
    validateMenuItemSubmissionVariants([variant({ name: "   " })]),
    null,
  );
  assert.notEqual(
    validateMenuItemSubmissionVariants([
      variant({ portion: { value: 0, unit: "G" } }),
    ]),
    null,
  );
});

// Публикация ------------------------------------------------------------------

test("публикация копирует поля заявки и делает блюдо доступным", () => {
  const portion: MenuPortion = { value: 350, unit: "G" };
  const source = submission({
    name: "  Паста  ",
    description: "  Сливочный соус  ",
    category: "  Паста  ",
    imageMediaId: "media-1",
    portion,
    priceCents: 900,
    variants: [
      variant({ id: "v1", name: " Стандартная ", isDefault: true }),
      variant({
        id: "v2",
        name: "Большая",
        priceDeltaCents: 250,
        isDefault: false,
        portion: { value: 500, unit: "G" },
      }),
    ],
  });

  const item = buildPublishedMenuItemFromSubmission(source, "menu-item-1");
  assert.equal(item.id, "menu-item-1");
  assert.equal(item.restaurantId, "restaurant-1");
  assert.equal(item.name, "Паста");
  assert.equal(item.description, "Сливочный соус");
  assert.equal(item.category, "Паста");
  assert.equal(item.imageMediaId, "media-1");
  assert.deepEqual(item.portion, portion);
  assert.equal(item.priceCents, 900);
  assert.equal(item.available, true);
  assert.equal(item.availabilityPause, null);
  assert.equal(item.variants?.length, 2);
  assert.equal(item.variants?.[0].name, "Стандартная");
  assert.equal(item.variants?.[0].available, true);
  assert.equal(item.variants?.[0].isDefault, true);
  assert.deepEqual(item.variants?.[1].portion, { value: 500, unit: "G" });
});

test("публикация без фото, категории и вариантов допустима", () => {
  const item = buildPublishedMenuItemFromSubmission(
    submission({ category: "   ", imageMediaId: null, portion: null, variants: [] }),
    "menu-item-2",
  );
  assert.equal(item.category, null);
  assert.equal(item.imageMediaId, null);
  assert.equal(item.portion, null);
  assert.equal(item.variants, undefined, "пустой список вариантов не создаётся");
  assert.equal(item.available, true);
});
