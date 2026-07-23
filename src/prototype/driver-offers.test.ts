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
  DRIVER_OFFER_DURATION_MS,
  acceptDriverOffer,
  declineDriverOffer,
  driverOfferId,
  getEligibleDriversForOrder,
  isOrderEligibleForDriverOffers,
  reconcileDriverOffers,
} from "./driver-offers.ts";
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
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 19);
});

test("2: нормализатор принимает схемы 7–18", () => {
  const base = createDefaultState();
  for (let version = 7; version <= 19; version += 1) {
    const parsed = parseStoredState(
      JSON.stringify({ ...base, schemaVersion: version }),
    );
    assert.ok(parsed, `схема ${version}`);
    assert.equal(parsed.schemaVersion, 19);
  }
  assert.equal(
    parseStoredState(JSON.stringify({ ...base, schemaVersion: 20 })),
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
  assert.equal(isOrderEligibleForDriverOffers(order({ status: "PREPARING" })), true);
});

test("11: подходит READY", () => {
  assert.equal(isOrderEligibleForDriverOffers(order({ status: "READY" })), true);
});

test("12: не подходит PICKUP", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(order({ deliveryMode: "PICKUP" })),
    false,
  );
});

test("13: не подходит RESTAURANT_DELIVERY", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(order({ deliveryMode: "RESTAURANT_DELIVERY" })),
    false,
  );
});

test("14: не подходит неоплаченный заказ", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(order({ paymentStatus: "AWAITING_PAYMENT" })),
    false,
  );
});

test("15: не подходит неготовый lifecycle", () => {
  for (const status of ["RESTAURANT_REVIEW", "AWAITING_PAYMENT"] as const) {
    assert.equal(isOrderEligibleForDriverOffers(order({ status })), false, status);
  }
});

test("16: не подходит назначенный заказ", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(order({ assignedDriverId: D1 })),
    false,
  );
});

test("17: не подходит терминальный заказ", () => {
  for (const status of ["DELIVERED", "CANCELED"] as const) {
    assert.equal(isOrderEligibleForDriverOffers(order({ status })), false, status);
  }
});

test("18: не подходит CASH-заказ", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(order({ paymentMethod: "CASH" })),
    false,
  );
});

test("19: не подходит заказ без улицы", () => {
  const noStreet = order();
  (noStreet.address as { street: string }).street = "   ";
  assert.equal(isOrderEligibleForDriverOffers(noStreet), false);
  assert.equal(isOrderEligibleForDriverOffers(order({ address: null })), false);
});

test("20: не подходит заказ без зоны клиента", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(
      order({ financials: { customerZoneId: null, driverPayoutCents: 300 } as never }),
    ),
    false,
  );
});

test("21: не подходит заказ с нулевой/некорректной выплатой", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(
      order({ financials: { customerZoneId: "zone-1", driverPayoutCents: 0 } as never }),
    ),
    false,
  );
  assert.equal(
    isOrderEligibleForDriverOffers(
      order({ financials: { customerZoneId: "zone-1", driverPayoutCents: -5 } as never }),
    ),
    false,
  );
  assert.equal(
    isOrderEligibleForDriverOffers(
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
  const res = acceptDriverOffer(created.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 5_000));
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
  const acc = acceptDriverOffer(created2.state, D1, openForD1[0].id, iso(BASE_MS + 3_000));
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
  const first = acceptDriverOffer(created.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(first.result.ok, true);
  const second = acceptDriverOffer(first.state, D2, driverOfferId(orderId, D2), iso(BASE_MS + 2_000));
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error, "Предложение уже недоступно.");
});

test("60: истёкшее предложение принять нельзя", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const res = acceptDriverOffer(
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
  const res = acceptDriverOffer(paused.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(res.result.ok, false);
  assert.equal(res.state, paused.state);
});

test("62: водитель другой зоны принять не может", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const moved = changeDriverZone(created.state, D1, "zone-1"); // offer ещё OPEN
  const res = acceptDriverOffer(moved.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
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
  const res = acceptDriverOffer(withOther, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
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
  const res = acceptDriverOffer(assigned.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error, "Предложение уже недоступно.");
});

test("65: при ошибке принятия нет частичной мутации", () => {
  const { state, orderId } = eligibleState();
  const created = reconcileAt(online(state, D1), BASE_MS);
  const res = acceptDriverOffer(created.state, D1, "нет-такого", iso(BASE_MS + 1_000));
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
  const r1 = acceptDriverOffer(created.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(r1.result.ok, true);
  const r2 = acceptDriverOffer(r1.state, D2, driverOfferId(orderId, D2), iso(BASE_MS + 1_001));
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
  assert.equal(isOrderEligibleForDriverOffers(order({ paymentMethod: "CASH" })), false);
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
  const accepted = acceptDriverOffer(created.state, D1, driverOfferId(orderId, D1), iso(BASE_MS + 1_000));
  assert.equal(accepted.result.ok, true);
  assert.equal(accepted.state.settlements, created.state.settlements);
  assert.deepEqual(orderOf(accepted.state, orderId).financials, before);
});
