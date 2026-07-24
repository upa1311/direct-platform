import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  assignDriverToOrder,
  changeDriverZone,
  confirmDriverZone,
  goDriverOffline,
  goDriverOnline,
  markOrderDeliveredByDriverWithResult,
  pauseDriver,
  reassignDriverForOrder,
  resumeDriver,
  setDriverAvailability,
  unassignDriverFromOrder,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import { parseStoredState } from "./prototype-store.ts";
import {
  driverStatusLabels,
  getAvailableDrivers,
  getDriverActiveOrder,
} from "./selectors.ts";
import type {
  DriverProfile,
  DriverStatus,
  Order,
  OrderStatus,
  PrototypeState,
  ZoneId,
} from "./models.ts";

/**
 * Фундамент доступности водителя (v16).
 *
 * Ключевой инвариант: зона НИКОГДА не определяется автоматически. Водитель
 * указывает её при выходе онлайн и подтверждает после каждого завершённого,
 * отменённого или снятого заказа. Система вправе только предложить зону
 * доставленного заказа — предложение авторитетным не считается.
 *
 * Причины паузы в модели нет: водитель никому не объясняет перерыв.
 */

const D1 = "driver-1"; // Пётр — единственный с допуском к наличным
const D2 = "driver-2";
const D3 = "driver-3";
const Z1: ZoneId = "zone-1";
const Z2: ZoneId = "zone-2";

const DRIVER_PAGE = readFileSync("src/app/driver/page.tsx", "utf8");
// v18 UI: рабочий экран водителя вынесен в общий компонент.
const DRIVER_WORKSPACE = readFileSync(
  "src/components/driver/driver-workspace.tsx",
  "utf8",
);
const DRIVER_SETTLEMENTS_PAGE = readFileSync(
  "src/app/driver/settlements/page.tsx",
  "utf8",
);
const DRIVER_HEADER = readFileSync(
  "src/components/workspaces/driver-header.tsx",
  "utf8",
);

function driverOf(state: PrototypeState, driverId: string): DriverProfile {
  const driver = state.drivers.find((d) => d.id === driverId);
  assert.ok(driver, `водитель ${driverId} не найден`);
  return driver;
}

const statusOf = (state: PrototypeState, driverId: string): DriverStatus =>
  driverOf(state, driverId).status;

/** Минимальный, но валидный для назначения PLATFORM_DRIVER-заказ. */
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
    restaurant: {
      id: "restaurant-1",
      name: "Ресторан 1",
      address: "",
      zoneId: Z1,
    },
    financials: {
      currencyCode: "USD",
      restaurantCollectedFromCustomerCents: 0,
      platformCollectedFromCustomerCents: 0,
      platformCommissionReceivableCents: 0,
      restaurantNetAfterPlatformCommissionCents: 0,
      customerZoneId: Z2,
      // Минимальная фикстура без канонического движения: REVIEW_REQUIRED —
      // завершение проходит, accounting-запись законно не создаётся.
      moneyMovementStatus: "REVIEW_REQUIRED",
    },
    ...overrides,
  } as unknown as Order;
}

/** Состояние с заданными заказами и явно выставленными полями водителей. */
function stateWith(
  orders: Order[],
  drivers: Record<string, Partial<DriverProfile>> = {},
): PrototypeState {
  const base = createDefaultState();
  return {
    ...base,
    orders,
    drivers: base.drivers.map((d) =>
      drivers[d.id] ? { ...d, ...drivers[d.id] } : d,
    ),
  };
}

/** Онлайн-водитель с подтверждённой зоной — обычная предпосылка назначения. */
function online(
  state: PrototypeState,
  driverId: string,
  zoneId: ZoneId = Z1,
): PrototypeState {
  const res = goDriverOnline(state, driverId, zoneId);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  return res.state;
}

// --- 1–2: схема ---------------------------------------------------------------

test("1: схема прототипа поднята до 18", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 24);
});

