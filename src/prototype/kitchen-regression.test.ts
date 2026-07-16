import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  adjustOrderEtaFromIntent,
  assignDriverToOrder,
  completePickupWithCode,
  createOrderFromCart,
  expireUnansweredRestaurantOrders,
  markOrderArrivingWithResult,
  markOrderDeliveredWithResult,
  markOrderOutForDeliveryWithResult,
  markOrderReadyWithResult,
  markPickupNoShow,
  reportRestaurantPreparationProblem,
  setCartFulfillmentChoice,
  simulateSuccessfulOnlinePaymentWithResult,
  updateCartAddress,
  RESTAURANT_RESPONSE_TIMEOUT_MS,
} from "./actions.ts";
import { getPickupNoShowEligibleAtIso } from "./selectors.ts";
import type {
  Order,
  OrderHistoryEvent,
  PrototypeState,
  RestaurantOrderWorkflowMode,
} from "./models.ts";

/**
 * Сквозной regression кухонного lifecycle без React: каждая проверка проходит
 * последовательность состояний целиком и подтверждает КАЖДЫЙ переход отдельно
 * (revision, история, тип/границы/роль события, финансы, settlement), а не
 * только итог. Отдельные граничные случаи уже покрыты unit-тестами соседних
 * файлов и здесь не дублируются — тут проверяется именно связка шагов.
 *
 * Время: заказы создаются реальным `new Date()`, поэтому любой явный nowIso
 * вычисляется от фактического предыдущего состояния через afterIso(). Жёстких
 * дат нет: с ними тест записывал paidAt на двое суток РАНЬШЕ createdAt (домен
 * такую хронологию не валидирует, но проверка обязана быть достоверной).
 */

/** Момент строго позже переданного (по умолчанию +1 секунда). */
function afterIso(iso: string, milliseconds = 1_000): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function stateWithMode(
  restaurantId: string,
  mode: RestaurantOrderWorkflowMode,
): PrototypeState {
  const s = createDefaultState();
  return {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === restaurantId ? { ...r, orderWorkflowMode: mode } : r,
    ),
  };
}

/** Ресторан 2 — доставка Direct, 3 — собственный курьер ресторана. */
function makeOrder(
  restaurantId: string,
  fulfillment: "PICKUP" | "DELIVERY",
  mode: RestaurantOrderWorkflowMode = "COMBINED",
): { state: PrototypeState; orderId: string } {
  let s = stateWithMode(restaurantId, mode);
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  }
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  s = addCartItem(s, `${restaurantId}-item-1`).state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

function getOrder(state: PrototypeState, orderId: string): Order {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
}

/** Инварианты, которые ни одно кухонное действие не имеет права менять. */
function invariantsOf(state: PrototypeState, orderId: string) {
  const o = getOrder(state, orderId);
  return {
    financials: JSON.stringify(o.financials),
    items: JSON.stringify(o.items),
    settlements: state.settlements.length,
    revision: state.revision,
    history: o.history.length,
  };
}

/**
 * Проверка одного успешного перехода: ревизия +1, ожидаемое число новых
 * событий, у последнего события — верные тип/границы/роль, состав и финансовый
 * снимок не тронуты. Возвращает добавленные события для точечных проверок.
 */
function expectStep(
  prevState: PrototypeState,
  nextState: PrototypeState,
  orderId: string,
  expected: {
    from: Order["status"];
    to: Order["status"];
    type: OrderHistoryEvent["type"];
    role?: OrderHistoryEvent["restaurantWorkspaceRole"];
    actor?: OrderHistoryEvent["actor"];
    events?: number;
  },
): OrderHistoryEvent[] {
  const before = invariantsOf(prevState, orderId);
  const order = getOrder(nextState, orderId);
  const addedCount = expected.events ?? 1;

  assert.equal(order.status, expected.to, "итоговый статус шага");
  assert.equal(nextState.revision, before.revision + 1, "ревизия +1 за шаг");
  assert.equal(
    order.history.length,
    before.history + addedCount,
    "число новых событий шага",
  );

  const added = order.history.slice(before.history);
  const last = added.at(-1) as OrderHistoryEvent;
  assert.equal(last.type, expected.type);
  assert.equal(last.fromStatus, expected.from);
  assert.equal(last.toStatus, expected.to);
  assert.equal(last.restaurantWorkspaceRole, expected.role);
  if (expected.actor) assert.equal(last.actor, expected.actor);

  // Кухонный шаг не пересчитывает финансы и не меняет состав заказа.
  assert.equal(JSON.stringify(order.financials), before.financials);
  assert.equal(JSON.stringify(order.items), before.items);
  return added;
}

