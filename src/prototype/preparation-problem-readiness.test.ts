import assert from "node:assert/strict";
import { test } from "node:test";

import { buildKitchenProductionTicketData } from "../components/kitchen/kitchen-production-ticket-data.ts";
import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  createOrderFromCart,
  markOrderReadyWithResult,
  reportRestaurantPreparationProblem,
  resolveRestaurantPreparationProblem,
  setCartFulfillmentChoice,
  simulateSuccessfulOnlinePaymentWithResult,
  updateCartAddress,
} from "./actions.ts";
import type {
  FulfillmentChoice,
  Order,
  PrototypeState,
  RestaurantOrderWorkflowMode,
  RestaurantWorkspaceRole,
} from "./models.ts";
import { getOpenPreparationProblem } from "./selectors.ts";

const OPEN_READY_ERROR =
  "Сначала дождитесь решения проблемы приготовления.";

function getOrder(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((candidate) => candidate.id === orderId);
  assert.ok(order);
  return order;
}

function makePreparingOrder(
  mode: RestaurantOrderWorkflowMode,
  fulfillment: FulfillmentChoice = "PICKUP",
): { state: PrototypeState; orderId: string } {
  const restaurantId = "restaurant-2";
  let state = createDefaultState();
  state = {
    ...state,
    restaurants: state.restaurants.map((restaurant) =>
      restaurant.id === restaurantId
        ? { ...restaurant, orderWorkflowMode: mode }
        : restaurant,
    ),
  };
  state = setCartFulfillmentChoice(state, fulfillment);
  if (fulfillment === "DELIVERY") {
    state = updateCartAddress(state, {
      street: "Тестовая улица 1",
      house: "1",
    });
  }
  state = addCartItem(state, `${restaurantId}-item-1`).state;

  const created = createOrderFromCart(state);
  assert.equal(created.result.error, null);
  const orderId = created.result.orderId as string;
  const acceptRole: RestaurantWorkspaceRole =
    mode === "COMBINED" ? "COMBINED" : "OPERATOR";
  const accepted = acceptRestaurantOrderWithResult(
    created.state,
    orderId,
    25,
    "RESTAURANT",
    acceptRole,
  );
  assert.equal(accepted.result.ok, true, accepted.result.error ?? "");

  const preparing =
    fulfillment === "DELIVERY"
      ? simulateSuccessfulOnlinePaymentWithResult(accepted.state, orderId)
      : accepted;
  assert.equal(preparing.result.ok, true, preparing.result.error ?? "");
  assert.equal(getOrder(preparing.state, orderId).status, "PREPARING");
  return { state: preparing.state, orderId };
}

function reportOpenProblem(
  mode: RestaurantOrderWorkflowMode,
  fulfillment: FulfillmentChoice = "PICKUP",
): { state: PrototypeState; orderId: string; problemId: string } {
  const prepared = makePreparingOrder(mode, fulfillment);
  const order = getOrder(prepared.state, prepared.orderId);
  const reportRole: RestaurantWorkspaceRole =
    mode === "COMBINED" ? "COMBINED" : "KITCHEN";
  const reported = reportRestaurantPreparationProblem(
    prepared.state,
    prepared.orderId,
    "Закончился ингредиент",
    "RESTAURANT",
    new Date(Date.parse(order.updatedAt) + 1_000).toISOString(),
    reportRole,
  );
  assert.equal(reported.result.ok, true, reported.result.error ?? "");
  const problem = getOpenPreparationProblem(
    getOrder(reported.state, prepared.orderId),
  );
  assert.ok(problem);
  return {
    state: reported.state,
    orderId: prepared.orderId,
    problemId: problem.problemId,
  };
}

function resolveOpenProblem(
  state: PrototypeState,
  orderId: string,
  problemId: string,
  role: "OPERATOR" | "COMBINED",
): PrototypeState {
  const before = getOrder(state, orderId);
  const resolved = resolveRestaurantPreparationProblem(
    state,
    orderId,
    problemId,
    "Проблема устранена",
    "RESTAURANT",
    role,
    new Date(Date.parse(before.updatedAt) + 1_000).toISOString(),
  );
  assert.equal(resolved.result.ok, true, resolved.result.error ?? "");
  assert.equal(getOpenPreparationProblem(getOrder(resolved.state, orderId)), null);
  return resolved.state;
}

function assertBlockedReadyIsPure(
  state: PrototypeState,
  orderId: string,
  role: "KITCHEN" | "COMBINED",
): void {
  const before = getOrder(state, orderId);
  const result = markOrderReadyWithResult(
    state,
    orderId,
    "RESTAURANT",
    role,
  );

  assert.equal(result.result.ok, false);
  assert.equal(result.result.error, OPEN_READY_ERROR);
  assert.equal(result.state, state, "возвращён исходный state тем же объектом");
  assert.equal(result.state.revision, state.revision);

  const after = getOrder(result.state, orderId);
  assert.equal(after.status, "PREPARING");
  assert.equal(after.history, before.history);
  assert.equal(after.expectedReadyAt, before.expectedReadyAt);
  assert.equal(after.preparationMinutes, before.preparationMinutes);
  assert.equal(after.items, before.items);
  assert.equal(after.etaAdjustments, before.etaAdjustments);
  assert.equal(after.paymentStatus, before.paymentStatus);
  assert.equal(after.paidAt, before.paidAt);
  assert.equal(after.financials, before.financials);
  assert.equal(result.state.settlements, state.settlements);
  assert.equal(after.pickupCode, before.pickupCode);
  assert.equal(after.pickupCodeUsed, before.pickupCodeUsed);
  assert.equal(after.assignedDriverId, before.assignedDriverId);
}

