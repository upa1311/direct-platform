import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  acceptRestaurantOrder,
  addCartItem,
  adminCancelOrder,
  assignDriverToOrder,
  changeDriverZone,
  createOrderFromCart,
  goDriverOnline,
  markOrderReady,
  pauseDriver,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import { parseStoredState } from "./prototype-store.ts";
import {
  CASH_RESERVE_CONFIRMATION_REQUIRED_ERROR,
  DRIVER_OFFER_DURATION_MS,
  acceptDriverOffer,
  declineDriverOffer,
  driverOfferId,
  getEligibleDriversForOrder,
  isOrderEligibleForDriverOffers,
  reconcileDriverOffers,
} from "./driver-offers.ts";
import { getPlatformDriverCashSnapshot } from "./selectors.ts";
import {
  DRIVER_OFFER_SOUND_KEY,
  isDriverOfferBeepDue,
  shouldDriverOfferSoundPlay,
} from "../components/driver/driver-offer-sound-logic.ts";
import { KITCHEN_SOUND_KEY } from "../components/workspaces/kitchen-sound.ts";
import type {
  DriverOffer,
  Order,
  PrototypeState,
  ZoneId,
} from "./models.ts";

/**
 * Предложения заказов водителям по зоне (v17). Домен чистый: момент времени —
 * всегда аргумент, зона сравнивается со снимком заказа, наличные не участвуют.
 */

const D1 = "driver-1";
const D2 = "driver-2";
// Ресторан-2 — PLATFORM_DRIVER в зоне zone-2; свободные водители должны быть в
// зоне ресторана, а не клиента.
const REST_ZONE: ZoneId = "zone-2";

const BASE_MS = Date.parse("2026-07-22T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** Принятие онлайн-предложения: наличное подтверждение не требуется (false). */
const acceptOnline = (
  state: PrototypeState,
  driverId: string,
  offerId: string,
  nowIso: string,
) =>
  acceptDriverOffer(state, driverId, offerId, nowIso, {
    cashReserveConfirmed: false,
  });

const DRIVER_PAGE = readFileSync("src/app/driver/page.tsx", "utf8");
const OFFERS_PAGE = readFileSync("src/app/driver/offers/page.tsx", "utf8");
// v18 session UI: предложения теперь на едином экране; карточка вынесена.
const OFFER_CARD = readFileSync(
  "src/components/driver/driver-offer-card.tsx",
  "utf8",
);
const WORKSPACE = readFileSync(
  "src/components/driver/driver-workspace.tsx",
  "utf8",
);

/** READY, ONLINE, PAID заказ ресторана-2 (пригодный для предложений). */
function eligibleState(base: PrototypeState = createDefaultState()): {
  state: PrototypeState;
  orderId: string;
} {
  let s = updateCartAddress(base, { street: "Тестовая улица 1", house: "1" });
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(s);
  const orderId = created.result.orderId as string;
  s = acceptRestaurantOrder(created.state, orderId, 20);
  s = simulateSuccessfulOnlinePayment(s, orderId);
  s = markOrderReady(s, orderId);
  return { state: s, orderId };
}

function online(
  state: PrototypeState,
  driverId: string,
  zoneId: ZoneId = REST_ZONE,
): PrototypeState {
  const res = goDriverOnline(state, driverId, zoneId);
  assert.equal(res.result.ok, true, res.result.error ?? "");
  return res.state;
}

function orderOf(state: PrototypeState, orderId: string): Order {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
}

/** Минимальный Order для точечной проверки eligibility. */
function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-x",
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
    status: "PREPARING",
    assignedDriverId: null,
    address: {
      street: "Тестовая улица 1",
      house: "1",
      apartment: "",
      entrance: "",
      floor: "",
      comment: "",
      zoneId: "zone-1",
    },
    restaurant: { id: "restaurant-2", name: "Ресторан 2", address: "адрес", zoneId: REST_ZONE },
    financials: { customerZoneId: "zone-1", driverPayoutCents: 300 },
    ...overrides,
  } as unknown as Order;
}

const reconcileAt = (state: PrototypeState, ms: number) =>
  reconcileDriverOffers(state, iso(ms));

const offerFor = (state: PrototypeState, orderId: string, driverId: string) =>
  state.driverOffers.find(
    (o) => o.orderId === orderId && o.driverId === driverId,
  );

// --- 1–9: schema и нормализация ------------------------------------------------

test("1: схема прототипа равна 18", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 22);
});

test("2: нормализатор принимает схемы 7–18", () => {
  const base = createDefaultState();
  for (let version = 7; version <= 22; version += 1) {
    const parsed = parseStoredState(
      JSON.stringify({ ...base, schemaVersion: version }),
    );
    assert.ok(parsed, `схема ${version}`);
    assert.equal(parsed.schemaVersion, 22);
  }
  assert.equal(
    parseStoredState(JSON.stringify({ ...base, schemaVersion: 23 })),
    null,
  );
});

test("3: состояние до v17 получает пустой driverOffers", () => {
  const base = createDefaultState();
  const legacy = JSON.parse(JSON.stringify({ ...base, schemaVersion: 16 }));
  delete legacy.driverOffers;
  const parsed = parseStoredState(JSON.stringify(legacy));
  assert.ok(parsed);
  assert.deepEqual(parsed.driverOffers, []);
});

/** Разбор состояния с одним «сырым» предложением. */
function parseWithOffer(raw: Record<string, unknown>): DriverOffer[] {
  const { state, orderId } = eligibleState();
  const withOffer = {
    ...state,
    driverOffers: [{ orderId, driverId: D1, ...raw }],
  };
  const parsed = parseStoredState(JSON.stringify(withOffer));
  assert.ok(parsed);
  return parsed.driverOffers;
}

test("4: валидное предложение сохраняется", () => {
  const offers = parseWithOffer({
    id: "offer-1",
    status: "OPEN",
    offeredAt: iso(BASE_MS),
    expiresAt: iso(BASE_MS + DRIVER_OFFER_DURATION_MS),
    resolvedAt: null,
  });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].status, "OPEN");
});

test("5: неизвестный статус удаляется", () => {
  assert.equal(
    parseWithOffer({
      id: "offer-1",
      status: "ЧТО-ТО",
      offeredAt: iso(BASE_MS),
      expiresAt: iso(BASE_MS + 30_000),
      resolvedAt: null,
    }).length,
    0,
  );
});

test("6: некорректные ISO и окно удаляются", () => {
  assert.equal(
    parseWithOffer({
      id: "o",
      status: "OPEN",
      offeredAt: "не-дата",
      expiresAt: iso(BASE_MS + 30_000),
      resolvedAt: null,
    }).length,
    0,
  );
  // expiresAt <= offeredAt — тоже удаляется.
  assert.equal(
    parseWithOffer({
      id: "o",
      status: "OPEN",
      offeredAt: iso(BASE_MS + 30_000),
      expiresAt: iso(BASE_MS),
      resolvedAt: null,
    }).length,
    0,
  );
});