/** Отказ домена: тот же объект state, без ревизии, событий и начислений. */
function expectRejected(
  prevState: PrototypeState,
  result: { state: PrototypeState; result: { ok: boolean } },
  orderId: string,
): void {
  const before = invariantsOf(prevState, orderId);
  assert.equal(result.result.ok, false);
  assert.equal(result.state, prevState, "state возвращается тем же объектом");
  assert.equal(result.state.revision, before.revision);
  assert.equal(getOrder(result.state, orderId).history.length, before.history);
  assert.equal(result.state.settlements.length, before.settlements);
}

test("Regression 1: COMBINED PICKUP — приём → готовность → выдача по коду", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP");
  const created = getOrder(state, orderId);
  const baseFinancials = JSON.stringify(created.financials);
  assert.equal(created.status, "RESTAURANT_REVIEW");
  assert.equal(created.paymentMethod, "PAY_AT_RESTAURANT");
  assert.equal(created.paymentStatus, "DUE_AT_PICKUP");
  assert.ok(created.pickupCode);
  assert.equal(created.pickupCodeUsed, false);
  assert.equal(state.settlements.length, 0);
  assert.equal(state.orders.filter((o) => o.id === orderId).length, 1);

  // Шаг 1 — приём: PICKUP сразу в PREPARING.
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "COMBINED");
  assert.equal(accepted.result.ok, true);
  expectStep(state, accepted.state, orderId, {
    from: "RESTAURANT_REVIEW", to: "PREPARING", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT",
  });
  const prep = getOrder(accepted.state, orderId);
  assert.equal(prep.preparationMinutes, 20);
  assert.ok(prep.expectedReadyAt);
  assert.equal(accepted.state.settlements.length, 0);

  // Шаг 2 — готовность: код и ожидаемое время не трогаются.
  const ready = markOrderReadyWithResult(accepted.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(ready.result.ok, true);
  expectStep(accepted.state, ready.state, orderId, {
    from: "PREPARING", to: "READY_FOR_PICKUP", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT",
  });
  const readyOrder = getOrder(ready.state, orderId);
  assert.equal(readyOrder.pickupCode, created.pickupCode);
  assert.equal(readyOrder.pickupCodeUsed, false);
  assert.equal(readyOrder.expectedReadyAt, prep.expectedReadyAt);
  assert.equal(ready.state.settlements.length, 0);

  // Шаг 3 — выдача: время считается от фактического состояния, не жёсткой датой.
  const handoffAt = afterIso(readyOrder.updatedAt);
  assert.ok(Date.parse(handoffAt) > Date.parse(readyOrder.updatedAt));
  const code = readyOrder.pickupCode as string;
  const done = completePickupWithCode(ready.state, orderId, code, "CARD", "RESTAURANT", handoffAt, "COMBINED");
  assert.equal(done.result.ok, true);
  const added = expectStep(ready.state, done.state, orderId, {
    from: "READY_FOR_PICKUP", to: "PICKED_UP", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT", events: 2,
  });
  // Первое из двух событий — оплата на точке, статус при этом не меняется.
  assert.equal(added[0].type, "PAYMENT");
  assert.equal(added[0].fromStatus, "READY_FOR_PICKUP");
  assert.equal(added[0].toStatus, "READY_FOR_PICKUP");
  assert.equal(added[0].restaurantWorkspaceRole, "COMBINED");

  const final = getOrder(done.state, orderId);
  assert.equal(final.paymentStatus, "PAID_AT_RESTAURANT");
  assert.equal(final.pickupCodeUsed, true);
  assert.equal(final.pickupPaidWith, "CARD");
  // Хронология: оплата не раньше создания и не раньше готовности.
  assert.equal(final.paidAt, handoffAt);
  assert.ok(Date.parse(final.paidAt as string) >= Date.parse(created.createdAt));
  assert.ok(Date.parse(final.paidAt as string) >= Date.parse(readyOrder.updatedAt));
  // Комиссия начисляется один раз и берётся из исторического снимка.
  assert.equal(done.state.settlements.length, 1);
  assert.equal(done.state.settlements[0].type, "PICKUP_COMMISSION");
  assert.equal(done.state.settlements[0].orderId, orderId);
  assert.equal(
    done.state.settlements[0].amountCents,
    created.financials.platformCommissionReceivableCents,
  );
  assert.equal(JSON.stringify(final.financials), baseFinancials);
  assert.equal(final.financials.deliveryFeeCents, 0);
  assert.equal(done.state.orders.filter((o) => o.id === orderId).length, 1);

  // Повторная выдача не создаёт второе финальное состояние.
  const again = completePickupWithCode(done.state, orderId, code, "CARD", "RESTAURANT", afterIso(handoffAt), "COMBINED");
  expectRejected(done.state, again, orderId);
  assert.equal(again.state.settlements.length, 1);
});

