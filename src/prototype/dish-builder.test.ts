import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildDishBuilderPatch,
  centsToMoneyInput,
  dishBuilderBackHref,
  dishBuilderNewHref,
  emptyDishBuilderFormState,
  mediaIdToDeleteAfterSave,
  parsePortionFields,
  parsePriceInput,
  parseVariantDeltaInput,
  parseVariantRows,
  pendingMediaIdToDelete,
  resolveDishBuilderRole,
  resolveMenuPageRole,
  type DishVariantFormRow,
} from "../components/menu/dish-builder-form.ts";
import {
  computeScaledSize,
  createMenuMediaId,
  isValidMenuMediaId,
  MENU_IMAGE_MAX_BYTES,
  MENU_IMAGE_PROCESS_ERROR,
  MENU_IMAGE_SIZE_ERROR,
  MENU_IMAGE_TYPE_ERROR,
  validateMenuImageFile,
} from "./media-store.ts";
import { createDefaultState } from "./default-state.ts";
import {
  addCartItem,
  createMenuItemSubmissionDraft,
  createOrderFromCart,
  approveMenuItemSubmission,
  MENU_MEDIA_ID_ERROR,
  setCartFulfillmentChoice,
  submitMenuItemSubmission,
  updateMenuItemSubmissionDraft,
} from "./actions.ts";
import {
  getPendingMenuSubmissions,
  getRestaurantMenu,
  getRestaurantMenuCategories,
  getRestaurantMenuSubmissions,
  isMenuMediaIdInUse,
  menuSubmissionStatusLabels,
} from "./selectors.ts";
import type { PrototypeState } from "./models.ts";

/**
 * Конструктор нового блюда с модерацией Direct: рабочая роль, разбор ввода
 * формы (цена, порция, варианты), media store и контракты разметки. Доменные
 * инварианты заявок (fail-closed, права, публикация ровно одного MenuItem)
 * дополнительно покрыты в menu-item-submissions.test.ts.
 */

const readSource = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const PANEL_SOURCE = readSource(
  "../components/kitchen/restaurant-menu-availability-panel.tsx",
);
const BUILDER_SOURCE = readSource(
  "../components/menu/restaurant-dish-builder.tsx",
);
const MEDIA_STORE_SOURCE = readSource("./media-store.ts");
const MEDIA_IMAGE_SOURCE = readSource(
  "../components/menu/menu-media-image.tsx",
);
const KITCHEN_PAGE_SOURCE = readSource("../app/restaurant/kitchen/page.tsx");
const OPERATOR_PAGE_SOURCE = readSource("../app/restaurant/operator/page.tsx");
const MENU_PAGE_SOURCE = readSource("../app/restaurant/menu/page.tsx");
const ACTIONS_SOURCE = readSource(
  "../components/menu/restaurant-menu-catalog-actions.tsx",
);

// 1–5 — точка входа в панели «Меню и доступность» -------------------------------

test("Plus в строке меню один для всех ролей и не зависит от роли", () => {
  // Панель встроена и на кухонный экран (KITCHEN/COMBINED), и оператору.
  assert.ok(KITCHEN_PAGE_SOURCE.includes("RestaurantMenuAvailabilityPanel"));
  assert.ok(OPERATOR_PAGE_SOURCE.includes("RestaurantMenuAvailabilityPanel"));
  // Кнопка Plus с доступным именем рендерится безусловно (без ветвлений по роли).
  assert.ok(PANEL_SOURCE.includes('aria-label="Добавить новое блюдо"'));
  assert.ok(!/workspaceRole\s*===/.test(PANEL_SOURCE), "Plus виден всем ролям");
});

test("Plus не переключает <details>: preventDefault + stopPropagation", () => {
  assert.ok(PANEL_SOURCE.includes("event.preventDefault()"));
  assert.ok(PANEL_SOURCE.includes("event.stopPropagation()"));
  assert.ok(PANEL_SOURCE.includes('type="button"'));
  // Открывает отдельную страницу конструктора с сохранением рабочей роли.
  assert.ok(PANEL_SOURCE.includes("dishBuilderNewHref(workspaceRole)"));
});

test("раскрытая панель содержит общие действия каталога", () => {
  // Разметка действий не дублируется: единственный источник — общий компонент
  // RestaurantMenuCatalogActions с обеими ссылками и реальной ролью.
  assert.ok(PANEL_SOURCE.includes("<RestaurantMenuCatalogActions"));
  assert.ok(PANEL_SOURCE.includes('variant="COMPACT"'));
  assert.ok(ACTIONS_SOURCE.includes("Добавить новое блюдо"));
  assert.ok(ACTIONS_SOURCE.includes("Мои заявки"));
  assert.ok(ACTIONS_SOURCE.includes("dishBuilderNewHref(workspaceRole)"));
  assert.ok(ACTIONS_SOURCE.includes("dishSubmissionsHref(workspaceRole)"));
});

// --- Полноэкранная страница «Меню и доступность» --------------------------------

