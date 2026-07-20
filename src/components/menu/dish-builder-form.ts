// Импорты относительные: модуль проверяется node:test, где alias «@/» не
// резолвится. Типы стираются при стриппинге, значения — нет.
import type {
  MenuItemSubmission,
  MenuItemSubmissionVariant,
  MenuPortion,
  MenuPortionUnit,
  RestaurantOrderWorkflowMode,
  RestaurantWorkspaceRole,
} from "../../prototype/models";
import type { MenuItemSubmissionDraftPatch } from "../../prototype/actions";
import { validateMenuPortion } from "../../prototype/menu-catalog";

/**
 * Чистое ядро конструктора блюда: разбор пользовательского ввода (цена в
 * обычных долларах, порция, варианты) в доменные значения и обратно, плюс
 * навигационный контекст рабочей роли. Без React и DOM — покрывается
 * node-тестами. Домен остаётся авторитетным: эти функции только готовят patch
 * для существующих submission-actions и человеческие ошибки для формы.
 */

// --- Рабочая роль конструктора -----------------------------------------------

/**
 * Реальная роль рабочего экрана, из которого открыт конструктор. URL — только
 * UI-подсказка: в COMBINED роль всегда COMBINED (что бы ни пришло в query), в
 * SPLIT принимаются только явные OPERATOR/KITCHEN. Всё остальное — null:
 * форма fail-closed, ничего не сохраняет и предлагает вернуться в кабинет.
 * Домен затем повторно проверяет право MANAGE_MENU_CATALOG по этой роли.
 */
export function resolveDishBuilderRole(
  mode: RestaurantOrderWorkflowMode,
  rawRole: unknown,
): RestaurantWorkspaceRole | null {
  if (mode === "COMBINED") return "COMBINED";
  return rawRole === "OPERATOR" || rawRole === "KITCHEN" ? rawRole : null;
}

/**
 * Роль полноэкранной страницы «Меню и доступность». Ресторанный кабинет
 * НИКОГДА не работает read-only: OPERATOR, KITCHEN и COMBINED имеют полное
 * право управлять меню, поэтому роль всегда каноническая. Порядок:
 * 1) валидный query-параметр (оператор остаётся оператором);
 * 2) сохранённый workspace-контекст (session-подсказка кабинета);
 * 3) канонический рабочий экран режима: COMBINED — общий экран, SPLIT —
 *    кухня (экран меню SPLIT исторически ведёт кухня).
 * Неизвестный query не уничтожает нормальный контекст — он просто
 * игнорируется. Права всё равно повторно проверяет домен
 * (MANAGE_MENU_CATALOG / CHANGE_MENU_AVAILABILITY) — UI не источник
 * авторизации, но и не место, где авторизованный ресторан теряет кнопки.
 */
export function resolveMenuPageRole(
  mode: RestaurantOrderWorkflowMode,
  queryRole: unknown,
  sessionHint: unknown,
): RestaurantWorkspaceRole {
  if (mode === "COMBINED") return "COMBINED";
  if (queryRole === "OPERATOR" || queryRole === "KITCHEN") return queryRole;
  if (sessionHint === "OPERATOR" || sessionHint === "KITCHEN") {
    return sessionHint;
  }
  return "KITCHEN";
}

/**
 * Возврат «← Назад к меню»: каждый попадает в СВОЙ рабочий кабинет (оператор —
 * к оператору, кухня — на кухню, COMBINED — на общий экран заказов). Хеш #menu
 * автоматически раскрывает панель «Меню и доступность».
 */
export function dishBuilderBackHref(role: RestaurantWorkspaceRole): string {
  return role === "OPERATOR"
    ? "/restaurant/operator#menu"
    : "/restaurant/kitchen#menu";
}

/** Ссылка на новый черновик с сохранением контекста роли. */
export function dishBuilderNewHref(role: RestaurantWorkspaceRole): string {
  return `/restaurant/menu/new?role=${role}`;
}

/** Ссылка на список заявок с сохранением контекста роли. */
export function dishSubmissionsHref(role: RestaurantWorkspaceRole): string {
  return `/restaurant/menu/submissions?role=${role}`;
}

/** Ссылка на конкретную заявку с сохранением контекста роли. */
export function dishSubmissionHref(
  submissionId: string,
  role: RestaurantWorkspaceRole,
): string {
  return `/restaurant/menu/submissions/${submissionId}?role=${role}`;
}

// --- Деньги: доллары в поле ↔ cents в домене -----------------------------------

const MONEY_INPUT_PATTERN = /^\d+(?:[.,]\d{1,2})?$/;

export type MoneyParseResult =
  | { ok: true; cents: number | null }
  | { ok: false; error: string };

/**
 * Разбор денежного поля «12.50» в целые cents. Пользователь никогда не вводит
 * cents. Запятая допускается как разделитель. Отрицательные значения, NaN,
 * Infinity и более двух знаков после точки не проходят сам формат.
 */
