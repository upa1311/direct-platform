import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  createOrderFromCart,
  rejectCancellationRequest,
  reportRestaurantPreparationProblem,
  requestOrderCancellationByClient,
  requestOrderCancellationByRestaurant,
  setCartFulfillmentChoice,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import type {
  CancellationRequest,
  Order,
  OrderHistoryEvent,
  PrototypeState,
  RestaurantOrderWorkflowMode,
  RestaurantWorkspaceRole,
} from "./models.ts";
import {
  clientHistoryEvent,
  getCancellationRequestForOrder,
  getClientCancellationMessage,
  getOpenPreparationProblem,
} from "./selectors.ts";

const INTERNAL_REASON = "СЕКРЕТНАЯ внутренняя причина склада 12345";
const ADMIN_NOTE = "Внутренний комментарий администратора №42 для аудита";

function getOrder(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((candidate) => candidate.id === orderId);
  assert.ok(order);
  return order;
}

function lastEvent(order: Order): OrderHistoryEvent {
  return order.history[order.history.length - 1];
}

function makePreparingOrder(mode: RestaurantOrderWorkflowMode): {
  state: PrototypeState;
  orderId: string;
} {
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
  state = setCartFulfillmentChoice(state, "PICKUP");
  state = addCartItem(state, `${restaurantId}-item-1`).state;
  const created = createOrderFromCart(state);
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
  assert.equal(getOrder(accepted.state, orderId).status, "PREPARING");
  return { state: accepted.state, orderId };
}