test("Regression 2: COMBINED PICKUP — невыкуп после 30 минут вместо выдачи", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP");
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "COMBINED").state;
  const ready = markOrderReadyWithResult(accepted, orderId, "RESTAURANT", "COMBINED").state;
  const readyOrder = getOrder(ready, orderId);
  const baseFinancials = JSON.stringify(readyOrder.financials);

  // Авторитетная временная точка невыкупа — из самого домена.
  const eligibleAt = getPickupNoShowEligibleAtIso(readyOrder) as string;
  assert.ok(eligibleAt);
  assert.ok(Date.parse(eligibleAt) > Date.parse(readyOrder.updatedAt));

  const res = markPickupNoShow(ready, orderId, "Клиент не пришёл", "RESTAURANT", eligibleAt, "COMBINED");
  assert.equal(res.result.ok, true);
  expectStep(ready, res.state, orderId, {
    from: "READY_FOR_PICKUP", to: "CANCELED", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT",
  });
  const o = getOrder(res.state, orderId);
  assert.equal(o.pickupNoShowAt, eligibleAt);
  assert.equal(res.state.customer.noShowPickupCount, ready.customer.noShowPickupCount + 1);
  // Невыкуп не фиксирует оплату и не начисляет комиссию.
  assert.equal(o.paymentStatus, "DUE_AT_PICKUP");
  assert.equal(o.paidAt, null);
  assert.equal(o.pickupPaidWith, null);
  assert.equal(o.pickupCodeUsed, false);
  assert.equal(JSON.stringify(o.financials), baseFinancials);
  assert.equal(res.state.settlements.length, 0);

  // Выдать заказ после невыкупа нельзя.
  const handoff = completePickupWithCode(res.state, orderId, readyOrder.pickupCode as string, "CASH", "RESTAURANT", afterIso(eligibleAt), "COMBINED");
  expectRejected(res.state, handoff, orderId);
  assert.equal(handoff.state.settlements.length, 0);
  assert.equal(handoff.state.customer.noShowPickupCount, res.state.customer.noShowPickupCount);
});

