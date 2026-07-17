import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  createOrderFromCart,
  reportRestaurantPreparationProblem,
  resolveRestaurantPreparationProblem,
  setCartFulfillmentChoice,
} from "./actions.ts";
import {
  getLatestResolvedPreparationProblem,
  getOpenPreparationProblem,
} from "./selectors.ts";
import type {
  Order,
  OrderHistoryEvent,
  PrototypeState,
  RestaurantOrderWorkflowMode,
} from "./models.ts";

/**
 * Этап 1 из 2: проблема приготовления получает OPEN/RESOLVED-состояние, оператор
 * (в COMBINED — общий экран) подтверждает решение. Проверяется домен и чистые
 * selectors, не React. Отмена/возврат сюда НЕ входят — их здесь и не должно быть.
 */

function preparingOrder(
  mode: RestaurantOrderWorkflowMode,
): { state: PrototypeState; orderId: string; acceptRole: "OPERATOR" | "COMBINED" } {
  const restaurantId = "restaurant-2";
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === restaurantId ? { ...r, orderWorkflowMode: mode } : r,
    ),
  };
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  const acceptRole = mode === "COMBINED" ? "COMBINED" : "OPERATOR";
  const accepted = acceptRestaurantOrderWithResult(
    created.state,
    orderId,
    25,
    "RESTAURANT",
    acceptRole,
  );
  assert.equal(accepted.result.ok, true);
  assert.equal(getOrder(accepted.state, orderId).status, "PREPARING");
  return { state: accepted.state, orderId, acceptRole };
}

function getOrder(state: PrototypeState, orderId: string): Order {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
}

/** Кухня сообщает о проблеме; возвращает state, orderId и id проблемы. */
function reportedProblem(mode: RestaurantOrderWorkflowMode): {
  state: PrototypeState;
  orderId: string;
  problemId: string;
} {
  const { state, orderId, acceptRole } = preparingOrder(mode);
  const reportRole = mode === "COMBINED" ? "COMBINED" : "KITCHEN";
  const res = reportRestaurantPreparationProblem(
    state,
    orderId,
    "Закончился ингредиент",
    "RESTAURANT",
    new Date(Date.parse(getOrder(state, orderId).updatedAt) + 1000).toISOString(),
    reportRole,
  );
  assert.equal(res.result.ok, true, res.result.error ?? "");
  void acceptRole;
  const problem = getOpenPreparationProblem(getOrder(res.state, orderId));
  assert.ok(problem);
  return { state: res.state, orderId, problemId: problem.problemId };
}

test("KITCHEN создаёт один OPEN-event проблемы", () => {
  const { state, orderId } = preparingOrder("SPLIT_OPERATOR_KITCHEN");
  const before = getOrder(state, orderId);
  const res = reportRestaurantPreparationProblem(
    state,
    orderId,
    "Закончился ингредиент",
    "RESTAURANT",
    new Date(Date.parse(before.updatedAt) + 1000).toISOString(),
    "KITCHEN",
  );
  assert.equal(res.result.ok, true);

  const order = getOrder(res.state, orderId);
  const added = order.history.slice(before.history.length);
  assert.equal(added.length, 1);
  const ev = added[0];
  assert.equal(ev.type, "PREPARATION_PROBLEM");
  assert.equal(ev.preparationProblemState, "OPEN");
  assert.ok(ev.preparationProblemId);
  assert.equal(ev.actor, "RESTAURANT");
  assert.equal(ev.restaurantWorkspaceRole, "KITCHEN");
  assert.equal(ev.fromStatus, ev.toStatus);
  assert.equal(order.status, "PREPARING");
  assert.equal(res.state.revision, state.revision + 1);

  // Selector видит открытую проблему с исходной причиной.
  const open = getOpenPreparationProblem(order);
  assert.ok(open);
  assert.equal(open.reason, "Закончился ингредиент");
});

