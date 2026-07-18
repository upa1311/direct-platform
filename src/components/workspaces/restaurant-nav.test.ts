import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RESTAURANT_KITCHEN_PATH,
  RESTAURANT_LEGACY_SETTINGS_PATH,
  RESTAURANT_SETTINGS_BUTTON_LABEL,
  RESTAURANT_SETTLEMENTS_PATH,
  WORKFLOW_MODE_HINTS,
  WORKFLOW_MODE_ORDER,
  restaurantNavItems,
} from "./restaurant-nav.ts";
import { createDefaultState } from "../../prototype/default-state.ts";
import {
  createOrderFromCart,
  acceptRestaurantOrder,
  addCartItem,
  setCartFulfillmentChoice,
  setRestaurantWorkflowModeWithResult,
} from "../../prototype/actions.ts";
import { workflowModeLabels } from "../../prototype/selectors.ts";
import type { PrototypeState } from "../../prototype/models.ts";

const labels = (mode: Parameters<typeof restaurantNavItems>[0]) =>
  restaurantNavItems(mode).map((item) => item.label);

test("COMBINED: рабочие разделы без оператора, режим не занимает место в навигации", () => {
  const items = restaurantNavItems("COMBINED");

  // Общий экран ведёт заказ целиком, поэтому называется «Заказы», а не «Кухня».
  assert.deepEqual(labels("COMBINED"), ["Заказы", "Меню и доступность", "Расчёты"]);
  assert.ok(!labels("COMBINED").includes("Кухня"));
  assert.ok(!labels("COMBINED").includes("Оператор заказов"));
  // «Расчёты» — ровно один раз, последним разделом.
  assert.equal(
    labels("COMBINED").filter((l) => l === "Расчёты").length,
    1,
  );
  assert.equal(items[items.length - 1].href, RESTAURANT_SETTLEMENTS_PATH);
  // Режим переключается шестерёнкой, поэтому текстового раздела «Настройки»
  // в рабочей навигации быть не должно.
  assert.ok(!labels("COMBINED").includes("Настройки"));
  assert.ok(
    !items.some((item) => item.href === RESTAURANT_LEGACY_SETTINGS_PATH),
    "старый URL настроек не должен оставаться в навигации",
  );
  assert.equal(items[0].href, RESTAURANT_KITCHEN_PATH);
});

test("SPLIT: порядок Оператор заказов → Кухня → Меню и доступность", () => {
  const items = restaurantNavItems("SPLIT_OPERATOR_KITCHEN");

  assert.deepEqual(labels("SPLIT_OPERATOR_KITCHEN"), [
    "Оператор заказов",
    "Кухня",
    "Меню и доступность",
    "Расчёты",
  ]);
  assert.deepEqual(
    items.map((item) => item.href),
    [
      "/restaurant/operator",
      RESTAURANT_KITCHEN_PATH,
      "/restaurant/menu",
      RESTAURANT_SETTLEMENTS_PATH,
    ],
  );
  // «Расчёты» — ровно один раз.
  assert.equal(
    labels("SPLIT_OPERATOR_KITCHEN").filter((l) => l === "Расчёты").length,
    1,
  );
  assert.ok(
    !items.some((item) => item.href === RESTAURANT_LEGACY_SETTINGS_PATH),
    "старый URL настроек не должен оставаться в навигации",
  );
});

test("тексты режимов объясняют число устройств, а не урезанную роль оператора", () => {
  assert.equal(workflowModeLabels.COMBINED, "Общий экран");
  assert.equal(
    WORKFLOW_MODE_HINTS.COMBINED,
    "Все заказы ведутся на одном устройстве.",
  );
  assert.equal(
    workflowModeLabels.SPLIT_OPERATOR_KITCHEN,
    "Оператор и кухня раздельно",
  );
  assert.equal(
    WORKFLOW_MODE_HINTS.SPLIT_OPERATOR_KITCHEN,
    "Оператор принимает и ведёт заказ, кухня готовит на отдельном устройстве Direct.",
  );

  // Решение по новому заказу принимает оператор, поэтому свести его роль к
  // доставке и выдаче нельзя, а общий экран — не только приготовление.
  for (const hint of Object.values(WORKFLOW_MODE_HINTS)) {
    assert.ok(!hint.includes("только за доставку"), hint);
  }
  assert.ok(
    !WORKFLOW_MODE_HINTS.COMBINED.includes("Приём, приготовление и выдача"),
  );
});

