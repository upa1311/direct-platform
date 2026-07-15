import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  completePickupWithCode,
  createOrderFromCart,
  issuePickupWithoutCode,
  markOrderReady,
  markPickupNoShow,
  setCartFulfillmentChoice,
  updateCartAddress,
  PICKUP_NO_SHOW_REASON_MAX_LENGTH,
} from "./actions.ts";
import {
  getPickupNoShowEligibleAtIso,
  getReadyForPickupSinceIso,
  isPickupNoShowEligibleAt,
  PICKUP_NO_SHOW_WAIT_MS,
} from "./selectors.ts";
import { upgradeToV6 } from "./prototype-store.ts";
import type {
  Order,
  PickupPaymentMethod,
  PrototypeState,
} from "./models.ts";

const NOW = "2026-07-14T12:00:00.000Z";

/** Готовый к выдаче PICKUP-заказ (снимок ["CASH","CARD"], оплата на точке). */
function makeReadyPickup(): {
  state: PrototypeState;
  orderId: string;
  code: string;
} {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  s = created.state;
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(s, orderId, 20);
  s = markOrderReady(s, orderId);
  const order = s.orders.find((o) => o.id === orderId);
  assert.ok(order);
  assert.equal(order.status, "READY_FOR_PICKUP");
  assert.ok(order.pickupCode);
  return { state: s, orderId, code: order.pickupCode as string };
}

function getOrder(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

/** Возвращает копию состояния с точечно изменённым заказом. */
function patchOrder(
  state: PrototypeState,
  orderId: string,
  patch: Partial<Order>,
): PrototypeState {
  return {
    ...state,
    orders: state.orders.map((o) =>
      o.id === orderId ? { ...o, ...patch } : o,
    ),
  };
}

function eligibleAtFor(state: PrototypeState, orderId: string): string {
  const iso = getPickupNoShowEligibleAtIso(getOrder(state, orderId));
  assert.ok(iso);
  return iso;
}

// --- Нормальная выдача по коду (§2, §5, §6) ---------------------------------

test("выдача по коду: статус PICKED_UP", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, true);
  assert.equal(getOrder(res.state, orderId).status, "PICKED_UP");
});

test("выдача по коду: paymentStatus PAID_AT_RESTAURANT", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(getOrder(res.state, orderId).paymentStatus, "PAID_AT_RESTAURANT");
});

test("выдача по коду: paidAt = nowIso", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(getOrder(res.state, orderId).paidAt, NOW);
});

test("выдача по коду: updatedAt = nowIso", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(getOrder(res.state, orderId).updatedAt, NOW);
});

test("выдача по коду: pickupCodeUsed = true", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(getOrder(res.state, orderId).pickupCodeUsed, true);
});

test("выдача наличными: pickupPaidWith = CASH и result.paidWith = CASH", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(getOrder(res.state, orderId).pickupPaidWith, "CASH");
  assert.equal(res.result.paidWith, "CASH");
});

test("выдача картой: pickupPaidWith = CARD", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CARD", "RESTAURANT", NOW);
  assert.equal(getOrder(res.state, orderId).pickupPaidWith, "CARD");
  assert.equal(res.result.paidWith, "CARD");
});

test("выдача по коду: order.paymentMethod остаётся PAY_AT_RESTAURANT", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(getOrder(res.state, orderId).paymentMethod, "PAY_AT_RESTAURANT");
});

test("выдача по коду: ровно одно PAYMENT и одно STATUS событие", () => {
  const { state, orderId, code } = makeReadyPickup();
  const before = getOrder(state, orderId).history.length;
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  const events = getOrder(res.state, orderId).history.slice(before);
  assert.equal(events.filter((e) => e.type === "PAYMENT").length, 1);
  assert.equal(events.filter((e) => e.type === "STATUS").length, 1);
});

test("выдача наличными: текст PAYMENT-события", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  const payment = getOrder(res.state, orderId).history.find(
    (e) => e.type === "PAYMENT",
  );
  assert.equal(payment?.message, "Оплата получена в ресторане наличными.");
});

