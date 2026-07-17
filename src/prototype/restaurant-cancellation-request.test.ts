import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  approveCancellationRequest,
  createOrderFromCart,
  rejectCancellationRequest,
  reportRestaurantPreparationProblem,
  requestOrderCancellationByClient,
  requestOrderCancellationByRestaurant,
  resolveRestaurantPreparationProblem,
  setCartFulfillmentChoice,
  simulateSuccessfulOnlinePaymentWithResult,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import type {
  CancellationRequest,
  FulfillmentChoice,
  Order,
  PrototypeState,
  RestaurantOrderWorkflowMode,
  RestaurantWorkspaceRole,
} from "./models.ts";
import {
  getCancellationRequestForOrder,
  getOpenPreparationProblem,
} from "./selectors.ts";

const PENDING_BLOCKS_RESOLVE_ERROR =
  "Сначала дождитесь решения Direct по запросу на отмену.";

function getOrder(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((candidate) => candidate.id === orderId);
  assert.ok(order);
  return order;
}

/** Заказ ресторана-2 доводится до PREPARING в заданном режиме. */
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
    state = updateCartAddress(state, { street: "Тестовая улица 1", house: "1" });
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

/** Заказ в PREPARING с активной OPEN-проблемой приготовления. */
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

function requestByRestaurant(
  state: PrototypeState,
  orderId: string,
  problemId: string,
  role: "OPERATOR" | "COMBINED",
  reason = "Нет замены блюду",
) {
  const before = getOrder(state, orderId);
  return requestOrderCancellationByRestaurant(
    state,
    orderId,
    problemId,
    reason,
    "RESTAURANT",
    role,
    new Date(Date.parse(before.updatedAt) + 1_000).toISOString(),
  );
}

/** Инвариант: заказ и финансы не тронуты созданием/отклонением запроса. */
function assertLifecyclePreserved(before: Order, after: Order): void {
  assert.equal(after.status, before.status);
  assert.equal(after.expectedReadyAt, before.expectedReadyAt);
  assert.equal(after.preparationMinutes, before.preparationMinutes);
  assert.equal(after.items, before.items);
  assert.equal(after.etaAdjustments, before.etaAdjustments);
  assert.equal(after.paymentStatus, before.paymentStatus);
  assert.equal(after.paidAt, before.paidAt);
  assert.equal(after.financials, before.financials);
  assert.equal(after.pickupCode, before.pickupCode);
  assert.equal(after.pickupCodeUsed, before.pickupCodeUsed);
  assert.equal(after.assignedDriverId, before.assignedDriverId);
}

// 1 --------------------------------------------------------------------------

test("SPLIT OPERATOR создаёт PENDING request через общий pipeline", () => {
  const { state, orderId, problemId } = reportOpenProblem(
    "SPLIT_OPERATOR_KITCHEN",
  );
  const before = getOrder(state, orderId);
  const res = requestByRestaurant(state, orderId, problemId, "OPERATOR");

  assert.equal(res.result.ok, true, res.result.error ?? "");
  const request = getCancellationRequestForOrder(res.state, orderId);
  assert.ok(request);
  assert.equal(request.id, `cancellation-request-${orderId}`);
  assert.equal(request.status, "PENDING");
  assert.equal(request.requestedBy, "RESTAURANT");
  assert.equal(request.restaurantWorkspaceRole, "OPERATOR");
  assert.equal(request.preparationProblemId, problemId);
  assert.equal(request.requestedOrderStatus, "PREPARING");

  const after = getOrder(res.state, orderId);
  assert.equal(after.status, "PREPARING");
  const newEvents = after.history.slice(before.history.length);
  assert.equal(newEvents.length, 1);
  assert.equal(newEvents[0].type, "STATUS");
  assert.equal(newEvents[0].fromStatus, "PREPARING");
  assert.equal(newEvents[0].toStatus, "PREPARING");
  assert.equal(newEvents[0].restaurantWorkspaceRole, "OPERATOR");
  assert.match(newEvents[0].message ?? "", /запросил отмену у Direct/);
  // Проблема остаётся активной до решения Direct.
  assert.ok(getOpenPreparationProblem(after));
});