test("2: нормализатор принимает схемы 7–18", () => {
  const base = createDefaultState();
  for (let version = 7; version <= 24; version += 1) {
    const parsed = parseStoredState(
      JSON.stringify({ ...base, schemaVersion: version }),
    );
    assert.ok(parsed, `схема ${version} должна парситься`);
    assert.equal(parsed.schemaVersion, 24, `схема ${version} → 18`);
  }
  // Неизвестная будущая версия по-прежнему не принимается.
  assert.equal(
    parseStoredState(JSON.stringify({ ...base, schemaVersion: 25 })),
    null,
  );
});

// --- 3–8: миграция и нормализация водителя ------------------------------------

/** Разбор состояния с одним «сырым» водителем из хранилища. */
function parseDriver(raw: Record<string, unknown>): DriverProfile {
  const base = createDefaultState();
  const parsed = parseStoredState(
    JSON.stringify({ ...base, schemaVersion: 15, drivers: [raw] }),
  );
  assert.ok(parsed);
  assert.equal(parsed.drivers.length, 1, "сохранённые водители не заменяются");
  return parsed.drivers[0];
}

test("3: legacy BUSY мигрирует в BUSY_DIRECT", () => {
  assert.equal(parseDriver({ id: D1, status: "BUSY" }).status, "BUSY_DIRECT");
});

test("4: неизвестный статус fail-closed становится OFFLINE", () => {
  assert.equal(parseDriver({ id: D1, status: "ЧТО-ТО" }).status, "OFFLINE");
  assert.equal(parseDriver({ id: D1, status: 42 }).status, "OFFLINE");
  assert.equal(parseDriver({ id: D1 }).status, "OFFLINE");
  // Существующие значения сохраняются как есть.
  for (const status of [
    "OFFLINE",
    "AVAILABLE",
    "PAUSED",
    "BUSY_DIRECT",
    "ZONE_CONFIRMATION_REQUIRED",
  ] as const) {
    assert.equal(parseDriver({ id: D1, status }).status, status);
  }
});

test("5: у legacy-водителя без полей зон обе зоны равны null", () => {
  const driver = parseDriver({ id: D1, status: "AVAILABLE" });
  assert.equal(driver.currentZoneId, null);
  assert.equal(driver.suggestedZoneId, null);
});

test("6: существующие зоны сохраняются", () => {
  const driver = parseDriver({
    id: D1,
    status: "AVAILABLE",
    currentZoneId: "zone-3",
    suggestedZoneId: "zone-4",
  });
  assert.equal(driver.currentZoneId, "zone-3");
  assert.equal(driver.suggestedZoneId, "zone-4");
});

test("7: несуществующая зона нормализуется в null, а не в правдоподобную", () => {
  const driver = parseDriver({
    id: D1,
    status: "AVAILABLE",
    currentZoneId: "zone-99",
    suggestedZoneId: "",
  });
  assert.equal(driver.currentZoneId, null);
  assert.equal(driver.suggestedZoneId, null);
  assert.equal(parseDriver({ id: D1, currentZoneId: 7 }).currentZoneId, null);
});

test("8: cashEnabled сохраняется при миграции", () => {
  assert.equal(parseDriver({ id: D1, cashEnabled: true }).cashEnabled, true);
  assert.equal(parseDriver({ id: D2, cashEnabled: false }).cashEnabled, false);
  assert.equal(parseDriver({ id: D2 }).cashEnabled, false);
});

// --- 9–12: демо-водители -------------------------------------------------------

test("9: все seed-водители стартуют OFFLINE и без зон", () => {
  const state = createDefaultState();
  assert.equal(state.drivers.length, 3);
  for (const driver of state.drivers) {
    assert.equal(driver.status, "OFFLINE", driver.id);
    assert.equal(driver.currentZoneId, null, driver.id);
    assert.equal(driver.suggestedZoneId, null, driver.id);
  }
});

test("10: Пётр допущен к наличным заказам", () => {
  const peter = driverOf(createDefaultState(), D1);
  assert.equal(peter.name, "Водитель Пётр");
  assert.equal(peter.cashEnabled, true);
});

test("11: остальные водители к наличным не допущены", () => {
  const state = createDefaultState();
  assert.equal(driverOf(state, D2).cashEnabled, false);
  assert.equal(driverOf(state, D3).cashEnabled, false);
});

test("12: глобальная наличная оплата платформы выключена", () => {
  assert.equal(
    createDefaultState().platformSettings.platformDriverCashEnabled,
    false,
  );
});

