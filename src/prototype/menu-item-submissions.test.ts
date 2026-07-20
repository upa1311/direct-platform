import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  addCartItem,
  approveMenuItemSubmission,
  createMenuItemSubmissionDraft,
  createOrderFromCart,
  rejectMenuItemSubmission,
  setCartFulfillmentChoice,
  submitMenuItemSubmission,
  updateMenuItemSubmissionDraft,
} from "./actions.ts";
import { normalizePrototypeState } from "./prototype-store.ts";
import { getRestaurantMenu } from "./selectors.ts";
import type {
  MenuItemSubmission,
  MenuPortion,
  PrototypeState,
  RestaurantOrderWorkflowMode,
  RestaurantWorkspaceRole,
} from "./models.ts";

/**
 * Доменное ядро заявок на новое блюдо: черновик, отправка, модерация Direct,
 * права, fail-closed и клиентская невидимость до одобрения.
 */

const RID = "restaurant-1";

function baseState(
  mode: RestaurantOrderWorkflowMode = "COMBINED",
): PrototypeState {
  const state = createDefaultState();
  return {
    ...state,
    restaurants: state.restaurants.map((r) =>
      r.id === RID ? { ...r, orderWorkflowMode: mode } : r,
    ),
  };
}

function getSubmission(state: PrototypeState, id: string): MenuItemSubmission {
  const found = state.menuItemSubmissions.find((s) => s.id === id);
  assert.ok(found, "заявка должна существовать");
  return found;
}

/** Готовый к отправке черновик (название + цена). */
function draftReadyToSubmit(
  mode: RestaurantOrderWorkflowMode = "COMBINED",
  role: RestaurantWorkspaceRole = "COMBINED",
): { state: PrototypeState; submissionId: string } {
  const created = createMenuItemSubmissionDraft(baseState(mode), RID, "RESTAURANT", role);
  assert.equal(created.result.ok, true, created.result.error ?? "");
  const submissionId = created.result.submissionId as string;
  const updated = updateMenuItemSubmissionDraft(
    created.state,
    submissionId,
    { name: "Паста Карбонара", priceCents: 750 },
    "RESTAURANT",
    role,
  );
  assert.equal(updated.result.ok, true, updated.result.error ?? "");
  return { state: updated.state, submissionId };
}

/** Заявка на проверке. */
function pendingSubmission(): { state: PrototypeState; submissionId: string } {
  const { state, submissionId } = draftReadyToSubmit();
  const sent = submitMenuItemSubmission(state, submissionId, "RESTAURANT", "COMBINED");
  assert.equal(sent.result.ok, true, sent.result.error ?? "");
  return { state: sent.state, submissionId };
}

/** Проверяет полный fail-closed: тот же объект state и та же ревизия. */
function assertUnchanged(
  before: PrototypeState,
  result: { state: PrototypeState; result: { ok: boolean } },
): void {
  assert.equal(result.result.ok, false);
  assert.equal(result.state, before, "state возвращается тем же объектом");
  assert.equal(result.state.revision, before.revision);
  assert.equal(result.state.menuItems.length, before.menuItems.length);
}

// 1 — нормализация старого состояния ------------------------------------------

test("старое состояние без menuItemSubmissions нормализуется в пустой список", () => {
  const legacy = createDefaultState() as unknown as Record<string, unknown>;
  delete legacy.menuItemSubmissions;
  const normalized = normalizePrototypeState(legacy);
  assert.deepEqual(normalized.menuItemSubmissions, []);
});

// 2 — старые блюда ------------------------------------------------------------

test("старое блюдо получает imageMediaId/portion null, категория сохраняется", () => {
  const legacy = createDefaultState() as unknown as Record<string, unknown>;
  legacy.menuItems = [
    {
      id: "legacy-1",
      restaurantId: RID,
      category: "Популярное",
      name: "Старое блюдо",
      description: "",
      priceCents: 500,
      currencyCode: "USD",
      available: true,
      variants: [
        { id: "v1", name: "Стандартная", priceDeltaCents: 0, available: true, isDefault: true },
      ],
    },
  ];
  const normalized = normalizePrototypeState(legacy);
  const item = normalized.menuItems[0];
  assert.equal(item.category, "Популярное", "категория сохраняется");
  assert.equal(item.imageMediaId, null);
  assert.equal(item.portion, null);
  assert.equal(item.variants?.[0].portion, null);
  assert.equal(item.available, true);
});

