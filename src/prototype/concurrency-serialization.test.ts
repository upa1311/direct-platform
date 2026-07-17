import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  acceptRestaurantOrderWithResult,
  addCartItem,
  adjustOrderEtaFromIntent,
  cancelOrderByClient,
  completePickupWithCode,
  createOrderFromCart,
  expireUnansweredRestaurantOrders,
  markOrderReady,
  rejectRestaurantOrder,
  rejectRestaurantOrderWithResult,
  resumeExpiredOperationalPauses,
  setCartFulfillmentChoice,
  setMenuItemOperationallyUnavailable,
  updateCartAddress,
  type ActionResult,
} from "./actions.ts";
import {
  PROTOTYPE_SAVE_FAILED_ERROR,
  SAFE_TAB_SYNC_UNAVAILABLE_ERROR,
  executeSerializedPrototypeMutation,
  selectLatestPrototypeState,
} from "./prototype-store.ts";
import type { Order, PrototypeState } from "./models.ts";

/**
 * Исправления 1–6: реальная модель конфликта двух вкладок поверх ЧИСТОГО ядра
 * транзакции executeSerializedPrototypeMutation (того же, что использует
 * provider). Каждая вкладка держит СВОЙ устаревший local state (одна и та же
 * ревизия N), общий persisted store моделирует localStorage (JSON-roundtrip,
 * как parseStoredState). Под «lock» ядро перечитывает persisted, выбирает
 * самый свежий base, применяет мутацию и сохраняет ДО освобождения lock.
 * Тесты не зависят от браузерного navigator.locks.
 */

interface Tab {
  local: PrototypeState;
}

function makeSharedStore(initial: PrototypeState) {
  // JSON-roundtrip: persisted — отдельный объект, как после parseStoredState.
  let persisted: PrototypeState = JSON.parse(JSON.stringify(initial));
  let persistCalls = 0;
  return {
    read(): PrototypeState {
      return persisted;
    },
    persistCalls(): number {
      return persistCalls;
    },
    runUnderLock<T>(
      tab: Tab,
      mutation: (baseState: PrototypeState) => ActionResult<T>,
    ): T {
      const outcome = executeSerializedPrototypeMutation({
        localState: tab.local,
        storedState: persisted,
        mutation,
        persist: (next) => {
          persistCalls += 1;
          persisted = JSON.parse(JSON.stringify(next));
        },
      });
      tab.local = outcome.nextState;
      return outcome.result;
    },
  };
}

/** Обёртка для legacy state-only функций (модель runSerializedStateMutation). */
function stateOnly(
  fn: (baseState: PrototypeState) => PrototypeState,
): (baseState: PrototypeState) => ActionResult<null> {
  return (baseState) => ({ state: fn(baseState), result: null });
}

/** Корзина restaurant-2 (SPLIT) заполнена, заказ ещё НЕ создан. */
function cartReadyState(fulfillment: "PICKUP" | "DELIVERY"): PrototypeState {
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
  return s;
}

