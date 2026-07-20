import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  completePickupAtRestaurant,
  createOrderFromCart,
  markOrderReady,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import { normalizePrototypeState } from "./prototype-store.ts";
import { computeOrderMoneyMovement } from "./order-money-movement.ts";
import { finalizePickupMoneyMovement } from "./money-movement-snapshot.ts";
import type {
  FinancialSnapshot,
  Order,
  PrototypeState,
} from "./models.ts";

/**
 * Канонический money movement в финансовом снимке (schema v10): создание
 * заказов, однократная фиксация канала самовывоза при выдаче и fail-closed
 * migration старых состояний.
 */

const ADDR = { street: "Тестовая улица 1", house: "1" };

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

/** Новый PLATFORM_DRIVER-заказ (restaurant-2, доставка Direct, онлайн). */
function platformOrder(): { state: PrototypeState; orderId: string } {
  let s = updateCartAddress(createDefaultState(), ADDR);
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

/** Новый RESTAURANT_DELIVERY-заказ (restaurant-3, собственный курьер). */
function courierOrder(): { state: PrototypeState; orderId: string } {
  let s = updateCartAddress(createDefaultState(), ADDR);
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

/** Новый PICKUP-заказ (restaurant-2). */
function pickupOrder(): { state: PrototypeState; orderId: string } {
  let s = setCartFulfillmentChoice(createDefaultState(), "PICKUP");
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  return { state: created.state, orderId: created.result.orderId as string };
}

/** PICKUP, доведённый до READY_FOR_PICKUP (COMBINED). */
function pickupReady(): { state: PrototypeState; orderId: string } {
  const { state, orderId } = pickupOrder();
  let s = acceptRestaurantOrder(state, orderId, 20);
  s = markOrderReady(s, orderId);
  assert.equal(orderOf(s, orderId).status, "READY_FOR_PICKUP");
  return { state: s, orderId };
}

/** Снимок без v10-полей — имитация legacy-заказа до миграции. */
function stripMovement(financials: FinancialSnapshot): Record<string, unknown> {
  const { moneyMovement, moneyMovementStatus, ...legacy } = financials;
  void moneyMovement;
  void moneyMovementStatus;
  return legacy;
}

/** Состояние с одним заказом, приведённым surgery-функцией. */
function withOrder(
  state: PrototypeState,
  orderId: string,
  update: (order: Order) => Order,
): PrototypeState {
  return {
    ...state,
    orders: state.orders.map((o) => (o.id === orderId ? update(o) : o)),
  };
}

// 1/2 — новый PLATFORM_DRIVER --------------------------------------------------

test("новый PLATFORM_DRIVER получает COMPLETE money movement с банком", () => {
  const { state, orderId } = platformOrder();
  const f = orderOf(state, orderId).financials;
  assert.equal(f.moneyMovementStatus, "COMPLETE");
  assert.ok(f.moneyMovement);
  const m = f.moneyMovement;
  assert.equal(m.paymentChannel, "ONLINE_CARD");
  assert.equal(m.customerMoneyRecipient, "DIRECT");
  // Банковская комиссия рассчитана и сходится.
  assert.equal(
    m.totalBankFeeCents,
    Math.round(f.customerTotalCents / 100),
  );
  assert.equal(
    m.restaurantBankFeeCents + m.directBankFeeCents,
    m.totalBankFeeCents,
  );
  // Direct должен ресторану правильную сумму.
  assert.equal(
    m.directOwesRestaurantCents,
    f.foodSubtotalCents - f.restaurantCommissionCents - m.restaurantBankFeeCents,
  );
  assert.equal(m.restaurantOwesDirectCents, 0);
  // Выплата водителю равна доставке (инвариант прошёл каноническую проверку).
  assert.equal(f.driverPayoutCents, f.deliveryFeeCents);
});

// 3 — новый RESTAURANT_DELIVERY ------------------------------------------------

test("новый RESTAURANT_DELIVERY сразу получает COMPLETE", () => {
  const { state, orderId } = courierOrder();
  const f = orderOf(state, orderId).financials;
  assert.equal(f.moneyMovementStatus, "COMPLETE");
  assert.ok(f.moneyMovement);
  assert.equal(f.moneyMovement.paymentChannel, "CASH_TO_RESTAURANT_COURIER");
  assert.equal(f.moneyMovement.totalBankFeeCents, 0);
  assert.equal(
    f.moneyMovement.restaurantOwesDirectCents,
    f.restaurantCommissionCents,
  );
  // Собственная доставка остаётся ресторану.
  assert.equal(
    f.moneyMovement.restaurantNetCents,
    f.customerTotalCents - f.restaurantCommissionCents,
  );
});

// 4 — новый PICKUP ---------------------------------------------------------------

test("новый PICKUP создаётся с PENDING_PAYMENT_CHANNEL без движения", () => {
  const { state, orderId } = pickupOrder();
  const f = orderOf(state, orderId).financials;
  assert.equal(f.moneyMovementStatus, "PENDING_PAYMENT_CHANNEL");
  assert.equal(f.moneyMovement, undefined);
});

// 5/6/7/8 — фиксация канала при выдаче -------------------------------------------

test("pickup cash при завершении получает CASH_AT_RESTAURANT", () => {
  const { state, orderId } = pickupReady();
  const done = completePickupAtRestaurant(state, orderId, "CASH");
  assert.equal(done.result.ok, true, done.result.error ?? "");
  const f = orderOf(done.state, orderId).financials;
  assert.equal(f.moneyMovementStatus, "COMPLETE");
  assert.equal(f.moneyMovement?.paymentChannel, "CASH_AT_RESTAURANT");
  assert.equal(f.moneyMovement?.totalBankFeeCents, 0);
});

test("pickup card: CARD_AT_RESTAURANT, банк ресторана, долг Direct без банка", () => {
  const { state, orderId } = pickupReady();
  const done = completePickupAtRestaurant(state, orderId, "CARD");
  assert.equal(done.result.ok, true, done.result.error ?? "");
  const f = orderOf(done.state, orderId).financials;
  assert.equal(f.moneyMovementStatus, "COMPLETE");
  const m = f.moneyMovement;
  assert.ok(m);
  assert.equal(m.paymentChannel, "CARD_AT_RESTAURANT");
  // Весь банковский 1% несёт ресторан.
  assert.equal(m.totalBankFeeCents, Math.round(f.customerTotalCents / 100));
  assert.ok(m.totalBankFeeCents > 0);
  assert.equal(m.restaurantBankFeeCents, m.totalBankFeeCents);
  assert.equal(m.directBankFeeCents, 0);
  // Банк НЕ увеличивает долг ресторана перед Direct: как при наличных.
  const cash = completePickupAtRestaurant(state, orderId, "CASH");
  assert.equal(
    m.restaurantOwesDirectCents,
    orderOf(cash.state, orderId).financials.moneyMovement?.restaurantOwesDirectCents,
  );
  assert.equal(m.restaurantOwesDirectCents, f.restaurantCommissionCents);
});

// 9/10 — идемпотентность и неизменяемость канала ---------------------------------

test("повторное завершение с тем же каналом идемпотентно", () => {
  const { state, orderId } = pickupReady();
  const done = completePickupAtRestaurant(state, orderId, "CASH");
  const f = orderOf(done.state, orderId).financials;
  // Повтор на снимке с тем же каналом: СОХРАНЁННОЕ движение, без пересчёта.
  const again = finalizePickupMoneyMovement(f, "CASH");
  assert.equal(again.ok, true);
  assert.ok(again.ok && again.moneyMovement === f.moneyMovement);
  // Повтор самого действия блокируется без мутации состояния.
  const secondAction = completePickupAtRestaurant(done.state, orderId, "CASH");
  assert.equal(secondAction.result.ok, false);
  assert.equal(secondAction.state, done.state);
});

test("замена уже зафиксированного CASH на CARD отклоняется", () => {
  const { state, orderId } = pickupReady();
  const done = completePickupAtRestaurant(state, orderId, "CASH");
  const f = orderOf(done.state, orderId).financials;
  const changed = finalizePickupMoneyMovement(f, "CARD");
  assert.equal(changed.ok, false);
  assert.ok(!changed.ok && /уже зафиксирован/.test(changed.error));
});

// 11 — неизменяемость после изменений настроек -----------------------------------

test("изменение меню и комиссий после заказа не меняет money movement", () => {
  const { state, orderId } = platformOrder();
  const before = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(before);
  // Меняем цену блюда и комиссию ресторана «после» заказа.
  const mutated: PrototypeState = {
    ...state,
    menuItems: state.menuItems.map((m) => ({ ...m, priceCents: m.priceCents * 2 })),
    restaurants: state.restaurants.map((r) => ({
      ...r,
      commissionRateBps: 9_900,
    })),
  };
  // Прямое чтение: снимок заказа не зависит от настроек.
  assert.equal(orderOf(mutated, orderId).financials.moneyMovement, before);
  // Normalization сохранённого состояния тоже НЕ пересчитывает COMPLETE.
  const normalized = normalizePrototypeState(mutated);
  assert.deepEqual(
    orderOf(normalized, orderId).financials.moneyMovement,
    before,
  );
  assert.equal(
    orderOf(normalized, orderId).financials.moneyMovementStatus,
    "COMPLETE",
  );
});

// 12-16 — migration legacy-состояний ---------------------------------------------

test("старый pickup с известным pickupPaidWith безопасно нормализуется", () => {
  const { state, orderId } = pickupReady();
  const done = completePickupAtRestaurant(state, orderId, "CASH").state;
  // Legacy: v10-полей в снимке ещё нет, но фактический способ оплаты сохранён.
  const legacy = withOrder(done, orderId, (o) => ({
    ...o,
    financials: stripMovement(o.financials) as unknown as FinancialSnapshot,
  }));
  const normalized = normalizePrototypeState(legacy);
  const f = orderOf(normalized, orderId).financials;
  assert.equal(f.moneyMovementStatus, "COMPLETE");
  assert.equal(f.moneyMovement?.paymentChannel, "CASH_AT_RESTAURANT");
});

test("старый завершённый pickup без pickupPaidWith получает REVIEW_REQUIRED", () => {
  const { state, orderId } = pickupReady();
  const done = completePickupAtRestaurant(state, orderId, "CASH").state;
  const legacy = withOrder(done, orderId, (o) => ({
    ...o,
    pickupPaidWith: null,
    financials: stripMovement(o.financials) as unknown as FinancialSnapshot,
  }));
  const f = orderOf(normalizePrototypeState(legacy), orderId).financials;
  assert.equal(f.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(f.moneyMovement, undefined);
});

test("незавершённый pickup без метода оплаты получает PENDING_PAYMENT_CHANNEL", () => {
  const { state, orderId } = pickupReady();
  const legacy = withOrder(state, orderId, (o) => ({
    ...o,
    financials: stripMovement(o.financials) as unknown as FinancialSnapshot,
  }));
  const f = orderOf(normalizePrototypeState(legacy), orderId).financials;
  assert.equal(f.moneyMovementStatus, "PENDING_PAYMENT_CHANNEL");
  assert.equal(f.moneyMovement, undefined);
});

test("повреждённые старые суммы получают REVIEW_REQUIRED, а не нули", () => {
  const { state, orderId } = pickupReady();
  const done = completePickupAtRestaurant(state, orderId, "CARD").state;
  const legacy = withOrder(done, orderId, (o) => ({
    ...o,
    financials: {
      ...(stripMovement(o.financials) as unknown as FinancialSnapshot),
      // Суммы не сходятся: еда больше суммы клиента.
      customerTotalCents: o.financials.foodSubtotalCents - 1,
    },
  }));
  const f = orderOf(normalizePrototypeState(legacy), orderId).financials;
  assert.equal(f.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(f.moneyMovement, undefined);
});

// --- Fail-closed: неполные исходные суммы --------------------------------------

/** Legacy-снимок без movement и без перечисленных полей сумм. */
function stripFields(
  financials: FinancialSnapshot,
  fields: readonly string[],
): FinancialSnapshot {
  const clone = { ...stripMovement(financials) };
  for (const field of fields) {
    delete clone[field];
  }
  return clone as unknown as FinancialSnapshot;
}

test("отсутствующие legacy-суммы дают REVIEW_REQUIRED, а не нулевой COMPLETE", () => {
  // PLATFORM_DRIVER без комиссии.
  const platform = platformOrder();
  const p = orderOf(
    normalizePrototypeState(
      withOrder(platform.state, platform.orderId, (o) => ({
        ...o,
        financials: stripFields(o.financials, ["restaurantCommissionCents"]),
      })),
    ),
    platform.orderId,
  ).financials;
  assert.equal(p.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(p.moneyMovement, undefined);

  // RESTAURANT_DELIVERY без комиссии.
  const courier = courierOrder();
  const c = orderOf(
    normalizePrototypeState(
      withOrder(courier.state, courier.orderId, (o) => ({
        ...o,
        financials: stripFields(o.financials, ["restaurantCommissionCents"]),
      })),
    ),
    courier.orderId,
  ).financials;
  assert.equal(c.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(c.moneyMovement, undefined);

  // Завершённый pickup без customerTotalCents.
  const pickup = pickupReady();
  const done = completePickupAtRestaurant(pickup.state, pickup.orderId, "CASH").state;
  const f = orderOf(
    normalizePrototypeState(
      withOrder(done, pickup.orderId, (o) => ({
        ...o,
        financials: stripFields(o.financials, ["customerTotalCents"]),
      })),
    ),
    pickup.orderId,
  ).financials;
  assert.equal(f.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(f.moneyMovement, undefined);

  // Полностью отсутствующие суммы НЕ становятся «успешным нулевым заказом».
  const bare = orderOf(
    normalizePrototypeState(
      withOrder(platform.state, platform.orderId, (o) => ({
        ...o,
        financials: stripFields(o.financials, [
          "foodSubtotalCents",
          "deliveryFeeCents",
          "smallOrderFeeCents",
          "customerTotalCents",
          "restaurantCommissionCents",
          "driverPayoutCents",
        ]),
      })),
    ),
    platform.orderId,
  ).financials;
  assert.equal(bare.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(bare.moneyMovement, undefined);
});

test("незавершённый pickup без сумм и канала остаётся PENDING_PAYMENT_CHANNEL", () => {
  const { state, orderId } = pickupReady();
  const f = orderOf(
    normalizePrototypeState(
      withOrder(state, orderId, (o) => ({
        ...o,
        financials: stripFields(o.financials, [
          "foodSubtotalCents",
          "customerTotalCents",
        ]),
      })),
    ),
    orderId,
  ).financials;
  assert.equal(f.moneyMovementStatus, "PENDING_PAYMENT_CHANNEL");
  assert.equal(f.moneyMovement, undefined);
});

// --- Fail-closed: семантика сохранённого COMPLETE ------------------------------

/** Выданный CASH-самовывоз с испорченным сохранённым движением. */
function corruptedPickupState(
  corrupt: (movement: NonNullable<FinancialSnapshot["moneyMovement"]>) =>
    Partial<NonNullable<FinancialSnapshot["moneyMovement"]>>,
): { state: PrototypeState; orderId: string } {
  const { state, orderId } = pickupReady();
  const done = completePickupAtRestaurant(state, orderId, "CASH").state;
  const mutated = withOrder(done, orderId, (o) => {
    const movement = o.financials.moneyMovement;
    assert.ok(movement);
    return {
      ...o,
      financials: {
        ...o.financials,
        moneyMovement: { ...movement, ...corrupt(movement) },
      },
    };
  });
  return { state: mutated, orderId };
}

test("ложный сохранённый COMPLETE уходит в REVIEW_REQUIRED", () => {
  // Неверный payment channel.
  const wrongChannel = corruptedPickupState(() => ({
    paymentChannel: "CARD_AT_RESTAURANT",
  }));
  assert.equal(
    orderOf(normalizePrototypeState(wrongChannel.state), wrongChannel.orderId)
      .financials.moneyMovementStatus,
    "REVIEW_REQUIRED",
  );
  // Неверный получатель денег.
  const wrongRecipient = corruptedPickupState(() => ({
    customerMoneyRecipient: "DIRECT",
  }));
  assert.equal(
    orderOf(
      normalizePrototypeState(wrongRecipient.state),
      wrongRecipient.orderId,
    ).financials.moneyMovementStatus,
    "REVIEW_REQUIRED",
  );
  // Банковская комиссия, сдвинутая на один цент (структурно согласованная).
  const wrongBank = corruptedPickupState((m) => ({
    totalBankFeeCents: m.totalBankFeeCents + 1,
    restaurantBankFeeCents: m.restaurantBankFeeCents + 1,
  }));
  const bankFin = orderOf(
    normalizePrototypeState(wrongBank.state),
    wrongBank.orderId,
  ).financials;
  assert.equal(bankFin.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(bankFin.moneyMovement, undefined);
});

test("неправильный directOwesRestaurantCents у Direct-заказа отклоняется", () => {
  const { state, orderId } = platformOrder();
  const mutated = withOrder(state, orderId, (o) => {
    const movement = o.financials.moneyMovement;
    assert.ok(movement);
    return {
      ...o,
      financials: {
        ...o.financials,
        moneyMovement: {
          ...movement,
          directOwesRestaurantCents: movement.directOwesRestaurantCents + 1,
        },
      },
    };
  });
  const f = orderOf(normalizePrototypeState(mutated), orderId).financials;
  assert.equal(f.moneyMovementStatus, "REVIEW_REQUIRED");
  assert.equal(f.moneyMovement, undefined);
});

test("совпадающий COMPLETE сохраняется исходным объектом; normalization идемпотентна", () => {
  const { state, orderId } = platformOrder();
  const original = orderOf(state, orderId).financials.moneyMovement;
  assert.ok(original);
  const once = normalizePrototypeState(state);
  // Тот же объект movement — без пересчёта и без замены новым объектом.
  assert.equal(orderOf(once, orderId).financials.moneyMovement, original);
  assert.equal(orderOf(once, orderId).financials.moneyMovementStatus, "COMPLETE");
  // Повторная normalization идемпотентна для COMPLETE…
  const twice = normalizePrototypeState(once);
  assert.equal(orderOf(twice, orderId).financials.moneyMovement, original);
  // …и для REVIEW_REQUIRED (испорченные данные не «дочиниваются» нулями).
  const broken = withOrder(state, orderId, (o) => ({
    ...o,
    financials: stripFields(o.financials, ["restaurantCommissionCents"]),
  }));
  const brokenOnce = normalizePrototypeState(broken);
  assert.equal(
    orderOf(brokenOnce, orderId).financials.moneyMovementStatus,
    "REVIEW_REQUIRED",
  );
  const brokenTwice = normalizePrototypeState(brokenOnce);
  assert.equal(
    orderOf(brokenTwice, orderId).financials.moneyMovementStatus,
    "REVIEW_REQUIRED",
  );
  assert.equal(orderOf(brokenTwice, orderId).financials.moneyMovement, undefined);
});

test("старые Direct/restaurant-delivery восстанавливаются канонической функцией", () => {
  for (const make of [platformOrder, courierOrder]) {
    const { state, orderId } = make();
    const original = orderOf(state, orderId);
    const legacy = withOrder(state, orderId, (o) => ({
      ...o,
      financials: stripMovement(o.financials) as unknown as FinancialSnapshot,
    }));
    const f = orderOf(normalizePrototypeState(legacy), orderId).financials;
    assert.equal(f.moneyMovementStatus, "COMPLETE");
    // Восстановленное движение — ровно результат канонической функции.
    const canonical = computeOrderMoneyMovement({
      deliveryMode: original.deliveryMode,
      paymentChannel:
        original.deliveryMode === "PLATFORM_DRIVER"
          ? "ONLINE_CARD"
          : "CASH_TO_RESTAURANT_COURIER",
      foodSubtotalCents: original.financials.foodSubtotalCents,
      deliveryFeeCents: original.financials.deliveryFeeCents,
      smallOrderFeeCents: original.financials.smallOrderFeeCents,
      customerTotalCents: original.financials.customerTotalCents,
      restaurantCommissionCents: original.financials.restaurantCommissionCents,
      driverPayoutCents:
        original.deliveryMode === "PLATFORM_DRIVER"
          ? original.financials.deliveryFeeCents
          : 0,
    });
    assert.equal(canonical.ok, true);
    assert.ok(canonical.ok);
    assert.deepEqual(f.moneyMovement, canonical.movement);
  }
});