test("пустая категория старого блюда нормализуется в null, а не в строку", () => {
  const legacy = createDefaultState() as unknown as Record<string, unknown>;
  legacy.menuItems = [
    {
      id: "legacy-2",
      restaurantId: RID,
      category: "   ",
      name: "Без категории",
      description: "",
      priceCents: 500,
      currencyCode: "USD",
      available: true,
    },
  ];
  const item = normalizePrototypeState(legacy).menuItems[0];
  assert.equal(item.category, null);
  assert.notEqual(item.category, "null");
});

// 7 — черновик ----------------------------------------------------------------

test("DRAFT может быть частично пустым", () => {
  const created = createMenuItemSubmissionDraft(baseState(), RID);
  assert.equal(created.result.ok, true);
  const draft = getSubmission(created.state, created.result.submissionId as string);
  assert.equal(draft.status, "DRAFT");
  assert.equal(draft.name, "");
  assert.equal(draft.priceCents, null);
  assert.equal(draft.category, null);
  assert.equal(draft.imageMediaId, null);
  assert.equal(draft.portion, null);
  assert.deepEqual(draft.variants, []);
  assert.equal(draft.publishedMenuItemId, null);
  // Опубликованное меню не изменилось.
  assert.equal(created.state.menuItems.length, baseState().menuItems.length);
});

test("черновик нормализует строки и категорию", () => {
  const created = createMenuItemSubmissionDraft(baseState(), RID);
  const id = created.result.submissionId as string;
  const updated = updateMenuItemSubmissionDraft(created.state, id, {
    name: "  Паста  ",
    description: "  Описание  ",
    category: "   ",
    imageMediaId: "  ",
    priceCents: 750,
  });
  assert.equal(updated.result.ok, true, updated.result.error ?? "");
  const draft = getSubmission(updated.state, id);
  assert.equal(draft.name, "Паста");
  assert.equal(draft.description, "Описание");
  assert.equal(draft.category, null);
  assert.equal(draft.imageMediaId, null);
});

// 8 — отправка ----------------------------------------------------------------

test("отправка без названия и без цены запрещена, меню не меняется", () => {
  const created = createMenuItemSubmissionDraft(baseState(), RID);
  const id = created.result.submissionId as string;

  const noName = submitMenuItemSubmission(created.state, id);
  assertUnchanged(created.state, noName);

  const withName = updateMenuItemSubmissionDraft(created.state, id, {
    name: "Паста",
  }).state;
  const noPrice = submitMenuItemSubmission(withName, id);
  assertUnchanged(withName, noPrice);
  assert.equal(getSubmission(noPrice.state, id).status, "DRAFT");
});

test("отправка с названием и ценой успешна и не публикует блюдо", () => {
  const { state, submissionId } = draftReadyToSubmit();
  const menuBefore = state.menuItems.length;
  const sent = submitMenuItemSubmission(state, submissionId);
  assert.equal(sent.result.ok, true, sent.result.error ?? "");

  const submission = getSubmission(sent.state, submissionId);
  assert.equal(submission.status, "PENDING_REVIEW");
  assert.ok(submission.submittedAt);
  assert.equal(submission.publishedMenuItemId, null);
  assert.equal(sent.state.menuItems.length, menuBefore, "меню не изменилось");
});

test("повторная отправка заявки на проверке запрещена", () => {
  const { state, submissionId } = pendingSubmission();
  assertUnchanged(state, submitMenuItemSubmission(state, submissionId));
});

// 9 — клиентская невидимость --------------------------------------------------