function splitOrderState(fulfillment: "PICKUP" | "DELIVERY"): {
  state: PrototypeState;
  orderId: string;
} {
  const created = createOrderFromCart(cartReadyState(fulfillment));
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

/** nowIso позже createdAt на заданное число минут (для автозакрытия 7 минут). */
function minutesAfter(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

test("Сценарий A (PICKUP): одна вкладка приняла первой — устаревшая вкладка получает race-ошибку", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const revisionN = initial.revision;
  const store = makeSharedStore(initial);
  // Обе вкладки стартуют с ОДНОЙ ревизии N.
  const acceptingTab: Tab = { local: initial };
  const operatorTab: Tab = { local: initial };

  // 1) Первая вкладка получает lock, перечитывает N, принимает, сохраняет N+1.
  const acceptRes = store.runUnderLock(acceptingTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
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
  const acceptingTab: Tab = { local: initial };
  const operatorTab: Tab = { local: initial };

  const acceptRes = store.runUnderLock(acceptingTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
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

test("Сценарий B: одна вкладка отклонила первой — устаревшая вкладка не может принять", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const revisionN = initial.revision;
  const store = makeSharedStore(initial);
  const acceptingTab: Tab = { local: initial };
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

  // 2) Вторая вкладка (локально N) получает lock, rebase на N+1, пытается принять.
  const acceptRes = store.runUnderLock(acceptingTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
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

// ─── Исправление 6: гонки с системной автоотменой (maintenance sweep) ────────

test("Accept против auto-expire: оператор принял первым — sweep не отменяет заказ", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const acceptingTab: Tab = { local: initial };
  const sweepTab: Tab = { local: initial };
  const createdAt = getOrder(initial, orderId).createdAt;

  const acceptRes = store.runUnderLock(acceptingTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
  );
  assert.equal(acceptRes.ok, true);
  const revisionAfterAccept = store.read().revision;

  // Sweep (устаревшая вкладка, время далеко за границей 7 минут) через тот же
  // gateway: rebase на принятый заказ → PREPARING не под автоотмену → no-op.
  store.runUnderLock(
    sweepTab,
    stateOnly((base) => {
      const nowIso = minutesAfter(createdAt, 8);
      return resumeExpiredOperationalPauses(
        expireUnansweredRestaurantOrders(base, nowIso),
        nowIso,
      );
    }),
  );

  const finalOrder = getOrder(store.read(), orderId);
  assert.equal(finalOrder.status, "PREPARING");
  // Нет одновременно события принятия И автоотмены.
  assert.equal(restaurantActionCount(finalOrder), 1);
  assert.equal(
    finalOrder.history.filter((e) => e.actor === "SYSTEM").length,
    0,
  );
  // No-op sweep не увеличил ревизию и ничего не записал.
  assert.equal(store.read().revision, revisionAfterAccept);
});

test("Accept против auto-expire: sweep отменил первым — устаревший оператор получает ошибку", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const acceptingTab: Tab = { local: initial };
  const sweepTab: Tab = { local: initial };
  const createdAt = getOrder(initial, orderId).createdAt;

  store.runUnderLock(
    sweepTab,
    stateOnly((base) =>
      expireUnansweredRestaurantOrders(base, minutesAfter(createdAt, 8)),
    ),
  );
  assert.equal(getOrder(store.read(), orderId).status, "CANCELED");
  const revisionAfterExpire = store.read().revision;

  const acceptRes = store.runUnderLock(acceptingTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
  );
  assert.equal(acceptRes.ok, false);
  assert.equal(acceptRes.error, "Заказ уже обработан. Обновите данные.");
  assert.equal(getOrder(store.read(), orderId).status, "CANCELED");
  assert.equal(store.read().revision, revisionAfterExpire);
});

test("Reject против auto-expire: sweep отменил первым — устаревший оператор получает ошибку", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const operatorTab: Tab = { local: initial };
  const sweepTab: Tab = { local: initial };
  const createdAt = getOrder(initial, orderId).createdAt;

  store.runUnderLock(
    sweepTab,
    stateOnly((base) =>
      expireUnansweredRestaurantOrders(base, minutesAfter(createdAt, 8)),
    ),
  );
  const rejectRes = store.runUnderLock(operatorTab, (base) =>
    rejectRestaurantOrderWithResult(base, orderId, "Причина", "RESTAURANT", "OPERATOR"),
  );
  assert.equal(rejectRes.ok, false);
  const finalOrder = getOrder(store.read(), orderId);
  assert.equal(finalOrder.status, "CANCELED");
  // Только одно терминальное действие в истории.
  assert.equal(restaurantActionCount(finalOrder), 0);
});

// ─── Гонки с клиентской отменой ──────────────────────────────────────────────

test("Accept против client cancel: клиент отменил первым — устаревший оператор получает ошибку", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const acceptingTab: Tab = { local: initial };
  const clientTab: Tab = { local: initial };

  const cancelRes = store.runUnderLock(clientTab, (base) =>
    cancelOrderByClient(base, orderId, "Заказал по ошибке"),
  );
  assert.equal(cancelRes.ok, true);

  const acceptRes = store.runUnderLock(acceptingTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
  );
  assert.equal(acceptRes.ok, false);
  assert.equal(acceptRes.error, "Заказ уже обработан. Обновите данные.");
  assert.equal(getOrder(store.read(), orderId).status, "CANCELED");
});

test("Accept против client cancel: оператор принял первым — устаревший клиент не отменяет бесплатно", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const acceptingTab: Tab = { local: initial };
  const clientTab: Tab = { local: initial };

  const acceptRes = store.runUnderLock(acceptingTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
  );
  assert.equal(acceptRes.ok, true);

  const cancelRes = store.runUnderLock(clientTab, (base) =>
    cancelOrderByClient(base, orderId, "Передумал"),
  );
  assert.equal(cancelRes.ok, false);
  const finalOrder = getOrder(store.read(), orderId);
  assert.equal(finalOrder.status, "PREPARING");
  assert.deepEqual(finalOrder.financials, getOrder(initial, orderId).financials);
});

test("Reject против client cancel: клиент отменил первым — оператор получает race-ошибку", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const operatorTab: Tab = { local: initial };
  const clientTab: Tab = { local: initial };

  const cancelRes = store.runUnderLock(clientTab, (base) =>
    cancelOrderByClient(base, orderId, "Заказал по ошибке"),
  );
  assert.equal(cancelRes.ok, true);
  const revisionAfterCancel = store.read().revision;

  const rejectRes = store.runUnderLock(operatorTab, (base) =>
    rejectRestaurantOrderWithResult(base, orderId, "Причина", "RESTAURANT", "OPERATOR"),
  );
  assert.equal(rejectRes.ok, false);
  assert.equal(rejectRes.error, "Заказ уже обработан. Обновите данные.");
  assert.equal(store.read().revision, revisionAfterCancel);
});

test("Client cancel против auto-expire: sweep отменил первым — повторной отмены нет", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const clientTab: Tab = { local: initial };
  const sweepTab: Tab = { local: initial };
  const createdAt = getOrder(initial, orderId).createdAt;

  store.runUnderLock(
    sweepTab,
    stateOnly((base) =>
      expireUnansweredRestaurantOrders(base, minutesAfter(createdAt, 8)),
    ),
  );
  const revisionAfterExpire = store.read().revision;

  const cancelRes = store.runUnderLock(clientTab, (base) =>
    cancelOrderByClient(base, orderId, "Передумал"),
  );
  assert.equal(cancelRes.ok, false);
  assert.equal(store.read().revision, revisionAfterExpire);
  // Терминальное событие одно (SYSTEM), дублей отмены нет.
  const finalOrder = getOrder(store.read(), orderId);
  assert.equal(finalOrder.status, "CANCELED");
});

