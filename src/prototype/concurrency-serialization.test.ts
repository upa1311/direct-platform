import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrderWithResult,
  addCartItem,
  createOrderFromCart,
  rejectRestaurantOrderWithResult,
  setCartFulfillmentChoice,
  updateCartAddress,
  type ActionResult,
} from "./actions.ts";
import { selectLatestPrototypeState } from "./prototype-store.ts";
import type { Order, PrototypeState } from "./models.ts";

/**
 * Исправление 5: реальная модель конфликта двух вкладок. Каждая вкладка держит
 * СВОЙ устаревший local state (одна и та же ревизия N), общий persisted store
 * моделирует localStorage (JSON-roundtrip, как parseStoredState). Executor
 * повторяет семантику runSerializedPrototypeMutation: под «lock» перечитывается
 * persisted, выбирается самый свежий base (selectLatestPrototypeState), мутация
 * применяется к нему, результат сохраняется синхронно до «освобождения lock».
 */

interface Tab {
  local: PrototypeState;
}

function makeSharedStore(initial: PrototypeState) {
  // JSON-roundtrip: persisted — отдельный объект, как после parseStoredState.
  let persisted: PrototypeState = JSON.parse(JSON.stringify(initial));
  return {
    read(): PrototypeState {
      return persisted;
    },
    runUnderLock<T>(
      tab: Tab,
      mutation: (baseState: PrototypeState) => ActionResult<T>,
    ): T {
      // Внутри lock: rebase на самый свежий state (persisted может быть новее).
      const base = selectLatestPrototypeState(tab.local, persisted);
      tab.local = base;
      const action = mutation(base);
      if (action.state !== base) {
        // Синхронное сохранение до освобождения lock.
        persisted = JSON.parse(JSON.stringify(action.state));
        tab.local = action.state;
      }
      return action.result;
    },
  };
}

function splitOrderState(fulfillment: "PICKUP" | "DELIVERY"): {
  state: PrototypeState;
  orderId: string;
} {
  let s = createDefaultState();
  s = {
    ...s,
    restaurants: s.restaurants.map((r) =>
      r.id === "restaurant-2"
        ? { ...r, orderWorkflowMode: "SPLIT_OPERATOR_KITCHEN" as const }
        : r,
    ),
  };
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  }
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  return { state: created.state, orderId: created.result.orderId as string };
}

function getOrder(state: PrototypeState, orderId: string): Order {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
}

/** Количество ресторанных STATUS-событий после создания заказа. */
function restaurantActionCount(order: Order): number {
  return order.history.filter(
    (e) => e.actor === "RESTAURANT" && e.type === "STATUS",
  ).length;
}

test("Сценарий A (PICKUP): кухня приняла первой — устаревший оператор получает race-ошибку", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const revisionN = initial.revision;
  const store = makeSharedStore(initial);
  // Обе вкладки стартуют с ОДНОЙ ревизии N.
  const kitchenTab: Tab = { local: initial };
  const operatorTab: Tab = { local: initial };

  // 1) Кухня получает lock, перечитывает N, принимает, сохраняет N+1.
  const acceptRes = store.runUnderLock(kitchenTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "KITCHEN"),
  );
  assert.equal(acceptRes.ok, true);
  assert.equal(store.read().revision, revisionN + 1);

  // 2) Оператор (локально всё ещё N!) получает lock, rebase на N+1, отклоняет.
  assert.equal(operatorTab.local.revision, revisionN);
  const rejectRes = store.runUnderLock(operatorTab, (base) =>
    rejectRestaurantOrderWithResult(
      base,
      orderId,
      "Нет нужных позиций",
      "RESTAURANT",
      "OPERATOR",
    ),
  );
  assert.equal(rejectRes.ok, false);
  assert.equal(rejectRes.error, "Заказ уже обработан. Обновите данные.");

  // Итог: заказ принят, не отменён; одна эффективная мутация.
  const finalOrder = getOrder(store.read(), orderId);
  assert.equal(finalOrder.status, "PREPARING");
  assert.equal(restaurantActionCount(finalOrder), 1);
  // Неуспешное действие не увеличило ревизию.
  assert.equal(store.read().revision, revisionN + 1);
  // Финансы/оплата/settlement не тронуты.
  assert.deepEqual(finalOrder.financials, getOrder(initial, orderId).financials);
  assert.equal(finalOrder.paymentStatus, "DUE_AT_PICKUP");
  assert.equal(store.read().settlements.length, 0);
  // Один заказ, без дублей.
  assert.equal(store.read().orders.filter((o) => o.id === orderId).length, 1);
});

test("Сценарий A (ONLINE): принятие даёт AWAITING_PAYMENT, отклонение не перезаписывает", () => {
  const { state: initial, orderId } = splitOrderState("DELIVERY");
  const store = makeSharedStore(initial);
  const kitchenTab: Tab = { local: initial };
  const operatorTab: Tab = { local: initial };

  const acceptRes = store.runUnderLock(kitchenTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "KITCHEN"),
  );
  assert.equal(acceptRes.ok, true);
  assert.equal(getOrder(store.read(), orderId).status, "AWAITING_PAYMENT");

  const rejectRes = store.runUnderLock(operatorTab, (base) =>
    rejectRestaurantOrderWithResult(base, orderId, "Причина", "RESTAURANT", "OPERATOR"),
  );
  assert.equal(rejectRes.ok, false);
  const finalOrder = getOrder(store.read(), orderId);
  assert.equal(finalOrder.status, "AWAITING_PAYMENT");
  assert.equal(finalOrder.paymentStatus, "AWAITING_PAYMENT");
  assert.equal(restaurantActionCount(finalOrder), 1);
});

test("Сценарий B: оператор отклонил первым — устаревшая кухня не может принять", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const revisionN = initial.revision;
  const store = makeSharedStore(initial);
  const kitchenTab: Tab = { local: initial };
  const operatorTab: Tab = { local: initial };

  // 1) Оператор первым: lock → N → отклонение → N+1.
  const rejectRes = store.runUnderLock(operatorTab, (base) =>
    rejectRestaurantOrderWithResult(
      base,
      orderId,
      "Ресторан не может выполнить заказ",
      "RESTAURANT",
      "OPERATOR",
    ),
  );
  assert.equal(rejectRes.ok, true);
  assert.equal(store.read().revision, revisionN + 1);

  // 2) Кухня (локально N) получает lock второй, rebase на N+1, пытается принять.
  const acceptRes = store.runUnderLock(kitchenTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "KITCHEN"),
  );
  assert.equal(acceptRes.ok, false);
  assert.equal(acceptRes.error, "Заказ уже обработан. Обновите данные.");

  const finalOrder = getOrder(store.read(), orderId);
  assert.equal(finalOrder.status, "CANCELED");
  assert.equal(restaurantActionCount(finalOrder), 1);
  assert.equal(store.read().revision, revisionN + 1);
  assert.equal(store.read().settlements.length, 0);
});

test("selectLatestPrototypeState: выбирает более свежий persisted, иначе локальный", () => {
  const { state } = splitOrderState("PICKUP");
  // stored отсутствует → локальный.
  assert.equal(selectLatestPrototypeState(state, null), state);
  // stored свежее → stored.
  const newer: PrototypeState = {
    ...state,
    revision: state.revision + 1,
    updatedAt: new Date(Date.parse(state.updatedAt) + 1000).toISOString(),
  };
  assert.equal(selectLatestPrototypeState(state, newer), newer);
  // локальный свежее → локальный.
  assert.equal(selectLatestPrototypeState(newer, state), newer);
});
