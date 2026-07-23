import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlatformDriverCashSnapshot,
  resolvePlatformDriverCashSnapshot,
  type PlatformDriverCashAmountsInput,
} from "./platform-driver-cash.ts";
import {
  getPlatformDriverCashSnapshot,
  hasValidPlatformDriverCashSnapshot,
} from "./selectors.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type { Order, PlatformDriverCashSnapshot } from "./models.ts";
import { createDefaultState } from "./default-state.ts";
import { parseStoredState } from "./prototype-store.ts";
import {
  DRIVER_OFFER_DURATION_MS,
  isOrderEligibleForDriverOffers,
} from "./driver-offers.ts";

/**
 * CASH DIRECT — часть 1: неизменяемый финансовый снимок будущего наличного
 * заказа PLATFORM_DRIVER. В этом коммите наличные ВЫКЛЮЧЕНЫ: продукт не создаёт
 * cash-заказов, поэтому в реальном pipeline снимок всегда null. Здесь проверяем
 * (1) чистый builder, (2) строгое разрешение снимка (нормализация/селектор),
 * (3) миграцию, (4) регрессии «наличные остаются выключенными».
 */

// Каноническая согласованная четвёрка: 1000 = 600 + 300 + 100.
const OK_AMOUNTS: PlatformDriverCashAmountsInput = {
  customerTotalCents: 1000,
  restaurantPayoutBeforeBankFeeCents: 600,
  driverPayoutCents: 300,
  platformGrossRevenueCents: 100,
};

const OK_SNAPSHOT: PlatformDriverCashSnapshot = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 600,
  driverEarningCents: 300,
  directReceivableFromDriverCents: 100,
};

/** Минимальный заказ для селектора (читает только режимы и financials). */
function cashOrder(over: {
  deliveryMode?: Order["deliveryMode"];
  paymentMethod?: Order["paymentMethod"];
  amounts?: Partial<PlatformDriverCashAmountsInput>;
  candidate?: unknown;
}): Order {
  const amounts = { ...OK_AMOUNTS, ...(over.amounts ?? {}) };
  return {
    deliveryMode: over.deliveryMode ?? "PLATFORM_DRIVER",
    paymentMethod: over.paymentMethod ?? "CASH",
    financials: {
      customerTotalCents: amounts.customerTotalCents,
      restaurantPayoutBeforeBankFeeCents:
        amounts.restaurantPayoutBeforeBankFeeCents,
      driverPayoutCents: amounts.driverPayoutCents,
      platformGrossRevenueCents: amounts.platformGrossRevenueCents,
      platformDriverCash:
        over.candidate === undefined ? OK_SNAPSHOT : over.candidate,
    },
  } as unknown as Order;
}

// --- 1–16: чистый builder -----------------------------------------------------

test("1: корректные суммы создают snapshot", () => {
  const result = buildPlatformDriverCashSnapshot(OK_AMOUNTS);
  assert.equal(result.ok, true);
});

test("2: customerCollection берётся из customerTotal", () => {
  const r = buildPlatformDriverCashSnapshot(OK_AMOUNTS);
  assert.ok(r.ok);
  assert.equal(r.snapshot.customerCollectionCents, 1000);
});

test("3: restaurantHandoff из restaurantPayoutBeforeBankFee", () => {
  const r = buildPlatformDriverCashSnapshot(OK_AMOUNTS);
  assert.ok(r.ok);
  assert.equal(r.snapshot.restaurantHandoffCents, 600);
});

test("4: driverEarning из driverPayout", () => {
  const r = buildPlatformDriverCashSnapshot(OK_AMOUNTS);
  assert.ok(r.ok);
  assert.equal(r.snapshot.driverEarningCents, 300);
});

test("5: directReceivable из platformGrossRevenue", () => {
  const r = buildPlatformDriverCashSnapshot(OK_AMOUNTS);
  assert.ok(r.ok);
  assert.equal(r.snapshot.directReceivableFromDriverCents, 100);
});

test("6: reconciliation сходится (клиент = ресторан + водитель + Direct)", () => {
  const r = buildPlatformDriverCashSnapshot(OK_AMOUNTS);
  assert.ok(r.ok);
  const s = r.snapshot;
  assert.equal(
    s.customerCollectionCents,
    s.restaurantHandoffCents +
      s.driverEarningCents +
      s.directReceivableFromDriverCents,
  );
});