test("Regression 3: SPLIT PICKUP — кухня готовит, выдаёт только оператор", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP", "SPLIT_OPERATOR_KITCHEN");

  // Приём — зона кухни: оператор не принимает.
  expectRejected(state, acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "OPERATOR"), orderId);
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "KITCHEN");
  assert.equal(accepted.result.ok, true);
  expectStep(state, accepted.state, orderId, {
    from: "RESTAURANT_REVIEW", to: "PREPARING", type: "STATUS",
    role: "KITCHEN", actor: "RESTAURANT",
  });

  // Готовность — тоже зона кухни.
  expectRejected(accepted.state, markOrderReadyWithResult(accepted.state, orderId, "RESTAURANT", "OPERATOR"), orderId);
  const ready = markOrderReadyWithResult(accepted.state, orderId, "RESTAURANT", "KITCHEN");
  assert.equal(ready.result.ok, true);
  expectStep(accepted.state, ready.state, orderId, {
    from: "PREPARING", to: "READY_FOR_PICKUP", type: "STATUS",
    role: "KITCHEN", actor: "RESTAURANT",
  });

  const readyOrder = getOrder(ready.state, orderId);
  const code = readyOrder.pickupCode as string;
  const handoffAt = afterIso(readyOrder.updatedAt);

  // Выдача и невыкуп кухне недоступны — это зона оператора.
  expectRejected(ready.state, completePickupWithCode(ready.state, orderId, code, "CASH", "RESTAURANT", handoffAt, "KITCHEN"), orderId);
  const eligibleAt = getPickupNoShowEligibleAtIso(readyOrder) as string;
  expectRejected(ready.state, markPickupNoShow(ready.state, orderId, "Не пришёл", "RESTAURANT", eligibleAt, "KITCHEN"), orderId);

  const done = completePickupWithCode(ready.state, orderId, code, "CASH", "RESTAURANT", handoffAt, "OPERATOR");
  assert.equal(done.result.ok, true);
  const added = expectStep(ready.state, done.state, orderId, {
    from: "READY_FOR_PICKUP", to: "PICKED_UP", type: "STATUS",
    role: "OPERATOR", actor: "RESTAURANT", events: 2,
  });
  assert.equal(added[0].type, "PAYMENT");
  added.forEach((e) => assert.equal(e.restaurantWorkspaceRole, "OPERATOR"));
  const final = getOrder(done.state, orderId);
  assert.equal(final.paidAt, handoffAt);
  assert.ok(Date.parse(final.paidAt as string) >= Date.parse(readyOrder.updatedAt));
  assert.equal(done.state.settlements.length, 1);
  assert.equal(done.state.settlements[0].type, "PICKUP_COMMISSION");
});