test("7: предложение отсутствующего заказа удаляется", () => {
  const { state } = eligibleState();
  const parsed = parseStoredState(
    JSON.stringify({
      ...state,
      driverOffers: [
        {
          id: "o",
          orderId: "order-нет",
          driverId: D1,
          status: "OPEN",
          offeredAt: iso(BASE_MS),
          expiresAt: iso(BASE_MS + 30_000),
          resolvedAt: null,
        },
      ],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.driverOffers.length, 0);
});

test("8: предложение отсутствующего водителя удаляется", () => {
  const { state, orderId } = eligibleState();
  const parsed = parseStoredState(
    JSON.stringify({
      ...state,
      driverOffers: [
        {
          id: "o",
          orderId,
          driverId: "driver-нет",
          status: "OPEN",
          offeredAt: iso(BASE_MS),
          expiresAt: iso(BASE_MS + 30_000),
          resolvedAt: null,
        },
      ],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.driverOffers.length, 0);
});

test("9: повторная нормализация идемпотентна", () => {
  const offers = parseWithOffer({
    id: "offer-1",
    status: "OPEN",
    offeredAt: iso(BASE_MS),
    expiresAt: iso(BASE_MS + 30_000),
    resolvedAt: null,
  });
  const { state, orderId } = eligibleState();
  const once = { ...state, driverOffers: offers };
  const twice = parseStoredState(JSON.stringify(once));
  assert.ok(twice);
  assert.deepEqual(twice.driverOffers, offers);
  assert.equal(twice.driverOffers[0].orderId, orderId);
});

// --- 10–21: eligibility заказа -------------------------------------------------

test("10: подходит PLATFORM_DRIVER + ONLINE + PAID + PREPARING", () => {
  assert.equal(isOrderEligibleForDriverOffers(createDefaultState(), order({ status: "PREPARING" })), true);
});

test("11: подходит READY", () => {
  assert.equal(isOrderEligibleForDriverOffers(createDefaultState(), order({ status: "READY" })), true);
});

test("12: не подходит PICKUP", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(), order({ deliveryMode: "PICKUP" })),
    false,
  );
});

test("13: не подходит RESTAURANT_DELIVERY", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(), order({ deliveryMode: "RESTAURANT_DELIVERY" })),
    false,
  );
});

test("14: не подходит неоплаченный заказ", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(), order({ paymentStatus: "AWAITING_PAYMENT" })),
    false,
  );
});

test("15: не подходит неготовый lifecycle", () => {
  for (const status of ["RESTAURANT_REVIEW", "AWAITING_PAYMENT"] as const) {
    assert.equal(isOrderEligibleForDriverOffers(createDefaultState(), order({ status })), false, status);
  }
});

test("16: не подходит назначенный заказ", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(), order({ assignedDriverId: D1 })),
    false,
  );
});

test("17: не подходит терминальный заказ", () => {
  for (const status of ["DELIVERED", "CANCELED"] as const) {
    assert.equal(isOrderEligibleForDriverOffers(createDefaultState(), order({ status })), false, status);
  }
});

test("18: не подходит CASH-заказ", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(), order({ paymentMethod: "CASH" })),
    false,
  );
});

test("19: не подходит заказ без улицы", () => {
  const noStreet = order();
  (noStreet.address as { street: string }).street = "   ";
  assert.equal(isOrderEligibleForDriverOffers(createDefaultState(), noStreet), false);
  assert.equal(isOrderEligibleForDriverOffers(createDefaultState(), order({ address: null })), false);
});

test("20: не подходит заказ без зоны клиента", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(),
      order({ financials: { customerZoneId: null, driverPayoutCents: 300 } as never }),
    ),
    false,
  );
});

test("21: не подходит заказ с нулевой/некорректной выплатой", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(),
      order({ financials: { customerZoneId: "zone-1", driverPayoutCents: 0 } as never }),
    ),
    false,
  );
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(),
      order({ financials: { customerZoneId: "zone-1", driverPayoutCents: -5 } as never }),
    ),
    false,
  );
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(),
      order({ financials: { customerZoneId: "zone-1", driverPayoutCents: 1.5 } as never }),
    ),
    false,
  );
});

// --- 22–29: eligibility водителя ----------------------------------------------

test("22: предложение получает только AVAILABLE", () => {
  const { state, orderId } = eligibleState();
  const s = online(state, D1);
  const eligible = getEligibleDriversForOrder(s, orderOf(s, orderId));
  assert.deepEqual(eligible.map((d) => d.id), [D1]);
});

test("23: требуется подтверждённая зона", () => {
  const { state, orderId } = eligibleState();
  // Повреждённое состояние: AVAILABLE, но без зоны.
  const s: PrototypeState = {
    ...state,
    drivers: state.drivers.map((d) =>
      d.id === D1 ? { ...d, status: "AVAILABLE", currentZoneId: null } : d,
    ),
  };
  assert.deepEqual(getEligibleDriversForOrder(s, orderOf(s, orderId)), []);
});

test("24: зона должна совпадать с зоной ресторана заказа", () => {
  const { state, orderId } = eligibleState();
  // Водитель в зоне клиента (zone-1), а не ресторана (zone-2) — не подходит.
  const s = online(state, D1, "zone-1");
  assert.deepEqual(getEligibleDriversForOrder(s, orderOf(s, orderId)), []);
});

test("25–28: PAUSED/OFFLINE/BUSY_DIRECT/ZONE_CONFIRMATION_REQUIRED не подходят", () => {
  const { state, orderId } = eligibleState();
  for (const status of [
    "PAUSED",
    "OFFLINE",
    "BUSY_DIRECT",
    "ZONE_CONFIRMATION_REQUIRED",
  ] as const) {
    const s: PrototypeState = {
      ...state,
      drivers: state.drivers.map((d) =>
        d.id === D1 ? { ...d, status, currentZoneId: REST_ZONE } : d,
      ),
    };
    assert.deepEqual(
      getEligibleDriversForOrder(s, orderOf(s, orderId)),
      [],
      status,
    );
  }
});

test("29: водитель с активным заказом не подходит", () => {
  const { state, orderId } = eligibleState();
  let s = online(state, D1);
  // Дадим D1 другой активный назначенный заказ.
  s = {
    ...s,
    orders: [
      ...s.orders,
      order({ id: "other", assignedDriverId: D1, status: "OUT_FOR_DELIVERY" }),
    ],
  };
  assert.deepEqual(getEligibleDriversForOrder(s, orderOf(s, orderId)), []);
});

// --- 30–37: одновременная отправка --------------------------------------------