test("DRAFT, PENDING_REVIEW и REJECTED не видны в опубликованном меню", () => {
  const before = getRestaurantMenu(baseState(), RID).length;

  const draft = draftReadyToSubmit();
  assert.equal(getRestaurantMenu(draft.state, RID).length, before, "DRAFT невидим");

  const pending = submitMenuItemSubmission(draft.state, draft.submissionId).state;
  assert.equal(getRestaurantMenu(pending, RID).length, before, "PENDING невидим");

  const rejected = rejectMenuItemSubmission(pending, draft.submissionId, "Нет фото").state;
  assert.equal(getRestaurantMenu(rejected, RID).length, before, "REJECTED невидим");
  // Ни одно из названий заявки не попало в опубликованное меню.
  assert.ok(!getRestaurantMenu(rejected, RID).some((m) => m.name === "Паста Карбонара"));
});

// 4/10 — одобрение ------------------------------------------------------------

test("одобрение создаёт ровно одно блюдо и копирует поля", () => {
  const created = createMenuItemSubmissionDraft(baseState(), RID);
  const id = created.result.submissionId as string;
  const portion: MenuPortion = { value: 350, unit: "G" };
  const filled = updateMenuItemSubmissionDraft(created.state, id, {
    name: "Паста Карбонара",
    description: "Сливочный соус",
    priceCents: 900,
    category: "Паста",
    imageMediaId: "media-1",
    portion,
    variants: [
      { id: "v1", name: "Стандартная", priceDeltaCents: 0, isDefault: true, portion: null },
      { id: "v2", name: "Большая", priceDeltaCents: 250, isDefault: false, portion: { value: 500, unit: "G" } },
    ],
  }).state;
  const pending = submitMenuItemSubmission(filled, id).state;
  const menuBefore = pending.menuItems.length;

  const approved = approveMenuItemSubmission(pending, id, "ADMIN");
  assert.equal(approved.result.ok, true, approved.result.error ?? "");
  assert.equal(approved.state.menuItems.length, menuBefore + 1, "ровно одно блюдо");

  const submission = getSubmission(approved.state, id);
  assert.equal(submission.status, "APPROVED");
  assert.equal(submission.reviewedBy, "ADMIN");
  assert.ok(submission.reviewedAt);
  assert.ok(submission.publishedMenuItemId);

  const published = approved.state.menuItems.find(
    (m) => m.id === submission.publishedMenuItemId,
  );
  assert.ok(published);
  assert.equal(published.name, "Паста Карбонара");
  assert.equal(published.category, "Паста");
  assert.equal(published.imageMediaId, "media-1");
  assert.deepEqual(published.portion, portion);
  assert.equal(published.priceCents, 900);
  assert.equal(published.available, true);
  assert.equal(published.availabilityPause, null);
  assert.equal(published.variants?.length, 2);
  assert.ok(published.variants?.every((v) => v.available === true));
  // Теперь блюдо видно в опубликованном меню.
  assert.ok(getRestaurantMenu(approved.state, RID).some((m) => m.id === published.id));
});

test("одобрение блюда без фото, категории, описания, порции и вариантов", () => {
  const { state, submissionId } = pendingSubmission();
  const approved = approveMenuItemSubmission(state, submissionId, "ADMIN");
  assert.equal(approved.result.ok, true, approved.result.error ?? "");
  const published = approved.state.menuItems.find(
    (m) => m.id === getSubmission(approved.state, submissionId).publishedMenuItemId,
  );
  assert.ok(published);
  assert.equal(published.imageMediaId, null);
  assert.equal(published.category, null);
  assert.equal(published.description, "");
  assert.equal(published.portion, null);
  assert.equal(published.variants, undefined);
});

test("одобрить может только ADMIN", () => {
  const { state, submissionId } = pendingSubmission();
  assertUnchanged(
    state,
    approveMenuItemSubmission(state, submissionId, "RESTAURANT"),
  );
});

// 11 — повторное одобрение ----------------------------------------------------

test("повторный approve запрещён и не создаёт второе блюдо", () => {
  const { state, submissionId } = pendingSubmission();
  const first = approveMenuItemSubmission(state, submissionId, "ADMIN");
  assert.equal(first.result.ok, true);
  const menuAfterFirst = first.state.menuItems.length;

  const second = approveMenuItemSubmission(first.state, submissionId, "ADMIN");
  assertUnchanged(first.state, second);
  assert.equal(second.state.menuItems.length, menuAfterFirst, "второго блюда нет");
});