test("Regression 4: RESTAURANT_DELIVERY — полная цепочка до DELIVERED", () => {
  const { state, orderId } = makeOrder("restaurant-3", "DELIVERY");
  const created = getOrder(state, orderId);
  const baseFinancials = JSON.stringify(created.financials);
  assert.equal(created.deliveryMode, "RESTAURANT_DELIVERY");

  const accepted = acceptRestaurantOrderWithResult(state, orderId, 30, "RESTAURANT", "COMBINED");
  assert.equal(accepted.result.ok, true);
  expectStep(state, accepted.state, orderId, {
    from: "RESTAURANT_REVIEW", to: "PREPARING", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT",
  });
  assert.ok(getOrder(accepted.state, orderId).expectedReadyAt);

  // Курьерский заказ готов — READY (не READY_FOR_PICKUP).
  const ready = markOrderReadyWithResult(accepted.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(ready.result.ok, true);
  expectStep(accepted.state, ready.state, orderId, {
    from: "PREPARING", to: "READY", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT",
  });
  assert.equal(ready.state.settlements.length, 0);

  const out = markOrderOutForDeliveryWithResult(ready.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(out.result.ok, true);
  expectStep(ready.state, out.state, orderId, {
    from: "READY", to: "OUT_FOR_DELIVERY", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT",
  });
  assert.equal(out.state.settlements.length, 0);

  const arriving = markOrderArrivingWithResult(out.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(arriving.result.ok, true);
  expectStep(out.state, arriving.state, orderId, {
    from: "OUT_FOR_DELIVERY", to: "ARRIVING", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT",
  });
  assert.equal(arriving.state.settlements.length, 0);

  // Доставка: оплата курьеру + переход, комиссия начисляется один раз.
  const delivered = markOrderDeliveredWithResult(arriving.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(delivered.result.ok, true);
  const added = expectStep(arriving.state, delivered.state, orderId, {
    from: "ARRIVING", to: "DELIVERED", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT", events: 2,
  });
  assert.equal(added[0].type, "PAYMENT");
  const final = getOrder(delivered.state, orderId);
  const settlements = delivered.state.settlements.filter((s) => s.orderId === orderId);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].type, "RESTAURANT_DELIVERY_COMMISSION");
  assert.equal(
    settlements[0].amountCents,
    created.financials.platformCommissionReceivableCents,
  );
  assert.equal(JSON.stringify(final.financials), baseFinancials);

  const again = markOrderDeliveredWithResult(delivered.state, orderId, "RESTAURANT", "COMBINED");
  expectRejected(delivered.state, again, orderId);
  assert.equal(again.state.settlements.filter((s) => s.orderId === orderId).length, 1);
});

test("Regression 5: PLATFORM_DRIVER — оплата, приготовление, READY без водителя", () => {
  const { state, orderId } = makeOrder("restaurant-2", "DELIVERY");
  const created = getOrder(state, orderId);
  const baseFinancials = JSON.stringify(created.financials);
  assert.equal(created.deliveryMode, "PLATFORM_DRIVER");

  // Онлайн-заказ после приёма ждёт оплату.
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 25, "RESTAURANT", "COMBINED");
  assert.equal(accepted.result.ok, true);
  expectStep(state, accepted.state, orderId, {
    from: "RESTAURANT_REVIEW", to: "AWAITING_PAYMENT", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT",
  });
  assert.equal(getOrder(accepted.state, orderId).paymentStatus, "AWAITING_PAYMENT");
  // Кухня не может отметить готовность до оплаты.
  expectRejected(accepted.state, markOrderReadyWithResult(accepted.state, orderId, "RESTAURANT", "COMBINED"), orderId);

  // Оплату подтверждает система: два события SYSTEM без ресторанной роли.
  const paid = simulateSuccessfulOnlinePaymentWithResult(accepted.state, orderId);
  assert.equal(paid.result.ok, true);
  const paidAdded = expectStep(accepted.state, paid.state, orderId, {
    from: "AWAITING_PAYMENT", to: "PREPARING", type: "STATUS",
    role: undefined, actor: "SYSTEM", events: 2,
  });
  assert.equal(paidAdded[0].type, "PAYMENT");
  assert.equal(paidAdded[0].actor, "SYSTEM");
  assert.equal(paidAdded[0].restaurantWorkspaceRole, undefined);
  const prep = getOrder(paid.state, orderId);
  assert.equal(prep.paymentStatus, "PAID");
  assert.ok(prep.expectedReadyAt);

  // Готовность кухни: водитель не появляется, комиссия не начисляется.
  const ready = markOrderReadyWithResult(paid.state, orderId, "RESTAURANT", "COMBINED");
  assert.equal(ready.result.ok, true);
  expectStep(paid.state, ready.state, orderId, {
    from: "PREPARING", to: "READY", type: "STATUS",
    role: "COMBINED", actor: "RESTAURANT",
  });
  const readyOrder = getOrder(ready.state, orderId);
  assert.equal(readyOrder.assignedDriverId, null);
  assert.equal(ready.state.settlements.length, 0);
  assert.equal(JSON.stringify(readyOrder.financials), baseFinancials);

  // Без назначенного водителя выезд невозможен.
  expectRejected(ready.state, markOrderOutForDeliveryWithResult(ready.state, orderId, "RESTAURANT", "COMBINED"), orderId);
  // Назначение — административное действие; после него переход разрешён.
  const assigned = assignDriverToOrder(ready.state, orderId, "driver-1");
  assert.equal(assigned.result.ok, true);
  assert.equal(
    markOrderOutForDeliveryWithResult(assigned.state, orderId, "RESTAURANT", "COMBINED").result.ok,
    true,
  );
});

test("Regression 6: ETA — корректировка не трогает статус, финансы и оплату", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP", "SPLIT_OPERATOR_KITCHEN");
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "KITCHEN").state;
  const prep = getOrder(accepted, orderId);
  const baseSettlements = accepted.settlements.length;

  // nowIso не раньше updatedAt принятого заказа.
  const nowIso = afterIso(prep.updatedAt);
  assert.ok(Date.parse(nowIso) >= Date.parse(prep.updatedAt));

  const res = adjustOrderEtaFromIntent(accepted, orderId, { kind: "DELAY", minutes: 10 }, "Кухня перегружена", "RESTAURANT", nowIso, "KITCHEN");
  assert.equal(res.result.ok, true);
  const added = expectStep(accepted, res.state, orderId, {
    from: "PREPARING", to: "PREPARING", type: "ETA",
    role: "KITCHEN", actor: "RESTAURANT",
  });
  assert.equal(added[0].occurredAt, nowIso);
  assert.ok(added[0].message.includes("Кухня перегружена"));

  const o = getOrder(res.state, orderId);
  assert.equal(o.preparationMinutes, prep.preparationMinutes);
  assert.notEqual(o.expectedReadyAt, prep.expectedReadyAt);
  assert.ok(Date.parse(o.expectedReadyAt as string) > Date.parse(nowIso));
  // Ровно одна запись аудита с корректными границами времени.
  assert.equal(o.etaAdjustments.length, prep.etaAdjustments.length + 1);
  const adj = o.etaAdjustments.at(-1);
  assert.equal(adj?.previousExpectedReadyAt, prep.expectedReadyAt);
  assert.equal(adj?.nextExpectedReadyAt, o.expectedReadyAt);
  assert.equal(adj?.reason, "Кухня перегружена");
  assert.equal(adj?.restaurantWorkspaceRole, "KITCHEN");
  // Оплата, водитель и начисления не затрагиваются.
  assert.equal(o.paymentStatus, prep.paymentStatus);
  assert.equal(o.paidAt, prep.paidAt);
  assert.equal(o.assignedDriverId, null);
  assert.equal(res.state.settlements.length, baseSettlements);
});

