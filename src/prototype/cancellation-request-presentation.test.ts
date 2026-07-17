import assert from "node:assert/strict";
import { test } from "node:test";

import type { CancellationRequest, Order } from "./models.ts";
import {
  PREPARATION_PROBLEM_KITCHEN_PREFIX,
  getCancellationRequester,
  getPreparationProblemById,
  getRestaurantCancellationUiState,
  isRestaurantCancellationForProblem,
  restaurantWorkspaceRoleLabel,
} from "./selectors.ts";

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
    reason: "причина",
    status: "PENDING",
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    ...overrides,
  };
}

function orderWithProblem(problemId: string, kitchenReason: string): Order {
  return {
    history: [
      {
        id: problemId,
        occurredAt: "2026-01-01T00:00:00.000Z",
        actor: "RESTAURANT",
        type: "PREPARATION_PROBLEM",
        fromStatus: "PREPARING",
        toStatus: "PREPARING",
        message: `${PREPARATION_PROBLEM_KITCHEN_PREFIX}${kitchenReason}`,
        preparationProblemId: problemId,
        preparationProblemState: "OPEN",
      },
    ],
  } as unknown as Order;
}

// 1 --------------------------------------------------------------------------

test("legacy requestedBy undefined → CLIENT", () => {
  assert.equal(getCancellationRequester(makeRequest()), "CLIENT");
});

// 2 --------------------------------------------------------------------------

test("новый клиентский request → CLIENT", () => {
  assert.equal(
    getCancellationRequester(makeRequest({ requestedBy: "CLIENT" })),
    "CLIENT",
  );
});

// 3 --------------------------------------------------------------------------

test("ресторанный request распознаётся и совпадает только со своим problemId", () => {
  const request = makeRequest({
    requestedBy: "RESTAURANT",
    preparationProblemId: "p1",
  });
  assert.equal(getCancellationRequester(request), "RESTAURANT");
  assert.equal(isRestaurantCancellationForProblem(request, "p1"), true);
  assert.equal(isRestaurantCancellationForProblem(request, "p2"), false);
  assert.equal(isRestaurantCancellationForProblem(null, "p1"), false);
});

// 4 --------------------------------------------------------------------------

test("UI-state ресторанного request: PENDING / REJECTED / APPROVED", () => {
  const base = { requestedBy: "RESTAURANT" as const, preparationProblemId: "p1" };
  assert.equal(
    getRestaurantCancellationUiState(
      makeRequest({ ...base, status: "PENDING" }),
      "p1",
    ),
    "PENDING",
  );
  assert.equal(
    getRestaurantCancellationUiState(
      makeRequest({ ...base, status: "REJECTED" }),
      "p1",
    ),
    "REJECTED",
  );
  assert.equal(
    getRestaurantCancellationUiState(
      makeRequest({ ...base, status: "APPROVED" }),
      "p1",
    ),
    "APPROVED",
  );
  // Другой problemId — не относится к этой проблеме.
  assert.equal(
    getRestaurantCancellationUiState(makeRequest(base), "p2"),
    "NONE",
  );
});

// 5 --------------------------------------------------------------------------

test("CLIENT request не считается ресторанным request проблемы", () => {
  const client = makeRequest({
    requestedBy: "CLIENT",
    preparationProblemId: "p1",
  });
  assert.equal(isRestaurantCancellationForProblem(client, "p1"), false);
  assert.equal(getRestaurantCancellationUiState(client, "p1"), "NONE");
  // Legacy тоже трактуется как CLIENT.
  assert.equal(
    getRestaurantCancellationUiState(makeRequest({ preparationProblemId: "p1" }), "p1"),
    "NONE",
  );
});

// 6 --------------------------------------------------------------------------

test("REJECTED restaurant request: состояние REJECTED (cancel-кнопка не предлагается)", () => {
  // На уровне presentation UI-state REJECTED — сигнал скрыть кнопку отмены;
  // повторную отмену не предлагаем (один request на заказ). Resolve при этом
  // разрешён domain-слоем (проверяется в restaurant-cancellation-request.test).
  const rejected = makeRequest({
    requestedBy: "RESTAURANT",
    preparationProblemId: "p1",
    status: "REJECTED",
    resolutionNote: "Готовьте из аналога",
  });
  assert.equal(getRestaurantCancellationUiState(rejected, "p1"), "REJECTED");
});

// 7 --------------------------------------------------------------------------

test("PENDING restaurant request: состояние PENDING (resolve не предлагается)", () => {
  const pending = makeRequest({
    requestedBy: "RESTAURANT",
    preparationProblemId: "p1",
    status: "PENDING",
  });
  assert.equal(getRestaurantCancellationUiState(pending, "p1"), "PENDING");
});

// 8 --------------------------------------------------------------------------

test("admin presentation: инициатор, рабочий экран, проблема кухни", () => {
  // Ярлыки инициатора выводятся из requester, не из сырого enum.
  assert.equal(getCancellationRequester(makeRequest({ requestedBy: "RESTAURANT" })), "RESTAURANT");
  assert.equal(getCancellationRequester(makeRequest({ requestedBy: "CLIENT" })), "CLIENT");

  // Рабочий экран — человекочитаемый, сырой enum не возвращается.
  assert.equal(restaurantWorkspaceRoleLabel("OPERATOR"), "Оператор заказов");
  assert.equal(restaurantWorkspaceRoleLabel("COMBINED"), "Общий экран");
  assert.equal(restaurantWorkspaceRoleLabel("KITCHEN"), null);
  assert.equal(restaurantWorkspaceRoleLabel(undefined), null);

  // Причина кухни сопоставляется строго по preparationProblemId.
  const order = orderWithProblem("p1", "Нет рыбы");
  assert.equal(getPreparationProblemById(order, "p1")?.reason, "Нет рыбы");
  assert.equal(getPreparationProblemById(order, "p2"), null);
});