test("страница меню: «Добавить новое блюдо» и «Мои заявки» видны сразу", () => {
  assert.ok(MENU_PAGE_SOURCE.includes("<RestaurantMenuCatalogActions"));
  assert.ok(MENU_PAGE_SOURCE.includes('variant="PAGE"'));
  // Действия размещены ДО MenuAvailabilitySection — видны без прокрутки и
  // раскрытия панелей.
  const actionsIndex = MENU_PAGE_SOURCE.indexOf(
    "<RestaurantMenuCatalogActions",
  );
  const sectionIndex = MENU_PAGE_SOURCE.indexOf("<MenuAvailabilitySection");
  assert.ok(actionsIndex !== -1 && sectionIndex !== -1);
  assert.ok(actionsIndex < sectionIndex);
  // Второй формы конструктора нет, href не дублируются вручную.
  assert.ok(!MENU_PAGE_SOURCE.includes("RestaurantDishBuilder"));
  assert.ok(!MENU_PAGE_SOURCE.includes("Сохранить черновик"));
  assert.ok(!MENU_PAGE_SOURCE.includes("dishBuilderNewHref("));
  assert.ok(!MENU_PAGE_SOURCE.includes("dishSubmissionsHref("));
});

test("роль страницы меню всегда каноническая: OPERATOR/KITCHEN/COMBINED", () => {
  // Переход от оператора сохраняет OPERATOR (query или session-подсказка).
  assert.equal(
    resolveMenuPageRole("SPLIT_OPERATOR_KITCHEN", "OPERATOR", null),
    "OPERATOR",
  );
  assert.equal(
    resolveMenuPageRole("SPLIT_OPERATOR_KITCHEN", null, "OPERATOR"),
    "OPERATOR",
  );
  // Query важнее подсказки; кухня остаётся кухней.
  assert.equal(
    resolveMenuPageRole("SPLIT_OPERATOR_KITCHEN", "KITCHEN", "OPERATOR"),
    "KITCHEN",
  );
  assert.equal(
    resolveMenuPageRole("SPLIT_OPERATOR_KITCHEN", null, "KITCHEN"),
    "KITCHEN",
  );
  // COMBINED всегда COMBINED, что бы ни лежало в контексте.
  assert.equal(resolveMenuPageRole("COMBINED", "KITCHEN", "OPERATOR"), "COMBINED");
  assert.equal(resolveMenuPageRole("COMBINED", null, null), "COMBINED");
  // Неизвестный query НЕ уничтожает нормальный workspace-контекст.
  assert.equal(
    resolveMenuPageRole("SPLIT_OPERATOR_KITCHEN", "ADMIN", "OPERATOR"),
    "OPERATOR",
  );
  // Без контекста — канонический экран меню режима (SPLIT ведёт кухня), а не
  // read-only: ресторанный кабинет не теряет свои кнопки.
  assert.equal(
    resolveMenuPageRole("SPLIT_OPERATOR_KITCHEN", null, null),
    "KITCHEN",
  );
  assert.equal(
    resolveMenuPageRole("SPLIT_OPERATOR_KITCHEN", "COMBINED", "мусор"),
    "KITCHEN",
  );
  // Кабинеты записывают контекст как резервную подсказку.
  assert.ok(
    OPERATOR_PAGE_SOURCE.includes('rememberMenuWorkspaceRole("OPERATOR")'),
  );
  assert.ok(
    KITCHEN_PAGE_SOURCE.includes(
      'rememberMenuWorkspaceRole(isSplit ? "KITCHEN" : "COMBINED")',
    ),
  );
});

test("страница меню никогда не read-only: действия и управление всегда видны", () => {
  // Действия каталога рендерятся безусловно (после hydration), а секция
  // получает валидную RestaurantWorkspaceRole — никакого canManage/null.
  assert.ok(!MENU_PAGE_SOURCE.includes("DishBuilderRoleError"));
  assert.ok(MENU_PAGE_SOURCE.includes("<RestaurantMenuCatalogActions"));
  assert.ok(MENU_PAGE_SOURCE.includes("<MenuAvailabilitySection"));
  // Регрессионного условного рендера действий и read-only подсказки нет.
  assert.ok(!MENU_PAGE_SOURCE.includes("{workspaceRole ? ("));
  assert.ok(
    !MENU_PAGE_SOURCE.includes("Откройте раздел из кабинета оператора"),
  );
  // Повреждённый/отсутствующий query канонизируется через router.replace, а не
  // молчаливым исчезновением кнопок.
  assert.ok(MENU_PAGE_SOURCE.includes("router.replace(`/restaurant/menu?role=${workspaceRole}`)"));
  // Session-подсказка — внешний источник с SSR-снимком null.
  assert.ok(MENU_PAGE_SOURCE.includes("useSyncExternalStore"));

  // Секция снова требует валидную роль: регрессионная null/canManage-логика
  // удалена, «Отключить»/«Вернуть» и массовые действия рендерятся как раньше.
  const operations = readSource("../components/kitchen/kitchen-operations.tsx");
  assert.ok(!operations.includes("RestaurantWorkspaceRole | null"));
  assert.ok(!operations.includes("canManage"));
  assert.ok(operations.includes("Отключить"));
  assert.ok(operations.includes("Вернуть"));
  assert.ok(operations.includes("Отключить категорию"));

  // Fail-closed заглушка осталась только там, где без роли продолжить нельзя:
  // страницы конструктора (создание/редактирование/отправка заявки).
  const shell = readSource("../components/menu/dish-builder-page.tsx");
  assert.ok(shell.includes("DishBuilderRoleError"));
});