test("30–33: все водители зоны получают одинаковые offeredAt/expiresAt (+30с)", () => {
  const { state, orderId } = eligibleState();
  let s = online(state, D1);
  s = online(s, D2);
  const res = reconcileAt(s, BASE_MS);
  assert.equal(res.result.ok, true);
  assert.equal(res.result.createdCount, 2);
  const o1 = offerFor(res.state, orderId, D1)!;
  const o2 = offerFor(res.state, orderId, D2)!;
  assert.ok(o1 && o2);
  assert.equal(o1.offeredAt, o2.offeredAt);
  assert.equal(o1.expiresAt, o2.expiresAt);
  assert.equal(
    Date.parse(o1.expiresAt) - Date.parse(o1.offeredAt),
    DRIVER_OFFER_DURATION_MS,
  );
  assert.equal(DRIVER_OFFER_DURATION_MS, 30_000);
});

test("34: водитель другой зоны предложение не получает", () => {
  const { state, orderId } = eligibleState();
  let s = online(state, D1); // zone-2 — совпадает с рестораном
  s = online(s, D2, "zone-1"); // другая зона
  const res = reconcileAt(s, BASE_MS);
  assert.equal(res.result.createdCount, 1);
  assert.ok(offerFor(res.state, orderId, D1));
  assert.equal(offerFor(res.state, orderId, D2), undefined);
});

test("35: повторный reconcile не создаёт дубликаты и не меняет revision", () => {
  const { state } = eligibleState();
  const s = online(state, D1);
  const first = reconcileAt(s, BASE_MS);
  assert.equal(first.result.createdCount, 1);
  const second = reconcileAt(first.state, BASE_MS);
  assert.equal(second.result.createdCount, 0);
  assert.equal(second.state, first.state, "тот же объект state");
  assert.equal(second.state.revision, first.state.revision);
});

test("36: после DECLINED тот же заказ повторно не предлагается", () => {
  const { state, orderId } = eligibleState();
  const s = online(state, D1);
  const created = reconcileAt(s, BASE_MS);
  const offerId = driverOfferId(orderId, D1);
  const declined = declineDriverOffer(created.state, D1, offerId, iso(BASE_MS + 1_000));
  assert.equal(declined.result.ok, true);
  const again = reconcileAt(declined.state, BASE_MS + 2_000);
  assert.equal(again.result.createdCount, 0);
});

test("37: после EXPIRED тот же заказ повторно не предлагается", () => {
  const { state, orderId } = eligibleState();
  const s = online(state, D1);
  const created = reconcileAt(s, BASE_MS);
  assert.equal(created.result.createdCount, 1);
  const expired = reconcileAt(created.state, BASE_MS + DRIVER_OFFER_DURATION_MS);
  assert.equal(expired.result.expiredCount, 1);
  const again = reconcileAt(expired.state, BASE_MS + DRIVER_OFFER_DURATION_MS + 1_000);
  assert.equal(again.result.createdCount, 0);
  assert.equal(offerFor(again.state, orderId, D1)!.status, "EXPIRED");
});

// --- 38–44: истечение и отмена ------------------------------------------------

test("38: на 29.999с предложение ещё OPEN", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const res = reconcileAt(created.state, BASE_MS + 29_999);
  assert.equal(res.result.expiredCount, 0);
  assert.equal(offerFor(res.state, orderId, D1)!.status, "OPEN");
});

test("39: на 30-й секунде предложение становится EXPIRED", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const res = reconcileAt(created.state, BASE_MS + 30_000);
  assert.equal(res.result.expiredCount, 1);
  const offer = offerFor(res.state, orderId, D1)!;
  assert.equal(offer.status, "EXPIRED");
  assert.equal(offer.resolvedAt, iso(BASE_MS + 30_000));
});

test("40: PAUSED отменяет открытое предложение", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const paused = pauseDriver(created.state, D1);
  const res = reconcileAt(paused.state, BASE_MS + 1_000);
  assert.equal(res.result.canceledCount, 1);
  assert.equal(offerFor(res.state, orderId, D1)!.status, "CANCELED");
});

test("41: смена зоны отменяет открытое предложение", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const moved = changeDriverZone(created.state, D1, "zone-1");
  const res = reconcileAt(moved.state, BASE_MS + 1_000);
  assert.equal(res.result.canceledCount, 1);
  assert.equal(offerFor(res.state, orderId, D1)!.status, "CANCELED");
});

test("42: ручное назначение отменяет остальные предложения", () => {
  const { state, orderId } = eligibleState();
  let s = online(state, D1);
  s = online(s, D2);
  const created = reconcileAt(s, BASE_MS);
  assert.equal(created.result.createdCount, 2);
  const assigned = assignDriverToOrder(created.state, orderId, D1);
  assert.equal(assigned.result.ok, true, assigned.result.error ?? "");
  const res = reconcileAt(assigned.state, BASE_MS + 1_000);
  assert.equal(res.result.canceledCount, 2);
  assert.equal(offerFor(res.state, orderId, D1)!.status, "CANCELED");
  assert.equal(offerFor(res.state, orderId, D2)!.status, "CANCELED");
});

test("43: отмена заказа отменяет предложения", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const canceled = adminCancelOrder(created.state, orderId, "тест");
  assert.equal(canceled.result.ok, true);
  const res = reconcileAt(canceled.state, BASE_MS + 1_000);
  assert.equal(res.result.canceledCount, 1);
  assert.equal(offerFor(res.state, orderId, D1)!.status, "CANCELED");
});

test("44: reconcile без изменений — no-op без revision", () => {
  const base = createDefaultState();
  const res = reconcileAt(base, BASE_MS);
  assert.equal(res.result.ok, true);
  assert.equal(res.result.createdCount, 0);
  assert.equal(res.state, base);
  assert.equal(res.state.revision, base.revision);
});

test("44a: некорректное время — ошибка без мутации", () => {
  const { state } = eligibleState();
  const s = online(state, D1);
  const res = reconcileDriverOffers(s, "не-дата");
  assert.equal(res.result.ok, false);
  assert.equal(res.state, s);
});

// --- 45–51: отказ -------------------------------------------------------------

test("45–48: отказ без причины оставляет водителя AVAILABLE, чужие OPEN не трогает", () => {
  const { state, orderId } = eligibleState();
  let s = online(state, D1);
  s = online(s, D2);
  const created = reconcileAt(s, BASE_MS);
  const res = declineDriverOffer(created.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(res.result.ok, true);
  assert.equal(res.result.orderId, orderId);
  // Причину функция аргументом не принимает (ровно 4 параметра).
  assert.equal(declineDriverOffer.length, 4);
  assert.equal(offerFor(res.state, orderId, D1)!.status, "DECLINED");
  assert.equal(res.state.drivers.find((d) => d.id === D1)!.status, "AVAILABLE");
  assert.equal(offerFor(res.state, orderId, D2)!.status, "OPEN");
});

test("49: нельзя отказаться от чужого предложения", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const res = declineDriverOffer(created.state, D2, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(res.result.ok, false);
  assert.equal(res.state, created.state);
});

test("50: нельзя отказаться после истечения", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const res = declineDriverOffer(
    created.state,
    D1,
    driverOfferId(orderId, D1),
    iso(BASE_MS + DRIVER_OFFER_DURATION_MS),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Предложение уже недоступно.");
});

test("51: ошибка отказа не меняет заказ и водителя", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const res = declineDriverOffer(created.state, D1, "нет-такого", iso(BASE_MS + 1_000));
  assert.equal(res.result.ok, false);
  assert.equal(res.state, created.state);
  assert.equal(orderOf(res.state, orderId).assignedDriverId, null);
});