function statusEventsSince(order: Order, historyLength: number) {
  return order.history
    .slice(historyLength)
    .filter((event) => event.type === "STATUS");
}

test("SPLIT KITCHEN: OPEN-проблема блокирует готовность без любой мутации", () => {
  const { state, orderId } = reportOpenProblem("SPLIT_OPERATOR_KITCHEN");
  assertBlockedReadyIsPure(state, orderId, "KITCHEN");
});

test("COMBINED: OPEN-проблема блокирует готовность без любой мутации", () => {
  const { state, orderId } = reportOpenProblem("COMBINED");
  assertBlockedReadyIsPure(state, orderId, "COMBINED");
});

test("PICKUP: после RESOLVED готовность переводит заказ в READY_FOR_PICKUP", () => {
  const open = reportOpenProblem("SPLIT_OPERATOR_KITCHEN");
  const resolved = resolveOpenProblem(
    open.state,
    open.orderId,
    open.problemId,
    "OPERATOR",
  );
  const before = getOrder(resolved, open.orderId);
  const ready = markOrderReadyWithResult(
    resolved,
    open.orderId,
    "RESTAURANT",
    "KITCHEN",
  );

  assert.equal(ready.result.ok, true, ready.result.error ?? "");
  const after = getOrder(ready.state, open.orderId);
  assert.equal(after.status, "READY_FOR_PICKUP");
  assert.equal(statusEventsSince(after, before.history.length).length, 1);
});

test("delivery: после RESOLVED готовность переводит заказ в READY", () => {
  const open = reportOpenProblem("COMBINED", "DELIVERY");
  const resolved = resolveOpenProblem(
    open.state,
    open.orderId,
    open.problemId,
    "COMBINED",
  );
  const before = getOrder(resolved, open.orderId);
  const ready = markOrderReadyWithResult(
    resolved,
    open.orderId,
    "RESTAURANT",
    "COMBINED",
  );

  assert.equal(ready.result.ok, true, ready.result.error ?? "");
  const after = getOrder(ready.state, open.orderId);
  assert.equal(after.status, "READY");
  assert.equal(statusEventsSince(after, before.history.length).length, 1);
});

test("race: после решения свежий mark ready успешен, повторный переход не создаётся", () => {
  const open = reportOpenProblem("SPLIT_OPERATOR_KITCHEN");

  const staleAttempt = markOrderReadyWithResult(
    open.state,
    open.orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(staleAttempt.result.error, OPEN_READY_ERROR);
  assert.equal(staleAttempt.state, open.state);

  const resolved = resolveOpenProblem(
    open.state,
    open.orderId,
    open.problemId,
    "OPERATOR",
  );
  const first = markOrderReadyWithResult(
    resolved,
    open.orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(first.result.ok, true);
  const statusCount = getOrder(first.state, open.orderId).history.filter(
    (event) => event.type === "STATUS",
  ).length;

  const second = markOrderReadyWithResult(
    first.state,
    open.orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(second.result.ok, false);
  assert.notEqual(second.result.error, OPEN_READY_ERROR);
  assert.equal(second.state, first.state);
  assert.equal(
    getOrder(second.state, open.orderId).history.filter(
      (event) => event.type === "STATUS",
    ).length,
    statusCount,
  );
});

test("печать тикета остаётся чистой и не зависит от OPEN/RESOLVED", () => {
  const prepared = makePreparingOrder("SPLIT_OPERATOR_KITCHEN");
  const beforeOrder = getOrder(prepared.state, prepared.orderId);
  const beforeOrderSnapshot = structuredClone(beforeOrder);
  const beforeTicket = buildKitchenProductionTicketData(beforeOrder, "Europe/Chisinau");
  assert.deepEqual(beforeOrder, beforeOrderSnapshot, "печать не мутирует заказ");

  const open = reportRestaurantPreparationProblem(
    prepared.state,
    prepared.orderId,
    "Закончился ингредиент",
    "RESTAURANT",
    new Date(Date.parse(beforeOrder.updatedAt) + 1_000).toISOString(),
    "KITCHEN",
  );
  assert.equal(open.result.ok, true);
  const openOrder = getOrder(open.state, prepared.orderId);
  assert.deepEqual(
    buildKitchenProductionTicketData(openOrder, "Europe/Chisinau"),
    beforeTicket,
  );
  const problem = getOpenPreparationProblem(openOrder);
  assert.ok(problem);

  const resolved = resolveOpenProblem(
    open.state,
    prepared.orderId,
    problem.problemId,
    "OPERATOR",
  );
  assert.deepEqual(
    buildKitchenProductionTicketData(getOrder(resolved, prepared.orderId), "Europe/Chisinau"),
    beforeTicket,
  );
});