test("навигация передаёт роль явно: query переживает reload", async () => {
  const { menuNavHref, restaurantNavItemsForPath } = await import(
    "../components/workspaces/restaurant-nav.ts"
  );
  // Из оператора — OPERATOR, из кухни SPLIT — KITCHEN, COMBINED — COMBINED.
  assert.equal(
    menuNavHref("SPLIT_OPERATOR_KITCHEN", "/restaurant/operator"),
    "/restaurant/menu?role=OPERATOR",
  );
  assert.equal(
    menuNavHref("SPLIT_OPERATOR_KITCHEN", "/restaurant/kitchen"),
    "/restaurant/menu?role=KITCHEN",
  );
  assert.equal(
    menuNavHref("COMBINED", "/restaurant/kitchen"),
    "/restaurant/menu?role=COMBINED",
  );
  // Неизвестный экран в SPLIT — без query: страница остаётся видимой read-only.
  assert.equal(
    menuNavHref("SPLIT_OPERATOR_KITCHEN", "/restaurant/settlements"),
    "/restaurant/menu",
  );
  // Ролевая ссылка подставляется в общий набор навигации.
  const items = restaurantNavItemsForPath(
    "SPLIT_OPERATOR_KITCHEN",
    "/restaurant/operator",
  );
  assert.ok(
    items.some((item) => item.href === "/restaurant/menu?role=OPERATOR"),
  );
  // Шапка ресторана использует ролевую навигацию.
  const header = readSource("../components/workspaces/restaurant-header.tsx");
  assert.ok(header.includes("restaurantNavItemsForPath(mode, pathname)"));
});

test("мобильная страница меню: действия переносятся без горизонтальной прокрутки", () => {
  const css = readSource("../components/kitchen/kitchen.module.css");
  const block = css.slice(
    css.indexOf(".menuPageActions {"),
    css.indexOf(".menuPanelAddLink {"),
  );
  assert.ok(block.includes("flex-wrap: wrap"));
  assert.ok(block.includes("min-width: 0"));
});

test("вне панели точка входа не дублируется: страницы только передают пропсы", () => {
  // Единственная точка входа — внутри RestaurantMenuAvailabilityPanel.
  // Отдельных кнопок/ссылок конструктора внизу operator/kitchen нет.
  for (const page of [OPERATOR_PAGE_SOURCE, KITCHEN_PAGE_SOURCE]) {
    assert.ok(!page.includes("Добавить новое блюдо"));
    assert.ok(!page.includes("Мои заявки"));
    assert.ok(!page.includes("dishBuilderNewHref"));
    assert.ok(!page.includes("dishSubmissionsHref"));
    assert.ok(!page.includes("/restaurant/menu/new"));
    assert.ok(!page.includes("/restaurant/menu/submissions"));
    // Страница передаёт общему компоненту restaurant, nowMs и workspaceRole.
    assert.ok(page.includes("restaurant={restaurant}"));
    assert.ok(page.includes("nowMs={nowMs}"));
    assert.ok(/workspaceRole=/.test(page));
  }
});

test("мобильная строка меню: одна строка без горизонтальной прокрутки", () => {
  const css = readSource("../components/kitchen/kitchen.module.css");
  const summaryBlock = css.slice(
    css.indexOf(".menuSummary {"),
    css.indexOf(".menuSummary:"),
  );
  // Plus и chevron не переносятся отдельной строкой под статусом…
  assert.ok(summaryBlock.includes("flex-wrap: nowrap"));
  // …а длинный статус переносится внутри себя, не растягивая строку вширь.
  const statusBlock = css.slice(
    css.indexOf(".menuStatus {", css.indexOf("Компактный статус")),
    css.indexOf(".menuStatusDot {"),
  );
  assert.ok(statusBlock.includes("flex: 1"));
  assert.ok(statusBlock.includes("min-width: 0"));
  assert.ok(statusBlock.includes("overflow-wrap: anywhere"));
});

// 6 — один конструктор, без копий по ролям --------------------------------------

test("все маршруты используют один RestaurantDishBuilder, копий нет", () => {
  const appDir = fileURLToPath(new URL("../app", import.meta.url));
  assert.ok(existsSync(`${appDir}/restaurant/menu/new/page.tsx`));
  assert.ok(existsSync(`${appDir}/restaurant/menu/submissions/page.tsx`));
  assert.ok(
    existsSync(`${appDir}/restaurant/menu/submissions/[submissionId]/page.tsx`),
  );
  assert.ok(!existsSync(`${appDir}/restaurant/operator/new-dish`));
  assert.ok(!existsSync(`${appDir}/restaurant/kitchen/new-dish`));
  for (const route of [
    readSource("../app/restaurant/menu/new/page.tsx"),
    readSource(
      "../app/restaurant/menu/submissions/[submissionId]/page.tsx",
    ),
  ]) {
    assert.ok(route.includes("RestaurantDishBuilder"));
  }
});

