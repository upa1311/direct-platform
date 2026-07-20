import type {
  CurrencyCode,
  MenuItem,
  MenuItemSubmission,
  MenuItemSubmissionVariant,
  MenuItemVariant,
  MenuPortion,
  MenuPortionUnit,
} from "./models";

/**
 * Чистое ядро каталога блюд: порция, необязательная категория, валидация заявки
 * и сборка опубликованного MenuItem. Без React, state и мутаций — те же функции
 * пригодны и для backend.
 *
 * Ключевой инвариант: заявка НЕ является опубликованным блюдом. Пока Direct не
 * одобрил её, объект физически отсутствует в menuItems, поэтому в клиентский
 * каталог, корзину, заказ, акции и поиск он попасть не может.
 */

/** Публичные подписи единиц порции. */
export const PORTION_UNIT_LABELS: Record<MenuPortionUnit, string> = {
  G: "г",
  ML: "мл",
  PCS: "шт.",
  CM: "см",
};

/** Единицы, у которых допустимо только целое значение. */
const INTEGER_ONLY_UNITS: ReadonlySet<MenuPortionUnit> = new Set<MenuPortionUnit>(
  ["G", "ML", "PCS"],
);

/** Максимум знаков после запятой для СМ. */
const CM_MAX_DECIMALS = 2;

function isMenuPortionUnit(value: unknown): value is MenuPortionUnit {
  return value === "G" || value === "ML" || value === "PCS" || value === "CM";
}

/** Сколько знаков после запятой у числа (без экспоненциальной записи). */
function decimalPlaces(value: number): number {
  const text = String(value);
  if (text.includes("e") || text.includes("E")) return Number.POSITIVE_INFINITY;
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Категория, которую ресторан придумывает сам. Пустая строка и строка из
 * пробелов — это «без категории», то есть null; глобального enum категорий нет.
 */
export function normalizeOptionalCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Проверка порции. null — валидное значение («порция не указана»). Возвращает
 * русскую ошибку либо null, если всё в порядке.
 */
export function validateMenuPortion(portion: MenuPortion | null): string | null {
  if (portion === null) return null;
  if (typeof portion !== "object") return "Некорректная порция.";
  if (!isMenuPortionUnit(portion.unit)) {
    return "Некорректная единица измерения порции.";
  }
  const { value, unit } = portion;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Порция должна быть числом.";
  }
  if (value <= 0) {
    return "Порция должна быть больше нуля.";
  }
  if (INTEGER_ONLY_UNITS.has(unit) && !Number.isInteger(value)) {
    return "Для этой единицы измерения порция должна быть целым числом.";
  }
  if (unit === "CM" && decimalPlaces(value) > CM_MAX_DECIMALS) {
    return "Для сантиметров допускается не более двух знаков после запятой.";
  }
  return null;
}

/** «350 г», «500 мл», «6 шт.», «30 см»; null — печатать нечего. */
export function formatMenuPortion(portion: MenuPortion | null): string | null {
  if (portion === null) return null;
  if (validateMenuPortion(portion) !== null) return null;
  return `${portion.value} ${PORTION_UNIT_LABELS[portion.unit]}`;
}

/**
 * Действующая порция варианта: собственная порция варианта важнее, иначе
 * используется базовая порция блюда, иначе порции нет. Одно правило в одном
 * месте — оно не размазывается по UI.
 */
export function effectiveMenuItemVariantPortion(
  basePortion: MenuPortion | null,
  variantPortion: MenuPortion | null,
): MenuPortion | null {
  return variantPortion ?? basePortion ?? null;
}

/** Ключ сравнения названий вариантов: trim + приведение регистра. */
function variantNameKey(name: string): string {
  return name.trim().toLocaleLowerCase("ru-RU");
}

/** Корректная цена в копейках: конечное целое больше нуля. */
function validatePriceCents(priceCents: number | null): string | null {
  if (priceCents === null) return "Укажите цену блюда.";
  if (typeof priceCents !== "number" || !Number.isFinite(priceCents)) {
    return "Цена должна быть числом.";
  }
  if (!Number.isInteger(priceCents)) {
    return "Цена должна быть целым числом копеек.";
  }
  if (priceCents <= 0) {
    return "Цена должна быть больше нуля.";
  }
  return null;
}