// --- 13–19: действия водителя --------------------------------------------------

test("13: выход онлайн требует существующую зону", () => {
  const state = createDefaultState();
  const res = goDriverOnline(state, D1, "zone-99" as ZoneId);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Зона не найдена.");
  assert.equal(res.state, state, "состояние не пересобрано");
  assert.equal(statusOf(state, D1), "OFFLINE");
  // Compatibility-wrapper без сохранённой зоны тоже отказывает.
  const legacy = setDriverAvailability(state, D1, true);
  assert.equal(legacy.result.ok, false);
  assert.equal(legacy.result.error, "Сначала выберите текущую зону.");
});

test("14: OFFLINE → AVAILABLE с указанной зоной", () => {
  const state = createDefaultState();
  const res = goDriverOnline(state, D1, Z2);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const driver = driverOf(res.state, D1);
  assert.equal(driver.status, "AVAILABLE");
  assert.equal(driver.currentZoneId, Z2);
  assert.equal(driver.suggestedZoneId, null);
  assert.equal(res.state.revision, state.revision + 1);
});

test("15: повторный выход онлайн с той же зоной — no-op без роста ревизии", () => {
  const state = online(createDefaultState(), D1, Z1);
  const res = goDriverOnline(state, D1, Z1);
  assert.equal(res.result.ok, true);
  assert.equal(res.state, state, "тот же объект состояния");
  assert.equal(res.state.revision, state.revision);
});

test("16: AVAILABLE → PAUSED с сохранением зоны", () => {
  const state = online(createDefaultState(), D1, Z2);
  const res = pauseDriver(state, D1);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const driver = driverOf(res.state, D1);
  assert.equal(driver.status, "PAUSED");
  assert.equal(driver.currentZoneId, Z2, "зона сохранена");
  // Повторная пауза — успешный no-op.
  const again = pauseDriver(res.state, D1);
  assert.equal(again.result.ok, true);
  assert.equal(again.state, res.state);
});

test("17: причина паузы не принимается и нигде не хранится", () => {
  // Сигнатура ровно из двух аргументов: причину передать некуда.
  assert.equal(pauseDriver.length, 2);
  const state = pauseDriver(online(createDefaultState(), D1), D1).state;
  const driver = driverOf(state, D1) as Record<string, unknown>;
  for (const field of ["pauseReason", "reason", "pausedReason"]) {
    assert.equal(field in driver, false, `поле ${field} появляться не должно`);
  }
  assert.ok(!JSON.stringify(state.drivers).includes("Reason"));
  // В интерфейсе причина тоже не спрашивается.
  assert.ok(!DRIVER_PAGE.includes("Причина паузы"));
  assert.ok(!DRIVER_PAGE.includes("pauseReason"));
});

test("18: PAUSED → AVAILABLE, без зоны возобновление запрещено", () => {
  const paused = pauseDriver(online(createDefaultState(), D1, Z2), D1).state;
  const res = resumeDriver(paused, D1);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, D1), "AVAILABLE");
  assert.equal(driverOf(res.state, D1).currentZoneId, Z2);

  // Повреждённое состояние: PAUSED без зоны — возобновление fail-closed.
  const zoneless = stateWith([], { [D1]: { status: "PAUSED", currentZoneId: null } });
  const failed = resumeDriver(zoneless, D1);
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.error, "Сначала выберите текущую зону.");
  assert.equal(failed.state, zoneless);
});

test("19: уход офлайн очищает обе зоны", () => {
  const state = online(createDefaultState(), D1, Z2);
  const res = goDriverOffline(state, D1);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const driver = driverOf(res.state, D1);
  assert.equal(driver.status, "OFFLINE");
  assert.equal(driver.currentZoneId, null);
  assert.equal(driver.suggestedZoneId, null);
  // Уже офлайн и без зон — no-op.
  const again = goDriverOffline(res.state, D1);
  assert.equal(again.result.ok, true);
  assert.equal(again.state, res.state);
});

// --- 20–23: запреты переходов ---------------------------------------------------