test("reject после approve запрещён", () => {
  const { state, submissionId } = pendingSubmission();
  const approved = approveMenuItemSubmission(state, submissionId, "ADMIN").state;
  assertUnchanged(approved, rejectMenuItemSubmission(approved, submissionId, "Причина"));
});

// 12 — отклонение -------------------------------------------------------------

test("отклонение требует причину, не меняет меню и сохраняет вердикт", () => {
  const { state, submissionId } = pendingSubmission();
  assertUnchanged(state, rejectMenuItemSubmission(state, submissionId, "   "));

  const menuBefore = state.menuItems.length;
  const rejected = rejectMenuItemSubmission(state, submissionId, "  Нужно фото  ");
  assert.equal(rejected.result.ok, true, rejected.result.error ?? "");

  const submission = getSubmission(rejected.state, submissionId);
  assert.equal(submission.status, "REJECTED");
  assert.equal(submission.rejectionReason, "Нужно фото");
  assert.equal(submission.reviewedBy, "ADMIN");
  assert.equal(submission.publishedMenuItemId, null);
  assert.equal(rejected.state.menuItems.length, menuBefore, "меню не изменилось");
});

test("approve после reject запрещён", () => {
  const { state, submissionId } = pendingSubmission();
  const rejected = rejectMenuItemSubmission(state, submissionId, "Нужно фото").state;
  assertUnchanged(rejected, approveMenuItemSubmission(rejected, submissionId, "ADMIN"));
});

// 13 — повторная отправка после отклонения ------------------------------------

test("отклонённую заявку можно отредактировать и отправить снова", () => {
  const { state, submissionId } = pendingSubmission();
  const rejected = rejectMenuItemSubmission(state, submissionId, "Нужно фото").state;

  const edited = updateMenuItemSubmissionDraft(rejected, submissionId, {
    imageMediaId: "media-9",
  });
  assert.equal(edited.result.ok, true, edited.result.error ?? "");

  const resent = submitMenuItemSubmission(edited.state, submissionId);
  assert.equal(resent.result.ok, true, resent.result.error ?? "");

  const submission = getSubmission(resent.state, submissionId);
  assert.equal(submission.status, "PENDING_REVIEW");
  // Прошлый вердикт больше не действует.
  assert.equal(submission.rejectionReason, null);
  assert.equal(submission.reviewedAt, null);
  assert.equal(submission.reviewedBy, null);
  assert.equal(submission.publishedMenuItemId, null);
  // Но причина сохранилась в истории решений.
  assert.ok(
    submission.reviewHistory.some(
      (entry) => entry.action === "REJECTED" && entry.reason === "Нужно фото",
    ),
  );
});

test("заявку на проверке и одобренную редактировать нельзя", () => {
  const pending = pendingSubmission();
  assertUnchanged(
    pending.state,
    updateMenuItemSubmissionDraft(pending.state, pending.submissionId, {
      name: "Другое",
    }),
  );

  const approved = approveMenuItemSubmission(
    pending.state,
    pending.submissionId,
    "ADMIN",
  ).state;
  assertUnchanged(
    approved,
    updateMenuItemSubmissionDraft(approved, pending.submissionId, { name: "Ещё" }),
  );
});

// 14 — права ------------------------------------------------------------------