test("выдача картой: текст PAYMENT-события", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CARD", "RESTAURANT", NOW);
  const payment = getOrder(res.state, orderId).history.find(
    (e) => e.type === "PAYMENT",
  );
  assert.equal(payment?.message, "Оплата получена в ресторане картой.");
});

test("выдача по коду: текст STATUS-события (ресторан)", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  const status = getOrder(res.state, orderId).history.find(
    (e) => e.type === "STATUS" && e.toStatus === "PICKED_UP",
  );
  assert.equal(status?.message, "Заказ выдан клиенту по коду.");
});

test("выдача по коду администратором: тексты отражают администратора", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CARD", "ADMIN", NOW);
  const events = getOrder(res.state, orderId).history;
  const payment = events.find((e) => e.type === "PAYMENT");
  const status = events.find(
    (e) => e.type === "STATUS" && e.toStatus === "PICKED_UP",
  );
  assert.equal(
    payment?.message,
    "Администратор Direct подтвердил оплату картой в ресторане.",
  );
  assert.equal(
    status?.message,
    "Администратор Direct подтвердил выдачу клиенту по коду.",
  );
  assert.equal(payment?.actor, "ADMIN");
  assert.equal(status?.actor, "ADMIN");
});

test("выдача по коду: ровно одна settlement PICKUP_COMMISSION", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(res.state.settlements.length, 1);
  assert.equal(res.state.settlements[0].type, "PICKUP_COMMISSION");
  assert.equal(res.state.settlements[0].status, "PENDING");
  assert.equal(res.state.settlements[0].orderId, orderId);
});

test("выдача по коду: сумма settlement = platformCommissionReceivableCents", () => {
  const { state, orderId, code } = makeReadyPickup();
  const snapshot = getOrder(state, orderId).financials
    .platformCommissionReceivableCents;
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(res.state.settlements[0].amountCents, snapshot);
});

test("выдача по коду: settlement по историческому снимку не пересчитан", () => {
  const { state, orderId, code } = makeReadyPickup();
  // Искусственно завышаем расчётную комиссию в снимке заказа.
  const tampered = patchOrder(state, orderId, {
    financials: {
      ...getOrder(state, orderId).financials,
      platformCommissionReceivableCents: 99999,
    },
  });
  const res = completePickupWithCode(tampered, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(res.state.settlements[0].amountCents, 99999);
});

test("неверное время операции: ошибка без мутации", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", "not-a-date");
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
  assert.equal(res.result.paidWith, null);
});

test("несуществующий заказ: ошибка", () => {
  const { state } = makeReadyPickup();
  const res = completePickupWithCode(state, "order-x", "1234", "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
});

test("не-PICKUP заказ: ошибка", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-1-item-1", "size-standard").state;
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  const created = createOrderFromCart(s);
  s = created.state;
  const orderId = created.result.orderId as string;
  const res = completePickupWithCode(s, orderId, "1234", "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
});

test("неверный статус (PREPARING): ошибка", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  s = created.state;
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(s, orderId, 20); // PREPARING
  const code = getOrder(s, orderId).pickupCode as string;
  const res = completePickupWithCode(s, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
  assert.equal(getOrder(res.state, orderId).status, "PREPARING");
});

test("оплата уже закрыта (не DUE_AT_PICKUP): ошибка", () => {
  const { state, orderId, code } = makeReadyPickup();
  const tampered = patchOrder(state, orderId, {
    paymentStatus: "PAID_AT_RESTAURANT",
  });
  const res = completePickupWithCode(tampered, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
});

test("нет кода выдачи: ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const tampered = patchOrder(state, orderId, { pickupCode: null });
  const res = completePickupWithCode(tampered, orderId, "1234", "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
});

test("код не из четырёх цифр (3): ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, "123", "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Код должен состоять из четырёх цифр.");
});

test("код из пяти цифр: ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, "12345", "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
});

test("код с нецифровыми символами: ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, "12a4", "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
});

test("неверный код (4 цифры, не совпадает): ошибка", () => {
  const { state, orderId, code } = makeReadyPickup();
  const wrong = code === "0000" ? "1111" : "0000";
  const res = completePickupWithCode(state, orderId, wrong, "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Неверный код клиента.");
});