// --- 52–66: принятие ----------------------------------------------------------

test("52–58: принятие назначает заказ, занимает водителя и закрывает прочие", () => {
  const { state, orderId } = eligibleState();
  let s = online(state, D1);
  s = online(s, D2);
  const created = reconcileAt(s, BASE_MS);
  const res = acceptOnline(created.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 5_000));
  assert.equal(res.result.ok, true, res.result.error ?? "");
  const o = orderOf(res.state, orderId);
  assert.equal(o.assignedDriverId, D1); // 53
  assert.equal(o.driverAssignedAt, iso(BASE_MS + 5_000)); // 54
  assert.equal(res.state.drivers.find((d) => d.id === D1)!.status, "BUSY_DIRECT"); // 55
  assert.equal(offerFor(res.state, orderId, D1)!.status, "ACCEPTED"); // 56
  assert.equal(offerFor(res.state, orderId, D2)!.status, "CANCELED"); // 57 (прочие заказа)
  // 58: прочие открытые предложения этого водителя тоже закрываются — проверим
  // на втором пригодном заказе в той же зоне.
  const two = eligibleState();
  let s2 = online(two.state, D1);
  // Второй заказ той же зоны для того же водителя.
  const secondOrder = eligibleState(s2);
  s2 = secondOrder.state;
  const created2 = reconcileAt(s2, BASE_MS);
  const openForD1 = created2.state.driverOffers.filter(
    (of) => of.driverId === D1 && of.status === "OPEN",
  );
  assert.ok(openForD1.length >= 2, "у водителя несколько открытых предложений");
  const acc = acceptOnline(created2.state, D1, openForD1[0].id, iso(BASE_MS + 3_000));
  assert.equal(acc.result.ok, true, acc.result.error ?? "");
  const stillOpen = acc.state.driverOffers.filter(
    (of) => of.driverId === D1 && of.status === "OPEN",
  );
  assert.equal(stillOpen.length, 0, "прочие предложения водителя закрыты");
});

test("59: другой водитель больше не может принять назначенный заказ", () => {
  const { state, orderId } = eligibleState();
  let s = online(state, D1);
  s = online(s, D2);
  const created = reconcileAt(s, BASE_MS);
  const first = acceptOnline(created.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(first.result.ok, true);
  const second = acceptOnline(first.state, D2, driverOfferId(orderId, D2), iso(BASE_MS + 2_000));
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Предложение уже недоступно.");
});

test("60: истёкшее предложение принять нельзя", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const res = acceptOnline(
    created.state,
    D1,
    driverOfferId(orderId, D1),
    iso(BASE_MS + DRIVER_OFFER_DURATION_MS),
  );
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Предложение уже недоступно.");
});

test("61: PAUSED-водитель принять не может", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const paused = pauseDriver(created.state, D1); // предложение ещё OPEN
  const res = acceptOnline(paused.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(res.result.ok, false);
  assert.equal(res.state, paused.state);
});

test("62: водитель другой зоны принять не может", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const moved = changeDriverZone(created.state, D1, "zone-1"); // offer ещё OPEN
  const res = acceptOnline(moved.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Предложение уже недоступно.");
});

test("63: водитель с другим активным заказом принять не может", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const withOther: PrototypeState = {
    ...created.state,
    orders: [
      ...created.state.orders,
      order({ id: "other", assignedDriverId: D1, status: "OUT_FOR_DELIVERY" }),
    ],
  };
  const res = acceptOnline(withOther, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "У вас уже есть активный заказ.");
});

test("64: уже назначенный заказ принять нельзя", () => {
  const { state, orderId } = eligibleState();
  let s = online(state, D1);
  s = online(s, D2);
  const created = reconcileAt(s, BASE_MS);
  const assigned = assignDriverToOrder(created.state, orderId, D2);
  assert.equal(assigned.result.ok, true, assigned.result.error ?? "");
  const res = acceptOnline(assigned.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Предложение уже недоступно.");
});

test("65: при ошибке принятия нет частичной мутации", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const res = acceptOnline(created.state, D1, "нет-такого", iso(BASE_MS + 1_000));
  assert.equal(res.result.ok, false);
  assert.equal(res.state, created.state, "тот же объект state");
  assert.equal(orderOf(res.state, orderId).assignedDriverId, null);
  assert.equal(res.state.drivers.find((d) => d.id === D1)!.status, "AVAILABLE");
});

