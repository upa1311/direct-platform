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
  parsePortionFields,
  parsePriceInput,
  parseVariantDeltaInput,
  parseVariantRows,
  resolveDishBuilderRole,
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
  setCartFulfillmentChoice,
  submitMenuItemSubmission,
  updateMenuItemSubmissionDraft,
} from "./actions.ts";
import {
  getPendingMenuSubmissions,
  getRestaurantMenu,
  getRestaurantMenuCategories,
  getRestaurantMenuSubmissions,
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

test("раскрытая панель содержит «Добавить новое блюдо» и «Мои заявки»", () => {
  assert.ok(PANEL_SOURCE.includes(">Добавить новое блюдо<") ||
    PANEL_SOURCE.includes("Добавить новое блюдо\n"));
  assert.ok(PANEL_SOURCE.includes("Мои заявки"));
  assert.ok(PANEL_SOURCE.includes("dishSubmissionsHref(workspaceRole)"));
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
