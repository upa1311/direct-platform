import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  completePickupAtRestaurant,
  createOrderFromCart,
  markOrderArriving,
  markOrderDelivered,
  markOrderOutForDelivery,
  markOrderReady,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import {
  buildRestaurantFinanceReadModel,
  getRestaurantFinanceSummary,
} from "./restaurant-finance-read-model.ts";
import {
  getRestaurantOpenPayableCents,
  getRestaurantOpenReceivableCents,
} from "./restaurant-accounting.ts";
import type {
  Order,
  OrderMoneyMovement,
  PrototypeState,
  RestaurantAccountingEntry,
} from "./models.ts";

/**
 * Канонический read-model финансов ресторана: единый источник сумм для
 * ресторанного и будущего админского интерфейса. Баланс — только из OPEN
 * accounting entries, детали заказа — только из канонического moneyMovement.
 */

const RID = "restaurant-1";
const ADDR = { street: "Тестовая улица 1", house: "1" };
const T1 = "2026-07-17T10:00:00.000Z";
const T2 = "2026-07-17T11:00:00.000Z";
const T3 = "2026-07-17T12:00:00.000Z";

const TEMPLATE_ORDER = (() => {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, `${RID}-item-1`).state;
  const created = createOrderFromCart(s);
  const order = created.state.orders.find(
    (o) => o.id === (created.result.orderId as string),
  );
  assert.ok(order);
  return order;
})();

/** Движение «ресторан должен Direct amount» (наличные, банк 0). */
function moveOwesDirect(amount: number): OrderMoneyMovement {
  return {
    customerMoneyRecipient: "RESTAURANT",
    paymentChannel: "CASH_AT_RESTAURANT",
    totalBankFeeCents: 0,
    restaurantBankFeeCents: 0,
    directBankFeeCents: 0,
    restaurantOwesDirectCents: amount,
    directOwesRestaurantCents: 0,
    restaurantNetCents: 0,
    directNetRevenueCents: amount,
  };
}

/** Движение «Direct должен ресторану amount» (онлайн, банк учтён). */
function moveOwesRestaurant(amount: number, bank = 0): OrderMoneyMovement {
  return {
    customerMoneyRecipient: "DIRECT",
    paymentChannel: "ONLINE_CARD",
    totalBankFeeCents: bank,
    restaurantBankFeeCents: bank,
    directBankFeeCents: 0,
    restaurantOwesDirectCents: 0,
    directOwesRestaurantCents: amount,
    restaurantNetCents: amount,
    directNetRevenueCents: 0,
  };
}

function makeOrder(
  id: string,
  movement: OrderMoneyMovement | null,
  status:
    | "COMPLETE"
    | "PENDING_PAYMENT_CHANNEL"
    | "REVIEW_REQUIRED" = "COMPLETE",
  publicNumber = `DIR-${id}`,
): Order {
  return {
    ...TEMPLATE_ORDER,
    id,
    publicNumber,
    status: "PICKED_UP",
    financials: {
      ...TEMPLATE_ORDER.financials,
      moneyMovementStatus: status,
      moneyMovement: movement ?? undefined,
    },
  };
}

function entryFor(
  order: Order,
  direction: RestaurantAccountingEntry["direction"],
  amountCents: number,
  overrides: Partial<RestaurantAccountingEntry> = {},
): RestaurantAccountingEntry {
  const type =
    direction === "RESTAURANT_OWES_DIRECT"
      ? "PLATFORM_COMMISSION"
      : "RESTAURANT_PAYOUT";
  return {
    id: `accounting-${order.id}-${type}`,
    orderId: order.id,
    restaurantId: RID,
    direction,
    type,
    amountCents,
    currencyCode: "USD",
    status: "OPEN",
    recognizedAt: T1,
    settledAt: null,
    source: "ORDER_FINANCIAL_SNAPSHOT",
    legacySettlementId: null,
    ...overrides,
  };
}

function stateWith(
  orders: Order[],
  entries: RestaurantAccountingEntry[],
): PrototypeState {
  return {
    ...createDefaultState(),
    orders,
    restaurantAccountingEntries: entries,
  };
}

function okModel(state: PrototypeState, restaurantId = RID) {
  const result = buildRestaurantFinanceReadModel(state, restaurantId);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  if (!result.ok) throw new Error("unreachable");
  return result.model;
}

// 1/2/3/4 — балансы -------------------------------------------------------------