// 2 --------------------------------------------------------------------------

test("SPLIT KITCHEN получает отказ без мутации", () => {
  const { state, orderId, problemId } = reportOpenProblem(
    "SPLIT_OPERATOR_KITCHEN",
  );
  const res = requestByRestaurant(
    state,
    orderId,
    problemId,
    "KITCHEN" as "OPERATOR",
  );

  assert.equal(res.result.ok, false);
  assert.equal(res.state, state, "исходный state тем же объектом");
  assert.equal(res.state.revision, state.revision);
  assert.equal(getCancellationRequestForOrder(res.state, orderId), null);
  assertLifecyclePreserved(
    getOrder(state, orderId),
    getOrder(res.state, orderId),
  );
});

// 3 --------------------------------------------------------------------------

test("COMBINED создаёт request с ролью COMBINED", () => {
  const { state, orderId, problemId } = reportOpenProblem("COMBINED");
  const res = requestByRestaurant(state, orderId, problemId, "COMBINED");

  assert.equal(res.result.ok, true, res.result.error ?? "");
  const request = getCancellationRequestForOrder(res.state, orderId);
  assert.ok(request);
  assert.equal(request.requestedBy, "RESTAURANT");
  assert.equal(request.restaurantWorkspaceRole, "COMBINED");
  assert.equal(request.preparationProblemId, problemId);
});

// 4 --------------------------------------------------------------------------

test("без OPEN-проблемы запрос запрещён", () => {
  const prepared = makePreparingOrder("SPLIT_OPERATOR_KITCHEN");
  const res = requestOrderCancellationByRestaurant(
    prepared.state,
    prepared.orderId,
    "нет-проблемы",
    "Причина",
    "RESTAURANT",
    "OPERATOR",
    new Date(
      Date.parse(getOrder(prepared.state, prepared.orderId).updatedAt) + 1_000,
    ).toISOString(),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, prepared.state);
  assert.equal(getCancellationRequestForOrder(res.state, prepared.orderId), null);
});

// 5 --------------------------------------------------------------------------

test("чужой/устаревший problemId запрещён", () => {
  const { state, orderId } = reportOpenProblem("SPLIT_OPERATOR_KITCHEN");
  const res = requestByRestaurant(
    state,
    orderId,
    "чужой-problem-id",
    "OPERATOR",
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
  assert.equal(getCancellationRequestForOrder(res.state, orderId), null);
});

// 6 --------------------------------------------------------------------------

test("повторный запрос на тот же заказ запрещён (без дубликата)", () => {
  const { state, orderId, problemId } = reportOpenProblem(
    "SPLIT_OPERATOR_KITCHEN",
  );
  const first = requestByRestaurant(state, orderId, problemId, "OPERATOR");
  assert.equal(first.result.ok, true);

  const second = requestByRestaurant(
    first.state,
    orderId,
    problemId,
    "OPERATOR",
  );
  assert.equal(second.result.ok, false);
  assert.equal(second.state, first.state, "свежий state тем же объектом");
  assert.equal(second.state.revision, first.state.revision);
  assert.equal(
    first.state.cancellationRequests.filter((r) => r.orderId === orderId)
      .length,
    1,
  );
});

// 7 --------------------------------------------------------------------------

test("пустая и слишком длинная причина запрещены", () => {
  const { state, orderId, problemId } = reportOpenProblem(
    "SPLIT_OPERATOR_KITCHEN",
  );
  const empty = requestByRestaurant(state, orderId, problemId, "OPERATOR", "   ");
  assert.equal(empty.result.ok, false);
  assert.equal(empty.state, state);

  const tooLong = requestByRestaurant(
    state,
    orderId,
    problemId,
    "OPERATOR",
    "я".repeat(301),
  );
  assert.equal(tooLong.result.ok, false);
  assert.equal(tooLong.state, state);
  assert.equal(getCancellationRequestForOrder(state, orderId), null);
});

// 8 --------------------------------------------------------------------------

test("PENDING ресторанный request блокирует resolve проблемы", () => {
  const { state, orderId, problemId } = reportOpenProblem(
    "SPLIT_OPERATOR_KITCHEN",
  );
  const requested = requestByRestaurant(state, orderId, problemId, "OPERATOR");
  assert.equal(requested.result.ok, true);

  const before = getOrder(requested.state, orderId);
  const resolveAttempt = resolveRestaurantPreparationProblem(
    requested.state,
    orderId,
    problemId,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(before.updatedAt) + 1_000).toISOString(),
  );
  assert.equal(resolveAttempt.result.ok, false);
  assert.equal(resolveAttempt.result.error, PENDING_BLOCKS_RESOLVE_ERROR);
  assert.equal(resolveAttempt.state, requested.state, "без мутации");
  assert.ok(getOpenPreparationProblem(getOrder(resolveAttempt.state, orderId)));
});