function reportOpenProblem(mode: RestaurantOrderWorkflowMode): {
  state: PrototypeState;
  orderId: string;
  problemId: string;
} {
  const prepared = makePreparingOrder(mode);
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

function makeRequest(
  overrides: Partial<CancellationRequest> = {},
): CancellationRequest {
  return {
    id: "cancellation-request-o1",
    orderId: "o1",
    customerId: "c1",
    restaurantId: "r1",
    requestedAt: "2026-01-01T00:00:00.000Z",
    requestedOrderStatus: "PREPARING",
    paymentMethod: "ONLINE",
    reason: INTERNAL_REASON,
    status: "PENDING",
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    ...overrides,
  };
}

// 1 --------------------------------------------------------------------------

test("ресторанный request: причина в CancellationRequest, но не в истории", () => {
  const { state, orderId, problemId } = reportOpenProblem(
    "SPLIT_OPERATOR_KITCHEN",
  );
  const before = getOrder(state, orderId);
  const res = requestOrderCancellationByRestaurant(
    state,
    orderId,
    problemId,
    INTERNAL_REASON,
    "RESTAURANT",
    "OPERATOR",
    new Date(Date.parse(before.updatedAt) + 1_000).toISOString(),
  );
  assert.equal(res.result.ok, true, res.result.error ?? "");

  const request = getCancellationRequestForOrder(res.state, orderId);
  assert.ok(request);
  assert.equal(request.reason, INTERNAL_REASON);

  const after = getOrder(res.state, orderId);
  assert.equal(after.status, "PREPARING");
  assert.equal(after.history.length, before.history.length + 1);
  const created = lastEvent(after);
  assert.equal(created.type, "STATUS");
  assert.ok(
    !created.message?.includes(INTERNAL_REASON),
    "внутренняя причина не должна попасть в history message",
  );
  // Клиентское представление тоже безопасно и нейтрально.
  const clientView = clientHistoryEvent(created, after, true);
  assert.ok(!clientView.message.includes(INTERNAL_REASON));
  assert.equal(clientView.message, "Ресторан отправил запрос на отмену в Direct.");
});

// 2 --------------------------------------------------------------------------

test("ресторанный REJECTED: комментарий админа в resolutionNote, не в истории", () => {
  const open = reportOpenProblem("SPLIT_OPERATOR_KITCHEN");
  const requested = requestOrderCancellationByRestaurant(
    open.state,
    open.orderId,
    open.problemId,
    INTERNAL_REASON,
    "RESTAURANT",
    "OPERATOR",
    new Date(
      Date.parse(getOrder(open.state, open.orderId).updatedAt) + 1_000,
    ).toISOString(),
  );
  const requestId = getCancellationRequestForOrder(
    requested.state,
    open.orderId,
  )!.id;

  const rejected = rejectCancellationRequest(requested.state, requestId, ADMIN_NOTE);
  assert.equal(rejected.result.ok, true, rejected.result.error ?? "");

  const request = getCancellationRequestForOrder(rejected.state, open.orderId)!;
  assert.equal(request.status, "REJECTED");
  assert.equal(request.resolutionNote, ADMIN_NOTE);

  const after = getOrder(rejected.state, open.orderId);
  assert.equal(after.status, "PREPARING");
  assert.ok(getOpenPreparationProblem(after), "проблема остаётся OPEN");
  const rejectEvent = lastEvent(after);
  assert.ok(
    !rejectEvent.message?.includes(ADMIN_NOTE),
    "комментарий администратора не должен попасть в history",
  );
  assert.ok(
    !clientHistoryEvent(rejectEvent, after, true).message.includes(ADMIN_NOTE),
  );
});

// 3 --------------------------------------------------------------------------

test("клиентский REJECTED: текст и resolutionNote для клиента сохранены", () => {
  const prepared = makePreparingOrder("COMBINED");
  const clientReq = requestOrderCancellationByClient(
    prepared.state,
    prepared.orderId,
    "Передумал",
  );
  assert.equal(clientReq.result.ok, true);
  const requestId = getCancellationRequestForOrder(
    clientReq.state,
    prepared.orderId,
  )!.id;
  const clientNote = "Готовьте дальше, отмена невозможна";
  const rejected = rejectCancellationRequest(clientReq.state, requestId, clientNote);
  assert.equal(rejected.result.ok, true, rejected.result.error ?? "");

  const request = getCancellationRequestForOrder(rejected.state, prepared.orderId)!;
  assert.equal(request.resolutionNote, clientNote);
  // Клиентский reject-текст адресован клиенту — причина сохраняется в истории.
  const rejectEvent = lastEvent(getOrder(rejected.state, prepared.orderId));
  assert.ok(rejectEvent.message?.includes(clientNote));
  // И статус-хелпер показывает клиенту его причину.
  assert.ok(getClientCancellationMessage(request)?.includes(clientNote));
});

// 4 --------------------------------------------------------------------------

test("getClientCancellationMessage: клиент — как раньше, ресторан — без внутренних данных", () => {
  // CLIENT / legacy — существующие тексты.
  assert.equal(
    getClientCancellationMessage(makeRequest({ requestedBy: "CLIENT", status: "PENDING" })),
    "Запрос на отмену рассматривается",
  );
  assert.equal(
    getClientCancellationMessage(makeRequest({ status: "APPROVED" })), // legacy undefined → CLIENT
    "Отмена одобрена администратором",
  );
  const clientRejected = makeRequest({
    requestedBy: "CLIENT",
    status: "REJECTED",
    resolutionNote: "клиентское решение",
  });
  assert.ok(getClientCancellationMessage(clientRejected)?.includes("клиентское решение"));

  // RESTAURANT — ни reason, ни resolutionNote наружу.
  const base = {
    requestedBy: "RESTAURANT" as const,
    preparationProblemId: "p1",
    reason: INTERNAL_REASON,
  };
  const pending = getClientCancellationMessage(makeRequest({ ...base, status: "PENDING" }))!;
  assert.ok(!pending.includes(INTERNAL_REASON));
  assert.match(pending, /Ресторан сообщил о проблеме/);

  const rejected = getClientCancellationMessage(
    makeRequest({ ...base, status: "REJECTED", resolutionNote: ADMIN_NOTE }),
  )!;
  assert.ok(!rejected.includes(ADMIN_NOTE));
  assert.ok(!rejected.includes(INTERNAL_REASON));
  assert.equal(rejected, "Заказ продолжает выполняться.");

  const approved = getClientCancellationMessage(
    makeRequest({ ...base, status: "APPROVED", resolutionNote: ADMIN_NOTE }),
  )!;
  assert.ok(!approved.includes(ADMIN_NOTE));
  assert.equal(approved, "Заказ отменён администратором Direct.");
});

// 5 --------------------------------------------------------------------------

test("clientHistoryEvent: событие ресторанного request безопасно, клиентское — нет", () => {
  const order = { deliveryMode: "PICKUP" } as unknown as Order;

  // Legacy-событие с причиной в message + рабочей ролью → нейтрализуется.
  const legacyRestaurantEvent = {
    id: "e1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    actor: "RESTAURANT",
    type: "STATUS",
    fromStatus: "PREPARING",
    toStatus: "PREPARING",
    message: `Ресторан запросил отмену у Direct. Причина: ${INTERNAL_REASON}`,
    restaurantWorkspaceRole: "OPERATOR",
  } as unknown as OrderHistoryEvent;
  const safe = clientHistoryEvent(legacyRestaurantEvent, order, true);
  assert.ok(!safe.message.includes(INTERNAL_REASON));
  assert.equal(safe.message, "Ресторан отправил запрос на отмену в Direct.");
  assert.equal(safe.hideActor, true);

  // Клиентский запрос (без рабочей роли) под правило не попадает — свой текст.
  const clientEvent = {
    id: "e2",
    occurredAt: "2026-01-01T00:00:00.000Z",
    actor: "CLIENT",
    type: "STATUS",
    fromStatus: "PREPARING",
    toStatus: "PREPARING",
    message: "Клиент отправил запрос на отмену. Причина: Передумал",
  } as unknown as OrderHistoryEvent;
  const clientView = clientHistoryEvent(clientEvent, order, true);
  assert.equal(clientView.message, "Клиент отправил запрос на отмену. Причина: Передумал");
  assert.equal(clientView.hideActor, false);
});