test("66: первый serialized accept побеждает, второй получает ошибку", () => {
  const { state, orderId } = eligibleState();
  let s = online(state, D1);
  s = online(s, D2);
  const created = reconcileAt(s, BASE_MS);
  // Оба стартуют из одного состояния; сериализация означает, что второй
  // применяется к результату первого (перечитывает persisted state).
  const r1 = acceptOnline(created.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(r1.result.ok, true);
  const r2 = acceptOnline(r1.state, D2, driverOfferId(orderId, D2), iso(BASE_MS + 1_001));
  assert.equal(r2.result.ok, false);
  assert.equal(orderOf(r2.state, orderId).assignedDriverId, D1);
});

// --- 67–76: звук --------------------------------------------------------------

test("67: ключ звука водителя отличается от кухонного", () => {
  assert.equal(DRIVER_OFFER_SOUND_KEY, "direct-driver-offer-sound-enabled");
  assert.notEqual(DRIVER_OFFER_SOUND_KEY, KITCHEN_SOUND_KEY);
});

test("68: звук есть только у выбранного AVAILABLE с открытым предложением", () => {
  assert.equal(
    shouldDriverOfferSoundPlay({
      driverSelected: true,
      driverStatus: "AVAILABLE",
      openOfferCount: 1,
      soundEnabled: true,
    }),
    true,
  );
  // Нет выбранного водителя / нет предложений / звук выключен.
  assert.equal(
    shouldDriverOfferSoundPlay({
      driverSelected: false,
      driverStatus: "AVAILABLE",
      openOfferCount: 1,
      soundEnabled: true,
    }),
    false,
  );
  assert.equal(
    shouldDriverOfferSoundPlay({
      driverSelected: true,
      driverStatus: "AVAILABLE",
      openOfferCount: 0,
      soundEnabled: true,
    }),
    false,
  );
  assert.equal(
    shouldDriverOfferSoundPlay({
      driverSelected: true,
      driverStatus: "AVAILABLE",
      openOfferCount: 1,
      soundEnabled: false,
    }),
    false,
  );
});

test("69–71: на паузе / BUSY_DIRECT / OFFLINE звука нет", () => {
  for (const status of ["PAUSED", "BUSY_DIRECT", "OFFLINE", "ZONE_CONFIRMATION_REQUIRED"] as const) {
    assert.equal(
      shouldDriverOfferSoundPlay({
        driverSelected: true,
        driverStatus: status,
        openOfferCount: 1,
        soundEnabled: true,
      }),
      false,
      status,
    );
  }
});

test("72–74: без открытых предложений сигнал прекращается", () => {
  // После принятия/отказа/истечения openOfferCount == 0 → звука нет.
  assert.equal(
    shouldDriverOfferSoundPlay({
      driverSelected: true,
      driverStatus: "AVAILABLE",
      openOfferCount: 0,
      soundEnabled: true,
    }),
    false,
  );
  // И планировщик не «должен» при пустом списке.
  assert.equal(
    isDriverOfferBeepDue({
      openOfferIds: [],
      announcedOfferIds: ["x"],
      lastBeepAtMs: 0,
      nowMs: 1_000,
    }),
    false,
  );
});

test("75: несколько предложений не создают наложенных сигналов (одно расписание)", () => {
  // Все известные id уже объявлены и интервал не вышел → не пора.
  assert.equal(
    isDriverOfferBeepDue({
      openOfferIds: ["a", "b", "c"],
      announcedOfferIds: ["a", "b", "c"],
      lastBeepAtMs: 1_000,
      nowMs: 5_000,
    }),
    false,
  );
  // Новый (необъявленный) id — один сигнал сразу.
  assert.equal(
    isDriverOfferBeepDue({
      openOfferIds: ["a", "b", "c"],
      announcedOfferIds: ["a", "b"],
      lastBeepAtMs: 1_000,
      nowMs: 1_500,
    }),
    true,
  );
});

test("76: повтор сигнала — каждые 10 секунд", () => {
  const announced = ["a"];
  assert.equal(
    isDriverOfferBeepDue({ openOfferIds: ["a"], announcedOfferIds: announced, lastBeepAtMs: 1_000, nowMs: 1_000 + 9_999 }),
    false,
  );
  assert.equal(
    isDriverOfferBeepDue({ openOfferIds: ["a"], announcedOfferIds: announced, lastBeepAtMs: 1_000, nowMs: 1_000 + 10_000 }),
    true,
  );
});

// --- 77–90: UI и приватность (проверка исходников) ----------------------------

test("77–78: /driver/offers перенаправляет; предложения на едином экране", () => {
  // Отдельной страницы предложений больше нет — редирект на /driver.
  assert.ok(OFFERS_PAGE.includes('redirect("/driver")'));
  assert.ok(WORKSPACE.includes("Новых предложений пока нет"));
  assert.ok(!/рабоч[аеу]\w*\s+смен/i.test(WORKSPACE));
  assert.ok(!/рабоч[аеу]\w*\s+смен/i.test(DRIVER_PAGE));
});

test("79–81: до принятия видны улица и зоны, но не точный адрес и телефон", () => {
  assert.ok(OFFER_CARD.includes("order.address?.street"));
  assert.ok(OFFER_CARD.includes("zoneName(order.restaurant.zoneId)"));
  assert.ok(OFFER_CARD.includes("zoneName(order.financials.customerZoneId)"));
  // Точный адрес и контакты клиента в карточке предложения не читаются.
  for (const forbidden of [
    "address.house",
    "address.apartment",
    "address.entrance",
    "address.floor",
    "customer.phone",
    "customer.name",
    "address.comment",
  ]) {
    assert.ok(!OFFER_CARD.includes(forbidden), `offer card: ${forbidden}`);
  }
});

test("82: выплата берётся из сохранённого снимка", () => {
  assert.ok(OFFER_CARD.includes("order.financials.driverPayoutCents"));
  assert.ok(OFFER_CARD.includes("formatMoney("));
});

test("83–86: countdown, «Принять заказ», «Отказаться», без причины отказа", () => {
  assert.ok(OFFER_CARD.includes("Осталось:"));
  assert.ok(OFFER_CARD.includes("formatCountdown"));
  assert.ok(OFFER_CARD.includes("Принять заказ"));
  assert.ok(OFFER_CARD.includes("Отказаться"));
  assert.ok(!OFFER_CARD.includes("Причина отказа"));
});

test("87–89: активный заказ на едином экране, полный адрес/телефон", () => {
  // v18: активный заказ и его данные живут на рабочем экране /driver.
  assert.ok(WORKSPACE.includes("getDriverActiveOrder"));
  assert.ok(WORKSPACE.includes("tel:"));
  assert.ok(WORKSPACE.includes("formatCustomerAddress"));
});

test("90: сырые статусы предложений в UI не печатаются", () => {
  for (const page of [WORKSPACE, OFFER_CARD, DRIVER_PAGE]) {
    for (const raw of ['">OPEN<"', ">ACCEPTED<", ">DECLINED<", ">EXPIRED<"]) {
      assert.ok(!page.includes(raw));
    }
  }
});

// --- 91–96: regression --------------------------------------------------------

test("91–93: наличные не включены и не влияют на онлайн-предложения", () => {
  const state = createDefaultState();
  assert.equal(state.platformSettings.platformDriverCashEnabled, false);
  // Онлайн-заказ подходит независимо от cashEnabled водителя (Пётр cashEnabled).
  const { state: es, orderId } = eligibleState();
  const s = online(es, D1);
  assert.equal(s.drivers.find((d) => d.id === D1)!.cashEnabled, true);
  assert.deepEqual(
    getEligibleDriversForOrder(s, orderOf(s, orderId)).map((d) => d.id),
    [D1],
  );
  // Наличный заказ предложением не становится.
  assert.equal(isOrderEligibleForDriverOffers(createDefaultState(), order({ paymentMethod: "CASH" })), false);
});

test("94–96: финансовые модули не читаются доменом предложений", () => {
  const src = readFileSync("src/prototype/driver-offers.ts", "utf8");
  for (const forbidden of [
    "restaurant-accounting",
    "restaurant-settlement-records",
    "restaurant-balance-breakdown",
    "order-money-movement",
    "bank-fee",
    "pricing-engine",
  ]) {
    assert.ok(!src.includes(forbidden), `driver-offers импортирует ${forbidden}`);
  }
  // Приём предложения не создаёт settlements и не трогает финансовую историю.
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const before = orderOf(created.state, orderId).financials;
  const accepted = acceptOnline(created.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(accepted.result.ok, true);
  assert.equal(accepted.state.settlements, created.state.settlements);
  assert.deepEqual(orderOf(accepted.state, orderId).financials, before);
});

// ==============================================================================
// CASH DIRECT — часть 2: допуск наличных и подтверждение денежного запаса.
// ==============================================================================

const CASH_SNAPSHOT = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 600,
  driverEarningCents: 300,
  directReceivableFromDriverCents: 100,
};

const cashFinancials = (over: Record<string, unknown> = {}) => ({
  customerZoneId: "zone-1",
  customerTotalCents: 1000,
  restaurantPayoutBeforeBankFeeCents: 600,
  driverPayoutCents: 300,
  platformGrossRevenueCents: 100,
  platformDriverCash: CASH_SNAPSHOT,
  ...over,
});

/** Синтетический наличный заказ для точечной eligibility-проверки. */
function cashOrder(overrides: Partial<Order> = {}): Order {
  return order({
    paymentMethod: "CASH",
    paymentStatus: "CASH_ON_DELIVERY",
    financials: cashFinancials() as unknown as Order["financials"],
    ...overrides,
  });
}

/** Состояние с включённым/выключенным флагом наличных. */
function withCashFlag(state: PrototypeState, enabled: boolean): PrototypeState {
  return {
    ...state,
    platformSettings: {
      ...state.platformSettings,
      platformDriverCashEnabled: enabled,
    },
  };
}

const FLAG_ON = withCashFlag(createDefaultState(), true);

/**
 * Наличное состояние: флаг включён, заказ ресторана-2 переведён в
 * PLATFORM_DRIVER + CASH + CASH_ON_DELIVERY с валидным снимком, водители
 * онлайн в зоне ресторана. По умолчанию D2 (Олег) — cashEnabled false.
 */
function cashEnabledState(opts: { d2Cash?: boolean } = {}): {
  state: PrototypeState;
  orderId: string;
} {
  const { state: s0, orderId } = eligibleState();
  const state: PrototypeState = {
    ...withCashFlag(s0, true),
    orders: s0.orders.map((o) =>
      o.id === orderId
        ? {
            ...o,
            paymentMethod: "CASH",
            paymentStatus: "CASH_ON_DELIVERY",
            financials: {
              ...o.financials,
              customerTotalCents: 1000,
              restaurantPayoutBeforeBankFeeCents: 600,
              driverPayoutCents: 300,
              platformGrossRevenueCents: 100,
              platformDriverCash: CASH_SNAPSHOT,
            },
          }
        : o,
    ),
    drivers: s0.drivers.map((d) => {
      if (d.id === D1) {
        return { ...d, status: "AVAILABLE", currentZoneId: REST_ZONE };
      }
      if (d.id === D2) {
        return {
          ...d,
          status: "AVAILABLE",
          currentZoneId: REST_ZONE,
          cashEnabled: opts.d2Cash === true,
        };
      }
      return d;
    }),
  };
  return { state, orderId };
}

// --- eligibility заказа -------------------------------------------------------

test("cash-3: CASH flag false -> заказ неeligible", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(), cashOrder()),
    false,
  );
});