test("повторная отправка при открытой проблеме отклоняется без мутации", () => {
  const { state, orderId } = reportedProblem("SPLIT_OPERATOR_KITCHEN");
  const revisionBefore = state.revision;
  const historyBefore = getOrder(state, orderId).history.length;

  const res = reportRestaurantPreparationProblem(
    state,
    orderId,
    "Кухня перегружена",
    "RESTAURANT",
    new Date(Date.parse(getOrder(state, orderId).updatedAt) + 1000).toISOString(),
    "KITCHEN",
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
  assert.equal(res.state.revision, revisionBefore);
  assert.equal(getOrder(res.state, orderId).history.length, historyBefore);
});

test("OPERATOR решает OPEN-проблему: один RESOLVED-event, тот же id, статус PREPARING", () => {
  const { state, orderId, problemId } = reportedProblem("SPLIT_OPERATOR_KITCHEN");
  const before = getOrder(state, orderId);

  const res = resolveRestaurantPreparationProblem(
    state,
    orderId,
    problemId,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(before.updatedAt) + 1000).toISOString(),
  );
  assert.equal(res.result.ok, true, res.result.error ?? "");

  const order = getOrder(res.state, orderId);
  const added = order.history.slice(before.history.length);
  assert.equal(added.length, 1);
  const ev = added[0];
  assert.equal(ev.type, "PREPARATION_PROBLEM");
  assert.equal(ev.preparationProblemState, "RESOLVED");
  assert.equal(ev.preparationProblemId, problemId);
  assert.equal(ev.restaurantWorkspaceRole, "OPERATOR");
  assert.equal(ev.fromStatus, ev.toStatus);
  assert.equal(order.status, "PREPARING");
  assert.equal(res.state.revision, state.revision + 1);

  // Проблема больше не активна, но фиксируется как решённая.
  assert.equal(getOpenPreparationProblem(order), null);
  const resolved = getLatestResolvedPreparationProblem(order);
  assert.ok(resolved);
  assert.equal(resolved.problemId, problemId);
});

test("KITCHEN не может решить проблему", () => {
  const { state, orderId, problemId } = reportedProblem("SPLIT_OPERATOR_KITCHEN");
  const res = resolveRestaurantPreparationProblem(
    state,
    orderId,
    problemId,
    "Проблема устранена",
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Недостаточно прав для решения проблемы приготовления.");
  assert.equal(res.state, state);
  assert.equal(res.state.revision, state.revision);
});

test("COMBINED: общий экран сообщает и решает проблему", () => {
  const { state, orderId, problemId } = reportedProblem("COMBINED");
  const before = getOrder(state, orderId);

  const res = resolveRestaurantPreparationProblem(
    state,
    orderId,
    problemId,
    "Клиент согласился продолжить заказ",
    "RESTAURANT",
    "COMBINED",
    new Date(Date.parse(before.updatedAt) + 1000).toISOString(),
  );
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const order = getOrder(res.state, orderId);
  assert.equal(order.history.at(-1)?.restaurantWorkspaceRole, "COMBINED");
  assert.equal(order.history.at(-1)?.preparationProblemState, "RESOLVED");
  assert.equal(order.status, "PREPARING");
  assert.equal(getOpenPreparationProblem(order), null);
});

test("повторное решение отклоняется и не создаёт второй event", () => {
  const { state, orderId, problemId } = reportedProblem("SPLIT_OPERATOR_KITCHEN");
  const first = resolveRestaurantPreparationProblem(
    state,
    orderId,
    problemId,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(getOrder(state, orderId).updatedAt) + 1000).toISOString(),
  );
  assert.equal(first.result.ok, true);
  const historyAfterFirst = getOrder(first.state, orderId).history.length;

  const second = resolveRestaurantPreparationProblem(
    first.state,
    orderId,
    problemId,
    "Другая причина",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(getOrder(first.state, orderId).updatedAt) + 1000).toISOString(),
  );
  assert.equal(second.result.ok, false);
  assert.equal(second.state, first.state);
  assert.equal(getOrder(second.state, orderId).history.length, historyAfterFirst);
  assert.equal(second.state.revision, first.state.revision);
});

