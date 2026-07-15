import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  acceptRestaurantOrder,
  addCartItem,
  adminCancelOrder,
  completePickupWithCode,
  createOrderFromCart,
  markOrderReady,
  markPickupNoShow,
  setCartFulfillmentChoice,
} from "./actions.ts";
import {
  driverStatusLabels,
  formatSettlementStatus,
  formatSettlementType,
  getPickupStats,
  getPickupNoShowEligibleAtIso,
  orderActorLabels,
  orderStatusLabels,
  paymentMethodLabels,
  paymentStatusLabels,
  publicationStatusLabels,
  settlementStatusLabels,
  settlementTypeLabels,
} from "./selectors.ts";
import type {
  DriverStatus,
  Order,
  PaymentMethod,
  PaymentStatus,
  PrototypeState,
  PublicationStatus,
  SettlementStatus,
  SettlementType,
} from "./models.ts";

const NOW = "2026-07-14T12:00:00.000Z";

function getOrder(state: PrototypeState, orderId: string): Order {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
}

/** Добавляет PICKUP-заказ и доводит его до READY_FOR_PICKUP. */
function addReadyPickup(state: PrototypeState): {
  state: PrototypeState;
  orderId: string;
  code: string;
} {
  let s = state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  s = created.state;
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(s, orderId, 20);
  s = markOrderReady(s, orderId);
  return { state: s, orderId, code: getOrder(s, orderId).pickupCode as string };
}

function eligibleAt(state: PrototypeState, orderId: string): string {
  const iso = getPickupNoShowEligibleAtIso(getOrder(state, orderId));
  assert.ok(iso);
  return iso;
}

// --- §1: статистика самовывоза -----------------------------------------------

test("§1.1: markPickupNoShow увеличивает noShow", () => {
  const built = addReadyPickup(createDefaultState());
  const before = getPickupStats(built.state).noShow;
  const res = markPickupNoShow(
    built.state,
    built.orderId,
    "Не пришёл",
    "RESTAURANT",
    eligibleAt(built.state, built.orderId),
  );
  assert.equal(res.result.ok, true);
  assert.equal(getPickupStats(res.state).noShow, before + 1);
});

test("§1.2: markPickupNoShow не увеличивает suspiciousAfterReady", () => {
  const built = addReadyPickup(createDefaultState());
  const before = getPickupStats(built.state).suspiciousAfterReady;
  const res = markPickupNoShow(
    built.state,
    built.orderId,
    "Не пришёл",
    "RESTAURANT",
    eligibleAt(built.state, built.orderId),
  );
  assert.equal(getPickupStats(res.state).suspiciousAfterReady, before);
});

test("§1.3: adminCancelOrder из READY_FOR_PICKUP не увеличивает noShow", () => {
  const built = addReadyPickup(createDefaultState());
  const before = getPickupStats(built.state).noShow;
  const res = adminCancelOrder(built.state, built.orderId, "Технический сбой");
  assert.equal(res.result.ok, true);
  assert.equal(getPickupStats(res.state).noShow, before);
});

test("§1.4: adminCancelOrder из READY_FOR_PICKUP увеличивает suspiciousAfterReady", () => {
  const built = addReadyPickup(createDefaultState());
  const before = getPickupStats(built.state).suspiciousAfterReady;
  const res = adminCancelOrder(built.state, built.orderId, "Технический сбой");
  assert.equal(getPickupStats(res.state).suspiciousAfterReady, before + 1);
});

test("§1.5: отмена из PREPARING не увеличивает noShow", () => {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  s = created.state;
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(s, orderId, 20); // теперь PREPARING
  assert.equal(getOrder(s, orderId).status, "PREPARING");
  const before = getPickupStats(s);
  const res = adminCancelOrder(s, orderId, "Отмена до готовности");
  assert.equal(res.result.ok, true);
  const after = getPickupStats(res.state);
  assert.equal(after.noShow, before.noShow);
  assert.equal(after.suspiciousAfterReady, before.suspiciousAfterReady);
});

test("§1.6: PICKED_UP увеличивает issued", () => {
  const built = addReadyPickup(createDefaultState());
  const before = getPickupStats(built.state).issued;
  const res = completePickupWithCode(
    built.state,
    built.orderId,
    built.code,
    "CASH",
    "RESTAURANT",
    NOW,
  );
  assert.equal(res.result.ok, true);
  assert.equal(getPickupStats(res.state).issued, before + 1);
});

test("§1.7: noShowPercent считается только из issued + настоящих noShow", () => {
  // 1 выданный, 1 настоящий невыкуп, 1 обычная отмена из готовности.
  let s = createDefaultState();
  const a = addReadyPickup(s);
  s = completePickupWithCode(a.state, a.orderId, a.code, "CASH", "RESTAURANT", NOW)
    .state;
  const b = addReadyPickup(s);
  s = markPickupNoShow(
    b.state,
    b.orderId,
    "Не пришёл",
    "RESTAURANT",
    eligibleAt(b.state, b.orderId),
  ).state;
  const c = addReadyPickup(s);
  s = adminCancelOrder(c.state, c.orderId, "Обычная отмена").state;

  const stats = getPickupStats(s);
  assert.equal(stats.issued, 1);
  assert.equal(stats.noShow, 1);
  assert.equal(stats.suspiciousAfterReady, 1);
  // 1 / (1 + 1) = 50%, обычная отмена в знаменатель не входит.
  assert.equal(stats.noShowPercent, 50);
});

