import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
} from "./actions.ts";
import {
  LEGACY_V6_PROTOTYPE_STORAGE_KEY,
  PROTOTYPE_STORAGE_KEY,
  parseLegacyStoredState,
  parseStoredState,
  resolveBootstrapState,
  safeReadStoredState,
  safeReadStoredValue,
} from "./prototype-store.ts";
import type { PrototypeState } from "./models.ts";

/**
 * Исправление 1: модель legacy bootstrap поверх ЧИСТОГО решения
 * resolveBootstrapState — того же, что вызывает provider под Web Lock с
 * заново прочитанными значениями. Хранилище моделируется Map (localStorage).
 */

/** Состояние с активным заказом (принят кухней) — «свежий v7» другой вкладки. */
function stateWithAcceptedOrder(): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  const accepted = acceptRestaurantOrder(created.state, orderId, 20);
  return { state: accepted, orderId };
}

/** Legacy-состояние с данными (v6-подобный JSON с заказами). */
function legacyStateWithOrder(): PrototypeState {
  const { state } = stateWithAcceptedOrder();
  const legacy = parseLegacyStoredState(JSON.stringify(state));
  assert.ok(legacy);
  return legacy;
}

/** Bootstrap вкладки: как provider.runBootstrap, но над Map-хранилищем. */
function runModelBootstrap(
  store: Map<string, string>,
  localState: PrototypeState,
  localIsInitial: boolean,
): { state: PrototypeState; persisted: boolean } {
  // Повторное чтение внутри lock — никаких snapshot'ов до него.
  const freshV7State = parseStoredState(
    store.get(PROTOTYPE_STORAGE_KEY) ?? null,
  );
  const legacyState = freshV7State
    ? null
    : parseLegacyStoredState(store.get(LEGACY_V6_PROTOTYPE_STORAGE_KEY) ?? null);
  const resolution = resolveBootstrapState({
    freshV7State,
    legacyState,
    localState,
    localIsInitial,
  });
  if (resolution.shouldPersist) {
    store.set(PROTOTYPE_STORAGE_KEY, JSON.stringify(resolution.state));
  }
  return { state: resolution.state, persisted: resolution.shouldPersist };
}

test("Тест 1/22: legacy bootstrap не перезаписывает v7, появившийся после первого чтения", () => {
  const store = new Map<string, string>();
  const legacySource = legacyStateWithOrder();
  store.set(LEGACY_V6_PROTOTYPE_STORAGE_KEY, JSON.stringify(legacySource));

  // Вкладка A прочитала отсутствие v7 и нашла legacy (устаревший snapshot,
  // который provider больше НЕ использует). До её commit вкладка B сохранила
  // свежий v7 с активным заказом и большей ревизией.
  const { state: freshV7, orderId } = stateWithAcceptedOrder();
  store.set(PROTOTYPE_STORAGE_KEY, JSON.stringify(freshV7));

  // Вкладка A получает lock и bootstrap'ится с ПОВТОРНЫМ чтением.
  const localDefault = createDefaultState();
  const outcome = runModelBootstrap(store, localDefault, true);

  // Legacy не записан, v7 не перезаписан.
  assert.equal(outcome.persisted, false);
  const storedAfter = parseStoredState(
    store.get(PROTOTYPE_STORAGE_KEY) ?? null,
  ) as PrototypeState;
  assert.equal(storedAfter.revision, freshV7.revision);
  // Итоговый state вкладки A — свежий v7: ревизия и активный заказ на месте.
  assert.equal(outcome.state.revision, freshV7.revision);
  const order = outcome.state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  assert.equal(order.status, "PREPARING");
});

test("Тест 2: входящий BroadcastChannel state до bootstrap не откатывается", () => {
  const store = new Map<string, string>();
  const legacySource = legacyStateWithOrder();
  store.set(LEGACY_V6_PROTOTYPE_STORAGE_KEY, JSON.stringify(legacySource));

  // Вкладка уже приняла свежий state по BroadcastChannel (localIsInitial=false),
  // он новее legacy. v7 в хранилище нет (края: запись другой вкладки не видна).
  const { state: broadcastState, orderId } = stateWithAcceptedOrder();
  const incoming: PrototypeState = {
    ...broadcastState,
    revision: legacySource.revision + 5,
  };
  const outcome = runModelBootstrap(store, incoming, false);

  // Bootstrap не заменяет более свежий локальный state устаревшим legacy.
  assert.equal(outcome.state, incoming);
  assert.equal(
    outcome.state.orders.find((o) => o.id === orderId)?.status,
    "PREPARING",
  );
  // Выбранное (локальное) состояние записано как v7 — но это не откат.
  assert.equal(outcome.persisted, true);
  const storedAfter = parseStoredState(
    store.get(PROTOTYPE_STORAGE_KEY) ?? null,
  ) as PrototypeState;
  assert.equal(storedAfter.revision, incoming.revision);
});

test("Тест: нетронутый initial default уступает legacy-данным при миграции", () => {
  const store = new Map<string, string>();
  const legacySource = legacyStateWithOrder();
  store.set(LEGACY_V6_PROTOTYPE_STORAGE_KEY, JSON.stringify(legacySource));

  const localDefault = createDefaultState();
  const outcome = runModelBootstrap(store, localDefault, true);

  // Legacy выбран (даже при «не новее» по revision/updatedAt) и записан в v7.
  assert.equal(outcome.persisted, true);
  assert.equal(outcome.state.orders.length, legacySource.orders.length);
  assert.ok(outcome.state.orders.length > 0);
});

test("Тест: без v7 и без legacy ничего не записывается", () => {
  const store = new Map<string, string>();
  const localDefault = createDefaultState();
  const outcome = runModelBootstrap(store, localDefault, true);
  assert.equal(outcome.persisted, false);
  assert.equal(outcome.state, localDefault);
  assert.equal(store.has(PROTOTYPE_STORAGE_KEY), false);
});

test("Тест 3: ошибка чтения localStorage не роняет provider (safeRead → null)", () => {
  // В node window отсутствует — безопасное чтение возвращает null.
  assert.equal(safeReadStoredValue("любой-ключ"), null);
  assert.equal(safeReadStoredState(PROTOTYPE_STORAGE_KEY), null);

  // window.localStorage бросает SecurityError — безопасное чтение тоже null.
  const g = globalThis as { window?: unknown };
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  g.window = {
    localStorage: {
      getItem() {
        throw new Error("SecurityError");
      },
    },
  };
  try {
    assert.equal(safeReadStoredValue(PROTOTYPE_STORAGE_KEY), null);
    assert.equal(safeReadStoredState(PROTOTYPE_STORAGE_KEY), null);
  } finally {
    if (hadWindow) {
      g.window = prevWindow;
    } else {
      delete g.window;
    }
  }
});

test("Тест: битый JSON в v7 не роняет bootstrap и не считается v7", () => {
  const store = new Map<string, string>();
  store.set(PROTOTYPE_STORAGE_KEY, "{не json");
  const localDefault = createDefaultState();
  const outcome = runModelBootstrap(store, localDefault, true);
  assert.equal(outcome.state, localDefault);
  assert.equal(outcome.persisted, false);
});