test("код с пробелами по краям — trim и совпадает", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, ` ${code} `, "CASH", "RESTAURANT", NOW);
  assert.equal(res.result.ok, true);
});

test("способ оплаты вне снимка: ошибка", () => {
  const { state, orderId, code } = makeReadyPickup();
  const cashOnly = patchOrder(state, orderId, {
    pickupPaymentMethodsSnapshot: ["CASH"],
  });
  const res = completePickupWithCode(cashOnly, orderId, code, "CARD", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Этот способ оплаты недоступен на точке.");
});

test("некорректный paidWith: ошибка", () => {
  const { state, orderId, code } = makeReadyPickup();
  const res = completePickupWithCode(
    state,
    orderId,
    code,
    "BONUS" as PickupPaymentMethod,
    "RESTAURANT",
    NOW,
  );
  assert.equal(res.result.ok, false);
});

test("повторная выдача: «Заказ уже выдан.», тот же ref, одна settlement", () => {
  const { state, orderId, code } = makeReadyPickup();
  const first = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  const second = completePickupWithCode(first.state, orderId, code, "CASH", "RESTAURANT", NOW);
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Заказ уже выдан.");
  assert.equal(second.state, first.state);
  assert.equal(second.state.settlements.length, 1);
});

test("ошибка не мутирует состояние (тот же ref)", () => {
  const { state, orderId } = makeReadyPickup();
  const res = completePickupWithCode(state, orderId, "0000", "CASH", "RESTAURANT", NOW);
  assert.equal(res.state, state);
});

// --- Невыкуп (§11) -----------------------------------------------------------

test("константа окна невыкупа = 30 минут", () => {
  assert.equal(PICKUP_NO_SHOW_WAIT_MS, 30 * 60 * 1000);
});

test("невыкуп до 30 минут: ошибка и eligibleAt в результате", () => {
  const { state, orderId } = makeReadyPickup();
  const since = getReadyForPickupSinceIso(getOrder(state, orderId));
  assert.ok(since);
  const tooEarly = new Date(Date.parse(since) + 10 * 60 * 1000).toISOString();
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", tooEarly);
  assert.equal(res.result.ok, false);
  assert.ok(res.result.eligibleAt);
  assert.equal(res.state, state);
});

test("eligibleAt = момент готовности + 30 минут", () => {
  const { state, orderId } = makeReadyPickup();
  const since = getReadyForPickupSinceIso(getOrder(state, orderId));
  assert.ok(since);
  const expected = new Date(Date.parse(since) + PICKUP_NO_SHOW_WAIT_MS).toISOString();
  assert.equal(getPickupNoShowEligibleAtIso(getOrder(state, orderId)), expected);
});

test("невыкуп ровно на eligibleAt: успех", () => {
  const { state, orderId } = makeReadyPickup();
  const at = eligibleAtFor(state, orderId);
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", at);
  assert.equal(res.result.ok, true);
  assert.equal(getOrder(res.state, orderId).status, "CANCELED");
});

test("невыкуп после 30 минут: статус CANCELED", () => {
  const { state, orderId } = makeReadyPickup();
  const at = eligibleAtFor(state, orderId);
  const later = new Date(Date.parse(at) + 60_000).toISOString();
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", later);
  assert.equal(res.result.ok, true);
  assert.equal(getOrder(res.state, orderId).status, "CANCELED");
});

test("невыкуп: paymentStatus остаётся DUE_AT_PICKUP", () => {
  const { state, orderId } = makeReadyPickup();
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", eligibleAtFor(state, orderId));
  assert.equal(getOrder(res.state, orderId).paymentStatus, "DUE_AT_PICKUP");
});

test("невыкуп: paidAt и pickupPaidWith остаются null", () => {
  const { state, orderId } = makeReadyPickup();
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", eligibleAtFor(state, orderId));
  assert.equal(getOrder(res.state, orderId).paidAt, null);
  assert.equal(getOrder(res.state, orderId).pickupPaidWith, null);
});

test("невыкуп: pickupCodeUsed остаётся false", () => {
  const { state, orderId } = makeReadyPickup();
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", eligibleAtFor(state, orderId));
  assert.equal(getOrder(res.state, orderId).pickupCodeUsed, false);
});

test("невыкуп: без settlement", () => {
  const { state, orderId } = makeReadyPickup();
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", eligibleAtFor(state, orderId));
  assert.equal(res.state.settlements.length, 0);
});

test("невыкуп: noShowPickupCount +1", () => {
  const { state, orderId } = makeReadyPickup();
  const before = state.customer.noShowPickupCount;
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", eligibleAtFor(state, orderId));
  assert.equal(res.state.customer.noShowPickupCount, before + 1);
});

test("невыкуп: ровно одно STATUS-событие и cancellationReason", () => {
  const { state, orderId } = makeReadyPickup();
  const before = getOrder(state, orderId).history.length;
  const res = markPickupNoShow(state, orderId, "Клиент не отвечает", "RESTAURANT", eligibleAtFor(state, orderId));
  const events = getOrder(res.state, orderId).history.slice(before);
  assert.equal(events.filter((e) => e.type === "STATUS").length, 1);
  assert.equal(getOrder(res.state, orderId).cancellationReason, "Клиент не отвечает");
});

test("невыкуп идемпотентен: повтор не удваивает счётчик", () => {
  const { state, orderId } = makeReadyPickup();
  const at = eligibleAtFor(state, orderId);
  const first = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", at);
  const second = markPickupNoShow(first.state, orderId, "Ещё раз", "RESTAURANT", at);
  assert.equal(second.result.ok, false);
  assert.equal(second.state, first.state);
  assert.equal(
    second.state.customer.noShowPickupCount,
    state.customer.noShowPickupCount + 1,
  );
});

test("невыкуп: пустая причина — ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const res = markPickupNoShow(state, orderId, "   ", "RESTAURANT", eligibleAtFor(state, orderId));
  assert.equal(res.result.ok, false);
});