test("направления баланса и net: owes/payable/mixed/balanced", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  const b = makeOrder("b", moveOwesDirect(200));
  const onlyOwes = okModel(
    stateWith([a, b], [entryFor(a, "RESTAURANT_OWES_DIRECT", 800), entryFor(b, "RESTAURANT_OWES_DIRECT", 200)]),
  );
  assert.equal(onlyOwes.restaurantOwesDirectCents, 1000);
  assert.equal(onlyOwes.directOwesRestaurantCents, 0);
  assert.equal(onlyOwes.netDirection, "RESTAURANT_OWES_DIRECT");
  assert.equal(onlyOwes.netAmountCents, 1000);

  const c = makeOrder("c", moveOwesRestaurant(5100));
  const onlyPayable = okModel(
    stateWith([c], [entryFor(c, "DIRECT_OWES_RESTAURANT", 5100)]),
  );
  assert.equal(onlyPayable.directOwesRestaurantCents, 5100);
  assert.equal(onlyPayable.netDirection, "DIRECT_OWES_RESTAURANT");
  assert.equal(onlyPayable.netAmountCents, 5100);

  const mixed = okModel(
    stateWith(
      [a, c],
      [entryFor(a, "RESTAURANT_OWES_DIRECT", 800), entryFor(c, "DIRECT_OWES_RESTAURANT", 5100)],
    ),
  );
  assert.equal(mixed.netDirection, "DIRECT_OWES_RESTAURANT");
  assert.equal(mixed.netAmountCents, 4300);

  const d = makeOrder("d", moveOwesRestaurant(800));
  const balanced = okModel(
    stateWith(
      [a, d],
      [entryFor(a, "RESTAURANT_OWES_DIRECT", 800), entryFor(d, "DIRECT_OWES_RESTAURANT", 800)],
    ),
  );
  assert.equal(balanced.netDirection, "BALANCED");
  assert.equal(balanced.netAmountCents, 0);
});

// 5 — закрытые не входят ---------------------------------------------------------

test("SETTLED и WAIVED не входят в открытый баланс и не ломают модель", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  const b = makeOrder("b", moveOwesDirect(300));
  const c = makeOrder("c", moveOwesRestaurant(900));
  const model = okModel(
    stateWith(
      [a, b, c],
      [
        entryFor(a, "RESTAURANT_OWES_DIRECT", 800),
        entryFor(b, "RESTAURANT_OWES_DIRECT", 300, { status: "SETTLED", settledAt: T2 }),
        entryFor(c, "DIRECT_OWES_RESTAURANT", 900, { status: "WAIVED", settledAt: T2 }),
      ],
    ),
  );
  assert.equal(model.restaurantOwesDirectCents, 800);
  assert.equal(model.directOwesRestaurantCents, 0);
  assert.equal(model.openAccountingEntryCount, 1);
  assert.equal(model.openOrders.length, 1);
});

// 6/18 — уникальность заказов ----------------------------------------------------

test("один заказ считается один раз; openOrderCount — уникальные заказы", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  const b = makeOrder("b", moveOwesDirect(200));
  const model = okModel(
    stateWith(
      [a, b],
      [entryFor(a, "RESTAURANT_OWES_DIRECT", 800), entryFor(b, "RESTAURANT_OWES_DIRECT", 200)],
    ),
  );
  assert.equal(model.openAccountingEntryCount, 2);
  assert.equal(model.openOrderCount, 2);
  assert.equal(model.restaurantOwesDirectCents, 1000);
});

// 7 — дубли orderId --------------------------------------------------------------

test("дубли записей одного заказа — fail-closed, сумма не удваивается", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  const result = buildRestaurantFinanceReadModel(
    stateWith(
      [a],
      [
        entryFor(a, "RESTAURANT_OWES_DIRECT", 800),
        entryFor(a, "RESTAURANT_OWES_DIRECT", 800, { id: "accounting-a-copy" }),
      ],
    ),
    RID,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /несколько бухгалтерских обязательств/.test(result.error));
});

// 8/9/10 — повреждённые данные ---------------------------------------------------

