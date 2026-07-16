/* eslint-disable @typescript-eslint/no-unused-vars -- типовые Expect-алиасы
   существуют только для compile-time проверки в tsc --noEmit */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrototypeContextValue } from "./prototype-provider.tsx";
import type { MutationAck } from "./prototype-store.ts";

/**
 * Тест 13 (Исправление 4): типы provider API. Проверка compile-time — файл
 * входит в `tsc --noEmit`; функция, объявленная как void, не пройдёт Expect.
 */

type Expect<T extends true> = T;
type ReturnsAckPromise<T> = T extends (...args: never[]) => infer R
  ? R extends Promise<MutationAck>
    ? true
    : false
  : false;

type _setMenuItemVariants = Expect<
  ReturnsAckPromise<PrototypeContextValue["setMenuItemVariants"]>
>;
type _savePromotion = Expect<
  ReturnsAckPromise<PrototypeContextValue["savePromotion"]>
>;
type _togglePromotion = Expect<
  ReturnsAckPromise<PrototypeContextValue["togglePromotion"]>
>;
type _resetPrototype = Expect<
  ReturnsAckPromise<PrototypeContextValue["resetPrototype"]>
>;
type _saveTariffMatrix = Expect<
  ReturnsAckPromise<PrototypeContextValue["saveTariffMatrix"]>
>;
type _restoreTariffs = Expect<
  ReturnsAckPromise<PrototypeContextValue["restoreTariffs"]>
>;
type _markReady = Expect<ReturnsAckPromise<PrototypeContextValue["markReady"]>>;
type _markOutForDelivery = Expect<
  ReturnsAckPromise<PrototypeContextValue["markOutForDelivery"]>
>;
type _markArriving = Expect<
  ReturnsAckPromise<PrototypeContextValue["markArriving"]>
>;
type _markDelivered = Expect<
  ReturnsAckPromise<PrototypeContextValue["markDelivered"]>
>;
type _markDeliveredByDriver = Expect<
  ReturnsAckPromise<PrototypeContextValue["markDeliveredByDriver"]>
>;
type _simulateOnlinePayment = Expect<
  ReturnsAckPromise<PrototypeContextValue["simulateOnlinePayment"]>
>;
type _setPreparationMinutes = Expect<
  ReturnsAckPromise<PrototypeContextValue["setPreparationMinutes"]>
>;
type _setRestaurantAccepting = Expect<
  ReturnsAckPromise<PrototypeContextValue["setRestaurantAccepting"]>
>;
type _setRestaurantWorkflow = Expect<
  ReturnsAckPromise<PrototypeContextValue["setRestaurantWorkflow"]>
>;
type _setItemQuantity = Expect<
  ReturnsAckPromise<PrototypeContextValue["setItemQuantity"]>
>;
type _updateAddress = Expect<
  ReturnsAckPromise<PrototypeContextValue["updateAddress"]>
>;

test("Тест 13: provider types для menu/promotions/reset возвращают Promise (compile-time)", () => {
  // Типовые Expect выше не позволяют tsc собрать проект, если какой-либо метод
  // снова замаскируется под void. Runtime-проверять здесь нечего.
  assert.ok(true);
});