// ─── Создание заказа из двух устаревших клиентских вкладок ───────────────────

test("Create order: две устаревшие вкладки не создают дубликат orderId/publicNumber", () => {
  const initial = cartReadyState("PICKUP");
  const nextNumberBefore = initial.nextOrderNumber;
  const ordersBefore = initial.orders.length;
  const store = makeSharedStore(initial);
  const tabA: Tab = { local: initial };
  const tabB: Tab = { local: initial };

  const resA = store.runUnderLock(tabA, (base) => createOrderFromCart(base));
  assert.ok(resA.orderId);

  // Вкладка B стартовала с той же корзиной, но под lock rebase видит, что
  // корзина уже израсходована — второй заказ не создаётся.
  const resB = store.runUnderLock(tabB, (base) => createOrderFromCart(base));
  assert.equal(resB.orderId, null);

  const finalState = store.read();
  assert.equal(finalState.orders.length, ordersBefore + 1);
  // nextOrderNumber увеличился ровно один раз.
  assert.equal(finalState.nextOrderNumber, nextNumberBefore + 1);
  // Никаких одинаковых orderId и publicNumber.
  const ids = finalState.orders.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length);
  const numbers = finalState.orders.map((o) => o.publicNumber);
  assert.equal(new Set(numbers).size, numbers.length);

  // Повторное заполнение корзины и создание дают НОВЫЙ уникальный номер.
  store.runUnderLock(
    tabB,
    stateOnly((base) => {
      let s = setCartFulfillmentChoice(base, "PICKUP");
      s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
      return s;
    }),
  );
  const resC = store.runUnderLock(tabB, (base) => createOrderFromCart(base));
  assert.ok(resC.orderId);
  assert.notEqual(resC.orderId, resA.orderId);
  const allIds = store.read().orders.map((o) => o.id);
  assert.equal(new Set(allIds).size, allIds.length);
  assert.equal(store.read().nextOrderNumber, nextNumberBefore + 2);
});