export function parseMoneyInput(
  raw: string,
  options: { required: boolean; allowZero: boolean; label: string },
): MoneyParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return options.required
      ? { ok: false, error: `Укажите ${options.label}.` }
      : { ok: true, cents: null };
  }
  if (!MONEY_INPUT_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error: `Введите ${options.label} числом, например 12.50.`,
    };
  }
  const amount = Number(trimmed.replace(",", "."));
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isInteger(cents)) {
    return {
      ok: false,
      error: `Введите ${options.label} числом, например 12.50.`,
    };
  }
  if (!options.allowZero && cents <= 0) {
    return { ok: false, error: "Цена должна быть больше нуля." };
  }
  return { ok: true, cents };
}

/** Цена блюда: обязательна при отправке, больше нуля. */
export function parsePriceInput(raw: string): MoneyParseResult {
  return parseMoneyInput(raw, {
    required: false,
    allowZero: false,
    label: "цену",
  });
}

/** Доплата варианта: необязательна (пусто = 0), неотрицательная. */
export function parseVariantDeltaInput(raw: string): MoneyParseResult {
  const parsed = parseMoneyInput(raw, {
    required: false,
    allowZero: true,
    label: "доплату",
  });
  if (parsed.ok && parsed.cents === null) {
    return { ok: true, cents: 0 };
  }
  return parsed;
}

/** Cents → значение денежного поля («1250» → «12.50»); null → пустое поле. */
export function centsToMoneyInput(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return "";
  return (cents / 100).toFixed(2);
}

// --- Порция --------------------------------------------------------------------

export type PortionParseResult =
  | { ok: true; portion: MenuPortion | null }
  | { ok: false; error: string };

/**
 * Разбор секции «Порция». Пустое количество — порция не указана (null),
 * независимо от выбранной единицы. Указанное количество требует единицу.
 * Числовые правила (больше нуля, целые для г/мл/шт., максимум два знака для
 * см) — те же доменные validateMenuPortion.
 */
export function parsePortionFields(
  valueRaw: string,
  unitRaw: MenuPortionUnit | "",
): PortionParseResult {
  const trimmed = valueRaw.trim();
  if (!trimmed) {
    return { ok: true, portion: null };
  }
  if (!unitRaw) {
    return { ok: false, error: "Выберите единицу порции." };
  }
  const value = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(value)) {
    return { ok: false, error: "Порция должна быть числом." };
  }
  const portion: MenuPortion = { value, unit: unitRaw };
  const domainError = validateMenuPortion(portion);
  if (domainError !== null) {
    return { ok: false, error: domainError };
  }
  return { ok: true, portion };
}

/** Порция → значение поля количества; null → пустое поле. */
export function portionToValueInput(portion: MenuPortion | null): string {
  return portion === null ? "" : String(portion.value);
}

// --- Варианты -------------------------------------------------------------------

/** Строка варианта в форме: все значения — сырой пользовательский ввод. */
export interface DishVariantFormRow {
  /** Стабильный доменный id варианта (сохраняется между правками). */
  id: string;
  name: string;
  deltaInput: string;
  portionValueInput: string;
  portionUnit: MenuPortionUnit | "";
  isDefault: boolean;
}

export type VariantsParseResult =
  | { ok: true; variants: MenuItemSubmissionVariant[] }
  | { ok: false; errors: Record<string, string> };

/**
 * Разбор строк вариантов в доменные MenuItemSubmissionVariant. Ошибки
 * возвращаются по id конкретного варианта — форма показывает их у нужной
 * строки. Уникальность названий проверяется без учёта регистра и пробелов.
 */
export function parseVariantRows(
  rows: readonly DishVariantFormRow[],
): VariantsParseResult {
  const errors: Record<string, string> = {};
  const variants: MenuItemSubmissionVariant[] = [];
  const nameKeys = new Map<string, string>();

  for (const row of rows) {
    const name = row.name.trim();
    if (!name) {
      errors[row.id] = "Укажите название варианта.";
      continue;
    }
    const nameKey = name.toLocaleLowerCase("ru-RU");
    if (nameKeys.has(nameKey)) {
      errors[row.id] = "Названия вариантов не должны повторяться.";
      continue;
    }
    nameKeys.set(nameKey, row.id);

    const delta = parseVariantDeltaInput(row.deltaInput);
    if (!delta.ok) {
      errors[row.id] = delta.error;
      continue;
    }
    const portion = parsePortionFields(row.portionValueInput, row.portionUnit);
    if (!portion.ok) {
      errors[row.id] = portion.error;
      continue;
    }
    variants.push({
      id: row.id,
      name,
      priceDeltaCents: delta.cents ?? 0,
      isDefault: row.isDefault === true,
      portion: portion.portion,
    });
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, variants };
}

/** Доменный вариант → строка формы. */
export function variantToFormRow(
  variant: MenuItemSubmissionVariant,
): DishVariantFormRow {
  return {
    id: variant.id,
    name: variant.name,
    deltaInput: centsToMoneyInput(variant.priceDeltaCents),
    portionValueInput: portionToValueInput(variant.portion),
    portionUnit: variant.portion?.unit ?? "",
    isDefault: variant.isDefault === true,
  };
}

// --- Итоговый patch -------------------------------------------------------------