// 9 --------------------------------------------------------------------------

test("REJECTED: заказ PREPARING, проблема OPEN, resolve снова возможен", () => {
  const { state, orderId, problemId } = reportOpenProblem(
    "SPLIT_OPERATOR_KITCHEN",
  );
  const requested = requestByRestaurant(state, orderId, problemId, "OPERATOR");
  const requestId = getCancellationRequestForOrder(
    requested.state,
    orderId,
  )!.id;

  const rejected = rejectCancellationRequest(
    requested.state,
    requestId,
    "Готовьте из аналога",
  );
  assert.equal(rejected.result.ok, true, rejected.result.error ?? "");
  const afterReject = getOrder(rejected.state, orderId);
  assert.equal(afterReject.status, "PREPARING");
  assert.equal(
    getCancellationRequestForOrder(rejected.state, orderId)!.status,
    "REJECTED",
  );
  assert.ok(getOpenPreparationProblem(afterReject));

  const resolved = resolveRestaurantPreparationProblem(
    rejected.state,
    orderId,
    problemId,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(afterReject.updatedAt) + 1_000).toISOString(),
  );
  assert.equal(resolved.result.ok, true, resolved.result.error ?? "");
  assert.equal(getOrder(resolved.state, orderId).status, "PREPARING");
  assert.equal(getOpenPreparationProblem(getOrder(resolved.state, orderId)), null);
});

// 10 -------------------------------------------------------------------------

test("APPROVED: заказ CANCELED, финансы сохранены, водитель освобождён", () => {
  const { state, orderId, problemId } = reportOpenProblem("COMBINED", "DELIVERY");
  // Назначим водителя вручную, чтобы проверить его освобождение при APPROVED.
  const driverId = state.drivers[0].id;
  const withDriver: PrototypeState = {
    ...state,
    drivers: state.drivers.map((d) =>
      d.id === driverId ? { ...d, status: "BUSY" } : d,
    ),
    orders: state.orders.map((o) =>
      o.id === orderId ? { ...o, assignedDriverId: driverId } : o,
    ),
  };
  const requested = requestByRestaurant(
    withDriver,
    orderId,
    problemId,
    "COMBINED",
  );
  assert.equal(requested.result.ok, true, requested.result.error ?? "");
  const before = getOrder(requested.state, orderId);
  const requestId = getCancellationRequestForOrder(
    requested.state,
    orderId,
  )!.id;

  const approved = approveCancellationRequest(
    requested.state,
    requestId,
    "Отмена согласована",
  );
  assert.equal(approved.result.ok, true, approved.result.error ?? "");
  const after = getOrder(approved.state, orderId);
  assert.equal(after.status, "CANCELED");
  assert.equal(
    getCancellationRequestForOrder(approved.state, orderId)!.status,
    "APPROVED",
  );
  // Финансы и оплата сохранены, settlements не тронуты, refund не выполнен.
  assert.equal(after.paymentStatus, before.paymentStatus);
  assert.equal(after.paidAt, before.paidAt);
  assert.equal(after.financials, before.financials);
  assert.equal(approved.state.settlements, state.settlements);
  // Водитель освобождён.
  assert.equal(after.assignedDriverId, null);
  assert.equal(
    approved.state.drivers.find((d) => d.id === driverId)!.status,
    "AVAILABLE",
  );
});