test("20: BUSY_DIRECT нельзя поставить на паузу", () => {
  const state = stateWith(
    [order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" })],
    { [D1]: { status: "BUSY_DIRECT", currentZoneId: Z1 } },
  );
  const res = pauseDriver(state, D1);
  assert.equal(res.result.ok, false);
  assert.equal(res.state, state);
  assert.equal(statusOf(res.state, D1), "BUSY_DIRECT");
});

test("21: BUSY_DIRECT нельзя вывести офлайн", () => {
  const state = stateWith(
    [order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" })],
    { [D1]: { status: "BUSY_DIRECT", currentZoneId: Z1 } },
  );
  const res = goDriverOffline(state, D1);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Нельзя уйти офлайн во время активной доставки.");
  assert.equal(res.state, state);
  // Compatibility-wrapper ведёт себя так же — второй логики нет.
  assert.equal(setDriverAvailability(state, D1, false).result.ok, false);
});

test("22: зону можно менять только в AVAILABLE и PAUSED", () => {
  const available = online(createDefaultState(), D1, Z1);
  const changed = changeDriverZone(available, D1, Z2);
  assert.equal(changed.result.ok, true, changed.result.error ?? "");
  assert.equal(driverOf(changed.state, D1).currentZoneId, Z2);

  const paused = pauseDriver(available, D1).state;
  const changedPaused = changeDriverZone(paused, D1, Z2);
  assert.equal(changedPaused.result.ok, true, changedPaused.result.error ?? "");
  assert.equal(driverOf(changedPaused.state, D1).currentZoneId, Z2);
  assert.equal(statusOf(changedPaused.state, D1), "PAUSED", "статус не меняется");

  // OFFLINE: зона выбирается только выходом онлайн.
  const offline = createDefaultState();
  assert.equal(changeDriverZone(offline, D1, Z2).result.ok, false);
  assert.equal(driverOf(offline, D1).currentZoneId, null);

  // BUSY_DIRECT и ZONE_CONFIRMATION_REQUIRED зону так менять не могут.
  for (const status of ["BUSY_DIRECT", "ZONE_CONFIRMATION_REQUIRED"] as const) {
    const s = stateWith([], { [D1]: { status, currentZoneId: Z1 } });
    assert.equal(changeDriverZone(s, D1, Z2).result.ok, false, status);
  }
});

test("23: подтверждение зоны доступно только из ZONE_CONFIRMATION_REQUIRED", () => {
  const state = stateWith([], {
    [D1]: { status: "ZONE_CONFIRMATION_REQUIRED", suggestedZoneId: Z2 },
  });
  const res = confirmDriverZone(state, D1, Z2, "AVAILABLE");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const driver = driverOf(res.state, D1);
  assert.equal(driver.status, "AVAILABLE");
  assert.equal(driver.currentZoneId, Z2);
  assert.equal(driver.suggestedZoneId, null, "предложение снято");

  // Второй вариант — подтвердить зону и остаться на паузе.
  const paused = confirmDriverZone(state, D1, Z1, "PAUSED");
  assert.equal(paused.result.ok, true);
  assert.equal(statusOf(paused.state, D1), "PAUSED");
  assert.equal(driverOf(paused.state, D1).currentZoneId, Z1);

  // Из остальных статусов подтверждение не требуется и не проходит.
  for (const status of ["OFFLINE", "AVAILABLE", "PAUSED", "BUSY_DIRECT"] as const) {
    const s = stateWith([], { [D1]: { status, currentZoneId: Z1 } });
    assert.equal(confirmDriverZone(s, D1, Z2, "AVAILABLE").result.ok, false, status);
  }
});

// --- 24–26: назначение ----------------------------------------------------------

test("24: назначение переводит AVAILABLE → BUSY_DIRECT", () => {
  const state = online(stateWith([order("A")]), D1, Z1);
  const res = assignDriverToOrder(state, "A", D1);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, D1), "BUSY_DIRECT");
  assert.equal(
    res.state.orders.find((o) => o.id === "A")?.assignedDriverId,
    D1,
  );
});