test("невыкуп: причина длиннее лимита — ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const long = "x".repeat(PICKUP_NO_SHOW_REASON_MAX_LENGTH + 1);
  const res = markPickupNoShow(state, orderId, long, "RESTAURANT", eligibleAtFor(state, orderId));
  assert.equal(res.result.ok, false);
});

test("невыкуп: некорректный nowIso — ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const res = markPickupNoShow(state, orderId, "Не пришёл", "RESTAURANT", "bad");
  assert.equal(res.result.ok, false);
});

test("невыкуп: не-PICKUP — ошибка", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-1-item-1", "size-standard").state;
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  const created = createOrderFromCart(s);
  s = created.state;
  const orderId = created.result.orderId as string;
  const res = markPickupNoShow(s, orderId, "Не пришёл", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
});

test("невыкуп: неверный статус — ошибка", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  s = created.state;
  const orderId = created.result.orderId as string; // RESTAURANT_REVIEW
  const res = markPickupNoShow(s, orderId, "Не пришёл", "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
});

test("окно невыкупа считается от реального перехода, а не от updatedAt", () => {
  const { state, orderId } = makeReadyPickup();
  const since = getReadyForPickupSinceIso(getOrder(state, orderId));
  assert.ok(since);
  // Добавляем «свежее» событие того же статуса и двигаем updatedAt в настоящее.
  const noisyNow = new Date(Date.parse(since) + 40 * 60 * 1000).toISOString();
  const order = getOrder(state, orderId);
  const noisy = patchOrder(state, orderId, {
    updatedAt: noisyNow,
    history: [
      ...order.history,
      {
        id: `${orderId}-noise`,
        occurredAt: noisyNow,
        actor: "ADMIN",
        type: "PAYMENT",
        fromStatus: "READY_FOR_PICKUP",
        toStatus: "READY_FOR_PICKUP",
        message: "Техническое событие того же статуса.",
      },
    ],
  });
  // Порог всё ещё считается от исходного перехода: eligibleAt неизменен.
  const at = new Date(Date.parse(since) + PICKUP_NO_SHOW_WAIT_MS).toISOString();
  assert.equal(getPickupNoShowEligibleAtIso(getOrder(noisy, orderId)), at);
  assert.equal(isPickupNoShowEligibleAt(getOrder(noisy, orderId), at), true);
});