test("повреждённые записи отклоняются fail-closed", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  // Дробная сумма.
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([a], [entryFor(a, "RESTAURANT_OWES_DIRECT", 800.5)]),
      RID,
    ).ok,
    false,
  );
  // Отрицательная сумма.
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([a], [entryFor(a, "RESTAURANT_OWES_DIRECT", -1)]),
      RID,
    ).ok,
    false,
  );
  // Неизвестное направление.
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([a], [
        entryFor(a, "RESTAURANT_OWES_DIRECT", 800, {
          direction: "SIDEWAYS" as RestaurantAccountingEntry["direction"],
        }),
      ]),
      RID,
    ).ok,
    false,
  );
  // Неизвестный статус.
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([a], [
        entryFor(a, "RESTAURANT_OWES_DIRECT", 800, {
          status: "MYSTERY" as RestaurantAccountingEntry["status"],
        }),
      ]),
      RID,
    ).ok,
    false,
  );
  // OPEN snapshot-запись без заказа.
  const orphan = buildRestaurantFinanceReadModel(
    stateWith([], [entryFor(a, "RESTAURANT_OWES_DIRECT", 800)]),
    RID,
  );
  assert.equal(orphan.ok, false);
  assert.ok(!orphan.ok && /несуществующий заказ/.test(orphan.error));
  // Сумма записи расходится с каноническим движением.
  const mismatch = buildRestaurantFinanceReadModel(
    stateWith([a], [entryFor(a, "RESTAURANT_OWES_DIRECT", 801)]),
    RID,
  );
  assert.equal(mismatch.ok, false);
  assert.ok(!mismatch.ok && /противоречит каноническому движению/.test(mismatch.error));
  // Невалидный recognizedAt открытой записи.
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([a], [entryFor(a, "RESTAURANT_OWES_DIRECT", 800, { recognizedAt: "не-дата" })]),
      RID,
    ).ok,
    false,
  );
});

// Ownership: неверный ресторан в записи --------------------------------------------

/** Заказ, принадлежащий произвольному ресторану. */
function makeOrderFor(rid: string, id: string, movement: OrderMoneyMovement): Order {
  return {
    ...makeOrder(id, movement),
    restaurant: { ...TEMPLATE_ORDER.restaurant, id: rid },
  };
}

test("entry с чужим restaurantId при заказе ресторана A — ошибка, не тихий недосчёт", () => {
  const orderA = makeOrderFor(RID, "a", moveOwesDirect(800));
  // Повреждённая запись: заказ ресторана A, restaurantId ресторана B.
  const corrupted = entryFor(orderA, "RESTAURANT_OWES_DIRECT", 800, {
    restaurantId: "restaurant-2",
  });
  const result = buildRestaurantFinanceReadModel(
    stateWith([orderA], [corrupted]),
    RID,
  );
  // Запись НЕ исчезает молча из баланса A — модель A отказывает явно.
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /содержит неверный ресторан/.test(result.error));
});

test("entry ресторана A с заказом ресторана B — ошибка", () => {
  const orderB = makeOrderFor("restaurant-2", "b", moveOwesDirect(500));
  const corrupted = entryFor(orderB, "RESTAURANT_OWES_DIRECT", 500, {
    restaurantId: RID,
  });
  const result = buildRestaurantFinanceReadModel(
    stateWith([orderB], [corrupted]),
    RID,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /содержит неверный ресторан/.test(result.error));
});

test("корректная запись другого ресторана не влияет на модель A", () => {
  const orderA = makeOrderFor(RID, "a", moveOwesDirect(800));
  const orderB = makeOrderFor("restaurant-2", "b", moveOwesDirect(500));
  const model = okModel(
    stateWith(
      [orderA, orderB],
      [
        entryFor(orderA, "RESTAURANT_OWES_DIRECT", 800),
        entryFor(orderB, "RESTAURANT_OWES_DIRECT", 500, {
          restaurantId: "restaurant-2",
        }),
      ],
    ),
  );
  assert.equal(model.restaurantOwesDirectCents, 800);
  assert.equal(model.openOrders.length, 1);
  assert.equal(model.openOrders[0].orderId, "a");
  // И модель B видит только свою запись.
  const modelB = okModel(
    stateWith(
      [orderA, orderB],
      [
        entryFor(orderA, "RESTAURANT_OWES_DIRECT", 800),
        entryFor(orderB, "RESTAURANT_OWES_DIRECT", 500, {
          restaurantId: "restaurant-2",
        }),
      ],
    ),
    "restaurant-2",
  );
  assert.equal(modelB.restaurantOwesDirectCents, 500);
});

// Source: только известные источники ----------------------------------------------

test("неизвестный source не считается legacy — ошибка", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  const result = buildRestaurantFinanceReadModel(
    stateWith([a], [
      entryFor(a, "RESTAURANT_OWES_DIRECT", 800, {
        source: "MANUAL_IMPORT" as RestaurantAccountingEntry["source"],
      }),
    ]),
    RID,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /Неизвестный источник/.test(result.error));
});

test("snapshot entry с ненулевым legacySettlementId — ошибка", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  const result = buildRestaurantFinanceReadModel(
    stateWith([a], [
      entryFor(a, "RESTAURANT_OWES_DIRECT", 800, {
        legacySettlementId: "settlement-a",
      }),
    ]),
    RID,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /не может ссылаться на старое начисление/.test(result.error));
});