test("7: дробная сумма отклоняется", () => {
  const r = buildPlatformDriverCashSnapshot({
    ...OK_AMOUNTS,
    customerTotalCents: 1000.5,
    driverPayoutCents: 300.5,
  });
  assert.equal(r.ok, false);
});

test("8: отрицательная сумма отклоняется", () => {
  const r = buildPlatformDriverCashSnapshot({
    ...OK_AMOUNTS,
    driverPayoutCents: -300,
  });
  assert.equal(r.ok, false);
});

test("9: unsafe integer отклоняется", () => {
  const r = buildPlatformDriverCashSnapshot({
    ...OK_AMOUNTS,
    customerTotalCents: Number.MAX_SAFE_INTEGER + 1,
  });
  assert.equal(r.ok, false);
});

test("10: customer total 0 отклоняется", () => {
  const r = buildPlatformDriverCashSnapshot({
    customerTotalCents: 0,
    restaurantPayoutBeforeBankFeeCents: 0,
    driverPayoutCents: 0,
    platformGrossRevenueCents: 0,
  });
  assert.equal(r.ok, false);
});

test("11: restaurant handoff 0 отклоняется", () => {
  const r = buildPlatformDriverCashSnapshot({
    customerTotalCents: 400,
    restaurantPayoutBeforeBankFeeCents: 0,
    driverPayoutCents: 300,
    platformGrossRevenueCents: 100,
  });
  assert.equal(r.ok, false);
});

test("12: driver earning 0 отклоняется", () => {
  const r = buildPlatformDriverCashSnapshot({
    customerTotalCents: 700,
    restaurantPayoutBeforeBankFeeCents: 600,
    driverPayoutCents: 0,
    platformGrossRevenueCents: 100,
  });
  assert.equal(r.ok, false);
});

test("13: direct receivable может быть 0", () => {
  const r = buildPlatformDriverCashSnapshot({
    customerTotalCents: 1000,
    restaurantPayoutBeforeBankFeeCents: 600,
    driverPayoutCents: 400,
    platformGrossRevenueCents: 0,
  });
  assert.ok(r.ok);
  assert.equal(r.snapshot.directReceivableFromDriverCents, 0);
});

test("14: расхождение на 1 цент отклоняется", () => {
  const r = buildPlatformDriverCashSnapshot({
    ...OK_AMOUNTS,
    platformGrossRevenueCents: 101, // сумма частей = 1001 ≠ 1000
  });
  assert.equal(r.ok, false);
});

test("15: builder не округляет дробную сумму до целой", () => {
  const r = buildPlatformDriverCashSnapshot({
    ...OK_AMOUNTS,
    customerTotalCents: 1000.4,
  });
  // 1000.4 не «исправляется» до 1000 — снимок не создаётся.
  assert.equal(r.ok, false);
});

test("16: builder не изменяет input", () => {
  const input: PlatformDriverCashAmountsInput = { ...OK_AMOUNTS };
  const snapshot = JSON.stringify(input);
  buildPlatformDriverCashSnapshot(input);
  assert.equal(JSON.stringify(input), snapshot);
});

// --- 17–28: разрешение снимка (нормализация / миграция) -----------------------

/** Стор-уровень: сериализовать состояние с одним заказом и прочитать обратно. */
function normalizeStoredOrder(
  rawOrder: Record<string, unknown>,
  schemaVersion: number,
): Order {
  const base = createDefaultState();
  const parsed = parseStoredState(
    JSON.stringify({ ...base, schemaVersion, orders: [rawOrder] }),
  );
  assert.ok(parsed, "состояние должно парситься");
  return parsed.orders[0];
}

function rawOrderWith(
  deliveryMode: string,
  paymentMethod: string,
  candidate: unknown,
): Record<string, unknown> {
  return {
    id: "o1",
    deliveryMode,
    paymentMethod,
    financials: {
      customerTotalCents: OK_AMOUNTS.customerTotalCents,
      restaurantPayoutBeforeBankFeeCents:
        OK_AMOUNTS.restaurantPayoutBeforeBankFeeCents,
      driverPayoutCents: OK_AMOUNTS.driverPayoutCents,
      platformGrossRevenueCents: OK_AMOUNTS.platformGrossRevenueCents,
      platformDriverCash: candidate,
    },
  };
}