test("25: PAUSED-водитель не назначается", () => {
  const available = online(stateWith([order("A")]), D1, Z1);
  const paused = pauseDriver(available, D1).state;
  const res = assignDriverToOrder(paused, "A", D1);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Водитель недоступен.");
  assert.equal(res.state, paused);
  // OFFLINE и ZONE_CONFIRMATION_REQUIRED тоже не назначаются.
  for (const status of ["OFFLINE", "ZONE_CONFIRMATION_REQUIRED", "BUSY_DIRECT"] as const) {
    const s = stateWith([order("A")], { [D1]: { status, currentZoneId: Z1 } });
    assert.equal(assignDriverToOrder(s, "A", D1).result.ok, false, status);
  }
});

test("25a: список свободных водителей совпадает с условиями назначения", () => {
  // Пустой список на свежем состоянии — не поломка: все стартуют не в сети.
  assert.deepEqual(getAvailableDrivers(createDefaultState()), []);

  const state = online(createDefaultState(), D1, Z1);
  assert.deepEqual(
    getAvailableDrivers(state).map((d) => d.id),
    [D1],
  );

  // AVAILABLE без подтверждённой зоны свободным не считается: иначе админу
  // предлагали бы водителя, которого домен откажется назначить.
  const zoneless = stateWith([], {
    [D1]: { status: "AVAILABLE", currentZoneId: null },
  });
  assert.deepEqual(getAvailableDrivers(zoneless), []);
  assert.equal(
    assignDriverToOrder(
      { ...zoneless, orders: [order("A")] },
      "A",
      D1,
    ).result.ok,
    false,
  );

  // Пауза и занятость свободными тоже не считаются.
  assert.deepEqual(getAvailableDrivers(pauseDriver(state, D1).state), []);
});

test("26: водитель без подтверждённой зоны не назначается", () => {
  // Повреждённое состояние: AVAILABLE, но зона не подтверждена.
  const state = stateWith([order("A")], {
    [D1]: { status: "AVAILABLE", currentZoneId: null },
  });
  const res = assignDriverToOrder(state, "A", D1);
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "У водителя не подтверждена текущая зона.");
  assert.equal(res.state, state);
});

// --- 27–30: освобождение --------------------------------------------------------

test("27: после доставки водитель обязан подтвердить зону", () => {
  const state = stateWith(
    [order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" })],
    { [D1]: { status: "BUSY_DIRECT", currentZoneId: Z1 } },
  );
  const res = markOrderDeliveredByDriverWithResult(state, "A");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, D1), "ZONE_CONFIRMATION_REQUIRED");
  // Предложений он не получает, пока зона не подтверждена.
  assert.equal(getDriverActiveOrder(res.state, D1), null);
});

test("28: после доставки предлагается зона клиента", () => {
  const state = stateWith(
    [
      order("A", {
        assignedDriverId: D1,
        status: "OUT_FOR_DELIVERY",
        financials: {
          currencyCode: "USD",
          restaurantCollectedFromCustomerCents: 0,
          platformCollectedFromCustomerCents: 0,
          platformCommissionReceivableCents: 0,
          restaurantNetAfterPlatformCommissionCents: 0,
          customerZoneId: "zone-4",
          moneyMovementStatus: "REVIEW_REQUIRED",
        },
      } as Partial<Order>),
    ],
    { [D1]: { status: "BUSY_DIRECT", currentZoneId: Z1 } },
  );
  const res = markOrderDeliveredByDriverWithResult(state, "A");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const driver = driverOf(res.state, D1);
  assert.equal(driver.suggestedZoneId, "zone-4", "предложена зона клиента");
  // Предложение не подменяет подтверждение: текущая зона прежняя.
  assert.equal(driver.currentZoneId, Z1);
});