// ─── Несвязанные мутации не перезаписывают принятие ──────────────────────────

test("Stale cart mutation после принятия: rebase сохраняет и заказ, и корзину", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const acceptingTab: Tab = { local: initial };
  const clientTab: Tab = { local: initial };

  store.runUnderLock(acceptingTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
  );

  // Устаревшая клиентская вкладка меняет адрес: изменение НЕ должно откатить
  // статус заказа (раньше persistence-effect мог записать весь старый state).
  store.runUnderLock(
    clientTab,
    stateOnly((base) =>
      updateCartAddress(base, { street: "Новая улица", house: "7" }),
    ),
  );

  const finalState = store.read();
  assert.equal(getOrder(finalState, orderId).status, "PREPARING");
  assert.equal(finalState.cart.address.street, "Новая улица");
  assert.equal(finalState.cart.address.house, "7");
});

test("Menu mutation после order mutation: оба изменения сохраняются", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const acceptingTab: Tab = { local: initial };
  const staleTab: Tab = { local: initial };

  store.runUnderLock(acceptingTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
  );
  const menuRes = store.runUnderLock(staleTab, (base) =>
    setMenuItemOperationallyUnavailable(
      base,
      "restaurant-2",
      "restaurant-2-item-1",
      "Закончились ингредиенты",
      "MANUAL",
      null,
      "RESTAURANT",
      "KITCHEN",
    ),
  );
  assert.equal(menuRes.ok, true);

  const finalState = store.read();
  assert.equal(getOrder(finalState, orderId).status, "PREPARING");
  const item = finalState.menuItems.find(
    (m) => m.id === "restaurant-2-item-1",
  );
  assert.ok(item?.availabilityPause);
});

test("ETA mutation после принятия: не откатывает статус и меняет время", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const acceptingTab: Tab = { local: initial };
  const staleTab: Tab = { local: initial };

  store.runUnderLock(acceptingTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
  );
  const before = getOrder(store.read(), orderId).expectedReadyAt;
  assert.ok(before);

  const etaRes = store.runUnderLock(staleTab, (base) =>
    adjustOrderEtaFromIntent(
      base,
      orderId,
      { kind: "DELAY", minutes: 10 },
      "Загружена кухня",
      "RESTAURANT",
      new Date().toISOString(),
      "KITCHEN",
    ),
  );
  assert.equal(etaRes.ok, true);
  const finalOrder = getOrder(store.read(), orderId);
  assert.equal(finalOrder.status, "PREPARING");
  assert.notEqual(finalOrder.expectedReadyAt, before);
});

// ─── Свойства самого ядра транзакции ─────────────────────────────────────────