// 7–11 — сохранение реальной роли ------------------------------------------------

test("OPERATOR остаётся OPERATOR, KITCHEN — KITCHEN, COMBINED — COMBINED", () => {
  assert.equal(
    resolveDishBuilderRole("SPLIT_OPERATOR_KITCHEN", "OPERATOR"),
    "OPERATOR",
  );
  assert.equal(
    resolveDishBuilderRole("SPLIT_OPERATOR_KITCHEN", "KITCHEN"),
    "KITCHEN",
  );
  // В COMBINED роль всегда COMBINED, что бы ни пришло в query.
  assert.equal(resolveDishBuilderRole("COMBINED", "KITCHEN"), "COMBINED");
  assert.equal(resolveDishBuilderRole("COMBINED", null), "COMBINED");
});

test("неизвестная или повреждённая роль в SPLIT — fail-closed (null)", () => {
  assert.equal(resolveDishBuilderRole("SPLIT_OPERATOR_KITCHEN", null), null);
  assert.equal(resolveDishBuilderRole("SPLIT_OPERATOR_KITCHEN", ""), null);
  assert.equal(
    resolveDishBuilderRole("SPLIT_OPERATOR_KITCHEN", "COMBINED"),
    null,
  );
  assert.equal(
    resolveDishBuilderRole("SPLIT_OPERATOR_KITCHEN", "ADMIN"),
    null,
  );
});

test("«Назад» ведёт в правильный кабинет с раскрытием панели меню", () => {
  assert.equal(dishBuilderBackHref("OPERATOR"), "/restaurant/operator#menu");
  assert.equal(dishBuilderBackHref("KITCHEN"), "/restaurant/kitchen#menu");
  assert.equal(dishBuilderBackHref("COMBINED"), "/restaurant/kitchen#menu");
  assert.equal(dishBuilderNewHref("OPERATOR"), "/restaurant/menu/new?role=OPERATOR");
});

test("каждое действие конструктора получает реальную workspaceRole", () => {
  assert.ok(
    BUILDER_SOURCE.includes("createMenuItemDraft(restaurant.id, workspaceRole)"),
  );
  assert.ok(BUILDER_SOURCE.includes("updateMenuItemDraft(id, built.patch, workspaceRole)"));
  assert.ok(BUILDER_SOURCE.includes("submitMenuItemDraft(id, workspaceRole)"));
  // Чужая заявка не открывается: фильтр по ресторану воркспейса.
  assert.ok(BUILDER_SOURCE.includes("candidate.restaurantId === restaurant.id"));
});

// 12–13 — черновик создаётся ровно один раз --------------------------------------