// --- Аварийная выдача (§10) --------------------------------------------------

test("аварийная выдача: PICKED_UP и оплата на точке", () => {
  const { state, orderId } = makeReadyPickup();
  const res = issuePickupWithoutCode(state, orderId, "Клиент забыл код", "CARD", "ADMIN", NOW);
  assert.equal(res.result.ok, true);
  const order = getOrder(res.state, orderId);
  assert.equal(order.status, "PICKED_UP");
  assert.equal(order.paymentStatus, "PAID_AT_RESTAURANT");
});

test("аварийная выдача: pickupPaidWith сохранён", () => {
  const { state, orderId } = makeReadyPickup();
  const res = issuePickupWithoutCode(state, orderId, "Забыл код", "CARD", "ADMIN", NOW);
  assert.equal(getOrder(res.state, orderId).pickupPaidWith, "CARD");
  assert.equal(getOrder(res.state, orderId).pickupCodeUsed, true);
});

test("аварийная выдача: одна settlement PICKUP_COMMISSION по снимку", () => {
  const { state, orderId } = makeReadyPickup();
  const snapshot = getOrder(state, orderId).financials
    .platformCommissionReceivableCents;
  const res = issuePickupWithoutCode(state, orderId, "Забыл код", "CASH", "ADMIN", NOW);
  assert.equal(res.state.settlements.length, 1);
  assert.equal(res.state.settlements[0].type, "PICKUP_COMMISSION");
  assert.equal(res.state.settlements[0].amountCents, snapshot);
});

test("аварийная выдача: STATUS-текст об аварийной выдаче", () => {
  const { state, orderId } = makeReadyPickup();
  const res = issuePickupWithoutCode(state, orderId, "Забыл код", "CASH", "ADMIN", NOW);
  const status = getOrder(res.state, orderId).history.find(
    (e) => e.type === "STATUS" && e.toStatus === "PICKED_UP",
  );
  assert.ok(status?.message.startsWith("Аварийная выдача без кода администратором Direct."));
});

test("аварийная выдача: пустая причина — ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const res = issuePickupWithoutCode(state, orderId, "   ", "CASH", "ADMIN", NOW);
  assert.equal(res.result.ok, false);
  assert.equal(res.state.settlements.length, 0);
});

test("аварийная выдача: причина длиннее лимита — ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const long = "y".repeat(PICKUP_NO_SHOW_REASON_MAX_LENGTH + 1);
  const res = issuePickupWithoutCode(state, orderId, long, "CASH", "ADMIN", NOW);
  assert.equal(res.result.ok, false);
});

test("аварийная выдача: способ вне снимка — ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const cashOnly = patchOrder(state, orderId, {
    pickupPaymentMethodsSnapshot: ["CASH"],
  });
  const res = issuePickupWithoutCode(cashOnly, orderId, "Забыл код", "CARD", "ADMIN", NOW);
  assert.equal(res.result.ok, false);
});

test("аварийная выдача: некорректный nowIso — ошибка", () => {
  const { state, orderId } = makeReadyPickup();
  const res = issuePickupWithoutCode(state, orderId, "Забыл код", "CASH", "ADMIN", "bad");
  assert.equal(res.result.ok, false);
});

test("аварийная выдача: неверный статус — ошибка", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  s = created.state;
  const orderId = created.result.orderId as string; // RESTAURANT_REVIEW
  const res = issuePickupWithoutCode(s, orderId, "Забыл код", "CASH", "ADMIN", NOW);
  assert.equal(res.result.ok, false);
});

test("аварийная выдача: повтор не создаёт вторую settlement", () => {
  const { state, orderId } = makeReadyPickup();
  const first = issuePickupWithoutCode(state, orderId, "Забыл код", "CASH", "ADMIN", NOW);
  const second = issuePickupWithoutCode(first.state, orderId, "Ещё раз", "CASH", "ADMIN", NOW);
  assert.equal(second.result.ok, false);
  assert.equal(second.state.settlements.length, 1);
});