test("шестерёнка: одна подпись для aria-label и title, оба режима доступны в popover", () => {
  assert.equal(RESTAURANT_SETTINGS_BUTTON_LABEL, "Настройки режима работы");
  // Порядок вариантов popover фиксирован, текущий режим отмечается radio.
  assert.deepEqual(WORKFLOW_MODE_ORDER, ["COMBINED", "SPLIT_OPERATOR_KITCHEN"]);
  for (const mode of WORKFLOW_MODE_ORDER) {
    assert.ok(workflowModeLabels[mode].length > 0);
    assert.ok(WORKFLOW_MODE_HINTS[mode].length > 0);
  }
});

test("старый URL настроек ведёт на кухню, а не в 404", () => {
  assert.equal(RESTAURANT_LEGACY_SETTINGS_PATH, "/restaurant/settings");
  assert.equal(RESTAURANT_KITCHEN_PATH, "/restaurant/kitchen");
  assert.notEqual(RESTAURANT_KITCHEN_PATH, RESTAURANT_LEGACY_SETTINGS_PATH);
});

/** Ресторан-1 с одним принятым pickup-заказом: срез для проверки инвариантов. */
function stateWithAcceptedOrder(): { state: PrototypeState; orderId: string } {
  let state = createDefaultState();
  state = addCartItem(state, "restaurant-1-item-1", "size-standard").state;
  state = setCartFulfillmentChoice(state, "PICKUP");
  const created = createOrderFromCart(state);
  const orderId = created.result.orderId as string;
  state = acceptRestaurantOrder(created.state, orderId, 25);
  return { state, orderId };
}

test("смена режима: меняется только выбранный ресторан, заказы и финансы нетронуты", () => {
  const { state, orderId } = stateWithAcceptedOrder();
  const before = state.orders.find((o) => o.id === orderId)!;
  const otherBefore = state.restaurants.find((r) => r.id === "restaurant-2")!;

  const { state: next, result } = setRestaurantWorkflowModeWithResult(
    state,
    "restaurant-1",
    "SPLIT_OPERATOR_KITCHEN",
  );

  assert.equal(result.ok, true);
  assert.equal(
    next.restaurants.find((r) => r.id === "restaurant-1")?.orderWorkflowMode,
    "SPLIT_OPERATOR_KITCHEN",
  );
  // Другой ресторан не должен измениться даже по ссылке.
  assert.equal(
    next.restaurants.find((r) => r.id === "restaurant-2"),
    otherBefore,
  );
  assert.equal(next.revision, state.revision + 1);

  const after = next.orders.find((o) => o.id === orderId)!;
  assert.equal(after, before, "заказ не должен пересоздаваться при смене режима");
  assert.equal(after.status, before.status);
  assert.equal(after.preparationMinutes, before.preparationMinutes);
  assert.equal(after.expectedReadyAt, before.expectedReadyAt);
  assert.equal(after.paymentStatus, before.paymentStatus);
  assert.equal(after.pickupCode, before.pickupCode);
  assert.equal(after.assignedDriverId, before.assignedDriverId);
  assert.deepEqual(after.pricing, before.pricing);
  assert.equal(after.history.length, before.history.length);
  assert.deepEqual(next.settlements, state.settlements);
  assert.deepEqual(next.customer, state.customer);
});

test("повторная и устаревшая смена режима отклоняется без повреждения state", () => {
  const { state } = stateWithAcceptedOrder();
  const { state: split } = setRestaurantWorkflowModeWithResult(
    state,
    "restaurant-1",
    "SPLIT_OPERATOR_KITCHEN",
  );

  // Повтор того же режима: другая вкладка успела раньше.
  const repeat = setRestaurantWorkflowModeWithResult(
    split,
    "restaurant-1",
    "SPLIT_OPERATOR_KITCHEN",
  );
  assert.equal(repeat.result.ok, false);
  assert.equal(repeat.result.error, "Режим работы уже изменён другой вкладкой.");
  assert.equal(repeat.state, split, "отклонённая мутация не меняет state");
  assert.equal(repeat.state.revision, split.revision);

  // Устаревшая мутация по несуществующему ресторану.
  const missing = setRestaurantWorkflowModeWithResult(
    split,
    "restaurant-removed",
    "COMBINED",
  );
  assert.equal(missing.result.ok, false);
  assert.equal(missing.state, split);
  assert.equal(missing.state.revision, split.revision);
});