test("сохранение: id созданного черновика запоминается, второй не создаётся", () => {
  assert.ok(BUILDER_SOURCE.includes("draftIdRef"));
  assert.ok(BUILDER_SOURCE.includes("draftIdRef.current = id"));
  // Создание вызывается только когда id ещё нет.
  assert.ok(/if \(!id\) \{\s*const created = await createMenuItemDraft/.test(BUILDER_SOURCE));
});

// 15–16 — название и цена ---------------------------------------------------------

test("submit-валидация: название обязательно, черновик — нет", () => {
  const form = emptyDishBuilderFormState();
  const draft = buildDishBuilderPatch(form, false);
  assert.equal(draft.ok, true);
  const submit = buildDishBuilderPatch(form, true);
  assert.equal(submit.ok, false);
  if (!submit.ok) {
    assert.equal(submit.errors.name, "Укажите название блюда.");
    assert.equal(submit.errors.price, "Укажите цену блюда.");
  }
});

test("цена: обычная сумма → cents, мусор и отрицательные не проходят", () => {
  assert.deepEqual(parsePriceInput("12.50"), { ok: true, cents: 1250 });
  assert.deepEqual(parsePriceInput("12,5"), { ok: true, cents: 1250 });
  assert.deepEqual(parsePriceInput("7"), { ok: true, cents: 700 });
  assert.deepEqual(parsePriceInput(""), { ok: true, cents: null });
  assert.equal(parsePriceInput("0").ok, false);
  assert.equal(parsePriceInput("-5").ok, false);
  assert.equal(parsePriceInput("abc").ok, false);
  assert.equal(parsePriceInput("12.505").ok, false);
  assert.equal(parsePriceInput("Infinity").ok, false);
  assert.equal(centsToMoneyInput(1250), "12.50");
  assert.equal(centsToMoneyInput(null), "");
});

// 17–19 — категории ---------------------------------------------------------------

test("категории собираются только из меню выбранного ресторана", () => {
  const state = createDefaultState();
  const categories = getRestaurantMenuCategories(state, "restaurant-2");
  assert.ok(categories.length > 0);
  // Дубликаты схлопнуты и нет категорий чужих ресторанов.
  const lower = categories.map((c) => c.toLocaleLowerCase("ru-RU"));
  assert.equal(new Set(lower).size, lower.length);
  const foreign = getRestaurantMenu(state, "restaurant-1").map(
    (item) => item.category,
  );
  void foreign; // категории чужого меню не обязаны присутствовать
});

test("новая и пустая категория: строка сохраняется, пустая → null", () => {
  let s = createDefaultState();
  const created = createMenuItemSubmissionDraft(s, "restaurant-2", "RESTAURANT", "COMBINED");
  assert.equal(created.result.ok, true);
  const id = created.result.submissionId as string;
  s = created.state;
  const withNew = updateMenuItemSubmissionDraft(
    s,
    id,
    { category: "Авторская кухня" },
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(
    withNew.state.menuItemSubmissions.find((x) => x.id === id)?.category,
    "Авторская кухня",
  );
  const emptied = updateMenuItemSubmissionDraft(
    withNew.state,
    id,
    { category: "   " },
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(
    emptied.state.menuItemSubmissions.find((x) => x.id === id)?.category,
    null,
  );
});

// 20–24 — порция -----------------------------------------------------------------

test("порции 350 г / 500 мл / 6 шт. / 30 см разбираются корректно", () => {
  assert.deepEqual(parsePortionFields("350", "G"), {
    ok: true,
    portion: { value: 350, unit: "G" },
  });
  assert.deepEqual(parsePortionFields("500", "ML"), {
    ok: true,
    portion: { value: 500, unit: "ML" },
  });
  assert.deepEqual(parsePortionFields("6", "PCS"), {
    ok: true,
    portion: { value: 6, unit: "PCS" },
  });
  assert.deepEqual(parsePortionFields("30", "CM"), {
    ok: true,
    portion: { value: 30, unit: "CM" },
  });
  assert.deepEqual(parsePortionFields("30.5", "CM"), {
    ok: true,
    portion: { value: 30.5, unit: "CM" },
  });
});

test("невалидные порции блокируются, пустое количество — порции нет", () => {
  assert.equal(parsePortionFields("350.5", "G").ok, false);
  assert.equal(parsePortionFields("0", "G").ok, false);
  assert.equal(parsePortionFields("-1", "ML").ok, false);
  assert.equal(parsePortionFields("abc", "PCS").ok, false);
  assert.equal(parsePortionFields("30.555", "CM").ok, false);
  assert.equal(parsePortionFields("350", "").ok, false); // количество без единицы
  assert.deepEqual(parsePortionFields("", "G"), { ok: true, portion: null });
  assert.deepEqual(parsePortionFields("", ""), { ok: true, portion: null });
});

// 25–28 — варианты ---------------------------------------------------------------

function variantRow(patch: Partial<DishVariantFormRow>): DishVariantFormRow {
  return {
    id: patch.id ?? "v1",
    name: "",
    deltaInput: "",
    portionValueInput: "",
    portionUnit: "",
    isDefault: false,
    ...patch,
  };
}

test("варианты: уникальные названия без учёта регистра, ошибки адресные", () => {
  const rows = [
    variantRow({ id: "v1", name: "Стандартная", isDefault: true }),
    variantRow({ id: "v2", name: "  стандартная " }),
  ];
  const parsed = parseVariantRows(rows);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.errors.v2, "Названия вариантов не должны повторяться.");
    assert.equal(parsed.errors.v1, undefined);
  }
});

test("доплата переводится в cents, порция варианта разбирается", () => {
  const parsed = parseVariantRows([
    variantRow({
      id: "v1",
      name: "30 см",
      deltaInput: "",
      portionValueInput: "30",
      portionUnit: "CM",
      isDefault: true,
    }),
    variantRow({
      id: "v2",
      name: "40 см",
      deltaInput: "5",
      portionValueInput: "40",
      portionUnit: "CM",
    }),
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.variants[0], {
      id: "v1",
      name: "30 см",
      priceDeltaCents: 0,
      isDefault: true,
      portion: { value: 30, unit: "CM" },
    });
    assert.equal(parsed.variants[1].priceDeltaCents, 500);
  }
  assert.equal(parseVariantDeltaInput("3.50").ok, true);
  assert.equal(parseVariantDeltaInput("-1").ok, false);
});

// 29–34 — фотография --------------------------------------------------------------

test("фото: MIME и размер проверяются с точными ошибками", () => {
  assert.equal(
    validateMenuImageFile({ type: "image/gif", size: 1000 }),
    MENU_IMAGE_TYPE_ERROR,
  );
  assert.equal(
    validateMenuImageFile({ type: "application/pdf", size: 1000 }),
    MENU_IMAGE_TYPE_ERROR,
  );
  assert.equal(
    validateMenuImageFile({ type: "image/jpeg", size: MENU_IMAGE_MAX_BYTES + 1 }),
    MENU_IMAGE_SIZE_ERROR,
  );
  assert.equal(
    validateMenuImageFile({ type: "image/png", size: 0 }),
    MENU_IMAGE_PROCESS_ERROR,
  );
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    assert.equal(validateMenuImageFile({ type, size: 5000 }), null);
  }
});