test("cash-4: CASH flag true + валидный snapshot -> eligible", () => {
  assert.equal(isOrderEligibleForDriverOffers(FLAG_ON, cashOrder()), true);
});

test("cash-1: ONLINE-заказ eligible как раньше (флаг наличных не важен)", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(createDefaultState(), order()),
    true,
  );
  assert.equal(isOrderEligibleForDriverOffers(FLAG_ON, order()), true);
});

test("cash-5: CASH paymentStatus не CASH_ON_DELIVERY -> неeligible", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(
      FLAG_ON,
      cashOrder({ paymentStatus: "NOT_STARTED" }),
    ),
    false,
  );
});

test("cash-6: CASH snapshot null -> неeligible", () => {
  const noSnap = cashOrder({
    financials: cashFinancials({
      platformDriverCash: null,
    }) as unknown as Order["financials"],
  });
  assert.equal(getPlatformDriverCashSnapshot(noSnap), null);
  assert.equal(isOrderEligibleForDriverOffers(FLAG_ON, noSnap), false);
});

test("cash-7: CASH snapshot повреждён/расходится -> неeligible", () => {
  const bad = cashOrder({
    financials: cashFinancials({
      platformDriverCash: { ...CASH_SNAPSHOT, restaurantHandoffCents: 599 },
    }) as unknown as Order["financials"],
  });
  assert.equal(isOrderEligibleForDriverOffers(FLAG_ON, bad), false);
});

// --- eligibility водителя + reconciliation ------------------------------------

test("cash-8: cash-enabled водитель (Пётр) получает наличное предложение", () => {
  const { state, orderId } = cashEnabledState();
  const r = reconcileAt(state, BASE_MS);
  const offer = offerFor(r.state, orderId, D1);
  assert.ok(offer);
  assert.equal(offer.status, "OPEN");
  assert.equal(offer.cashReserveConfirmedAt, null);
});

test("cash-9: водитель cashEnabled false (Олег) не получает наличное предложение", () => {
  const { state, orderId } = cashEnabledState();
  const r = reconcileAt(state, BASE_MS);
  assert.equal(offerFor(r.state, orderId, D2), undefined);
});

test("cash-10: другой cash-enabled водитель той же зоны получает предложение", () => {
  const { state, orderId } = cashEnabledState({ d2Cash: true });
  const r = reconcileAt(state, BASE_MS);
  assert.ok(offerFor(r.state, orderId, D1));
  assert.ok(offerFor(r.state, orderId, D2));
});

test("cash-11: водитель другой зоны наличное предложение не получает", () => {
  const { state, orderId } = cashEnabledState({ d2Cash: true });
  const moved: PrototypeState = {
    ...state,
    drivers: state.drivers.map((d) =>
      d.id === D2 ? { ...d, currentZoneId: "zone-1" } : d,
    ),
  };
  const r = reconcileAt(moved, BASE_MS);
  assert.equal(offerFor(r.state, orderId, D2), undefined);
});

test("cash-12: наличное предложение истекает через 30 секунд", () => {
  const { state, orderId } = cashEnabledState();
  const created = reconcileAt(state, BASE_MS);
  const offer = offerFor(created.state, orderId, D1);
  assert.ok(offer);
  assert.equal(
    Date.parse(offer.expiresAt) - Date.parse(offer.offeredAt),
    DRIVER_OFFER_DURATION_MS,
  );
  const expired = reconcileAt(
    created.state,
    BASE_MS + DRIVER_OFFER_DURATION_MS + 1,
  );
  assert.equal(offerFor(expired.state, orderId, D1)?.status, "EXPIRED");
});

test("cash-13: выключение флага отменяет OPEN наличное предложение", () => {
  const { state, orderId } = cashEnabledState();
  const created = reconcileAt(state, BASE_MS);
  const off = reconcileAt(withCashFlag(created.state, false), BASE_MS + 1_000);
  assert.equal(offerFor(off.state, orderId, D1)?.status, "CANCELED");
});

