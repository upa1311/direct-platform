import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  adminSetPreparationMinutesWithResult,
  assignDriverToOrder,
  createOrderFromCart,
  goDriverOnline,
  markOrderArrivingWithResult,
  markOrderDeliveredWithResult,
  markOrderOutForDeliveryWithResult,
  markOrderReady,
  markOrderReadyWithResult,
  resetPrototypeState,
  setCartFulfillmentChoice,
  setRestaurantAcceptingOrders,
  setRestaurantAcceptingOrdersWithResult,
  setRestaurantWorkflowModeWithResult,
  simulateSuccessfulOnlinePayment,
  simulateSuccessfulOnlinePaymentWithResult,
  updateCartAddress,
} from "./actions.ts";
import {
  markDriverArrivedAtRestaurant,
  markDriverArrivingToCustomer,
  markDriverDeliveredOrder,
  markDriverPickedUpOrder,
} from "./driver-delivery.ts";
import {
  executeSerializedPrototypeMutation,
  type MutationAck,
} from "./prototype-store.ts";
import type { Order, PrototypeState } from "./models.ts";

/**
 * Исправления 2–3: семантика MutationAck и result-based lifecycle actions.
 * Ack строится так же, как в provider.runSerializedStateMutation: успех
 * транзакции + фактический outcome.committed.
 */

/** Модель runSerializedStateMutation поверх чистого ядра транзакции. */
function stateOnlyAck(
  localState: PrototypeState,
  mutation: (base: PrototypeState) => PrototypeState,
): { ack: MutationAck; nextState: PrototypeState } {
  const outcome = executeSerializedPrototypeMutation({
    localState,
    storedState: null,
    mutation: (base) => ({ state: mutation(base), result: null }),
    persist: () => {},
  });
  return {
    ack: { ok: true, error: null, changed: outcome.committed },
    nextState: outcome.nextState,
  };
}

function deliveryOrderState(restaurantId: "restaurant-2" | "restaurant-3"): {
  state: PrototypeState;
  orderId: string;
} {
  // v16: назначить можно только онлайн-водителя с подтверждённой зоной.
  let s = goDriverOnline(createDefaultState(), "driver-1", "zone-1").state;
  s = setCartFulfillmentChoice(s, "DELIVERY");
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  const created = createOrderFromCart(s);
  assert.ok(created.result.orderId, created.result.error ?? "");
  return { state: created.state, orderId: created.result.orderId as string };
}

/** Доводит заказ до PREPARING (принят + онлайн-оплата подтверждена). */
function preparingOrderState(
  restaurantId: "restaurant-2" | "restaurant-3",
): { state: PrototypeState; orderId: string } {
  const { state, orderId } = deliveryOrderState(restaurantId);
  let s = acceptRestaurantOrder(state, orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, orderId);
  const order = s.orders.find((o) => o.id === orderId) as Order;
  assert.equal(order.status, "PREPARING");
  return { state: s, orderId };
}

function getOrder(state: PrototypeState, orderId: string): Order {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
}

// ─── Тесты 4–6: семантика MutationAck ────────────────────────────────────────

test("Тест 4: state-only committed mutation возвращает changed: true", () => {
  const s = createDefaultState();
  const { ack } = stateOnlyAck(s, (base) =>
    setRestaurantAcceptingOrders(base, "restaurant-2", false),
  );
  assert.deepEqual(ack, { ok: true, error: null, changed: true });
});

test("Тест 5: допустимый идемпотентный no-op возвращает ok: true, changed: false", () => {
  const s = createDefaultState();
  // restaurant-2 уже принимает заказы: требуемое значение уже установлено.
  const { ack, nextState } = stateOnlyAck(s, (base) =>
    setRestaurantAcceptingOrders(base, "restaurant-2", true),
  );
  assert.deepEqual(ack, { ok: true, error: null, changed: false });
  assert.equal(nextState, s);

  // Result-based версия — тот же идемпотентный успех без изменения state.
  const res = setRestaurantAcceptingOrdersWithResult(s, "restaurant-2", true);
  assert.equal(res.result.ok, true);
  assert.equal(res.state, s);
});

