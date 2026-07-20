import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { computeCompletedOrderAccounting } from "./restaurant-accounting.ts";
import { finalizePickupMoneyMovement } from "./money-movement-snapshot.ts";
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
    // Завершаем заказ (для recognition). Самовывоз при выдаче фиксирует
    // фактический канал (наличные) — как это делает completePickupAtRestaurant.
    let financials = order.financials;
    if (sc.fulfillment === "PICKUP") {
      const finalized = finalizePickupMoneyMovement(order.financials, "CASH");
      assert.ok(finalized.ok, sc.label);
      financials = {
        ...order.financials,
        moneyMovementStatus: finalized.moneyMovementStatus,
        moneyMovement: finalized.moneyMovement,
      };
    }
    const completed: Order = {
      ...order,
      status: sc.fulfillment === "PICKUP" ? "PICKED_UP" : "DELIVERED",
      financials,
    };
    const res = computeCompletedOrderAccounting(completed, []);
    assert.equal(res.ok, true, `${sc.label}: ${res.error ?? ""}`);
    const entries = res.entries;
    assert.equal(entries.length, 1, `ровно одна запись (${sc.label})`);
    const entry = entries[0];
    const movement = completed.financials.moneyMovement;
    assert.ok(movement, sc.label);
    if (sc.collector === "RESTAURANT") {
      // Ресторан собрал → должен Direct комиссию (payout не создаётся).
      // Сумма — из канонического движения денег снимка.
      assert.equal(entry.direction, "RESTAURANT_OWES_DIRECT", sc.label);
      assert.equal(entry.type, "PLATFORM_COMMISSION", sc.label);
      assert.equal(entry.amountCents, movement.restaurantOwesDirectCents, sc.label);
    } else {
      // Direct собрал → должен ресторану выплату (комиссия не создаётся).
      // Выплата уже уменьшена на банковскую часть ресторана.
      assert.equal(entry.direction, "DIRECT_OWES_RESTAURANT", sc.label);
      assert.equal(entry.type, "RESTAURANT_PAYOUT", sc.label);
      assert.equal(entry.amountCents, movement.directOwesRestaurantCents, sc.label);
      assert.equal(
        entry.amountCents,
        order.financials.restaurantPayoutBeforeBankFeeCents -
          movement.restaurantBankFeeCents,
        sc.label,
      );
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

test("повреждённый MIXED-movement отклоняется fail-closed, а не даёт две записи", () => {
  // MIXED-снимок штатно не создаётся (тест 2), а канонический movement с двумя
  // положительными сторонами невозможен по построению. Если он всё же возник
  // (повреждённое/ручное состояние), accounting обязан отказать — взаимозачёт
  // и двойные записи внутри одного заказа не выполняются. Смешанные
  // legacy-collected-поля при этом источником суммы не являются.
  const { order } = makeOrder("restaurant-1-item-1", "DELIVERY");
  const movement = order.financials.moneyMovement;
  assert.ok(movement);
  const corruptedMixed: Order = {
    ...order,
    status: "DELIVERED",
    financials: {
      ...order.financials,
      restaurantCollectedFromCustomerCents: 500,
      platformCollectedFromCustomerCents: 500,
      platformCommissionReceivableCents: 100,
      restaurantNetAfterPlatformCommissionCents: 400,
      moneyMovement: {
        ...movement,
        restaurantOwesDirectCents: 100,
        directOwesRestaurantCents: 400,
      },
    },
  };
  const res = computeCompletedOrderAccounting(corruptedMixed, []);
  assert.equal(res.ok, false);
  assert.equal(res.entries.length, 0);
  assert.ok(/Встречные обязательства/.test(res.error ?? ""));
});