// 11 -------------------------------------------------------------------------

test("legacy/client request: undefined requestedBy трактуется как CLIENT", () => {
  // Клиентский flow работает как раньше и помечает запрос requestedBy CLIENT.
  const prepared = makePreparingOrder("SPLIT_OPERATOR_KITCHEN");
  const clientReq = requestOrderCancellationByClient(
    prepared.state,
    prepared.orderId,
    "Передумал",
  );
  assert.equal(clientReq.result.ok, true, clientReq.result.error ?? "");
  assert.equal(
    getCancellationRequestForOrder(clientReq.state, prepared.orderId)!
      .requestedBy,
    "CLIENT",
  );

  // Клиентский PENDING-запрос не блокирует resolve (только RESTAURANT-запрос).
  const open = reportOpenProblem("SPLIT_OPERATOR_KITCHEN");
  const withClient = requestOrderCancellationByClient(
    open.state,
    open.orderId,
    "Передумал",
  );
  assert.equal(withClient.result.ok, true);
  const afterClient = getOrder(withClient.state, open.orderId);
  const resolvedOverClient = resolveRestaurantPreparationProblem(
    withClient.state,
    open.orderId,
    open.problemId,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(afterClient.updatedAt) + 1_000).toISOString(),
  );
  assert.equal(
    resolvedOverClient.result.ok,
    true,
    resolvedOverClient.result.error ?? "",
  );

  // Legacy-запрос без поля requestedBy трактуется как CLIENT — не блокирует resolve.
  const legacy = reportOpenProblem("SPLIT_OPERATOR_KITCHEN");
  const legacyRequest: CancellationRequest = {
    id: `cancellation-request-${legacy.orderId}`,
    orderId: legacy.orderId,
    customerId: getOrder(legacy.state, legacy.orderId).customer.id,
    restaurantId: getOrder(legacy.state, legacy.orderId).restaurant.id,
    requestedAt: getOrder(legacy.state, legacy.orderId).updatedAt,
    requestedOrderStatus: "PREPARING",
    paymentMethod: getOrder(legacy.state, legacy.orderId).paymentMethod,
    reason: "Старый запрос",
    status: "PENDING",
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    // requestedBy намеренно отсутствует (старое сохранённое состояние).
  };
  const withLegacy: PrototypeState = {
    ...legacy.state,
    cancellationRequests: [...legacy.state.cancellationRequests, legacyRequest],
  };
  const resolvedOverLegacy = resolveRestaurantPreparationProblem(
    withLegacy,
    legacy.orderId,
    legacy.problemId,
    "Проблема устранена",
    "RESTAURANT",
    "OPERATOR",
    new Date(
      Date.parse(getOrder(withLegacy, legacy.orderId).updatedAt) + 1_000,
    ).toISOString(),
  );
  assert.equal(
    resolvedOverLegacy.result.ok,
    true,
    resolvedOverLegacy.result.error ?? "",
  );
});

// 12 -------------------------------------------------------------------------

test("race: после rebase создаётся только один request", () => {
  const { state, orderId, problemId } = reportOpenProblem(
    "SPLIT_OPERATOR_KITCHEN",
  );
  // Первая вкладка коммитит запрос.
  const first = requestByRestaurant(state, orderId, problemId, "OPERATOR");
  assert.equal(first.result.ok, true);

  // Вторая вкладка после rebase выполняется уже на свежем (закоммиченном) state.
  const second = requestByRestaurant(first.state, orderId, problemId, "OPERATOR");
  assert.equal(second.result.ok, false);
  assert.equal(second.state, first.state, "исходный свежий state тем же объектом");
  assert.equal(
    first.state.cancellationRequests.filter((r) => r.orderId === orderId)
      .length,
    1,
  );
});
