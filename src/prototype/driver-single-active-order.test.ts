import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assignDriverToOrder,
  markOrderDeliveredByDriverWithResult,
  goDriverOnline,
  reassignDriverForOrder,
  unassignDriverFromOrder,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import {
  getDriverActiveOrder,
  isDriverAvailableForOffers,
} from "./selectors.ts";
import type {
  DriverStatus,
  Order,
  OrderStatus,
  PrototypeState,
} from "./models.ts";

// Сид v16: все демо-водители OFFLINE и без зоны; нужные статусы задаются явно.
const D1 = "driver-1";
const D2 = "driver-2";
const D3 = "driver-3";

/** Минимальный, но валидный для назначения/завершения PLATFORM_DRIVER-заказ. */
function order(id: string, overrides: Partial<Order> = {}): Order {
  return {
    id,
    deliveryMode: "PLATFORM_DRIVER",
    status: "PREPARING",
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
    assignedDriverId: null,
    driverAssignedAt: null,
    history: [],
    updatedAt: "2026-07-18T10:00:00.000Z",
    restaurant: { id: "restaurant-1", name: "Ресторан 1", address: "", zoneId: "zone-1" },
    financials: {
      currencyCode: "USD",
      restaurantCollectedFromCustomerCents: 0,
      platformCollectedFromCustomerCents: 0,
      platformCommissionReceivableCents: 0,
      restaurantNetAfterPlatformCommissionCents: 0,
      // Минимальная фикстура без канонического движения: REVIEW_REQUIRED —
      // завершение заказа проходит, accounting-запись законно не создаётся.
      moneyMovementStatus: "REVIEW_REQUIRED",
    },
    ...overrides,
  } as unknown as Order;
}

/**
 * Ставит статус напрямую (в т.ч. заведомо повреждённые сочетания). Любой
 * не-OFFLINE статус получает подтверждённую зону: без неё водитель недоступен
 * по определению, и проверялся бы не тот инвариант.
 */
function withDriverStatus(
  state: PrototypeState,
  driverId: string,
  status: DriverStatus,
): PrototypeState {
  return {
    ...state,
    drivers: state.drivers.map((d) =>
      d.id === driverId
        ? {
            ...d,
            status,
            currentZoneId: status === "OFFLINE" ? null : "zone-1",
          }
        : d,
    ),
  };
}

function stateWith(
  orders: Order[],
  driverStatuses: Record<string, DriverStatus> = {},
): PrototypeState {
  let s: PrototypeState = { ...createDefaultState(), orders };
  for (const [id, st] of Object.entries(driverStatuses)) {
    s = withDriverStatus(s, id, st);
  }
  return s;
}

const statusOf = (state: PrototypeState, driverId: string): DriverStatus =>
  state.drivers.find((d) => d.id === driverId)!.status;
const orderById = (state: PrototypeState, id: string): Order =>
  state.orders.find((o) => o.id === id)!;

// 1 --------------------------------------------------------------------------

test("OFFLINE + активный заказ → online fail, state/revision неизменны", () => {
  const state = stateWith(
    [order("A", { assignedDriverId: D3, status: "OUT_FOR_DELIVERY" })],
    { [D3]: "OFFLINE" },
  );
  const before = JSON.stringify(state);
  const res = goDriverOnline(state, D3, "zone-1");
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state, "тот же объект state");
  assert.equal(res.state.revision, state.revision);
  assert.equal(JSON.stringify(state), before);
  assert.equal(statusOf(res.state, D3), "OFFLINE", "статус не «починен» молча");
});

// 2 --------------------------------------------------------------------------

test("AVAILABLE + активный заказ → недоступен для новых offers", () => {
  const state = stateWith(
    [order("A", { assignedDriverId: D1, status: "READY" })],
    { [D1]: "AVAILABLE" }, // поле status повреждено (должно быть BUSY_DIRECT)
  );
  const driver = state.drivers.find((d) => d.id === D1)!;
  assert.equal(isDriverAvailableForOffers(state, driver), false);
});

// 3 --------------------------------------------------------------------------

test("AVAILABLE + активный заказ → назначение второго заказа fail", () => {
  const state = stateWith(
    [
      order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" }),
      order("B", { status: "PREPARING" }),
    ],
    { [D1]: "AVAILABLE" },
  );
  const before = JSON.stringify(state);
  const res = assignDriverToOrder(state, "B", D1);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "У водителя уже есть активный заказ.");
  assert.equal(res.state, state, "state тот же объект");
  assert.equal(JSON.stringify(state), before, "orders/drivers не мутированы");
  assert.equal(orderById(res.state, "B").assignedDriverId, null);
});

// 4 --------------------------------------------------------------------------

test("AVAILABLE + активный заказ → переназначение другого заказа на него fail", () => {
  const state = stateWith(
    [
      order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" }),
      order("B", { assignedDriverId: D2, status: "READY" }),
    ],
    { [D1]: "AVAILABLE", [D2]: "BUSY_DIRECT" },
  );
  const before = JSON.stringify(state);
  const res = reassignDriverForOrder(state, "B", D1, "смена водителя");
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "У водителя уже есть активный заказ.");
  assert.equal(res.state, state);
  assert.equal(JSON.stringify(state), before);
  assert.equal(orderById(res.state, "B").assignedDriverId, D2, "заказ B не переназначен");
});