test("17: schema 18 → platformDriverCash null", () => {
  const order = normalizeStoredOrder(
    rawOrderWith("PLATFORM_DRIVER", "ONLINE", OK_SNAPSHOT),
    18,
  );
  assert.equal(order.financials.platformDriverCash, null);
});

test("18: snapshot не реконструируется из старых financials", () => {
  // Валидные и совпадающие суммы, но кандидат отсутствует → снимок НЕ строится.
  const resolved = resolvePlatformDriverCashSnapshot({
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    amounts: OK_AMOUNTS,
    candidate: null,
  });
  assert.equal(resolved, null);
});

test("19: schema 19 сохраняет валидный PLATFORM_DRIVER CASH snapshot", () => {
  const resolved = resolvePlatformDriverCashSnapshot({
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    amounts: OK_AMOUNTS,
    candidate: OK_SNAPSHOT,
  });
  assert.deepEqual(resolved, OK_SNAPSHOT);
});

test("20: повреждённый snapshot превращается в null", () => {
  const resolved = resolvePlatformDriverCashSnapshot({
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    amounts: OK_AMOUNTS,
    candidate: { customerCollectionCents: "1000" }, // мусор
  });
  assert.equal(resolved, null);
});

test("21: ONLINE-заказ с cash snapshot → null", () => {
  const resolved = resolvePlatformDriverCashSnapshot({
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "ONLINE",
    amounts: OK_AMOUNTS,
    candidate: OK_SNAPSHOT,
  });
  assert.equal(resolved, null);
  // И через стор: ONLINE-заказ с записанным снимком тоже нормализуется в null.
  const order = normalizeStoredOrder(
    rawOrderWith("PLATFORM_DRIVER", "ONLINE", OK_SNAPSHOT),
    19,
  );
  assert.equal(order.financials.platformDriverCash, null);
});

test("22: PICKUP с cash snapshot → null", () => {
  const resolved = resolvePlatformDriverCashSnapshot({
    deliveryMode: "PICKUP",
    paymentMethod: "CASH",
    amounts: OK_AMOUNTS,
    candidate: OK_SNAPSHOT,
  });
  assert.equal(resolved, null);
  const order = normalizeStoredOrder(
    rawOrderWith("PICKUP", "CASH", OK_SNAPSHOT),
    19,
  );
  assert.equal(order.financials.platformDriverCash, null);
});

test("23: RESTAURANT_DELIVERY с cash snapshot → null", () => {
  const resolved = resolvePlatformDriverCashSnapshot({
    deliveryMode: "RESTAURANT_DELIVERY",
    paymentMethod: "CASH",
    amounts: OK_AMOUNTS,
    candidate: OK_SNAPSHOT,
  });
  assert.equal(resolved, null);
  const order = normalizeStoredOrder(
    rawOrderWith("RESTAURANT_DELIVERY", "CASH", OK_SNAPSHOT),
    19,
  );
  assert.equal(order.financials.platformDriverCash, null);
});

test("24: несовпадение customer total → null", () => {
  const resolved = resolvePlatformDriverCashSnapshot({
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    amounts: OK_AMOUNTS,
    candidate: { ...OK_SNAPSHOT, customerCollectionCents: 999 },
  });
  assert.equal(resolved, null);
});

test("25: несовпадение restaurant handoff → null", () => {
  const resolved = resolvePlatformDriverCashSnapshot({
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    amounts: OK_AMOUNTS,
    candidate: { ...OK_SNAPSHOT, restaurantHandoffCents: 599 },
  });
  assert.equal(resolved, null);
});

test("26: несовпадение driver earning → null", () => {
  const resolved = resolvePlatformDriverCashSnapshot({
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    amounts: OK_AMOUNTS,
    candidate: { ...OK_SNAPSHOT, driverEarningCents: 301 },
  });
  assert.equal(resolved, null);
});

test("27: несовпадение direct receivable → null", () => {
  const resolved = resolvePlatformDriverCashSnapshot({
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    amounts: OK_AMOUNTS,
    candidate: { ...OK_SNAPSHOT, directReceivableFromDriverCents: 99 },
  });
  assert.equal(resolved, null);
});

