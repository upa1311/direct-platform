import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  createOrderFromCart,
  markOrderReadyWithResult,
  setCartFulfillmentChoice,
  simulateSuccessfulOnlinePaymentWithResult,
  startKitchenPreparationWithResult,
  updateCartAddress,
} from "./actions.ts";
import type {
  PrototypeState,
  RestaurantOrderWorkflowMode,
  RestaurantWorkspaceRole,
} from "./models.ts";

/**
 * Подтверждение кухней «Начать готовить» (только SPLIT). Доменные инварианты:
 * kitchenStartedAt как источник истины, отдельное событие KITCHEN_START, права
 * (только кухня в SPLIT), идемпотентность и fail-closed готовности. React здесь
 * нет — только чистый домен.
 */

const RID = "restaurant-2";

function getOrder(state: PrototypeState, orderId: string) {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

/** Заказ в PREPARING для режима/способа получения (без подтверждения кухни). */
function preparingOrder(
  mode: RestaurantOrderWorkflowMode,
  fulfillment: "PICKUP" | "DELIVERY" = "PICKUP",
): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === RID ? { ...r, orderWorkflowMode: mode } : r,
    ),
  };
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  }
  s = addCartItem(s, `${RID}-item-1`, "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  const acceptRole: RestaurantWorkspaceRole =
    mode === "COMBINED" ? "COMBINED" : "OPERATOR";
  let next = acceptRestaurantOrderWithResult(
    created.state,
    orderId,
    20,
    "RESTAURANT",
    acceptRole,
  ).state;
  if (fulfillment === "DELIVERY") {
    next = simulateSuccessfulOnlinePaymentWithResult(next, orderId).state;
  }
  assert.equal(getOrder(next, orderId).status, "PREPARING");
  return { state: next, orderId };
}

// 1 — SPLIT: новый PREPARING получает kitchenStartedAt = null -------------------

test("SPLIT: заказ в PREPARING имеет kitchenStartedAt = null (наличные)", () => {
  const { state, orderId } = preparingOrder("SPLIT_OPERATOR_KITCHEN");
  assert.equal(getOrder(state, orderId).kitchenStartedAt, null);
});

test("SPLIT: онлайн-заказ после оплаты — PREPARING, kitchenStartedAt = null", () => {
  const { state, orderId } = preparingOrder("SPLIT_OPERATOR_KITCHEN", "DELIVERY");
  const order = getOrder(state, orderId);
  assert.equal(order.status, "PREPARING");
  assert.equal(order.kitchenStartedAt, null);
});

// 2 — COMBINED: переход в PREPARING автоматически ставит kitchenStartedAt --------

test("COMBINED: переход в PREPARING автоматически ставит kitchenStartedAt", () => {
  const { state, orderId } = preparingOrder("COMBINED");
  assert.notEqual(getOrder(state, orderId).kitchenStartedAt, null);
});

test("COMBINED: онлайн-заказ после оплаты сразу начат (kitchenStartedAt задан)", () => {
  const { state, orderId } = preparingOrder("COMBINED", "DELIVERY");
  assert.notEqual(getOrder(state, orderId).kitchenStartedAt, null);
});

// 3 — SPLIT KITCHEN успешно подтверждает начало --------------------------------

test("SPLIT KITCHEN: подтверждение начала ставит kitchenStartedAt и одно событие KITCHEN_START", () => {
  const { state, orderId } = preparingOrder("SPLIT_OPERATOR_KITCHEN");
  const before = getOrder(state, orderId);

  const res = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(res.result.ok, true);
  const order = getOrder(res.state, orderId);
  // Статус не меняется, фиксируется только начало.
  assert.equal(order.status, "PREPARING");
  assert.ok(order.kitchenStartedAt);
  // Ровно одно новое событие типа KITCHEN_START с ролью KITCHEN.
  assert.equal(order.history.length, before.history.length + 1);
  const ev = order.history.at(-1);
  assert.equal(ev?.type, "KITCHEN_START");
  assert.equal(ev?.fromStatus, "PREPARING");
  assert.equal(ev?.toStatus, "PREPARING");
  assert.equal(ev?.actor, "RESTAURANT");
  assert.equal(ev?.restaurantWorkspaceRole, "KITCHEN");
  assert.equal(ev?.occurredAt, order.kitchenStartedAt);
  // Отсчёт запускается ИМЕННО отсюда: до подтверждения времени готовности не
  // было, после — оно равно моменту клика плюс время приготовления.
  assert.equal(before.expectedReadyAt, null);
  assert.ok(order.expectedReadyAt);
  const deltaMin =
    (Date.parse(order.expectedReadyAt as string) -
      Date.parse(order.kitchenStartedAt as string)) /
    60_000;
  assert.equal(deltaMin, order.preparationMinutes);
  // Инварианты: ревизия +1, финансы/оплата/settlements не тронуты.
  assert.equal(res.state.revision, state.revision + 1);
  assert.deepEqual(order.financials, before.financials);
  assert.equal(order.preparationMinutes, before.preparationMinutes);
  assert.equal(order.paymentStatus, before.paymentStatus);
  assert.deepEqual(res.state.settlements, state.settlements);
});