// --- §6: локализация подписей начислений --------------------------------------

const ALL_SETTLEMENT_STATUSES: SettlementStatus[] = [
  "PENDING",
  "NETTED",
  "PAID",
  "WAIVED",
];
const ALL_SETTLEMENT_TYPES: SettlementType[] = [
  "PICKUP_COMMISSION",
  "RESTAURANT_DELIVERY_COMMISSION",
];

test("§6.1: каждый SettlementStatus имеет русскую подпись", () => {
  for (const status of ALL_SETTLEMENT_STATUSES) {
    const label = settlementStatusLabels[status];
    assert.ok(label && label !== status);
    assert.ok(/[А-Яа-яЁё]/.test(label));
  }
});

test("§6.2: каждый SettlementType имеет русскую подпись", () => {
  for (const type of ALL_SETTLEMENT_TYPES) {
    const label = settlementTypeLabels[type];
    assert.ok(label && label !== type);
    assert.ok(/[А-Яа-яЁё]/.test(label));
  }
});

test("§6.3: PENDING отображается как «Ожидает расчёта»", () => {
  assert.equal(formatSettlementStatus("PENDING"), "Ожидает расчёта");
});

test("§6.4: ни один известный статус/тип не возвращает сырой enum", () => {
  for (const status of ALL_SETTLEMENT_STATUSES) {
    assert.notEqual(formatSettlementStatus(status), status);
  }
  for (const type of ALL_SETTLEMENT_TYPES) {
    assert.notEqual(formatSettlementType(type), type);
  }
});

test("§6.5: неизвестное значение возвращает русский fallback", () => {
  assert.equal(formatSettlementStatus("WAT"), "Неизвестный статус расчёта");
  assert.equal(formatSettlementType("WAT"), "Неизвестный тип начисления");
});

test("§6.6: PickupAdminDetails не выводит сырой PENDING (через formatSettlementStatus)", () => {
  // Экран использует formatSettlementStatus, поэтому сырой enum не попадает в UI.
  const rendered = formatSettlementStatus("PENDING");
  assert.notEqual(rendered, "PENDING");
  const src = readFileSync("src/app/admin/orders/page.tsx", "utf8");
  assert.ok(!src.includes("${settlement.status}"));
  assert.ok(src.includes("formatSettlementStatus"));
});

test("§6.7: страница расчётов не использует raw fallback entry.status", () => {
  const src = readFileSync("src/app/admin/settlements/page.tsx", "utf8");
  assert.ok(!src.includes("?? entry.status"));
  assert.ok(src.includes("formatSettlementStatus"));
});

test("§6.8: страница расчётов не использует raw fallback entry.type", () => {
  const src = readFileSync("src/app/admin/settlements/page.tsx", "utf8");
  assert.ok(!src.includes("?? entry.type"));
  assert.ok(src.includes("formatSettlementType"));
});

test("§6.9: существующие label maps остаются полными", () => {
  const orderStatuses: Order["status"][] = [
    "RESTAURANT_REVIEW",
    "AWAITING_PAYMENT",
    "PREPARING",
    "READY",
    "READY_FOR_PICKUP",
    "PICKED_UP",
    "OUT_FOR_DELIVERY",
    "ARRIVING",
    "DELIVERED",
    "CANCELED",
  ];
  for (const s of orderStatuses) assert.ok(orderStatusLabels[s]);

  const payMethods: PaymentMethod[] = [
    "ONLINE",
    "CASH",
    "PAY_AT_RESTAURANT",
    "CASH_TO_RESTAURANT_COURIER",
  ];
  for (const m of payMethods) assert.ok(paymentMethodLabels[m]);

  const payStatuses: PaymentStatus[] = [
    "NOT_STARTED",
    "AWAITING_PAYMENT",
    "PAID",
    "CASH_ON_DELIVERY",
    "DUE_AT_PICKUP",
    "PAID_AT_RESTAURANT",
    "DUE_TO_RESTAURANT_COURIER",
    "PAID_TO_RESTAURANT_COURIER",
  ];
  for (const s of payStatuses) assert.ok(paymentStatusLabels[s]);

  const driverStatuses: DriverStatus[] = ["AVAILABLE", "BUSY", "OFFLINE"];
  for (const d of driverStatuses) assert.ok(driverStatusLabels[d]);

  const pubStatuses: PublicationStatus[] = [
    "DRAFT",
    "PENDING_REVIEW",
    "PUBLISHED",
    "HIDDEN",
    "ARCHIVED",
  ];
  for (const p of pubStatuses) assert.ok(publicationStatusLabels[p]);

  const actors: Order["history"][number]["actor"][] = [
    "CLIENT",
    "RESTAURANT",
    "SYSTEM",
    "ADMIN",
  ];
  for (const a of actors) assert.ok(orderActorLabels[a]);
});