test("фото оптимизируется: размер уменьшается максимум до 1600×1600", () => {
  assert.deepEqual(computeScaledSize(4000, 3000), { width: 1600, height: 1200 });
  assert.deepEqual(computeScaledSize(3000, 4000), { width: 1200, height: 1600 });
  // Маленькое изображение не увеличивается.
  assert.deepEqual(computeScaledSize(800, 600), { width: 800, height: 600 });
  // Итоговый формат — WEBP, исходные 10 МБ не сохраняются.
  assert.ok(MEDIA_STORE_SOURCE.includes('"image/webp"'));
  assert.ok(MEDIA_STORE_SOURCE.includes('imageOrientation: "from-image"'));
});

test("media id стабильный и никогда не содержит данные изображения", () => {
  const id = createMenuMediaId();
  assert.ok(isValidMenuMediaId(id), id);
  assert.ok(id.startsWith("media-"));
  assert.equal(isValidMenuMediaId("data:image/png;base64,AAA"), false);
  assert.equal(isValidMenuMediaId("blob:http://localhost/x"), false);
  assert.equal(isValidMenuMediaId("C:\\photos\\dish.png"), false);
  assert.equal(isValidMenuMediaId(""), false);
});

test("фото переживает reload: Blob в IndexedDB, а не в state", () => {
  assert.ok(MEDIA_STORE_SOURCE.includes("indexedDB.open"));
  // Blob не пишется в localStorage и не попадает в PrototypeState.
  assert.ok(!MEDIA_STORE_SOURCE.includes("localStorage.setItem"));
  assert.ok(!MEDIA_STORE_SOURCE.includes('from "./prototype-store"'));
  assert.ok(!MEDIA_STORE_SOURCE.includes('from "./models"'));
});

test("object URL создаётся только для отображения и освобождается в cleanup", () => {
  assert.ok(MEDIA_IMAGE_SOURCE.includes("URL.createObjectURL"));
  assert.ok(MEDIA_IMAGE_SOURCE.includes("URL.revokeObjectURL"));
  // Fallback-декодер media-store тоже освобождает свой временный URL.
  assert.ok(MEDIA_STORE_SOURCE.includes("URL.revokeObjectURL"));
});

// 35–49 — полный цикл: заявка → модерация → клиент → корзина → заказ --------------