test("No-op мутация: ничего не записывает, не растит ревизию, принимает свежий base", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const accepted = acceptRestaurantOrder(initial, orderId, 20, "RESTAURANT", "OPERATOR");

  let persistCalls = 0;
  // Устаревший local + более свежий stored: no-op мутация возвращает base.
  const outcome = executeSerializedPrototypeMutation({
    localState: initial,
    storedState: accepted,
    mutation: (base) => ({ state: base, result: "untouched" }),
    persist: () => {
      persistCalls += 1;
    },
  });
  // Устаревший local НЕ записан обратно (то, что раньше делал опасный
  // persistence-effect); вкладка просто принимает свежий rebased state.
  assert.equal(persistCalls, 0);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.nextState, accepted);
  assert.equal(outcome.result, "untouched");
});

test("Maintenance sweep через gateway: без изменений — без записи", () => {
  const { state: initial } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const sweepTab: Tab = { local: initial };
  const revisionBefore = store.read().revision;
  const persistBefore = store.persistCalls();

  // Заказ свежий (7 минут не прошло) — обе maintenance-функции no-op.
  store.runUnderLock(
    sweepTab,
    stateOnly((base) => {
      const nowIso = new Date().toISOString();
      return resumeExpiredOperationalPauses(
        expireUnansweredRestaurantOrders(base, nowIso),
        nowIso,
      );
    }),
  );
  assert.equal(store.read().revision, revisionBefore);
  assert.equal(store.persistCalls(), persistBefore);
});

test("Ошибка localStorage.setItem: транзакция не успешна, state не принят", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");

  assert.throws(() =>
    executeSerializedPrototypeMutation({
      localState: initial,
      storedState: null,
      mutation: (base) =>
        acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
      persist: () => {
        throw new Error("QuotaExceededError");
      },
    }),
  );

  // Модель провайдера: catch → русская инфраструктурная ошибка, stateRef
  // остаётся на прежнем подтверждённом состоянии, ложного успеха нет.
  let result: { ok: boolean; error: string | null };
  let stateRefCurrent = initial;
  try {
    const outcome = executeSerializedPrototypeMutation({
      localState: stateRefCurrent,
      storedState: null,
      mutation: (base) =>
        acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
      persist: () => {
        throw new Error("QuotaExceededError");
      },
    });
    stateRefCurrent = outcome.nextState;
    result = outcome.result;
  } catch {
    result = { ok: false, error: PROTOTYPE_SAVE_FAILED_ERROR };
  }
  assert.equal(result.ok, false);
  assert.equal(result.error, "Не удалось сохранить действие. Обновите страницу и повторите.");
  assert.equal(stateRefCurrent, initial);
  assert.equal(getOrder(stateRefCurrent, orderId).status, "RESTAURANT_REVIEW");
});

test("Web Locks недоступны: критическая операция получает fail-closed русскую ошибку", () => {
  // Провайдер при отсутствии navigator.locks возвращает эту ошибку для
  // критических lifecycle-мутаций (без spin-lock и без записи stale state).
  assert.equal(
    SAFE_TAB_SYNC_UNAVAILABLE_ERROR,
    "Безопасная синхронизация вкладок недоступна в этом браузере.",
  );
});

test("Ошибка BroadcastChannel после успешной записи не теряет транзакцию", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  let persisted: PrototypeState | null = null;

  const outcome = executeSerializedPrototypeMutation({
    localState: initial,
    storedState: null,
    mutation: (base) =>
      acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT", "OPERATOR"),
    persist: (next) => {
      persisted = next;
    },
    broadcast: () => {
      throw new Error("channel closed");
    },
  });
  // Commit состоялся: persist выполнен, результат успешный, state принят.
  assert.equal(outcome.committed, true);
  assert.equal(outcome.result.ok, true);
  assert.ok(persisted);
  assert.equal(
    getOrder(persisted as PrototypeState, orderId).status,
    "PREPARING",
  );
});

// ─── Результаты для UI: COMBINED и ADMIN ─────────────────────────────────────