test("Тест 6: недопустимый lifecycle no-op возвращает ok: false", () => {
  const { state, orderId } = deliveryOrderState("restaurant-2");
  // Заказ в RESTAURANT_REVIEW — готовность ставить рано.
  const res = markOrderReadyWithResult(state, orderId);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Заказ ещё не готов к этому переходу.");
  // Исходный state тем же объектом: revision/history/финансы не тронуты.
  assert.equal(res.state, state);
});

// ─── Тесты 7–8: markReady ────────────────────────────────────────────────────

test("Тест 7: markReady в неправильном статусе возвращает ошибку", () => {
  const { state, orderId } = deliveryOrderState("restaurant-2");
  const accepted = acceptRestaurantOrder(state, orderId, 20);
  // ONLINE-заказ после принятия ждёт оплату — готовность недопустима.
  assert.equal(getOrder(accepted, orderId).status, "AWAITING_PAYMENT");
  const res = markOrderReadyWithResult(accepted, orderId);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Заказ ещё не готов к этому переходу.");
  assert.equal(res.state, accepted);
});

test("Тест 8: повторный markReady возвращает ошибку без history event", () => {
  const { state, orderId } = preparingOrderState("restaurant-3");
  const first = markOrderReadyWithResult(state, orderId);
  assert.equal(first.result.ok, true);
  const readyOrder = getOrder(first.state, orderId);
  assert.equal(readyOrder.status, "READY");
  const historyAfterFirst = readyOrder.history.length;

  const second = markOrderReadyWithResult(first.state, orderId);
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Заказ уже обработан. Обновите данные.");
  assert.equal(second.state, first.state);
  assert.equal(getOrder(second.state, orderId).history.length, historyAfterFirst);
});

test("markReady: несуществующий заказ — «Заказ не найден.»", () => {
  const s = createDefaultState();
  const res = markOrderReadyWithResult(s, "order-нет");
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Заказ не найден.");
});

// ─── Тест 9: handoff в неправильном статусе ──────────────────────────────────

test("Тест 9: handoff в неправильном статусе возвращает ошибку", () => {
  const { state, orderId } = preparingOrderState("restaurant-3");
  // Заказ ещё готовится: «курьер выехал» рано.
  const early = markOrderOutForDeliveryWithResult(state, orderId);
  assert.equal(early.result.ok, false);
  assert.equal(early.result.error, "Заказ ещё не готов к этому переходу.");
  assert.equal(early.state, state);

  // ARRIVING без OUT_FOR_DELIVERY — тоже ошибка.
  const arriving = markOrderArrivingWithResult(state, orderId);
  assert.equal(arriving.result.ok, false);

  // Доставленный заказ повторно «выехать» не может.
  let s = markOrderReady(state, orderId);
  s = markOrderOutForDeliveryWithResult(s, orderId).state;
  s = markOrderArrivingWithResult(s, orderId).state;
  const delivered = markOrderDeliveredWithResult(s, orderId);
  assert.equal(delivered.result.ok, true);
  const again = markOrderOutForDeliveryWithResult(delivered.state, orderId);
  assert.equal(again.result.ok, false);
  assert.equal(again.result.error, "Заказ уже обработан. Обновите данные.");
});

// ─── Тест 10: доставка без назначенного водителя ─────────────────────────────

test("Тест 10: delivery without assigned driver возвращает ошибку", () => {
  const { state, orderId } = preparingOrderState("restaurant-2");
  const ready = markOrderReady(state, orderId);
  assert.equal(getOrder(ready, orderId).status, "READY");

  // v18: ресторан/админ курьерский этап заказа Direct не двигает.
  const res = markOrderOutForDeliveryWithResult(ready, orderId);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Этот этап отмечает назначенный водитель Direct.");
  assert.equal(res.state, ready);

  // Даже с назначенным водителем ресторанский переход отклоняется.
  const assigned = assignDriverToOrder(ready, orderId, "driver-1");
  assert.equal(assigned.result.ok, true);
  const blocked = markOrderOutForDeliveryWithResult(assigned.state, orderId);
  assert.equal(blocked.result.ok, false);
  // Заказ забирает сам водитель: READY → OUT_FOR_DELIVERY.
  const arrived = markDriverArrivedAtRestaurant(assigned.state, "driver-1", orderId, "2026-07-22T12:00:00.000Z");
  const picked = markDriverPickedUpOrder(arrived.state, "driver-1", orderId, "2026-07-22T12:01:00.000Z");
  assert.equal(picked.result.ok, true, picked.result.error ?? "");
  assert.equal(getOrder(picked.state, orderId).status, "OUT_FOR_DELIVERY");
});