test("cash-14: потеря cashEnabled отменяет OPEN наличное предложение", () => {
  const { state, orderId } = cashEnabledState();
  const created = reconcileAt(state, BASE_MS);
  const noCash: PrototypeState = {
    ...created.state,
    drivers: created.state.drivers.map((d) =>
      d.id === D1 ? { ...d, cashEnabled: false } : d,
    ),
  };
  const r = reconcileAt(noCash, BASE_MS + 1_000);
  assert.equal(offerFor(r.state, orderId, D1)?.status, "CANCELED");
});

test("cash-15: невалидный snapshot отменяет OPEN наличное предложение", () => {
  const { state, orderId } = cashEnabledState();
  const created = reconcileAt(state, BASE_MS);
  const broken: PrototypeState = {
    ...created.state,
    orders: created.state.orders.map((o) =>
      o.id === orderId
        ? { ...o, financials: { ...o.financials, platformDriverCash: null } }
        : o,
    ),
  };
  const r = reconcileAt(broken, BASE_MS + 1_000);
  assert.equal(offerFor(r.state, orderId, D1)?.status, "CANCELED");
});

// --- атомарное принятие -------------------------------------------------------

function openCashOffer(): {
  state: PrototypeState;
  orderId: string;
  offerId: string;
} {
  const { state, orderId } = cashEnabledState();
  const created = reconcileAt(state, BASE_MS);
  return { state: created.state, orderId, offerId: driverOfferId(orderId, D1) };
}

test("cash-16: принятие CASH без подтверждения -> fail-closed ошибка", () => {
  const { state, offerId } = openCashOffer();
  const r = acceptDriverOffer(state, D1, offerId, iso(BASE_MS + 1_000), {
    cashReserveConfirmed: false,
  });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error, CASH_RESERVE_CONFIRMATION_REQUIRED_ERROR);
});

test("cash-17: при ошибке state не меняется", () => {
  const { state, offerId } = openCashOffer();
  const r = acceptDriverOffer(state, D1, offerId, iso(BASE_MS + 1_000), {
    cashReserveConfirmed: false,
  });
  assert.equal(r.state, state);
});

test("cash-18: при ошибке revision не растёт", () => {
  const { state, offerId } = openCashOffer();
  const r = acceptDriverOffer(state, D1, offerId, iso(BASE_MS + 1_000), {
    cashReserveConfirmed: false,
  });
  assert.equal(r.state.revision, state.revision);
});

test("cash-19..24: принятие CASH с подтверждением — атомарный успех", () => {
  const { state, orderId, offerId } = openCashOffer();
  const at = iso(BASE_MS + 2_000);
  const r = acceptDriverOffer(state, D1, offerId, at, {
    cashReserveConfirmed: true,
  });
  assert.equal(r.result.ok, true); // 19
  const offer = r.state.driverOffers.find((o) => o.id === offerId);
  assert.ok(offer);
  assert.equal(offer.status, "ACCEPTED");
  assert.equal(offer.cashReserveConfirmedAt, at); // 20
  const assigned = orderOf(r.state, orderId);
  assert.equal(assigned.assignedDriverId, D1); // 21
  assert.equal(
    r.state.drivers.find((d) => d.id === D1)?.status,
    "BUSY_DIRECT",
  ); // 22
  // 23: прочие открытые предложения этого заказа/водителя закрыты.
  assert.ok(
    r.state.driverOffers
      .filter((o) => o.orderId === orderId && o.id !== offerId)
      .every((o) => o.status !== "OPEN"),
  );
  // 24: ровно одна новая запись истории принятия.
  const before = orderOf(state, orderId).history.length;
  assert.equal(assigned.history.length, before + 1);
});

test("cash-25: повторное принятие не создаёт второе подтверждение", () => {
  const { state, offerId } = openCashOffer();
  const at = iso(BASE_MS + 2_000);
  const first = acceptDriverOffer(state, D1, offerId, at, {
    cashReserveConfirmed: true,
  });
  assert.equal(first.result.ok, true);
  const second = acceptDriverOffer(
    first.state,
    D1,
    offerId,
    iso(BASE_MS + 3_000),
    { cashReserveConfirmed: true },
  );
  assert.equal(second.result.ok, false);
  assert.equal(
    second.state.driverOffers.find((o) => o.id === offerId)
      ?.cashReserveConfirmedAt,
    at,
  );
});

test("cash-26..27: ONLINE-принятие без подтверждения; confirmedAt null", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const offerId = driverOfferId(orderId, D1);
  const r = acceptDriverOffer(created.state, D1, offerId, iso(BASE_MS + 1_000), {
    cashReserveConfirmed: false,
  });
  assert.equal(r.result.ok, true); // 26
  assert.equal(
    r.state.driverOffers.find((o) => o.id === offerId)?.cashReserveConfirmedAt,
    null,
  ); // 27
});

test("cash-28: гонка двух cash-enabled водителей — принимает только один", () => {
  const { state, orderId } = cashEnabledState({ d2Cash: true });
  const created = reconcileAt(state, BASE_MS);
  const first = acceptDriverOffer(
    created.state,
    D1,
    driverOfferId(orderId, D1),
    iso(BASE_MS + 1_000),
    { cashReserveConfirmed: true },
  );
  assert.equal(first.result.ok, true);
  const second = acceptDriverOffer(
    first.state,
    D2,
    driverOfferId(orderId, D2),
    iso(BASE_MS + 1_001),
    { cashReserveConfirmed: true },
  );
  assert.equal(second.result.ok, false);
  assert.equal(orderOf(second.state, orderId).assignedDriverId, D1);
});

test("cash-29..30: подтверждение не хранит сумму в DriverOffer; сумма — из snapshot", () => {
  const { state, orderId, offerId } = openCashOffer();
  const r = acceptDriverOffer(state, D1, offerId, iso(BASE_MS + 2_000), {
    cashReserveConfirmed: true,
  });
  const offer = r.state.driverOffers.find((o) => o.id === offerId);
  assert.ok(offer);
  // 29: в предложении нет никакой суммы — только timestamp подтверждения.
  assert.ok(!("restaurantHandoffCents" in offer));
  assert.ok(!("amountCents" in offer));
  assert.ok(!("customerCollectionCents" in offer));
  // 30: сумма к передаче ресторану живёт только в снимке заказа.
  assert.equal(
    getPlatformDriverCashSnapshot(orderOf(r.state, orderId))
      ?.restaurantHandoffCents,
    600,
  );
});

// --- persistence --------------------------------------------------------------

const OFFERED_AT = iso(BASE_MS);
const EXPIRES_AT = iso(BASE_MS + DRIVER_OFFER_DURATION_MS);
const RESOLVED_AT = iso(BASE_MS + 5_000);
const CONFIRMED_AT = iso(BASE_MS + 5_000);