test("legacy PREPARATION_PROBLEM без новых полей считается OPEN", () => {
  const { state, orderId } = preparingOrder("SPLIT_OPERATOR_KITCHEN");
  const order = getOrder(state, orderId);
  const legacyEvent = {
    id: `${order.id}-legacy-problem`,
    occurredAt: order.updatedAt,
    actor: "RESTAURANT",
    type: "PREPARATION_PROBLEM",
    fromStatus: "PREPARING",
    toStatus: "PREPARING",
    message: "Кухня сообщила о проблеме: старое событие",
    restaurantWorkspaceRole: "KITCHEN",
  } as OrderHistoryEvent;
  const withLegacy: Order = {
    ...order,
    history: [...order.history, legacyEvent],
  };

  const open = getOpenPreparationProblem(withLegacy);
  assert.ok(open);
  // id проблемы для legacy — это event.id.
  assert.equal(open.problemId, legacyEvent.id);
  assert.equal(open.reason, "старое событие");

  // Такую legacy-проблему можно решить по её event.id.
  const stateWithLegacy: PrototypeState = {
    ...state,
    orders: state.orders.map((o) => (o.id === orderId ? withLegacy : o)),
  };
  const res = resolveRestaurantPreparationProblem(
    stateWithLegacy,
    orderId,
    legacyEvent.id,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(order.updatedAt) + 1000).toISOString(),
  );
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(getOpenPreparationProblem(getOrder(res.state, orderId)), null);
});

test("после RESOLVED повторное открытие проблемы снова возможно", () => {
  const { state, orderId, problemId } = reportedProblem("SPLIT_OPERATOR_KITCHEN");
  const resolved = resolveRestaurantPreparationProblem(
    state,
    orderId,
    problemId,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(getOrder(state, orderId).updatedAt) + 1000).toISOString(),
  ).state;
  assert.equal(getOpenPreparationProblem(getOrder(resolved, orderId)), null);

  // Новая реальная проблема снова принимается и активна.
  const again = reportRestaurantPreparationProblem(
    resolved,
    orderId,
    "Техническая проблема",
    "RESTAURANT",
    new Date(Date.parse(getOrder(resolved, orderId).updatedAt) + 2000).toISOString(),
    "KITCHEN",
  );
  assert.equal(again.result.ok, true);
  const open = getOpenPreparationProblem(getOrder(again.state, orderId));
  assert.ok(open);
  assert.notEqual(open.problemId, problemId);
  assert.equal(open.reason, "Техническая проблема");
});

test("решение проблемы не меняет lifecycle и финансы заказа", () => {
  const { state, orderId, problemId } = reportedProblem("SPLIT_OPERATOR_KITCHEN");
  const before = getOrder(state, orderId);
  const settlementsBefore = state.settlements.length;

  const res = resolveRestaurantPreparationProblem(
    state,
    orderId,
    problemId,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(before.updatedAt) + 1000).toISOString(),
  );
  assert.equal(res.result.ok, true);
  const after = getOrder(res.state, orderId);

  assert.equal(after.status, before.status);
  assert.deepEqual(after.items, before.items);
  assert.equal(after.expectedReadyAt, before.expectedReadyAt);
  assert.equal(after.paymentStatus, before.paymentStatus);
  assert.deepEqual(after.financials, before.financials);
  assert.equal(after.pickupCode, before.pickupCode);
  assert.equal(after.pickupCodeUsed, before.pickupCodeUsed);
  assert.equal(res.state.settlements.length, settlementsBefore);
});

test("две вкладки: устаревшее решение получает ошибку без второй мутации", () => {
  const { state, orderId, problemId } = reportedProblem("SPLIT_OPERATOR_KITCHEN");
  const base = state;

  // Первая вкладка решает проблему.
  const first = resolveRestaurantPreparationProblem(
    base,
    orderId,
    problemId,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(getOrder(base, orderId).updatedAt) + 1000).toISOString(),
  );
  assert.equal(first.result.ok, true);

  // Вторая вкладка (rebase на свежий state) с тем же problemId — уже решено.
  const second = resolveRestaurantPreparationProblem(
    first.state,
    orderId,
    problemId,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(getOrder(first.state, orderId).updatedAt) + 1000).toISOString(),
  );
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Проблема уже решена или не найдена. Обновите данные.");
  assert.equal(second.state, first.state);
});