test("legacy entry: только комиссия ресторана перед Direct", () => {
  const a = makeOrder("a", moveOwesRestaurant(500), "COMPLETE");
  // Выплата с legacy-источником невозможна: старый ledger фиксировал только
  // комиссию (direction и type проверяются по отдельности).
  const wrongDirection = buildRestaurantFinanceReadModel(
    stateWith([a], [
      entryFor(a, "DIRECT_OWES_RESTAURANT", 500, {
        source: "LEGACY_COMMISSION_SETTLEMENT",
        legacySettlementId: "settlement-a",
      }),
    ]),
    RID,
  );
  assert.equal(wrongDirection.ok, false);
  assert.ok(
    !wrongDirection.ok && /только комиссией Direct/.test(wrongDirection.error),
  );

  const b = makeOrder("b", moveOwesDirect(700));
  const wrongType = buildRestaurantFinanceReadModel(
    stateWith([b], [
      entryFor(b, "RESTAURANT_OWES_DIRECT", 700, {
        type: "RESTAURANT_PAYOUT",
        source: "LEGACY_COMMISSION_SETTLEMENT",
        legacySettlementId: "settlement-b",
      }),
    ]),
    RID,
  );
  assert.equal(wrongType.ok, false);

  // Без ссылки на старое начисление и с пустой ссылкой — ошибка.
  for (const legacySettlementId of [null, "   "]) {
    const result = buildRestaurantFinanceReadModel(
      stateWith([b], [
        entryFor(b, "RESTAURANT_OWES_DIRECT", 700, {
          source: "LEGACY_COMMISSION_SETTLEMENT",
          legacySettlementId,
        }),
      ]),
      RID,
    );
    assert.equal(result.ok, false);
    assert.ok(!result.ok && /без ссылки на старое начисление/.test(result.error));
  }
});

test("валюта не USD отклоняется для legacy и snapshot записей", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  for (const source of [
    "ORDER_FINANCIAL_SNAPSHOT",
    "LEGACY_COMMISSION_SETTLEMENT",
  ] as const) {
    const result = buildRestaurantFinanceReadModel(
      stateWith([a], [
        entryFor(a, "RESTAURANT_OWES_DIRECT", 800, {
          source,
          legacySettlementId:
            source === "LEGACY_COMMISSION_SETTLEMENT" ? "settlement-a" : null,
          currencyCode: "EUR" as RestaurantAccountingEntry["currencyCode"],
        }),
      ]),
      RID,
    );
    assert.equal(result.ok, false, source);
    assert.ok(!result.ok && /валюта/.test(result.error), source);
  }
});

test("контракт settledAt: OPEN — null; SETTLED — ISO; WAIVED — null или ISO", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  // OPEN с датой закрытия — повреждение.
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([a], [entryFor(a, "RESTAURANT_OWES_DIRECT", 800, { settledAt: T2 })]),
      RID,
    ).ok,
    false,
  );
  // SETTLED без даты — повреждение.
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([a], [
        entryFor(a, "RESTAURANT_OWES_DIRECT", 800, { status: "SETTLED", settledAt: null }),
      ]),
      RID,
    ).ok,
    false,
  );
  // WAIVED: существующий контракт проекта допускает оба варианта — ISO
  // (админ-решение) и null (мигрированный WAIVED legacy-settlement).
  for (const settledAt of [T2, null]) {
    const model = okModel(
      stateWith([a], [
        entryFor(a, "RESTAURANT_OWES_DIRECT", 800, { status: "WAIVED", settledAt }),
      ]),
    );
    assert.equal(model.restaurantOwesDirectCents, 0);
  }
});

test("корректная legacy-комиссия входит в баланс без пересчёта", () => {
  const order = makeOrder("lg2", null, "REVIEW_REQUIRED");
  const model = okModel(
    stateWith(
      [order],
      [
        entryFor(order, "RESTAURANT_OWES_DIRECT", 555, {
          source: "LEGACY_COMMISSION_SETTLEMENT",
          legacySettlementId: "settlement-lg2",
        }),
      ],
    ),
  );
  assert.equal(model.restaurantOwesDirectCents, 555);
  assert.equal(model.openOrders[0].totalBankFeeCents, null);
  assert.equal(model.openOrders[0].paymentChannel, "LEGACY_UNKNOWN");
});

// Закрытые snapshot-записи: семантика проверяется, баланс не трогается ------------