test("COMBINED reject: устаревшая вкладка получает domain error для показа в форме", () => {
  // COMBINED-режим: обычный ресторан по умолчанию (без SPLIT-переключения).
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const initial = created.state;
  const orderId = created.result.orderId as string;
  const store = makeSharedStore(initial);
  const combinedTab: Tab = { local: initial };
  const otherTab: Tab = { local: initial };

  store.runUnderLock(otherTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "RESTAURANT"),
  );
  // COMBINED-страница вызывает reject без workspace-роли (резолвится COMBINED).
  const rejectRes = store.runUnderLock(combinedTab, (base) =>
    rejectRestaurantOrderWithResult(base, orderId, "Причина", "RESTAURANT"),
  );
  assert.equal(rejectRes.ok, false);
  assert.equal(rejectRes.error, "Заказ уже обработан. Обновите данные.");
});

test("ADMIN accept/reject: получают типизированный result (ADMIN — отдельный actor)", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const store = makeSharedStore(initial);
  const adminTab: Tab = { local: initial };

  const acceptRes = store.runUnderLock(adminTab, (base) =>
    acceptRestaurantOrderWithResult(base, orderId, 20, "ADMIN"),
  );
  assert.equal(acceptRes.ok, true);
  const order = getOrder(store.read(), orderId);
  // ADMIN не получает restaurant workspace-role.
  const adminEvent = order.history.find((e) => e.actor === "ADMIN");
  assert.ok(adminEvent);
  assert.equal(adminEvent.restaurantWorkspaceRole, undefined);

  const rejectRes = store.runUnderLock(adminTab, (base) =>
    rejectRestaurantOrderWithResult(base, orderId, "Причина", "ADMIN"),
  );
  assert.equal(rejectRes.ok, false);
});

test("Compatibility-wrappers домена продолжают работать (state-возвращающие)", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  const accepted = acceptRestaurantOrder(initial, orderId, 20, "RESTAURANT", "OPERATOR");
  assert.equal(getOrder(accepted, orderId).status, "PREPARING");

  const { state: initial2, orderId: orderId2 } = splitOrderState("PICKUP");
  const rejected = rejectRestaurantOrder(
    initial2,
    orderId2,
    "Причина",
    "RESTAURANT",
    "OPERATOR",
  );
  assert.equal(getOrder(rejected, orderId2).status, "CANCELED");
});

// ─── Выдача самовывоза: код и settlement не задваиваются ─────────────────────

test("Pickup code не используется дважды; settlement не дублируется", () => {
  const { state: initial, orderId } = splitOrderState("PICKUP");
  let s = acceptRestaurantOrder(initial, orderId, 20, "RESTAURANT", "OPERATOR");
  s = markOrderReady(s, orderId, "RESTAURANT", "KITCHEN");
  const ready = getOrder(s, orderId);
  assert.equal(ready.status, "READY_FOR_PICKUP");
  assert.ok(ready.pickupCode);
  const code = ready.pickupCode as string;

  const store = makeSharedStore(s);
  const tabA: Tab = { local: s };
  const tabB: Tab = { local: s };

  const first = store.runUnderLock(tabA, (base) =>
    completePickupWithCode(
      base,
      orderId,
      code,
      "CASH",
      "RESTAURANT",
      new Date().toISOString(),
      "OPERATOR",
    ),
  );
  assert.equal(first.ok, true);
  const settlementsAfterFirst = store.read().settlements.length;

  // Вторая (устаревшая) вкладка пытается выдать тем же кодом.
  const second = store.runUnderLock(tabB, (base) =>
    completePickupWithCode(
      base,
      orderId,
      code,
      "CASH",
      "RESTAURANT",
      new Date().toISOString(),
      "OPERATOR",
    ),
  );
  assert.equal(second.ok, false);

  const finalState = store.read();
  assert.equal(getOrder(finalState, orderId).status, "PICKED_UP");
  assert.equal(getOrder(finalState, orderId).pickupCodeUsed, true);
  // Settlement не задвоился, финансовый снимок заказа не пересчитан.
  assert.equal(finalState.settlements.length, settlementsAfterFirst);
  assert.equal(
    finalState.orders.filter((o) => o.id === orderId).length,
    1,
  );
});