// 5 --------------------------------------------------------------------------

test("терминальный DELIVERED/CANCELED не блокирует online и новое назначение", () => {
  // Онлайн: у OFFLINE-водителя только завершённый заказ → online разрешён.
  const s1 = stateWith(
    [order("done", { assignedDriverId: D3, status: "DELIVERED" })],
    { [D3]: "OFFLINE" },
  );
  const r1 = goDriverOnline(s1, D3, "zone-1");
  assert.equal(r1.result.ok, true, r1.result.error ?? "");
  assert.equal(statusOf(r1.state, D3), "AVAILABLE");

  // Назначение: отменённый прошлый заказ не мешает получить новый.
  const s2 = stateWith(
    [
      order("canceled", { assignedDriverId: D1, status: "CANCELED" }),
      order("new", { status: "PREPARING" }),
    ],
    { [D1]: "AVAILABLE" },
  );
  const r2 = assignDriverToOrder(s2, "new", D1);
  assert.equal(r2.result.ok, true, r2.result.error ?? "");
  assert.equal(orderById(r2.state, "new").assignedDriverId, D1);
  assert.equal(statusOf(r2.state, D1), "BUSY_DIRECT");
});

// 6 --------------------------------------------------------------------------

test("PREPARING/READY/OUT_FOR_DELIVERY/ARRIVING считаются активными для назначенного заказа", () => {
  const activeStatuses: OrderStatus[] = [
    "PREPARING",
    "READY",
    "OUT_FOR_DELIVERY",
    "ARRIVING",
  ];
  for (const status of activeStatuses) {
    const state = stateWith([order("A", { assignedDriverId: D1, status })]);
    assert.equal(
      getDriverActiveOrder(state, D1)?.id,
      "A",
      `${status} активен`,
    );
  }
  // Не-курьерские/терминальные статусы активными не считаются.
  for (const status of ["DELIVERED", "CANCELED", "AWAITING_PAYMENT"] as OrderStatus[]) {
    const state = stateWith([order("A", { assignedDriverId: D1, status })]);
    assert.equal(getDriverActiveOrder(state, D1), null, `${status} не активен`);
  }
});

// 7 --------------------------------------------------------------------------

test("после завершения единственного заказа водитель подтверждает зону", () => {
  const state = stateWith(
    [order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" })],
    { [D1]: "BUSY_DIRECT" },
  );
  const res = markOrderDeliveredByDriverWithResult(state, "A");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(orderById(res.state, "A").status, "DELIVERED");
  assert.equal(
    statusOf(res.state, D1),
    "ZONE_CONFIRMATION_REQUIRED",
    "освобождён, но до подтверждения зоны предложений не получает",
  );
});

// 8 --------------------------------------------------------------------------

test("после освобождения одного заказа при другом активном — водитель остаётся занят", () => {
  // Повреждённое двойное назначение: у D1 два активных заказа.
  const state = stateWith(
    [
      order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" }),
      order("B", { assignedDriverId: D1, status: "READY" }),
    ],
    { [D1]: "BUSY_DIRECT" },
  );
  const res = unassignDriverFromOrder(state, "A", "ошибочное назначение");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  // A снят, но B всё ещё активен → водитель НЕ освобождается.
  assert.equal(orderById(res.state, "A").assignedDriverId, null);
  assert.equal(
    statusOf(res.state, D1),
    "BUSY_DIRECT",
    "остаётся занят при другом активном заказе",
  );
  assert.equal(getDriverActiveOrder(res.state, D1)?.id, "B");
});

// 9 --------------------------------------------------------------------------

test("нормальное освобождение единственного заказа через unassign → подтверждение зоны", () => {
  const state = stateWith(
    [order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" })],
    { [D1]: "BUSY_DIRECT" },
  );
  const res = unassignDriverFromOrder(state, "A", "по просьбе ресторана");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, D1), "ZONE_CONFIRMATION_REQUIRED");
  // Снятие назначения зону клиента не предлагает: заказ не доставлен.
  assert.equal(
    res.state.drivers.find((d) => d.id === D1)?.suggestedZoneId,
    null,
  );
});

// 10 -------------------------------------------------------------------------

test("успешное переназначение освобождает старого водителя корректно", () => {
  // D1 везёт A; переназначаем на свободного D2 (без активных заказов).
  const state = stateWith(
    [order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" })],
    { [D1]: "BUSY_DIRECT", [D2]: "AVAILABLE" },
  );
  const res = reassignDriverForOrder(state, "A", D2, "ближе к адресу");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(orderById(res.state, "A").assignedDriverId, D2);
  assert.equal(statusOf(res.state, D2), "BUSY_DIRECT", "новый водитель занят");
  // Старый водитель освобождён и подтверждает зону, а не становится доступным.
  assert.equal(statusOf(res.state, D1), "ZONE_CONFIRMATION_REQUIRED");
});