test("корректные SETTLED/WAIVED snapshot-записи проходят, но не входят в баланс", () => {
  const open = makeOrder("op", moveOwesDirect(800));
  const settled = makeOrder("st", moveOwesDirect(300));
  const waived = makeOrder("wv", moveOwesRestaurant(900));
  const model = okModel(
    stateWith(
      [open, settled, waived],
      [
        entryFor(open, "RESTAURANT_OWES_DIRECT", 800),
        entryFor(settled, "RESTAURANT_OWES_DIRECT", 300, {
          status: "SETTLED",
          settledAt: T2,
        }),
        entryFor(waived, "DIRECT_OWES_RESTAURANT", 900, {
          status: "WAIVED",
          settledAt: T2,
        }),
      ],
    ),
  );
  // Закрытые записи не меняют net и не попадают в openOrders.
  assert.equal(model.restaurantOwesDirectCents, 800);
  assert.equal(model.directOwesRestaurantCents, 0);
  assert.equal(model.netDirection, "RESTAURANT_OWES_DIRECT");
  assert.equal(model.netAmountCents, 800);
  assert.equal(model.openAccountingEntryCount, 1);
  assert.deepEqual(model.openOrders.map((r) => r.orderId), ["op"]);
});

test("повреждённые закрытые snapshot-записи ломают read-model fail-closed", () => {
  const closed = (
    status: "SETTLED" | "WAIVED",
    order: Order,
    overrides: Partial<RestaurantAccountingEntry> = {},
  ) =>
    entryFor(order, "RESTAURANT_OWES_DIRECT", 800, {
      status,
      settledAt: T2,
      ...overrides,
    });

  const a = makeOrder("a", moveOwesDirect(800));
  // SETTLED/WAIVED без заказа.
  for (const status of ["SETTLED", "WAIVED"] as const) {
    const result = buildRestaurantFinanceReadModel(
      stateWith([], [closed(status, a)]),
      RID,
    );
    assert.equal(result.ok, false, status);
    assert.ok(!result.ok && /несуществующий заказ/.test(result.error), status);
  }
  // SETTLED при REVIEW_REQUIRED заказа.
  const review = makeOrder("rv", null, "REVIEW_REQUIRED");
  const reviewResult = buildRestaurantFinanceReadModel(
    stateWith([review], [closed("SETTLED", review)]),
    RID,
  );
  assert.equal(reviewResult.ok, false);
  assert.ok(
    !reviewResult.ok && /противоречит каноническому движению/.test(reviewResult.error),
  );
  // SETTLED без movement при статусе COMPLETE.
  const broken = makeOrder("bk", null, "COMPLETE");
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([broken], [closed("SETTLED", broken)]),
      RID,
    ).ok,
    false,
  );
  // SETTLED с другой суммой.
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([a], [closed("SETTLED", a, { amountCents: 801 })]),
      RID,
    ).ok,
    false,
  );
  // WAIVED с другим направлением (движение — «ресторан должен Direct»).
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([a], [
        closed("WAIVED", a, {
          direction: "DIRECT_OWES_RESTAURANT",
          type: "RESTAURANT_PAYOUT",
        }),
      ]),
      RID,
    ).ok,
    false,
  );
  // Закрытая запись с неправильным типом.
  assert.equal(
    buildRestaurantFinanceReadModel(
      stateWith([a], [closed("SETTLED", a, { type: "RESTAURANT_PAYOUT" })]),
      RID,
    ).ok,
    false,
  );
});

test("движение с двумя положительными или двумя нулевыми сторонами — ошибка", () => {
  const mixed = makeOrder("mx", {
    ...moveOwesDirect(800),
    directOwesRestaurantCents: 100,
  });
  const mixedResult = buildRestaurantFinanceReadModel(
    stateWith([mixed], [
      entryFor(mixed, "RESTAURANT_OWES_DIRECT", 800, {
        status: "SETTLED",
        settledAt: T2,
      }),
    ]),
    RID,
  );
  assert.equal(mixedResult.ok, false);
  assert.ok(!mixedResult.ok && /Встречные обязательства/.test(mixedResult.error));

  // Обе стороны нулевые: snapshot-записи существовать не должно.
  const zero = makeOrder("zr", {
    ...moveOwesDirect(0),
    directNetRevenueCents: 0,
  });
  const zeroResult = buildRestaurantFinanceReadModel(
    stateWith([zero], [entryFor(zero, "RESTAURANT_OWES_DIRECT", 800)]),
    RID,
  );
  assert.equal(zeroResult.ok, false);
  assert.ok(!zeroResult.ok && /нулевом движении/.test(zeroResult.error));
});

test("закрытая legacy-запись без заказа допустима (историческая миграция)", () => {
  // Реальная миграция старых settlements поддерживает записи, чей заказ уже
  // удалён из состояния — закрытая историческая комиссия модель не ломает.
  const model = okModel(
    stateWith(
      [],
      [
        {
          id: "accounting-legacy-old",
          orderId: "давно-удалён",
          restaurantId: RID,
          direction: "RESTAURANT_OWES_DIRECT",
          type: "PLATFORM_COMMISSION",
          amountCents: 250,
          currencyCode: "USD",
          status: "SETTLED",
          settledAt: T2,
          recognizedAt: T1,
          source: "LEGACY_COMMISSION_SETTLEMENT",
          legacySettlementId: "settlement-old",
        },
      ],
    ),
  );
  assert.equal(model.restaurantOwesDirectCents, 0);
  assert.equal(model.openOrders.length, 0);
});