test("29: после снятия назначения требуется подтверждение зоны без предложения", () => {
  const state = stateWith(
    [order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" })],
    { [D1]: { status: "BUSY_DIRECT", currentZoneId: Z1 } },
  );
  const res = unassignDriverFromOrder(state, "A", "водитель заболел");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const driver = driverOf(res.state, D1);
  assert.equal(driver.status, "ZONE_CONFIRMATION_REQUIRED");
  assert.equal(driver.suggestedZoneId, null, "заказ не доставлен — зону не предлагаем");
});

test("30: при переназначении старый подтверждает зону, новый занят", () => {
  const base = stateWith(
    [order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" })],
    { [D1]: { status: "BUSY_DIRECT", currentZoneId: Z1 } },
  );
  const state = online(base, D2, Z2);
  const res = reassignDriverForOrder(state, "A", D2, "ближе к адресу");
  assert.equal(res.result.ok, true, res.result.error ?? "");
  assert.equal(statusOf(res.state, D1), "ZONE_CONFIRMATION_REQUIRED");
  assert.equal(driverOf(res.state, D1).suggestedZoneId, null);
  assert.equal(statusOf(res.state, D2), "BUSY_DIRECT");
});

// --- 31–36: интерфейс ------------------------------------------------------------

test("31: все пять статусов имеют русские подписи", () => {
  const statuses: DriverStatus[] = [
    "OFFLINE",
    "AVAILABLE",
    "PAUSED",
    "BUSY_DIRECT",
    "ZONE_CONFIRMATION_REQUIRED",
  ];
  assert.equal(Object.keys(driverStatusLabels).length, statuses.length);
  for (const status of statuses) {
    const label = driverStatusLabels[status];
    assert.ok(label, status);
    assert.ok(/[А-Яа-яЁё]/.test(label), `${status} должен быть по-русски`);
  }
  assert.equal(driverStatusLabels.OFFLINE, "Не в сети");
  assert.equal(driverStatusLabels.AVAILABLE, "Онлайн · ожидает заказы");
  assert.equal(driverStatusLabels.PAUSED, "Пауза");
  assert.equal(driverStatusLabels.BUSY_DIRECT, "Выполняет заказ Direct");
  assert.equal(
    driverStatusLabels.ZONE_CONFIRMATION_REQUIRED,
    "Подтвердите текущую зону",
  );
});

test("32: старый экран «Рабочая смена» удалён", () => {
  for (const phrase of [
    "Рабочая смена",
    "На смене",
    "Не на смене",
    "Включите статус онлайн",
  ]) {
    assert.ok(!DRIVER_PAGE.includes(phrase), `«${phrase}» больше не показывается`);
  }
});

test("33: главная водителя — единый экран без выбора профиля", () => {
  assert.ok(!DRIVER_PAGE.includes("RouteCards"));
  assert.ok(!DRIVER_PAGE.includes("PageHeading"));
  assert.ok(DRIVER_PAGE.includes("Заказы"));
  assert.ok(DRIVER_PAGE.includes("DriverWorkspace"));
  // v18 session UI: вход по имени/телефону, без списка и выбора водителей.
  assert.ok(DRIVER_WORKSPACE.includes("Вход водителя"));
  assert.ok(DRIVER_WORKSPACE.includes("Выйти онлайн"));
  assert.ok(!DRIVER_WORKSPACE.includes("Выберите водителя"));
  assert.ok(!DRIVER_WORKSPACE.includes("Сменить водителя"));
  assert.ok(!DRIVER_WORKSPACE.includes("useSelectedDriverId"));
  assert.ok(DRIVER_WORKSPACE.includes("useAuthenticatedDriverId"));
});

test("34: раздел «Расчёты» водителя существует отдельным маршрутом", () => {
  assert.ok(DRIVER_SETTLEMENTS_PAGE.includes("Расчёты"));
  // v23: заглушка заменена реальным журналом наличных расчётов.
  assert.ok(
    DRIVER_SETTLEMENTS_PAGE.includes(
      "Заработок с наличных доставок и сумма, которую нужно передать Direct.",
    ),
  );
  // Маршрут доступен из верхней навигации, а не карточкой на главной.
  assert.ok(DRIVER_HEADER.includes('href: "/driver/settlements"'));
  assert.ok(DRIVER_HEADER.includes('label: "Расчёты"'));
  assert.ok(!DRIVER_PAGE.includes("/driver/settlements"));
});

test("35: страница расчётов не выдумывает суммы (только ledger + formatMoney)", () => {
  // v23: суммы берутся из driver cash ledger и форматируются общим formatMoney;
  // литеральных сумм в разметке нет.
  assert.ok(!/\$\s?\d/.test(DRIVER_SETTLEMENTS_PAGE));
  assert.ok(!/\d+[.,]\d{2}/.test(DRIVER_SETTLEMENTS_PAGE));
  assert.ok(DRIVER_SETTLEMENTS_PAGE.includes("getDriverCashLedgerView"));
  assert.ok(DRIVER_SETTLEMENTS_PAGE.includes("formatMoney"));
  // Никакого netting и обещаний выплат.
  for (const forbidden of [
    "Доступно к выплате",
    "Чистый баланс",
    "Direct должен вам",
    "Погасить задолженность",
    "Оплатить сейчас",
  ]) {
    assert.ok(!DRIVER_SETTLEMENTS_PAGE.includes(forbidden), forbidden);
  }
});

test("36: интерфейс водителя не показывает английские статусы и наличные строки", () => {
  // Сырые enum-значения и английские подписи в видимый текст не попадают.
  const visibleText =
    DRIVER_WORKSPACE.match(/>[^<>{}]*[A-Za-zА-Яа-яЁё][^<>{}]*</g) ?? [];
  for (const chunk of visibleText) {
    assert.ok(
      !/(AVAILABLE|OFFLINE|PAUSED|BUSY_DIRECT|ZONE_CONFIRMATION_REQUIRED)/.test(
        chunk,
      ),
      `сырой статус в видимом тексте: ${chunk}`,
    );
  }
  for (const phrase of ["Cash enabled", "Рабочая смена", "На смене"]) {
    assert.ok(
      !DRIVER_WORKSPACE.includes(phrase),
      `в UI не должно быть «${phrase}»`,
    );
  }
  // v18: строка допуска к наличным убрана из основного рабочего интерфейса.
  assert.ok(!DRIVER_WORKSPACE.includes("Наличные заказы разрешены"));
  assert.ok(!DRIVER_WORKSPACE.includes("Наличные заказы недоступны"));
  assert.ok(!DRIVER_WORKSPACE.includes("platformDriverCashEnabled"));
});

// --- 37: соседние подсистемы не тронуты --------------------------------------------

test("37: ресторанные расчёты и финансовые модули не затронуты", () => {
  const balanceBreakdown = readFileSync(
    "src/prototype/restaurant-balance-breakdown.ts",
    "utf8",
  );
  const financeReadModel = readFileSync(
    "src/prototype/restaurant-finance-read-model.ts",
    "utf8",
  );
  const bankFee = readFileSync("src/prototype/bank-fee.ts", "utf8");
  for (const source of [balanceBreakdown, financeReadModel, bankFee]) {
    assert.ok(!source.includes("DriverStatus"));
    assert.ok(!source.includes("currentZoneId"));
    assert.ok(!source.includes("suggestedZoneId"));
  }
  // Завершение заказа по-прежнему признаёт обязательства ресторана.
  const state = stateWith(
    [order("A", { assignedDriverId: D1, status: "OUT_FOR_DELIVERY" })],
    { [D1]: { status: "BUSY_DIRECT", currentZoneId: Z1 } },
  );
  const before = state.restaurantAccountingEntries.length;
  const res = markOrderDeliveredByDriverWithResult(state, "A");
  assert.equal(res.result.ok, true);
  // REVIEW_REQUIRED-снимок обязательств не создаёт — и это не регрессия.
  assert.equal(res.state.restaurantAccountingEntries.length, before);
  assert.equal(res.state.settlements, state.settlements);
});

// --- Дополнительно: единственный источник активного заказа ---------------------

test("38: активный заказ читается только из order.assignedDriverId", () => {
  const state = stateWith(
    [order("A", { assignedDriverId: D1, status: "ARRIVING" })],
    { [D1]: { status: "BUSY_DIRECT", currentZoneId: Z1 } },
  );
  assert.equal(getDriverActiveOrder(state, D1)?.id, "A");
  // Отдельного поля активного заказа у водителя нет.
  const driver = driverOf(state, D1) as Record<string, unknown>;
  assert.equal("activeOrderId" in driver, false);
  assert.deepEqual(Object.keys(driver).sort(), [
    "cashEnabled",
    "currentZoneId",
    "id",
    "name",
    "phone",
    "status",
    "suggestedZoneId",
  ]);
});

test("39: терминальный статус заказа активным не считается", () => {
  for (const status of ["DELIVERED", "CANCELED"] as OrderStatus[]) {
    const state = stateWith([order("A", { assignedDriverId: D1, status })]);
    assert.equal(getDriverActiveOrder(state, D1), null, status);
  }
});