test("аварийная выдача уже выданного по коду заказа — ошибка", () => {
  const { state, orderId, code } = makeReadyPickup();
  const issued = completePickupWithCode(state, orderId, code, "CASH", "RESTAURANT", NOW);
  const res = issuePickupWithoutCode(issued.state, orderId, "Забыл код", "CASH", "ADMIN", NOW);
  assert.equal(res.result.ok, false);
  assert.equal(res.state.settlements.length, 1);
});

// --- Снимок способов оплаты и нормализация (§3, §4) --------------------------

test("создание PICKUP: снимок = способы ресторана", () => {
  const { state, orderId } = makeReadyPickup();
  assert.deepEqual(getOrder(state, orderId).pickupPaymentMethodsSnapshot, [
    "CASH",
    "CARD",
  ]);
});

test("создание PICKUP: pickupPaidWith = null", () => {
  const { state, orderId } = makeReadyPickup();
  assert.equal(getOrder(state, orderId).pickupPaidWith, null);
});

test("создание доставки: снимок = []", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-1-item-1", "size-standard").state;
  s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  assert.deepEqual(
    getOrder(created.state, orderId).pickupPaymentMethodsSnapshot,
    [],
  );
});

test("нормализация legacy PICKUP: снимок восстановлен из ресторана", () => {
  const base = createDefaultState();
  const legacy = {
    id: "order-900",
    publicNumber: "DIR-0900",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    customer: { id: "customer-1", name: "К", phone: "x" },
    restaurant: { id: "restaurant-1", name: "Ресторан 1", address: "a", zoneId: "zone-1" },
    address: null,
    deliveryMode: "PICKUP",
    paymentMethod: "PAY_AT_RESTAURANT",
    paymentStatus: "DUE_AT_PICKUP",
    paidAt: null,
    status: "READY_FOR_PICKUP",
    preparationMinutes: 20,
    expectedReadyAt: null,
    cancellationReason: null,
    pickupCode: "4321",
    pickupCodeUsed: false,
    items: [],
    financials: { foodSubtotalCents: 800, restaurantCommissionCents: 120 },
    history: [],
  };
  const migrated = upgradeToV6({ ...base, schemaVersion: 5, orders: [legacy] });
  assert.deepEqual(migrated.orders[0].pickupPaymentMethodsSnapshot, [
    "CASH",
    "CARD",
  ]);
  assert.equal(migrated.orders[0].pickupPaidWith, null);
});

test("нормализация legacy PICKUP без ресторана: fallback [CASH,CARD]", () => {
  const base = createDefaultState();
  const legacy = {
    id: "order-901",
    publicNumber: "DIR-0901",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    customer: { id: "customer-1", name: "К", phone: "x" },
    restaurant: { id: "restaurant-unknown", name: "Нет такого", address: "a", zoneId: "zone-1" },
    address: null,
    deliveryMode: "PICKUP",
    paymentMethod: "PAY_AT_RESTAURANT",
    paymentStatus: "DUE_AT_PICKUP",
    paidAt: null,
    status: "READY_FOR_PICKUP",
    preparationMinutes: 20,
    expectedReadyAt: null,
    cancellationReason: null,
    pickupCode: "4321",
    pickupCodeUsed: false,
    items: [],
    financials: { foodSubtotalCents: 800, restaurantCommissionCents: 120 },
    history: [],
  };
  const migrated = upgradeToV6({ ...base, schemaVersion: 5, orders: [legacy] });
  assert.deepEqual(migrated.orders[0].pickupPaymentMethodsSnapshot, [
    "CASH",
    "CARD",
  ]);
});

test("нормализация legacy delivery: снимок = []", () => {
  const base = createDefaultState();
  const legacy = {
    id: "order-902",
    publicNumber: "DIR-0902",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    customer: { id: "customer-1", name: "К", phone: "x" },
    restaurant: { id: "restaurant-1", name: "Ресторан 1", address: "a", zoneId: "zone-1" },
    address: null,
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
    paidAt: null,
    status: "DELIVERED",
    preparationMinutes: 20,
    expectedReadyAt: null,
    cancellationReason: null,
    items: [],
    financials: { foodSubtotalCents: 800, restaurantCommissionCents: 120 },
    history: [],
  };
  const migrated = upgradeToV6({ ...base, schemaVersion: 5, orders: [legacy] });
  assert.deepEqual(migrated.orders[0].pickupPaymentMethodsSnapshot, []);
  assert.equal(migrated.orders[0].pickupPaidWith, null);
});