test("legacy: устаревшее ожидаемое время пересчитывается от клика кухни", () => {
  const base = preparingOrder("SPLIT_OPERATOR_KITCHEN");
  // Заказ из старого состояния: начала нет, но время готовности уже шло.
  const staleIso = new Date(Date.now() - 60 * 60_000).toISOString();
  const legacy: PrototypeState = {
    ...base.state,
    orders: base.state.orders.map((o) =>
      o.id === base.orderId ? { ...o, expectedReadyAt: staleIso } : o,
    ),
  };

  const res = startKitchenPreparationWithResult(
    legacy,
    base.orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(res.result.ok, true);
  const order = getOrder(res.state, base.orderId);
  assert.notEqual(order.expectedReadyAt, staleIso, "старое время не продолжаем");
  const deltaMin =
    (Date.parse(order.expectedReadyAt as string) -
      Date.parse(order.kitchenStartedAt as string)) /
    60_000;
  assert.equal(deltaMin, order.preparationMinutes);
});

test("некорректное время приготовления не начинает приготовление", () => {
  const base = preparingOrder("SPLIT_OPERATOR_KITCHEN");
  for (const bad of [null, 0, -5, 12.5, Number.NaN]) {
    const broken: PrototypeState = {
      ...base.state,
      orders: base.state.orders.map((o) =>
        o.id === base.orderId
          ? { ...o, preparationMinutes: bad as number | null }
          : o,
      ),
    };
    const res = startKitchenPreparationWithResult(
      broken,
      base.orderId,
      "RESTAURANT",
      "KITCHEN",
    );
    assert.equal(res.result.ok, false, String(bad));
    assert.equal(res.result.error, "Не задано корректное время приготовления.");
    assert.equal(res.state, broken, "state тем же объектом");
    assert.equal(getOrder(res.state, base.orderId).kitchenStartedAt, null);
  }
});

// 4 — OPERATOR / COMBINED / ADMIN не могут вызвать кухонное действие ------------

test("SPLIT: оператор не может подтвердить начало за кухню", () => {
  const { state, orderId } = preparingOrder("SPLIT_OPERATOR_KITCHEN");
  const res = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
  assert.equal(getOrder(res.state, orderId).kitchenStartedAt, null);
});

test("ADMIN не подтверждает начало за кухню", () => {
  const { state, orderId } = preparingOrder("SPLIT_OPERATOR_KITCHEN");
  const res = startKitchenPreparationWithResult(state, orderId, "ADMIN");
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
});

test("COMBINED: подтверждения начала нет — действие отклоняется", () => {
  const { state, orderId } = preparingOrder("COMBINED");
  const res = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "COMBINED",
  );
  assert.equal(res.result.ok, false);
  assert.equal(
    res.result.error,
    "Подтверждение начала доступно только в раздельном режиме.",
  );
  assert.equal(res.state, state);
});

test("подтверждение в неправильном статусе (RESTAURANT_REVIEW) отклоняется", () => {
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === RID
        ? { ...r, orderWorkflowMode: "SPLIT_OPERATOR_KITCHEN" as const }
        : r,
    ),
  };
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, `${RID}-item-1`, "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  // Заказ ещё не принят — статус RESTAURANT_REVIEW.
  const res = startKitchenPreparationWithResult(
    created.state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.state, created.state);
});

// 5 — повторный клик не создаёт вторую мутацию и второе событие -----------------

test("повторное подтверждение начала — ошибка без второй мутации и события", () => {
  const { state, orderId } = preparingOrder("SPLIT_OPERATOR_KITCHEN");
  const first = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(first.result.ok, true);
  const startedAt = getOrder(first.state, orderId).kitchenStartedAt;
  const historyLen = getOrder(first.state, orderId).history.length;

  const second = startKitchenPreparationWithResult(
    first.state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  );
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Кухня уже подтвердила начало приготовления.");
  // Тот же объект state: без второй мутации, ревизии и события.
  assert.equal(second.state, first.state);
  assert.equal(second.state.revision, first.state.revision);
  const order = getOrder(second.state, orderId);
  assert.equal(order.kitchenStartedAt, startedAt);
  assert.equal(order.history.length, historyLen);
});

// 6/7 — markReady fail-closed до начала и успешен после -------------------------

test("SPLIT: markReady заблокирован до подтверждения начала, доступен после", () => {
  const { state, orderId } = preparingOrder("SPLIT_OPERATOR_KITCHEN");
  const early = markOrderReadyWithResult(state, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(early.result.ok, false);
  assert.equal(early.result.error, "Сначала подтвердите начало приготовления.");
  assert.equal(early.state, state);

  const started = startKitchenPreparationWithResult(
    state,
    orderId,
    "RESTAURANT",
    "KITCHEN",
  ).state;
  const ready = markOrderReadyWithResult(started, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(ready.result.ok, true);
  assert.equal(getOrder(ready.state, orderId).status, "READY_FOR_PICKUP");
});

// 14 — COMBINED готовность работает без явного подтверждения --------------------

test("COMBINED: markReady работает без отдельного подтверждения начала", () => {
  const { state, orderId } = preparingOrder("COMBINED");
  const ready = markOrderReadyWithResult(state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(ready.result.ok, true);
  assert.equal(getOrder(ready.state, orderId).status, "READY_FOR_PICKUP");
});