test("Regression 7: проблема приготовления не меняет заказ и не отменяет его", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP", "SPLIT_OPERATOR_KITCHEN");
  const accepted = acceptRestaurantOrderWithResult(state, orderId, 20, "RESTAURANT", "KITCHEN").state;
  const prep = getOrder(accepted, orderId);
  const baseSettlements = accepted.settlements.length;
  const nowIso = afterIso(prep.updatedAt);

  const res = reportRestaurantPreparationProblem(accepted, orderId, "Закончился ингредиент", "RESTAURANT", nowIso, "KITCHEN");
  assert.equal(res.result.ok, true);
  const added = expectStep(accepted, res.state, orderId, {
    from: "PREPARING", to: "PREPARING", type: "PREPARATION_PROBLEM",
    role: "KITCHEN", actor: "RESTAURANT",
  });
  assert.ok(added[0].message.includes("Закончился ингредиент"));

  // Заказ продолжает готовиться: время, оплата и начисления не тронуты.
  const o = getOrder(res.state, orderId);
  assert.equal(o.expectedReadyAt, prep.expectedReadyAt);
  assert.equal(o.preparationMinutes, prep.preparationMinutes);
  assert.equal(o.paymentStatus, prep.paymentStatus);
  assert.equal(o.paidAt, prep.paidAt);
  assert.equal(res.state.settlements.length, baseSettlements);
});

test("Regression 8: авто-закрытие нового заказа на пороге 7 минут и его идемпотентность", () => {
  const { state, orderId } = makeOrder("restaurant-2", "PICKUP");
  const created = getOrder(state, orderId);
  const baseFinancials = JSON.stringify(created.financials);
  const threshold = new Date(Date.parse(created.createdAt) + RESTAURANT_RESPONSE_TIMEOUT_MS).toISOString();

  // До порога заказ не трогается — тот же объект state.
  const justBefore = new Date(Date.parse(threshold) - 1000).toISOString();
  assert.equal(expireUnansweredRestaurantOrders(state, justBefore), state);

  // На точном пороге срабатывает штатное автозакрытие системой.
  const expired = expireUnansweredRestaurantOrders(state, threshold);
  expectStep(state, expired, orderId, {
    from: "RESTAURANT_REVIEW", to: "CANCELED", type: "STATUS",
    role: undefined, actor: "SYSTEM",
  });
  const o = getOrder(expired, orderId);
  assert.equal(expired.settlements.length, 0);
  assert.equal(JSON.stringify(o.financials), baseFinancials);

  // Повторный sweep не создаёт вторую отмену.
  const second = expireUnansweredRestaurantOrders(expired, afterIso(threshold));
  assert.equal(second, expired);
  assert.equal(getOrder(second, orderId).history.length, o.history.length);
  assert.equal(second.revision, expired.revision);

  // Автозакрытый заказ принять нельзя.
  expectRejected(expired, acceptRestaurantOrderWithResult(expired, orderId, 20, "RESTAURANT", "COMBINED"), orderId);
});