test("нормализация не пересчитывает финансы/статус/код legacy-заказа", () => {
  const base = createDefaultState();
  const legacy = {
    id: "order-903",
    publicNumber: "DIR-0903",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    customer: { id: "customer-1", name: "К", phone: "x" },
    restaurant: { id: "restaurant-2", name: "Ресторан 2", address: "a", zoneId: "zone-2" },
    address: null,
    deliveryMode: "PICKUP",
    paymentMethod: "PAY_AT_RESTAURANT",
    paymentStatus: "DUE_AT_PICKUP",
    paidAt: null,
    status: "READY_FOR_PICKUP",
    preparationMinutes: 20,
    expectedReadyAt: null,
    cancellationReason: null,
    pickupCode: "7788",
    pickupCodeUsed: false,
    items: [],
    financials: { foodSubtotalCents: 800, restaurantCommissionCents: 120 },
    history: [],
  };
  const migrated = upgradeToV6({ ...base, schemaVersion: 5, orders: [legacy] });
  const o = migrated.orders[0];
  assert.equal(o.financials.foodSubtotalCents, 800);
  assert.equal(o.status, "READY_FOR_PICKUP");
  assert.equal(o.paymentStatus, "DUE_AT_PICKUP");
  assert.equal(o.pickupCode, "7788");
  assert.equal(migrated.settlements.length, 0);
});

test("нормализация сохраняет уже присутствующий снимок как есть", () => {
  const base = createDefaultState();
  const legacy = {
    id: "order-904",
    publicNumber: "DIR-0904",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    customer: { id: "customer-1", name: "К", phone: "x" },
    restaurant: { id: "restaurant-1", name: "Ресторан 1", address: "a", zoneId: "zone-1" },
    address: null,
    deliveryMode: "PICKUP",
    paymentMethod: "PAY_AT_RESTAURANT",
    paymentStatus: "DUE_AT_PICKUP",
    paidAt: null,
    status: "READY_FOR_PICKUP",
    preparationMinutes: 20,
    expectedReadyAt: null,
    cancellationReason: null,
    pickupCode: "4321",
    pickupCodeUsed: false,
    pickupPaymentMethodsSnapshot: ["CASH"],
    pickupPaidWith: null,
    items: [],
    financials: { foodSubtotalCents: 800, restaurantCommissionCents: 120 },
    history: [],
  };
  const migrated = upgradeToV6({ ...base, schemaVersion: 5, orders: [legacy] });
  assert.deepEqual(migrated.orders[0].pickupPaymentMethodsSnapshot, ["CASH"]);
});

test("нормализация legacy pickupPaidWith восстанавливается при наличии", () => {
  const base = createDefaultState();
  const legacy = {
    id: "order-905",
    publicNumber: "DIR-0905",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    customer: { id: "customer-1", name: "К", phone: "x" },
    restaurant: { id: "restaurant-1", name: "Ресторан 1", address: "a", zoneId: "zone-1" },
    address: null,
    deliveryMode: "PICKUP",
    paymentMethod: "PAY_AT_RESTAURANT",
    paymentStatus: "PAID_AT_RESTAURANT",
    paidAt: "2026-07-10T01:00:00.000Z",
    status: "PICKED_UP",
    preparationMinutes: 20,
    expectedReadyAt: null,
    cancellationReason: null,
    pickupCode: "4321",
    pickupCodeUsed: true,
    pickupPaidWith: "CARD",
    items: [],
    financials: { foodSubtotalCents: 800, restaurantCommissionCents: 120 },
    history: [],
  };
  const migrated = upgradeToV6({ ...base, schemaVersion: 5, orders: [legacy] });
  assert.equal(migrated.orders[0].pickupPaidWith, "CARD");
});