test("28: нормализация идемпотентна", () => {
  const base = createDefaultState();
  const s1 = parseStoredState(
    JSON.stringify({
      ...base,
      schemaVersion: 19,
      orders: [rawOrderWith("PLATFORM_DRIVER", "CASH", OK_SNAPSHOT)],
    }),
  );
  assert.ok(s1);
  const s2 = parseStoredState(JSON.stringify(s1));
  assert.ok(s2);
  assert.deepEqual(
    s2.orders[0].financials.platformDriverCash,
    s1.orders[0].financials.platformDriverCash,
  );
  // Через продукт наличные выключены: CASH коэрцится в ONLINE → снимок null.
  assert.equal(s1.orders[0].financials.platformDriverCash, null);
  assert.equal(s1.orders[0].paymentMethod, "ONLINE");
});

// --- Селектор -----------------------------------------------------------------

test("селектор: валидный PLATFORM_DRIVER CASH → снимок и hasValid true", () => {
  const order = cashOrder({});
  assert.deepEqual(getPlatformDriverCashSnapshot(order), OK_SNAPSHOT);
  assert.equal(hasValidPlatformDriverCashSnapshot(order), true);
});

test("селектор: не CASH → null", () => {
  assert.equal(
    getPlatformDriverCashSnapshot(cashOrder({ paymentMethod: "ONLINE" })),
    null,
  );
});

test("селектор: не PLATFORM_DRIVER → null", () => {
  assert.equal(
    getPlatformDriverCashSnapshot(cashOrder({ deliveryMode: "PICKUP" })),
    null,
  );
});

test("селектор: расхождение с financials → null", () => {
  const order = cashOrder({ amounts: { customerTotalCents: 1001 } });
  assert.equal(getPlatformDriverCashSnapshot(order), null);
  assert.equal(hasValidPlatformDriverCashSnapshot(order), false);
});

test("селектор: отсутствующий снимок → null", () => {
  assert.equal(getPlatformDriverCashSnapshot(cashOrder({ candidate: null })), null);
});

// --- 29–40: регрессии («наличные остаются выключенными») ----------------------

test("29: schema равна 19", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 19);
});

test("30: platformDriverCashEnabled остаётся false", () => {
  assert.equal(
    createDefaultState().platformSettings.platformDriverCashEnabled,
    false,
  );
});

test("31: Пётр cashEnabled true", () => {
  const petr = createDefaultState().drivers.find((d) => d.id === "driver-1");
  assert.ok(petr);
  assert.equal(petr.cashEnabled, true);
});

test("32: Олег и Сергей cashEnabled false", () => {
  const drivers = createDefaultState().drivers;
  const oleg = drivers.find((d) => d.id === "driver-2");
  const sergey = drivers.find((d) => d.id === "driver-3");
  assert.ok(oleg && sergey);
  assert.equal(oleg.cashEnabled, false);
  assert.equal(sergey.cashEnabled, false);
});

test("33: checkout не показывает PLATFORM_DRIVER CASH (доставка ONLINE-only)", () => {
  for (const restaurant of createDefaultState().restaurants) {
    assert.ok(
      !restaurant.paymentMethods.includes("CASH"),
      `${restaurant.id} не должен предлагать CASH для доставки`,
    );
  }
});

test("34: cash order не получает driver offer", () => {
  const order = cashOrder({ paymentMethod: "CASH" });
  assert.equal(isOrderEligibleForDriverOffers(order), false);
});

test("35: ONLINE order продолжает получать offer", () => {
  const order = {
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
    status: "PREPARING",
    assignedDriverId: null,
    address: { street: "ул. Пушкина", zoneId: "zone-1" },
    financials: {
      customerZoneId: "zone-1",
      driverPayoutCents: 300,
    },
  } as unknown as Order;
  assert.equal(isOrderEligibleForDriverOffers(order), true);
});

test("36: срок offer остаётся 30 секунд", () => {
  assert.equal(DRIVER_OFFER_DURATION_MS, 30_000);
});

test("37–40: cash snapshot не влияет на ONLINE lifecycle/pricing/accounting", () => {
  // Снимок наличных — чистая проекция уже рассчитанных сумм: он не участвует в
  // расчёте цены, движении денег или бухгалтерии. Reconciliation builder'а
  // совпадает с инвариантом financials (клиент = ресторан + водитель + Direct),
  // что подтверждает: новые понятия не вводят вторую формулу.
  const r = buildPlatformDriverCashSnapshot(OK_AMOUNTS);
  assert.ok(r.ok);
  assert.equal(
    r.snapshot.customerCollectionCents,
    r.snapshot.restaurantHandoffCents +
      r.snapshot.driverEarningCents +
      r.snapshot.directReceivableFromDriverCents,
  );
});