// 11/12 — современный самовывоз (реальный поток) ---------------------------------

function readyPickup(): { state: PrototypeState; orderId: string } {
  let s = createDefaultState();
  s = setCartFulfillmentChoice(s, "PICKUP");
  s = addCartItem(s, `${RID}-item-1`).state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  let st = acceptRestaurantOrder(created.state, orderId, 20);
  st = markOrderReady(st, orderId);
  return { state: st, orderId };
}

test("современный pickup cash формирует строку COMPLETE с каналом наличных", () => {
  const { state, orderId } = readyPickup();
  const done = completePickupAtRestaurant(state, orderId, "CASH").state;
  const model = okModel(done);
  assert.equal(model.openOrders.length, 1);
  const row = model.openOrders[0];
  const order = done.orders.find((o) => o.id === orderId)!;
  const movement = order.financials.moneyMovement!;
  assert.equal(row.orderId, orderId);
  assert.equal(row.publicNumber, order.publicNumber);
  assert.equal(row.deliveryMode, "PICKUP");
  assert.equal(row.paymentChannel, "CASH_AT_RESTAURANT");
  assert.equal(row.direction, "RESTAURANT_OWES_DIRECT");
  assert.equal(row.amountCents, movement.restaurantOwesDirectCents);
  assert.equal(row.totalBankFeeCents, 0);
  assert.equal(row.dataStatus, "COMPLETE");
  assert.equal(model.restaurantOwesDirectCents, movement.restaurantOwesDirectCents);
});

test("pickup card: банк ресторана в строке, но долг Direct остаётся комиссией", () => {
  const { state, orderId } = readyPickup();
  const done = completePickupAtRestaurant(state, orderId, "CARD").state;
  const model = okModel(done);
  const row = model.openOrders.find((r) => r.orderId === orderId)!;
  const order = done.orders.find((o) => o.id === orderId)!;
  const movement = order.financials.moneyMovement!;
  assert.equal(row.paymentChannel, "CARD_AT_RESTAURANT");
  assert.ok((row.restaurantBankFeeCents ?? 0) > 0);
  assert.equal(row.restaurantBankFeeCents, movement.restaurantBankFeeCents);
  // Банк уменьшает net ресторана, но долг перед Direct — только комиссия.
  assert.equal(row.amountCents, order.financials.restaurantCommissionCents);
  assert.equal(row.amountCents, movement.restaurantOwesDirectCents);
  assert.equal(row.restaurantNetCents, movement.restaurantNetCents);
});

// 13 — доставка Direct: выплата после банковской части ---------------------------

test("Direct delivery показывает выплату ресторану после банковской части", () => {
  const amount = 8400;
  const bank = 100;
  const order = makeOrder("dd", moveOwesRestaurant(amount, bank));
  const model = okModel(
    stateWith([order], [entryFor(order, "DIRECT_OWES_RESTAURANT", amount)]),
  );
  const row = model.openOrders[0];
  assert.equal(row.direction, "DIRECT_OWES_RESTAURANT");
  assert.equal(row.amountCents, amount);
  assert.equal(row.restaurantBankFeeCents, bank);
  assert.equal(model.directOwesRestaurantCents, amount);
});

// 14 — доставка курьером ресторана (реальный поток) ------------------------------

test("restaurant delivery: комиссия Direct и нулевой банк", () => {
  let s = updateCartAddress(createDefaultState(), ADDR);
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-3-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  let st = acceptRestaurantOrder(created.state, orderId, 20);
  st = markOrderReady(st, orderId);
  st = markOrderOutForDelivery(st, orderId);
  st = markOrderArriving(st, orderId);
  st = markOrderDelivered(st, orderId);

  const model = okModel(st, "restaurant-3");
  assert.equal(model.openOrders.length, 1);
  const row = model.openOrders[0];
  const order = st.orders.find((o) => o.id === orderId)!;
  assert.equal(row.deliveryMode, "RESTAURANT_DELIVERY");
  assert.equal(row.paymentChannel, "CASH_TO_RESTAURANT_COURIER");
  assert.equal(row.direction, "RESTAURANT_OWES_DIRECT");
  assert.equal(row.amountCents, order.financials.moneyMovement!.restaurantOwesDirectCents);
  assert.equal(row.totalBankFeeCents, 0);
  assert.equal(row.dataStatus, "COMPLETE");
});