test("Водитель Direct: markDeliveredByDriver повторно — ошибка, водитель освобождён один раз", () => {
  const { state, orderId } = preparingOrderState("restaurant-2");
  let s = markOrderReady(state, orderId);
  s = assignDriverToOrder(s, orderId, "driver-1").state;
  // Водитель ведёт заказ до доставки своими действиями.
  s = markDriverArrivedAtRestaurant(s, "driver-1", orderId, "2026-07-22T12:00:00.000Z").state;
  s = markDriverPickedUpOrder(s, "driver-1", orderId, "2026-07-22T12:01:00.000Z").state;
  s = markDriverArrivingToCustomer(s, "driver-1", orderId, "2026-07-22T12:02:00.000Z").state;

  const first = markDriverDeliveredOrder(s, "driver-1", orderId, "2026-07-22T12:03:00.000Z", {
    cashCollectionConfirmed: false,
  });
  assert.equal(first.result.ok, true, first.result.error ?? "");
  assert.equal(getOrder(first.state, orderId).status, "DELIVERED");

  // Повторная доставка тем же водителем — успешный no-op без второго accounting.
  const before = first.state.restaurantAccountingEntries.length;
  const second = markDriverDeliveredOrder(first.state, "driver-1", orderId, "2026-07-22T12:04:00.000Z", {
    cashCollectionConfirmed: false,
  });
  assert.equal(second.result.ok, true);
  assert.equal(second.state, first.state);
  assert.equal(second.state.restaurantAccountingEntries.length, before);
});

// ─── Тест 11: повторное подтверждение оплаты ─────────────────────────────────

test("Тест 11: повторное подтверждение оплаты возвращает ошибку", () => {
  const { state, orderId } = deliveryOrderState("restaurant-2");
  const accepted = acceptRestaurantOrder(state, orderId, 20);
  const first = simulateSuccessfulOnlinePaymentWithResult(accepted, orderId);
  assert.equal(first.result.ok, true);
  const paidOrder = getOrder(first.state, orderId);
  assert.equal(paidOrder.paymentStatus, "PAID");
  const historyAfterFirst = paidOrder.history.length;

  const second = simulateSuccessfulOnlinePaymentWithResult(
    first.state,
    orderId,
  );
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Оплата уже подтверждена.");
  assert.equal(second.state, first.state);
  assert.equal(
    getOrder(second.state, orderId).history.length,
    historyAfterFirst,
  );
});

// ─── Тест 12/24: повторная доставка не создаёт settlement ────────────────────

test("Тест 12: повторная доставка не создаёт второй settlement", () => {
  const { state, orderId } = preparingOrderState("restaurant-3");
  let s = markOrderReady(state, orderId);
  s = markOrderOutForDeliveryWithResult(s, orderId).state;
  s = markOrderArrivingWithResult(s, orderId).state;

  const first = markOrderDeliveredWithResult(s, orderId);
  assert.equal(first.result.ok, true);
  const settlementsAfterFirst = first.state.settlements.filter(
    (e) => e.orderId === orderId,
  ).length;
  assert.equal(settlementsAfterFirst, 1);

  const second = markOrderDeliveredWithResult(first.state, orderId);
  assert.equal(second.result.ok, false);
  assert.equal(second.state, first.state);
  assert.equal(
    second.state.settlements.filter((e) => e.orderId === orderId).length,
    1,
  );
});

// ─── Настройки: время приготовления, приём заказов, режим работы ─────────────