/**
 * Проверка набора вариантов заявки; null — вариантов нет либо все корректны.
 *
 * `requireDefault` выключается для черновика: пока ресторан набирает варианты,
 * требовать выбранный по умолчанию рано. При отправке на модерацию правило
 * «ровно один default» обязательно.
 */
export function validateMenuItemSubmissionVariants(
  variants: readonly MenuItemSubmissionVariant[],
  requireDefault = true,
): string | null {
  // Пустой список допустим: блюдо без размеров использует базовые цену и порцию.
  if (variants.length === 0) return null;

  const ids = new Set<string>();
  const names = new Set<string>();
  let defaults = 0;

  for (const variant of variants) {
    const id = typeof variant.id === "string" ? variant.id.trim() : "";
    if (!id) return "У варианта отсутствует идентификатор.";
    if (ids.has(id)) return "Идентификаторы вариантов не должны повторяться.";
    ids.add(id);

    const name = typeof variant.name === "string" ? variant.name.trim() : "";
    if (!name) return "Укажите название варианта.";
    const key = variantNameKey(name);
    if (names.has(key)) return "Названия вариантов не должны повторяться.";
    names.add(key);

    const delta = variant.priceDeltaCents;
    if (typeof delta !== "number" || !Number.isFinite(delta)) {
      return "Доплата за вариант должна быть числом.";
    }
    if (!Number.isInteger(delta)) {
      return "Доплата за вариант должна быть целым числом копеек.";
    }
    if (delta < 0) return "Доплата за вариант не может быть отрицательной.";

    const portionError = validateMenuPortion(variant.portion);
    if (portionError !== null) return portionError;

    if (variant.isDefault === true) defaults += 1;
  }

  if (requireDefault && defaults === 0) return "Выберите вариант по умолчанию.";
  if (defaults > 1) return "Вариант по умолчанию должен быть только один.";
  return null;
}

/** Проверка черновика: структура вариантов и порции без требований к отправке. */
export function validateMenuItemSubmissionDraft(
  submission: MenuItemSubmission,
): string | null {
  if (submission.priceCents !== null) {
    const priceError = validatePriceCents(submission.priceCents);
    if (priceError !== null) return priceError;
  }
  const portionError = validateMenuPortion(submission.portion);
  if (portionError !== null) return portionError;
  return validateMenuItemSubmissionVariants(submission.variants, false);
}

/**
 * Полная проверка заявки перед отправкой на модерацию и перед публикацией.
 * Обязательны только непустое название и корректная цена: описание, категория,
 * фотография, порция и варианты необязательны — Direct обязан иметь возможность
 * одобрить блюдо без них.
 */
export function validateMenuItemSubmission(
  submission: MenuItemSubmission,
): string | null {
  const name = typeof submission.name === "string" ? submission.name.trim() : "";
  if (!name) return "Укажите название блюда.";

  const priceError = validatePriceCents(submission.priceCents);
  if (priceError !== null) return priceError;

  const portionError = validateMenuPortion(submission.portion);
  if (portionError !== null) return portionError;

  return validateMenuItemSubmissionVariants(submission.variants);
}

/**
 * Собирает опубликованный MenuItem из одобренной заявки. Вызывается только
 * после успешной валидации: цена здесь уже гарантированно задана. Новое блюдо
 * публикуется доступным и без операционной паузы.
 */
export function buildPublishedMenuItemFromSubmission(
  submission: MenuItemSubmission,
  menuItemId: string,
): MenuItem {
  const variants: MenuItemVariant[] = submission.variants.map((variant) => ({
    id: variant.id,
    name: variant.name.trim(),
    priceDeltaCents: variant.priceDeltaCents,
    available: true,
    isDefault: variant.isDefault === true,
    portion: variant.portion,
  }));

  const item: MenuItem = {
    id: menuItemId,
    restaurantId: submission.restaurantId,
    category: normalizeOptionalCategory(submission.category),
    name: submission.name.trim(),
    description: submission.description.trim(),
    priceCents: submission.priceCents as number,
    currencyCode: submission.currencyCode as CurrencyCode,
    available: true,
    imageMediaId: submission.imageMediaId,
    portion: submission.portion,
    availabilityPause: null,
  };
  // Пустой список вариантов не создаём: блюдо без размеров остаётся без поля.
  return variants.length > 0 ? { ...item, variants } : item;
}