// 15 — legacy без выдуманных сумм -------------------------------------------------

test("legacy entry: канал LEGACY_UNKNOWN, банковские детали null", () => {
  const order = makeOrder("lg", null, "REVIEW_REQUIRED");
  const model = okModel(
    stateWith(
      [order],
      [
        entryFor(order, "RESTAURANT_OWES_DIRECT", 555, {
          source: "LEGACY_COMMISSION_SETTLEMENT",
          legacySettlementId: "settlement-lg",
        }),
      ],
    ),
  );
  const row = model.openOrders[0];
  assert.equal(row.amountCents, 555); // историческая сумма, не пересчитана
  assert.equal(row.paymentChannel, "LEGACY_UNKNOWN");
  assert.equal(row.totalBankFeeCents, null);
  assert.equal(row.restaurantBankFeeCents, null);
  assert.equal(row.directBankFeeCents, null);
  assert.equal(row.customerTotalCents, null);
  assert.equal(row.restaurantNetCents, null);
  assert.equal(row.dataStatus, "REVIEW_REQUIRED");
  assert.equal(model.restaurantOwesDirectCents, 555);
});

// 16/17 — REVIEW и PENDING считаются отдельно ------------------------------------

test("REVIEW_REQUIRED и PENDING считаются отдельно и не входят в баланс", () => {
  const review = makeOrder("rv", null, "REVIEW_REQUIRED");
  const pending = { ...makeOrder("pd", null, "PENDING_PAYMENT_CHANNEL"), status: "PREPARING" as const };
  const paid = makeOrder("ok1", moveOwesDirect(800));
  const model = okModel(
    stateWith(
      [review, pending, paid],
      [entryFor(paid, "RESTAURANT_OWES_DIRECT", 800)],
    ),
  );
  assert.equal(model.reviewRequiredOrderCount, 1);
  assert.equal(model.pendingPaymentChannelOrderCount, 1);
  // Незавершённый pickup и review-заказ финансовым долгом не являются.
  assert.equal(model.restaurantOwesDirectCents, 800);
  assert.equal(model.openOrderCount, 1);
});

// 19 — самый старый открытый ------------------------------------------------------

test("oldestOpenRecognizedAt — минимальный recognizedAt среди OPEN", () => {
  const a = makeOrder("a", moveOwesDirect(100));
  const b = makeOrder("b", moveOwesDirect(200));
  const c = makeOrder("c", moveOwesDirect(300));
  const model = okModel(
    stateWith(
      [a, b, c],
      [
        entryFor(a, "RESTAURANT_OWES_DIRECT", 100, { recognizedAt: T2 }),
        entryFor(b, "RESTAURANT_OWES_DIRECT", 200, { recognizedAt: T1 }),
        // Закрытая запись со старейшей датой не участвует.
        entryFor(c, "RESTAURANT_OWES_DIRECT", 300, {
          recognizedAt: "2026-07-16T00:00:00.000Z",
          status: "SETTLED",
          settledAt: T3,
        }),
      ],
    ),
  );
  assert.equal(model.oldestOpenRecognizedAt, T1);
});

// 20 — детерминированная сортировка ----------------------------------------------

test("openOrders сортируется детерминированно: дата, номер, id", () => {
  const a = makeOrder("a", moveOwesDirect(100), "COMPLETE", "DIR-0002");
  const b = makeOrder("b", moveOwesDirect(200), "COMPLETE", "DIR-0001");
  const c = makeOrder("c", moveOwesDirect(300), "COMPLETE", "DIR-0003");
  const st = stateWith(
    [a, b, c],
    [
      entryFor(a, "RESTAURANT_OWES_DIRECT", 100, { recognizedAt: T2 }),
      entryFor(b, "RESTAURANT_OWES_DIRECT", 200, { recognizedAt: T2 }),
      entryFor(c, "RESTAURANT_OWES_DIRECT", 300, { recognizedAt: T1 }),
    ],
  );
  const first = okModel(st);
  assert.deepEqual(
    first.openOrders.map((r) => r.orderId),
    ["c", "b", "a"], // c — старее; b и a — по publicNumber
  );
  const second = okModel(st);
  assert.deepEqual(second.openOrders, first.openOrders);
});

// 21/22 — пустой ресторан и неизвестный id ---------------------------------------

test("пустой ресторан: нули, BALANCED, пустой список, null", () => {
  const model = okModel(createDefaultState());
  assert.equal(model.restaurantOwesDirectCents, 0);
  assert.equal(model.directOwesRestaurantCents, 0);
  assert.equal(model.netDirection, "BALANCED");
  assert.equal(model.netAmountCents, 0);
  assert.equal(model.openAccountingEntryCount, 0);
  assert.equal(model.openOrderCount, 0);
  assert.equal(model.oldestOpenRecognizedAt, null);
  assert.deepEqual(model.openOrders, []);
  assert.equal(model.lastClosedSettlement, null);
});