test("права: каталог ведут COMBINED, кухня и оператор", () => {
  // COMBINED.
  const combined = createMenuItemSubmissionDraft(
    baseState("COMBINED"),
    RID,
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(combined.result.ok, true);

  // Кухня в SPLIT.
  const kitchen = createMenuItemSubmissionDraft(
    baseState("SPLIT_OPERATOR_KITCHEN"),
    RID,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(kitchen.result.ok, true);

  // Оператор в SPLIT — тоже может завести заявку.
  const operator = createMenuItemSubmissionDraft(
    baseState("SPLIT_OPERATOR_KITCHEN"),
    RID,
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(operator.result.ok, true);

  // SPLIT без роли — по-прежнему fail-closed.
  const splitState = baseState("SPLIT_OPERATOR_KITCHEN");
  assertUnchanged(
    splitState,
    createMenuItemSubmissionDraft(splitState, RID, "RESTAURANT"),
  );
});

test("оператор доводит заявку до PENDING_REVIEW", () => {
  // Черновик заводит оператор, он же правит и отправляет на модерацию.
  const created = createMenuItemSubmissionDraft(
    baseState("SPLIT_OPERATOR_KITCHEN"),
    RID,
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(created.result.ok, true);
  const submissionId = created.result.submissionId as string;

  const filled = updateMenuItemSubmissionDraft(
    created.state,
    submissionId,
    { name: "Салат оператора", priceCents: 450 },
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(filled.result.ok, true);

  const submitted = submitMenuItemSubmission(
    filled.state,
    submissionId,
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(submitted.result.ok, true);
  const submission = submitted.state.menuItemSubmissions.find(
    (s) => s.id === submissionId,
  );
  assert.equal(submission?.status, "PENDING_REVIEW");
  // Публикация клиенту по-прежнему только после одобрения ADMIN.
  assert.equal(submission?.publishedMenuItemId, null);
});

test("ADMIN не создаёт ресторанный черновик", () => {
  const state = baseState();
  assertUnchanged(
    state,
    createMenuItemSubmissionDraft(state, RID, "ADMIN", "COMBINED"),
  );
});

test("правка заявки без роли в SPLIT остаётся fail-closed", () => {
  const { state, submissionId } = draftReadyToSubmit();
  // Права проверяются по режиму ресторана-ВЛАДЕЛЬЦА заявки. Роли у всех трёх
  // ресторанных ролей теперь одинаковые, но отсутствие явной роли в SPLIT
  // по-прежнему блокирует правку.
  const split = {
    ...state,
    restaurants: state.restaurants.map((r) =>
      r.id === RID ? { ...r, orderWorkflowMode: "SPLIT_OPERATOR_KITCHEN" as const } : r,
    ),
  };
  assertUnchanged(
    split,
    updateMenuItemSubmissionDraft(
      split,
      submissionId,
      { name: "Без роли" },
      "RESTAURANT",
    ),
  );
  // ADMIN тоже не правит ресторанный черновик.
  assertUnchanged(
    split,
    updateMenuItemSubmissionDraft(
      split,
      submissionId,
      { name: "Админ" },
      "ADMIN",
      "COMBINED",
    ),
  );
});

test("несуществующий ресторан и заявка дают ошибку без мутации", () => {
  const state = baseState();
  assertUnchanged(
    state,
    createMenuItemSubmissionDraft(state, "restaurant-nope", "RESTAURANT", "COMBINED"),
  );
  assertUnchanged(state, submitMenuItemSubmission(state, "menu-submission-404"));
  assertUnchanged(state, approveMenuItemSubmission(state, "menu-submission-404", "ADMIN"));
});

// 15 — варианты на уровне действий -------------------------------------------

test("нельзя отправить заявку с некорректными вариантами", () => {
  const { state, submissionId } = draftReadyToSubmit();
  // Без default-варианта.
  const noDefault = updateMenuItemSubmissionDraft(state, submissionId, {
    variants: [
      { id: "v1", name: "Стандартная", priceDeltaCents: 0, isDefault: false, portion: null },
    ],
  }).state;
  assertUnchanged(noDefault, submitMenuItemSubmission(noDefault, submissionId));

  // Отрицательная доплата не сохраняется даже в черновик.
  assertUnchanged(
    state,
    updateMenuItemSubmissionDraft(state, submissionId, {
      variants: [
        { id: "v1", name: "Стандартная", priceDeltaCents: -100, isDefault: true, portion: null },
      ],
    }),
  );

  // Дубликат id не сохраняется в черновик.
  assertUnchanged(
    state,
    updateMenuItemSubmissionDraft(state, submissionId, {
      variants: [
        { id: "v1", name: "A", priceDeltaCents: 0, isDefault: true, portion: null },
        { id: "v1", name: "B", priceDeltaCents: 0, isDefault: false, portion: null },
      ],
    }),
  );
});

test("некорректная порция не сохраняется в черновик", () => {
  const { state, submissionId } = draftReadyToSubmit();
  assertUnchanged(
    state,
    updateMenuItemSubmissionDraft(state, submissionId, {
      portion: { value: 0, unit: "G" },
    }),
  );
  assertUnchanged(
    state,
    updateMenuItemSubmissionDraft(state, submissionId, {
      portion: { value: 1.5, unit: "PCS" },
    }),
  );
});

// 16 — снимок порции в заказе -------------------------------------------------

/** Заказ на самовывоз с заданными порциями блюда и варианта. */
function orderWithPortions(
  itemPortion: MenuPortion | null,
  variantPortion: MenuPortion | null,
): PrototypeState["orders"][number] {
  let s = createDefaultState();
  s = {
    ...s,
    menuItems: s.menuItems.map((item) =>
      item.id === `${RID}-item-1`
        ? {
            ...item,
            portion: itemPortion,
            variants: item.variants?.map((v) =>
              v.id === "size-standard" ? { ...v, portion: variantPortion } : v,
            ),
          }
        : item,
    ),
  };
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, `${RID}-item-1`, "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const order = created.state.orders.at(-1);
  assert.ok(order);
  return order;
}

test("снимок порции: вариант важнее базовой, иначе базовая, иначе null", () => {
  const base: MenuPortion = { value: 350, unit: "G" };
  const own: MenuPortion = { value: 500, unit: "G" };

  assert.deepEqual(orderWithPortions(base, own).items[0].portionSnapshot, own);
  assert.deepEqual(orderWithPortions(base, null).items[0].portionSnapshot, base);
  assert.equal(orderWithPortions(null, null).items[0].portionSnapshot, null);
});

test("старый заказ без снимка порции нормализуется в null", () => {
  const legacy = createDefaultState() as unknown as Record<string, unknown>;
  legacy.orders = [
    {
      id: "order-legacy",
      publicNumber: "DIR-0001",
      status: "DELIVERED",
      deliveryMode: "PICKUP",
      restaurant: { id: RID, name: "Ресторан 1", address: "", zoneId: "zone-1" },
      customer: { id: "customer-1", name: "Клиент", phone: "" },
      items: [{ menuItemId: "x", name: "Старое блюдо", quantity: 1, unitPriceCents: 500 }],
      history: [],
    },
  ];
  const normalized = normalizePrototypeState(legacy);
  assert.equal(normalized.orders[0].items[0].portionSnapshot, null);
});

// 17 — fail-closed ------------------------------------------------------------

test("ошибки не меняют ревизию и не добавляют заявок или блюд", () => {
  const state = baseState();
  const submissionsBefore = state.menuItemSubmissions.length;
  const menuBefore = state.menuItems.length;

  for (const attempt of [
    // ADMIN ресторанный черновик не создаёт (в COMBINED любая роль резолвится
    // в COMBINED, поэтому отказ по роли проверяется на SPLIT отдельным тестом).
    createMenuItemSubmissionDraft(state, RID, "ADMIN", "COMBINED"),
    createMenuItemSubmissionDraft(state, "нет-такого", "RESTAURANT", "COMBINED"),
    submitMenuItemSubmission(state, "нет-такой"),
    approveMenuItemSubmission(state, "нет-такой", "ADMIN"),
    rejectMenuItemSubmission(state, "нет-такой", "Причина", "ADMIN"),
  ]) {
    assertUnchanged(state, attempt);
    assert.equal(attempt.state.menuItemSubmissions.length, submissionsBefore);
    assert.equal(attempt.state.menuItems.length, menuBefore);
  }
});

test("успешные действия увеличивают ревизию ровно на один шаг", () => {
  const state = baseState();
  const created = createMenuItemSubmissionDraft(state, RID, "RESTAURANT", "COMBINED");
  assert.equal(created.state.revision, state.revision + 1);

  const id = created.result.submissionId as string;
  const updated = updateMenuItemSubmissionDraft(created.state, id, {
    name: "Паста",
    priceCents: 750,
  });
  assert.equal(updated.state.revision, created.state.revision + 1);

  const sent = submitMenuItemSubmission(updated.state, id);
  assert.equal(sent.state.revision, updated.state.revision + 1);

  const approved = approveMenuItemSubmission(sent.state, id, "ADMIN");
  assert.equal(approved.state.revision, sent.state.revision + 1);
});