/** Полное состояние формы конструктора (сырой ввод). */
export interface DishBuilderFormState {
  name: string;
  description: string;
  category: string;
  priceInput: string;
  portionValueInput: string;
  portionUnit: MenuPortionUnit | "";
  imageMediaId: string | null;
  variants: DishVariantFormRow[];
}

export const DISH_NAME_MAX_LENGTH = 120;
export const DISH_DESCRIPTION_MAX_LENGTH = 400;
export const DISH_CATEGORY_MAX_LENGTH = 60;

export interface DishBuilderFieldErrors {
  name?: string;
  price?: string;
  portion?: string;
  variants?: Record<string, string>;
}

export type DishBuilderPatchResult =
  | { ok: true; patch: MenuItemSubmissionDraftPatch }
  | { ok: false; errors: DishBuilderFieldErrors };

/**
 * Сборка patch для существующего updateMenuItemSubmissionDraft. `forSubmit`
 * добавляет требования отправки (непустое название, обязательная цена) — для
 * черновика допустимо частичное заполнение. Ошибки адресные, без технических
 * текстов валидатора.
 */
export function buildDishBuilderPatch(
  form: DishBuilderFormState,
  forSubmit: boolean,
): DishBuilderPatchResult {
  const errors: DishBuilderFieldErrors = {};

  const name = form.name.trim();
  if (forSubmit && !name) {
    errors.name = "Укажите название блюда.";
  }
  if (name.length > DISH_NAME_MAX_LENGTH) {
    errors.name = `Название не длиннее ${DISH_NAME_MAX_LENGTH} символов.`;
  }

  const price = parsePriceInput(form.priceInput);
  let priceCents: number | null = null;
  if (!price.ok) {
    errors.price = price.error;
  } else {
    priceCents = price.cents;
    if (forSubmit && priceCents === null) {
      errors.price = "Укажите цену блюда.";
    }
  }

  const portion = parsePortionFields(form.portionValueInput, form.portionUnit);
  if (!portion.ok) {
    errors.portion = portion.error;
  }

  const variants = parseVariantRows(form.variants);
  if (!variants.ok) {
    errors.variants = variants.errors;
  }

  if (
    errors.name ||
    errors.price ||
    errors.portion ||
    (errors.variants && Object.keys(errors.variants).length > 0)
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    patch: {
      name,
      description: form.description.trim().slice(0, DISH_DESCRIPTION_MAX_LENGTH),
      category: form.category.trim().slice(0, DISH_CATEGORY_MAX_LENGTH),
      priceCents,
      imageMediaId: form.imageMediaId,
      portion: portion.ok ? portion.portion : null,
      variants: variants.ok ? variants.variants : [],
    },
  };
}

/** Заявка → состояние формы (для редактирования существующего черновика). */
export function submissionToFormState(
  submission: MenuItemSubmission,
): DishBuilderFormState {
  return {
    name: submission.name,
    description: submission.description,
    category: submission.category ?? "",
    priceInput: centsToMoneyInput(submission.priceCents),
    portionValueInput: portionToValueInput(submission.portion),
    portionUnit: submission.portion?.unit ?? "",
    imageMediaId: submission.imageMediaId,
    variants: submission.variants.map(variantToFormRow),
  };
}

/** Пустая форма нового блюда. */
export function emptyDishBuilderFormState(): DishBuilderFormState {
  return {
    name: "",
    description: "",
    category: "",
    priceInput: "",
    portionValueInput: "",
    portionUnit: "",
    imageMediaId: null,
    variants: [],
  };
}

// --- Жизненный цикл Blob фотографии --------------------------------------------

/**
 * Какой Blob можно удалить ПОСЛЕ успешного сохранения заявки: прежний
 * сохранённый media id, если сохранение заменило его другим значением (новым id
 * или null). До успеха update ничего не удаляется — заявка продолжает
 * ссылаться на прежнее фото, и при ошибке или уходе со страницы оно обязано
 * остаться рабочим. Вызывающий дополнительно проверяет ссылки через
 * isMenuMediaIdInUse.
 */
export function mediaIdToDeleteAfterSave(
  previousPersistedId: string | null,
  nextPersistedId: string | null,
): string | null {
  return previousPersistedId !== null && previousPersistedId !== nextPersistedId
    ? previousPersistedId
    : null;
}

/**
 * Какой Blob можно удалить при уходе со страницы или замене НЕсохранённого
 * фото: только временный id из формы, который ещё не записан в заявку.
 * Сохранённый media id (на него ссылается заявка) не возвращается никогда.
 */
export function pendingMediaIdToDelete(
  formMediaId: string | null,
  persistedMediaId: string | null,
): string | null {
  return formMediaId !== null && formMediaId !== persistedMediaId
    ? formMediaId
    : null;
}

let variantCounter = 0;

/** Новый вариант формы: первый добавленный становится основным. */
export function createVariantFormRow(isFirst: boolean): DishVariantFormRow {
  variantCounter += 1;
  return {
    id: `variant-${Date.now().toString(36)}-${variantCounter}`,
    name: "",
    deltaInput: "",
    portionValueInput: "",
    portionUnit: "",
    isDefault: isFirst,
  };
}