test("неизвестный restaurantId — явная ошибка (зафиксированный контракт)", () => {
  const result = buildRestaurantFinanceReadModel(createDefaultState(), "нет-такого");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /Ресторан не найден/.test(result.error));
});

// 23 — неизменяемость -------------------------------------------------------------

test("builder не мутирует state и детерминирован", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  const st = stateWith([a], [entryFor(a, "RESTAURANT_OWES_DIRECT", 800)]);
  const ordersRef = st.orders;
  const entriesRef = st.restaurantAccountingEntries;
  const snapshot = JSON.stringify(st);
  const first = okModel(st);
  const second = okModel(st);
  assert.equal(JSON.stringify(st), snapshot);
  assert.equal(st.orders, ordersRef);
  assert.equal(st.restaurantAccountingEntries, entriesRef);
  assert.deepEqual(first, second);
});

// 24 + shared contract ------------------------------------------------------------

test("summary — проекция того же builder; старые helpers согласованы", () => {
  const a = makeOrder("a", moveOwesDirect(800));
  const c = makeOrder("c", moveOwesRestaurant(5100));
  const st = stateWith(
    [a, c],
    [entryFor(a, "RESTAURANT_OWES_DIRECT", 800), entryFor(c, "DIRECT_OWES_RESTAURANT", 5100)],
  );
  const model = okModel(st);
  const summaryResult = getRestaurantFinanceSummary(st, RID);
  assert.equal(summaryResult.ok, true);
  if (!summaryResult.ok) throw new Error("unreachable");
  // Одни и те же значения — не вторая формула.
  assert.equal(summaryResult.summary.restaurantOwesDirectCents, model.restaurantOwesDirectCents);
  assert.equal(summaryResult.summary.directOwesRestaurantCents, model.directOwesRestaurantCents);
  assert.equal(summaryResult.summary.netDirection, model.netDirection);
  assert.equal(summaryResult.summary.netAmountCents, model.netAmountCents);
  // Существующие open-balance helpers дают те же открытые суммы.
  assert.equal(getRestaurantOpenReceivableCents(st, RID), model.restaurantOwesDirectCents);
  assert.equal(getRestaurantOpenPayableCents(st, RID), model.directOwesRestaurantCents);
});

// CASH_TO_PLATFORM_DRIVER (v24) -----------------------------------------------

/** Наличные водителю Direct: ресторан должен Direct amount (комиссия+small). */
function moveCashToDriver(amount: number): OrderMoneyMovement {
  return {
    customerMoneyRecipient: "RESTAURANT",
    paymentChannel: "CASH_TO_PLATFORM_DRIVER",
    totalBankFeeCents: 0,
    restaurantBankFeeCents: 0,
    directBankFeeCents: 0,
    restaurantOwesDirectCents: amount,
    directOwesRestaurantCents: 0,
    restaurantNetCents: 0,
    directNetRevenueCents: amount,
  };
}

test("CASH_TO_PLATFORM_DRIVER: read-model принимает RESTAURANT_REMITTANCE и сумму", () => {
  const order = {
    ...makeOrder("cash", moveCashToDriver(700)),
    deliveryMode: "PLATFORM_DRIVER" as const,
  };
  const entry = entryFor(order, "RESTAURANT_OWES_DIRECT", 700, {
    type: "RESTAURANT_REMITTANCE",
  });
  const model = okModel(stateWith([order], [entry]));
  assert.equal(model.restaurantOwesDirectCents, 700);
  assert.equal(model.directOwesRestaurantCents, 0);
  assert.equal(model.netDirection, "RESTAURANT_OWES_DIRECT");
  const row = model.openOrders.find((r) => r.orderId === order.id);
  assert.ok(row);
  assert.equal(row.accountingType, "RESTAURANT_REMITTANCE");
  assert.equal(row.paymentChannel, "CASH_TO_PLATFORM_DRIVER");
  assert.equal(row.amountCents, 700);
});

test("CASH_TO_PLATFORM_DRIVER: PLATFORM_COMMISSION-тип противоречит движению", () => {
  const order = {
    ...makeOrder("cash2", moveCashToDriver(700)),
    deliveryMode: "PLATFORM_DRIVER" as const,
  };
  const wrong = entryFor(order, "RESTAURANT_OWES_DIRECT", 700, {
    type: "PLATFORM_COMMISSION",
  });
  const result = buildRestaurantFinanceReadModel(stateWith([order], [wrong]), RID);
  assert.equal(result.ok, false);
});