function cashOrderRaw(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "o-cash",
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    paymentStatus: "CASH_ON_DELIVERY",
    status: "PREPARING",
    address: {
      street: "ул. Пушкина",
      house: "1",
      apartment: "",
      entrance: "",
      floor: "",
      comment: "",
      zoneId: "zone-2",
    },
    financials: cashFinancials(),
    ...over,
  };
}

function offerRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "offer-cash-1",
    orderId: "o-cash",
    driverId: D1,
    status: "ACCEPTED",
    offeredAt: OFFERED_AT,
    expiresAt: EXPIRES_AT,
    resolvedAt: RESOLVED_AT,
    cashReserveConfirmedAt: CONFIRMED_AT,
    ...over,
  };
}

function parseWith(
  schemaVersion: number,
  orderRaw: Record<string, unknown>,
  offer: Record<string, unknown>,
): PrototypeState {
  const base = createDefaultState();
  const parsed = parseStoredState(
    JSON.stringify({
      ...base,
      schemaVersion,
      orders: [orderRaw],
      driverOffers: [offer],
    }),
  );
  assert.ok(parsed, "состояние должно парситься");
  return parsed;
}

const parsedOffer = (state: PrototypeState) => state.driverOffers[0];

test("cash-31: схема поднята до 22", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 22);
});

test("cash-32: schema 19 offer получает cashReserveConfirmedAt null", () => {
  const s = parseWith(19, cashOrderRaw(), offerRaw());
  assert.equal(parsedOffer(s).cashReserveConfirmedAt, null);
});

test("cash-33: schema 20 accepted cash offer сохраняет валидный ISO", () => {
  const s = parseWith(20, cashOrderRaw(), offerRaw());
  assert.equal(parsedOffer(s).cashReserveConfirmedAt, CONFIRMED_AT);
});

test("cash-34: OPEN offer с timestamp нормализуется в null", () => {
  const s = parseWith(
    20,
    cashOrderRaw(),
    offerRaw({ status: "OPEN", resolvedAt: null }),
  );
  assert.equal(parsedOffer(s).cashReserveConfirmedAt, null);
});

test("cash-35: ONLINE accepted offer с timestamp нормализуется в null", () => {
  const onlineOrder = cashOrderRaw({
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
    financials: cashFinancials({ platformDriverCash: null }),
  });
  const s = parseWith(20, onlineOrder, offerRaw());
  assert.equal(parsedOffer(s).cashReserveConfirmedAt, null);
});

test("cash-36: CASH accepted offer без валидного snapshot -> timestamp null", () => {
  const badOrder = cashOrderRaw({
    financials: cashFinancials({
      platformDriverCash: { ...CASH_SNAPSHOT, driverEarningCents: 301 },
    }),
  });
  const s = parseWith(20, badOrder, offerRaw());
  assert.equal(s.orders[0].financials.platformDriverCash, null);
  assert.equal(parsedOffer(s).cashReserveConfirmedAt, null);
});

test("cash-37: timestamp не реконструируется из resolvedAt", () => {
  const raw = offerRaw();
  delete raw.cashReserveConfirmedAt;
  const s = parseWith(20, cashOrderRaw(), raw);
  assert.equal(parsedOffer(s).resolvedAt, RESOLVED_AT);
  assert.equal(parsedOffer(s).cashReserveConfirmedAt, null);
});

test("cash-38: serialize/parse идемпотентен", () => {
  const s1 = parseWith(20, cashOrderRaw(), offerRaw());
  const s2 = parseStoredState(JSON.stringify(s1));
  assert.ok(s2);
  assert.deepEqual(s2.driverOffers[0], s1.driverOffers[0]);
  assert.equal(s2.driverOffers[0].cashReserveConfirmedAt, CONFIRMED_AT);
});

// --- UI наличного предложения и подтверждения ---------------------------------

test("cash-ui-39: карточка показывает признак «Наличные»", () => {
  assert.ok(OFFER_CARD.includes("Наличные"));
  assert.ok(OFFER_CARD.includes("cashOfferTag"));
});

test("cash-ui-40: карточка показывает точную сумму restaurantHandoff", () => {
  assert.ok(OFFER_CARD.includes("Нужно иметь при себе"));
  assert.ok(OFFER_CARD.includes("cashHandoffCents"));
});

test("cash-ui-41-42: «Принять заказ» наличного открывает лист, а не назначает сразу", () => {
  // Наличное принятие ветвится по cashHandoffCents: сначала setCashConfirm.
  assert.ok(WORKSPACE.includes("setCashConfirm"));
  assert.ok(WORKSPACE.includes("cashHandoffCents !== null"));
});

test("cash-ui-43: есть кнопка «У меня есть эта сумма»", () => {
  assert.ok(WORKSPACE.includes("У меня есть эта сумма"));
});

test("cash-ui-44: главная кнопка передаёт cashReserveConfirmed: true", () => {
  assert.ok(WORKSPACE.includes("cashReserveConfirmed: true"));
  assert.ok(WORKSPACE.includes("confirmCash"));
});

test("cash-ui-45: есть кнопка «Отмена»", () => {
  assert.ok(WORKSPACE.includes("Отмена"));
});

test("cash-ui-46: ошибка остаётся в листе подтверждения", () => {
  const sheetStart = WORKSPACE.indexOf('title="Подтвердите наличные"');
  assert.notEqual(sheetStart, -1);
  const sheetEnd = WORKSPACE.indexOf("</DriverControlSheet>", sheetStart);
  assert.notEqual(sheetEnd, -1);
  const sheetBlock = WORKSPACE.slice(sheetStart, sheetEnd);
  assert.ok(sheetBlock.includes("styles.error"));
});

test("cash-ui-47-48: ONLINE-предложение принимается one-tap без листа наличных", () => {
  // Онлайн-ветка (cashHandoffCents === null) сразу вызывает accept с false.
  assert.ok(WORKSPACE.includes("cashReserveConfirmed: false"));
});

test("cash-ui-50: используется существующий DriverControlSheet", () => {
  assert.ok(WORKSPACE.includes("DriverControlSheet"));
  assert.ok(WORKSPACE.includes("Подтвердите наличные"));
});

test("cash-ui-active: активный наличный заказ показывает «Оплата: наличными»", () => {
  assert.ok(WORKSPACE.includes("Оплата: наличными"));
});

test("cash-ui-51: нет текста ещё не реализованных cash-этапов (долг/ledger)", () => {
  // Передача ресторану (ч.3) и получение денег от клиента (ч.4) реализованы,
  // поэтому их строки допустимы. Запрещены только будущие этапы: долг водителя,
  // ledger, погашение и выплаты.
  for (const forbidden of [
    "Долг водителя",
    "Вы должны Direct",
    "Погасить задолженность",
    "ledger",
  ]) {
    assert.ok(!WORKSPACE.includes(forbidden), `WORKSPACE: ${forbidden}`);
    assert.ok(!OFFER_CARD.includes(forbidden), `OFFER_CARD: ${forbidden}`);
  }
});