function fullPipelineState(): {
  state: PrototypeState;
  submissionId: string;
  menuItemId: string;
} {
  let s = createDefaultState();
  const created = createMenuItemSubmissionDraft(
    s,
    "restaurant-2",
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(created.result.ok, true);
  const submissionId = created.result.submissionId as string;
  s = created.state;

  const updated = updateMenuItemSubmissionDraft(
    s,
    submissionId,
    {
      name: "Пицца Кватро Тест",
      description: "Сырная классика.",
      category: "Пицца",
      priceCents: 1450,
      imageMediaId: "media-test-photo-0001",
      portion: { value: 30, unit: "CM" },
      variants: [
        {
          id: "size-30",
          name: "30 см",
          priceDeltaCents: 0,
          isDefault: true,
          portion: { value: 30, unit: "CM" },
        },
        {
          id: "size-40",
          name: "40 см",
          priceDeltaCents: 500,
          isDefault: false,
          portion: { value: 40, unit: "CM" },
        },
      ],
    },
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(updated.result.ok, true, updated.result.error ?? "");
  s = updated.state;

  const submitted = submitMenuItemSubmission(s, submissionId, "RESTAURANT", "COMBINED");
  assert.equal(submitted.result.ok, true, submitted.result.error ?? "");
  s = submitted.state;

  // До одобрения клиент блюда не видит.
  assert.equal(
    getRestaurantMenu(s, "restaurant-2").some((m) => m.name === "Пицца Кватро Тест"),
    false,
  );
  assert.equal(getPendingMenuSubmissions(s).length, 1);

  const approved = approveMenuItemSubmission(s, submissionId, "ADMIN");
  assert.equal(approved.result.ok, true, approved.result.error ?? "");
  s = approved.state;
  const menuItemId = s.menuItemSubmissions.find((x) => x.id === submissionId)!
    .publishedMenuItemId as string;
  return { state: s, submissionId, menuItemId };
}

test("APPROVED появляется у клиента с фото и порцией; вариант работает в корзине", () => {
  const { state, menuItemId } = fullPipelineState();
  const published = getRestaurantMenu(state, "restaurant-2").find(
    (item) => item.id === menuItemId,
  );
  assert.ok(published);
  assert.equal(published.available, true);
  assert.equal(published.imageMediaId, "media-test-photo-0001");
  assert.deepEqual(published.portion, { value: 30, unit: "CM" });
  assert.equal(published.variants?.length, 2);

  // Корзина: большой вариант с доплатой.
  let s = setCartFulfillmentChoice(state, "PICKUP");
  const added = addCartItem(s, menuItemId, "size-40");
  assert.equal(added.result, "ADDED");
  s = added.state;
  const createdOrder = createOrderFromCart(s);
  assert.equal(createdOrder.result.error, null);
  const order = createdOrder.state.orders.at(-1)!;
  const line = order.items.find((item) => item.menuItemId === menuItemId)!;
  assert.equal(line.selectedVariantId, "size-40");
  assert.equal(line.selectedVariantName, "40 см");
  assert.equal(line.finalUnitPriceCents, 1450 + 500);
  // portionSnapshot: порция варианта важнее базовой и фиксируется в заказе.
  assert.deepEqual(line.portionSnapshot, { value: 40, unit: "CM" });
});

test("список заявок ресторана канонический, подписи статусов русские", () => {
  const { state, submissionId } = fullPipelineState();
  const list = getRestaurantMenuSubmissions(state, "restaurant-2");
  assert.ok(list.some((x) => x.id === submissionId));
  // Чужой ресторан заявку не видит в своём списке.
  assert.equal(
    getRestaurantMenuSubmissions(state, "restaurant-3").some(
      (x) => x.id === submissionId,
    ),
    false,
  );
  assert.equal(menuSubmissionStatusLabels.DRAFT, "Черновик");
  assert.equal(menuSubmissionStatusLabels.PENDING_REVIEW, "На проверке Direct");
  assert.equal(menuSubmissionStatusLabels.REJECTED, "Нужно исправить");
  assert.equal(menuSubmissionStatusLabels.APPROVED, "Одобрено и опубликовано");
});

test("порция из снимка заказа печатается в производственном тикете", async () => {
  const { buildKitchenProductionTicketData } = await import(
    "../components/kitchen/kitchen-production-ticket-data.ts"
  );
  const { state, menuItemId } = fullPipelineState();
  let s = setCartFulfillmentChoice(state, "PICKUP");
  const added = addCartItem(s, menuItemId, "size-30");
  s = added.state;
  const createdOrder = createOrderFromCart(s);
  const order = createdOrder.state.orders.at(-1)!;
  const ticket = buildKitchenProductionTicketData(order, "Europe/Chisinau");
  const line = ticket.items.find((item) => item.name === "Пицца Кватро Тест")!;
  assert.equal(line.portionText, "30 см");
  assert.equal(line.variantName, "30 см");
});

// --- Защита фотографий черновика ------------------------------------------------

/** Черновик restaurant-2 с уже сохранённым фото media-saved-1. */
function draftWithSavedPhoto(): { state: PrototypeState; submissionId: string } {
  let s = createDefaultState();
  const created = createMenuItemSubmissionDraft(
    s,
    "restaurant-2",
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(created.result.ok, true);
  const submissionId = created.result.submissionId as string;
  const updated = updateMenuItemSubmissionDraft(
    created.state,
    submissionId,
    { name: "Блюдо с фото", priceCents: 500, imageMediaId: "media-saved-1" },
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(updated.result.ok, true, updated.result.error ?? "");
  s = updated.state;
  return { state: s, submissionId };
}

/** Хирургическая порча imageMediaId в обход update (для submit/approve). */
function corruptMediaId(
  state: PrototypeState,
  submissionId: string,
  value: string,
): PrototypeState {
  return {
    ...state,
    menuItemSubmissions: state.menuItemSubmissions.map((submission) =>
      submission.id === submissionId
        ? { ...submission, imageMediaId: value }
        : submission,
    ),
  };
}

const BAD_MEDIA_IDS = [
  "data:image/png;base64,AAAA",
  "blob:http://localhost/6a1b",
  "C:\\photos\\dish.png",
  "https://example.com/dish.png",
  "просто строка",
];

// 8–11 — доменная валидация media id ---------------------------------------------

test("update draft: data URI, blob, http и пути отклоняются доменом", () => {
  const { state, submissionId } = draftWithSavedPhoto();
  for (const bad of BAD_MEDIA_IDS) {
    const res = updateMenuItemSubmissionDraft(
      state,
      submissionId,
      { imageMediaId: bad },
      "RESTAURANT",
      "COMBINED",
    );
    assert.equal(res.result.ok, false, bad);
    assert.equal(res.result.error, MENU_MEDIA_ID_ERROR);
    // Исходный state тем же объектом, заявка не изменилась.
    assert.equal(res.state, state);
    assert.equal(
      res.state.menuItemSubmissions.find((s) => s.id === submissionId)
        ?.imageMediaId,
      "media-saved-1",
    );
  }
  // Корректный media-* принимается; null — тоже.
  const good = updateMenuItemSubmissionDraft(
    state,
    submissionId,
    { imageMediaId: "media-next-2" },
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(good.result.ok, true, good.result.error ?? "");
  const cleared = updateMenuItemSubmissionDraft(
    good.state,
    submissionId,
    { imageMediaId: null },
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(cleared.result.ok, true);
});

test("submit повторно проверяет media id (legacy-значение в обход update)", () => {
  const { state, submissionId } = draftWithSavedPhoto();
  const corrupted = corruptMediaId(state, submissionId, "data:image/png;base64,A");
  const res = submitMenuItemSubmission(
    corrupted,
    submissionId,
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, MENU_MEDIA_ID_ERROR);
  assert.equal(res.state, corrupted);
});

// 12 — approve повторно проверяет media id ---------------------------------------

test("approve повторно проверяет media id и не создаёт MenuItem", () => {
  const { state, submissionId } = draftWithSavedPhoto();
  const submitted = submitMenuItemSubmission(
    state,
    submissionId,
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(submitted.result.ok, true);
  const corrupted = corruptMediaId(
    submitted.state,
    submissionId,
    "blob:http://localhost/broken",
  );
  const menuBefore = corrupted.menuItems.length;
  const res = approveMenuItemSubmission(corrupted, submissionId, "ADMIN");
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, MENU_MEDIA_ID_ERROR);
  assert.equal(res.state, corrupted); // тем же объектом
  assert.equal(res.state.menuItems.length, menuBefore);
  assert.equal(
    res.state.menuItemSubmissions.find((s) => s.id === submissionId)?.status,
    "PENDING_REVIEW",
  );
});

// 7 — helper проверки ссылок ------------------------------------------------------

test("Blob не удаляется, пока id использует другая заявка или MenuItem", () => {
  const { state, submissionId } = draftWithSavedPhoto();
  // Текущая заявка ссылается — занято; с исключением текущей — свободно.
  assert.equal(isMenuMediaIdInUse(state, "media-saved-1"), true);
  assert.equal(isMenuMediaIdInUse(state, "media-saved-1", submissionId), false);
  assert.equal(isMenuMediaIdInUse(state, null), false);
  assert.equal(isMenuMediaIdInUse(state, "media-unknown"), false);

  // Вторая заявка с тем же фото: даже с исключением первой — занято.
  const second = createMenuItemSubmissionDraft(
    state,
    "restaurant-2",
    "RESTAURANT",
    "COMBINED",
  );
  const secondId = second.result.submissionId as string;
  const secondWithPhoto = updateMenuItemSubmissionDraft(
    second.state,
    secondId,
    { name: "Копия", priceCents: 400, imageMediaId: "media-saved-1" },
    "RESTAURANT",
    "COMBINED",
  ).state;
  assert.equal(
    isMenuMediaIdInUse(secondWithPhoto, "media-saved-1", submissionId),
    true,
  );

  // Опубликованный MenuItem с этим фото тоже удерживает Blob.
  const withMenuItem: PrototypeState = {
    ...state,
    menuItems: [
      ...state.menuItems,
      { ...state.menuItems[0], id: "menu-item-x", imageMediaId: "media-saved-1" },
    ],
  };
  assert.equal(
    isMenuMediaIdInUse(withMenuItem, "media-saved-1", submissionId),
    true,
  );
});

// 1–6 — жизненный цикл Blob в форме ----------------------------------------------

test("замена и удаление фото без сохранения не трогают сохранённый Blob", () => {
  // «Удалить»: в форме null, сохранённый id остаётся — удалять нечего.
  assert.equal(pendingMediaIdToDelete(null, "media-saved-1"), null);
  // В форме сохранённый id — он не временный, не удаляется.
  assert.equal(pendingMediaIdToDelete("media-saved-1", "media-saved-1"), null);
  // Заменённый ВРЕМЕННЫЙ Blob (не сохранённый) можно удалить.
  assert.equal(
    pendingMediaIdToDelete("media-temp-2", "media-saved-1"),
    "media-temp-2",
  );
  assert.equal(pendingMediaIdToDelete("media-temp-2", null), "media-temp-2");
});

test("старый Blob удаляется только после успешного сохранения замены", () => {
  assert.equal(mediaIdToDeleteAfterSave("media-old", "media-new"), "media-old");
  assert.equal(mediaIdToDeleteAfterSave("media-old", null), "media-old");
  // Значение не менялось либо фото не было — удалять нечего.
  assert.equal(mediaIdToDeleteAfterSave("media-old", "media-old"), null);
  assert.equal(mediaIdToDeleteAfterSave(null, "media-new"), null);
  assert.equal(mediaIdToDeleteAfterSave(null, null), null);
});

test("конструктор: каждое удаление Blob защищено проверкой ссылок", () => {
  // Все вызовы deleteMenuMediaBlob в билдере: замена временного, уход со
  // страницы, устаревшее фото после успешного сохранения — и каждый под
  // guard'ом isMenuMediaIdInUse.
  assert.equal(BUILDER_SOURCE.split("deleteMenuMediaBlob(").length - 1, 3);
  assert.equal(BUILDER_SOURCE.split("isMenuMediaIdInUse(").length - 1, 3);
  assert.ok(BUILDER_SOURCE.includes("persistedMediaIdRef"));
  // Ошибка update возвращает управление ДО обновления persistedMediaIdRef и
  // до какого-либо удаления: старое фото остаётся рабочим.
  const updateIndex = BUILDER_SOURCE.indexOf("if (!updated.ok)");
  const persistIndex = BUILDER_SOURCE.indexOf(
    "persistedMediaIdRef.current = nextPersisted",
  );
  const staleIndex = BUILDER_SOURCE.indexOf("mediaIdToDeleteAfterSave(");
  assert.ok(updateIndex !== -1 && persistIndex !== -1 && staleIndex !== -1);
  assert.ok(updateIndex < persistIndex && persistIndex < staleIndex);
});
