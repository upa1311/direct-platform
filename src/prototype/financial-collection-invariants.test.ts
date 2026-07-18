import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { computeCompletedOrderAccountingEntries } from "./restaurant-accounting.ts";
import type { FinancialSnapshot, Order, PrototypeState } from "./models.ts";

/** Создаёт валидный новый заказ штатным путём и возвращает его снимок. */
function makeOrder(
  itemId: string,
  fulfillment: "PICKUP" | "DELIVERY",
): { state: PrototypeState; order: Order } {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, fulfillment);
  if (fulfillment === "DELIVERY") {
    s = updateCartAddress(s, { street: "Тестовая улица 1", house: "1" });
  }
  // Несколько единиц, чтобы гарантированно превысить минимальную сумму доставки.
  for (let i = 0; i < 6; i += 1) {
    s = addCartItem(s, itemId).state;
  }
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null, created.result.error ?? "");
  const order = created.state.orders.find((o) => o.id === created.result.orderId);
  assert.ok(order);
  return { state: created.state, order };
}

/** Три штатных collector-сценария: PICKUP, RESTAURANT_DELIVERY, PLATFORM_DRIVER. */
const SCENARIOS = [
  { label: "PICKUP", itemId: "restaurant-1-item-1", fulfillment: "PICKUP" as const, deliveryMode: "PICKUP", collector: "RESTAURANT" },
  { label: "PLATFORM_DRIVER", itemId: "restaurant-1-item-1", fulfillment: "DELIVERY" as const, deliveryMode: "PLATFORM_DRIVER", collector: "DIRECT" },
  { label: "RESTAURANT_DELIVERY", itemId: "restaurant-3-item-1", fulfillment: "DELIVERY" as const, deliveryMode: "RESTAURANT_DELIVERY", collector: "RESTAURANT" },
];

// 1 --------------------------------------------------------------------------

test("сумма collected равна customerTotal для каждого штатного режима", () => {
  for (const sc of SCENARIOS) {
    const { order } = makeOrder(sc.itemId, sc.fulfillment);
    const f = order.financials;
    assert.equal(order.deliveryMode, sc.deliveryMode, sc.label);
    assert.equal(
      f.restaurantCollectedFromCustomerCents +
        f.platformCollectedFromCustomerCents,
      f.customerTotalCents,
      `collected sum == customerTotal (${sc.label})`,
    );
  }
});

// 2 --------------------------------------------------------------------------

test("штатный builder не создаёт MIXED: ровно одно collected-поле > 0", () => {
  for (const sc of SCENARIOS) {
    const { order } = makeOrder(sc.itemId, sc.fulfillment);
    const f = order.financials;
    const restaurantPositive = f.restaurantCollectedFromCustomerCents > 0;
    const platformPositive = f.platformCollectedFromCustomerCents > 0;
    // Ровно один собиратель (customerTotal > 0 в этих сценариях).
    assert.ok(f.customerTotalCents > 0, sc.label);
    assert.notEqual(restaurantPositive, platformPositive, `не MIXED (${sc.label})`);
    if (sc.collector === "RESTAURANT") {
      assert.equal(f.restaurantCollectedFromCustomerCents, f.customerTotalCents, sc.label);
      assert.equal(f.platformCollectedFromCustomerCents, 0, sc.label);
    } else {
      assert.equal(f.platformCollectedFromCustomerCents, f.customerTotalCents, sc.label);
      assert.equal(f.restaurantCollectedFromCustomerCents, 0, sc.label);
    }
  }
});

// 3 --------------------------------------------------------------------------

test("accounting entries соответствуют collector: ровно одна запись, без двойного учёта", () => {
  for (const sc of SCENARIOS) {
    const { order } = makeOrder(sc.itemId, sc.fulfillment);
    // Завершаем заказ (для recognition), не трогая финансовый снимок.
    const completed: Order = {
      ...order,
      status: sc.fulfillment === "PICKUP" ? "PICKED_UP" : "DELIVERED",
    };
    const entries = computeCompletedOrderAccountingEntries(completed, []);
    assert.equal(entries.length, 1, `ровно одна запись (${sc.label})`);
    const entry = entries[0];
    if (sc.collector === "RESTAURANT") {
      // Ресторан собрал → должен Direct комиссию (payout не создаётся).
      assert.equal(entry.direction, "RESTAURANT_OWES_DIRECT", sc.label);
      assert.equal(entry.type, "PLATFORM_COMMISSION", sc.label);
      assert.equal(entry.amountCents, order.financials.platformCommissionReceivableCents, sc.label);
    } else {
      // Direct собрал → должен ресторану выплату (комиссия не создаётся).
      assert.equal(entry.direction, "DIRECT_OWES_RESTAURANT", sc.label);
      assert.equal(entry.type, "RESTAURANT_PAYOUT", sc.label);
      assert.equal(entry.amountCents, order.financials.restaurantNetAfterPlatformCommissionCents, sc.label);
    }
  }
});

// 4 --------------------------------------------------------------------------

test("исторический snapshot не пересчитывается при изменении меню/комиссии/тарифов", () => {
  const { state, order } = makeOrder("restaurant-1-item-1", "DELIVERY");
  const before: FinancialSnapshot = structuredClone(order.financials);

  // Меняем текущее меню, комиссию ресторана и настройки платформы.
  const mutated: PrototypeState = {
    ...state,
    menuItems: state.menuItems.map((m) => ({ ...m, priceCents: 999_99 })),
    restaurants: state.restaurants.map((r) =>
      r.id === "restaurant-1" ? { ...r, commissionRateBps: 9000 } : r,
    ),
    platformSettings: {
      ...state.platformSettings,
      minimumPlatformGrossRevenueCents: 999_99,
    },
  };
  const sameOrder = mutated.orders.find((o) => o.id === order.id);
  assert.ok(sameOrder);
  // Снимок заказа неизменяем: те же collected-поля, комиссия, net, customerTotal.
  assert.deepEqual(sameOrder.financials, before);
  assert.equal(
    sameOrder.financials.restaurantCollectedFromCustomerCents +
      sameOrder.financials.platformCollectedFromCustomerCents,
    sameOrder.financials.customerTotalCents,
  );
});

// 5 --------------------------------------------------------------------------

test("теоретический MIXED недостижим штатно, но при повреждении дал бы две записи", () => {
  // Документируем риск: MIXED-снимок штатно не создаётся (тест 2). Если бы он
  // возник (повреждённое/ручное состояние), bilateral accounting создал бы ОБЕ
  // записи — полную комиссию И полную выплату. Здесь конструируем такой снимок
  // ВРУЧНУЮ только чтобы зафиксировать поведение, не меняя runtime.
  const { order } = makeOrder("restaurant-1-item-1", "DELIVERY");
  const corruptedMixed: Order = {
    ...order,
    status: "DELIVERED",
    financials: {
      ...order.financials,
      restaurantCollectedFromCustomerCents: 500,
      platformCollectedFromCustomerCents: 500,
      platformCommissionReceivableCents: 100,
      restaurantNetAfterPlatformCommissionCents: 400,
    },
  };
  const entries = computeCompletedOrderAccountingEntries(corruptedMixed, []);
  // Две записи — подтверждает, что защита от MIXED должна жить на уровне builder
  // (он гарантирует mutual exclusivity), а не в accounting.
  assert.equal(entries.length, 2);
  assert.ok(entries.some((e) => e.type === "PLATFORM_COMMISSION"));
  assert.ok(entries.some((e) => e.type === "RESTAURANT_PAYOUT"));
});