test("adminSetPreparationMinutes: вне PREPARING — понятная ошибка", () => {
  const { state, orderId } = deliveryOrderState("restaurant-2");
  const res = adminSetPreparationMinutesWithResult(state, orderId, 20);
  assert.equal(res.result.ok, false);
  assert.equal(
    res.result.error,
    "Изменить время можно только для готовящегося заказа.",
  );
  assert.equal(res.state, state);

  const notFound = adminSetPreparationMinutesWithResult(state, "order-нет", 20);
  assert.equal(notFound.result.error, "Заказ не найден.");

  const { state: prep, orderId: prepId } = preparingOrderState("restaurant-2");
  const badMinutes = adminSetPreparationMinutesWithResult(prep, prepId, 7);
  assert.equal(badMinutes.result.ok, false);
  assert.equal(badMinutes.result.error, "Недопустимое время приготовления.");
});

test("setRestaurantWorkflowMode: совпадающий режим и неизвестный ресторан — ошибки", () => {
  const s = createDefaultState();
  const same = setRestaurantWorkflowModeWithResult(s, "restaurant-2", "COMBINED");
  assert.equal(same.result.ok, false);
  assert.equal(
    same.result.error,
    "Режим работы уже изменён другой вкладкой.",
  );
  assert.equal(same.state, s);

  const missing = setRestaurantWorkflowModeWithResult(
    s,
    "restaurant-нет",
    "SPLIT_OPERATOR_KITCHEN",
  );
  assert.equal(missing.result.ok, false);
  assert.equal(missing.result.error, "Ресторан не найден.");

  const ok = setRestaurantWorkflowModeWithResult(
    s,
    "restaurant-2",
    "SPLIT_OPERATOR_KITCHEN",
  );
  assert.equal(ok.result.ok, true);
  assert.equal(
    ok.state.restaurants.find((r) => r.id === "restaurant-2")
      ?.orderWorkflowMode,
    "SPLIT_OPERATOR_KITCHEN",
  );
});

// ─── Тесты 21/23: reset failure и единственный Order/lifecycle ───────────────

test("Тест 21: reset failure не меняет подтверждённый state", () => {
  const { state } = preparingOrderState("restaurant-2");
  let result: MutationAck;
  let confirmed = state;
  try {
    const outcome = executeSerializedPrototypeMutation({
      localState: state,
      storedState: null,
      mutation: (base) => ({ state: resetPrototypeState(base), result: null }),
      persist: () => {
        throw new Error("QuotaExceededError");
      },
    });
    confirmed = outcome.nextState;
    result = { ok: true, error: null, changed: outcome.committed };
  } catch {
    result = {
      ok: false,
      error: "Не удалось сохранить действие. Обновите страницу и повторите.",
      changed: false,
    };
  }
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  // Подтверждённый state остался прежним (заказы не стёрты).
  assert.equal(confirmed, state);
  assert.ok(confirmed.orders.length > 0);
});

test("Тест 23: один Order и один lifecycle сохраняются на всём пути", () => {
  const { state, orderId } = preparingOrderState("restaurant-3");
  let s = markOrderReady(state, orderId);
  s = markOrderOutForDeliveryWithResult(s, orderId).state;
  s = markOrderArrivingWithResult(s, orderId).state;
  s = markOrderDeliveredWithResult(s, orderId).state;

  // Ровно один заказ с этим id, единый lifecycle в одной истории.
  assert.equal(s.orders.filter((o) => o.id === orderId).length, 1);
  const order = getOrder(s, orderId);
  assert.equal(order.status, "DELIVERED");
  const statusChain = order.history
    .filter((e) => e.type === "STATUS" && e.fromStatus !== e.toStatus)
    .map((e) => e.toStatus);
  assert.deepEqual(statusChain, [
    "RESTAURANT_REVIEW",
    "PREPARING",
    "READY",
    "OUT_FOR_DELIVERY",
    "ARRIVING",
    "DELIVERED",
  ]);
});

test("Тест 25: maintenance sweep без изменений даёт changed:false, а не ложный успех", () => {
  const { state } = preparingOrderState("restaurant-2");
  const { ack, nextState } = stateOnlyAck(state, (base) => base);
  assert.deepEqual(ack, { ok: true, error: null, changed: false });
  assert.equal(nextState, state);
});
