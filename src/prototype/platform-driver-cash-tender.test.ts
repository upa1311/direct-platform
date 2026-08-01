import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildPlatformDriverCashTenderSnapshot,
  resolvePlatformDriverCashTenderSnapshot,
} from "./platform-driver-cash.ts";
import {
  getDriverCashOfferDisclosureView,
  getPlatformDriverCashTenderSnapshot,
} from "./selectors.ts";
import {
  isOrderEligibleForDriverOffers,
  acceptDriverOffer,
  reconcileDriverOffers,
  driverOfferId,
} from "./driver-offers.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type { Order, PrototypeState } from "./models.ts";
import { createDefaultState } from "./default-state.ts";
import { parseStoredState } from "./prototype-store.ts";

/**
 * Cash Tender & Change Snapshot V1 (v31, F-5). Проверяет: (1) чистый
 * builder/resolver сдачи; (2) селектор раскрытия водителю; (3) миграцию v30→v31;
 * (4) допуск/принятие наличного предложения с учётом снимка сдачи; (5)
 * UI-контракт карточки, листа подтверждения и активного заказа. Экономика заказа
 * не меняется — снимок сдачи только раскрывает уже рассчитанные суммы.
 */

// --- 1–8: builder/resolver ----------------------------------------------------

test("tender-1: EXACT создаёт tender=collection, change=0", () => {
  const r = buildPlatformDriverCashTenderSnapshot({
    mode: "EXACT",
    tenderCents: 1000,
    customerCollectionCents: 1000,
  });
  assert.ok(r.ok);
  assert.deepEqual(r.snapshot, {
    mode: "EXACT",
    tenderCents: 1000,
    changeDueCents: 0,
  });
});

test("tender-2: CHANGE_FROM создаёт правильную сдачу", () => {
  const r = buildPlatformDriverCashTenderSnapshot({
    mode: "CHANGE_FROM",
    tenderCents: 1500,
    customerCollectionCents: 1000,
  });
  assert.ok(r.ok);
  assert.deepEqual(r.snapshot, {
    mode: "CHANGE_FROM",
    tenderCents: 1500,
    changeDueCents: 500,
  });
});

test("tender-3: CHANGE_FROM с tender == collection → fail", () => {
  const r = buildPlatformDriverCashTenderSnapshot({
    mode: "CHANGE_FROM",
    tenderCents: 1000,
    customerCollectionCents: 1000,
  });
  assert.equal(r.ok, false);
});

test("tender-4: tender < collection → fail (оба режима)", () => {
  assert.equal(
    buildPlatformDriverCashTenderSnapshot({
      mode: "CHANGE_FROM",
      tenderCents: 900,
      customerCollectionCents: 1000,
    }).ok,
    false,
  );
  assert.equal(
    buildPlatformDriverCashTenderSnapshot({
      mode: "EXACT",
      tenderCents: 900,
      customerCollectionCents: 1000,
    }).ok,
    false,
  );
});

test("tender-5: negative/zero/float/NaN/unsafe → fail", () => {
  const bad = [-100, 0, 10.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2];
  for (const tenderCents of bad) {
    assert.equal(
      buildPlatformDriverCashTenderSnapshot({
        mode: "CHANGE_FROM",
        tenderCents,
        customerCollectionCents: 1000,
      }).ok,
      false,
      `tender ${tenderCents}`,
    );
  }
  // Некорректная collection тоже fail-closed.
  assert.equal(
    buildPlatformDriverCashTenderSnapshot({
      mode: "EXACT",
      tenderCents: 1000,
      customerCollectionCents: 0,
    }).ok,
    false,
  );
});

test("tender-6: повреждённый сохранённый changeDueCents → resolver null", () => {
  const resolved = resolvePlatformDriverCashTenderSnapshot({
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    customerCollectionCents: 1000,
    // changeDueCents должен быть 500, но сохранён 400 — расхождение.
    candidate: { mode: "CHANGE_FROM", tenderCents: 1500, changeDueCents: 400 },
  });
  assert.equal(resolved, null);
});

test("tender-7: неизвестный mode → resolver null", () => {
  assert.equal(
    resolvePlatformDriverCashTenderSnapshot({
      deliveryMode: "PLATFORM_DRIVER",
      paymentMethod: "CASH",
      customerCollectionCents: 1000,
      candidate: { mode: "SPLIT", tenderCents: 1000, changeDueCents: 0 },
    }),
    null,
  );
  // Пустой/отсутствующий кандидат — тоже null.
  assert.equal(
    resolvePlatformDriverCashTenderSnapshot({
      deliveryMode: "PLATFORM_DRIVER",
      paymentMethod: "CASH",
      customerCollectionCents: 1000,
      candidate: null,
    }),
    null,
  );
});

test("tender-8: не-CASH / не-PLATFORM_DRIVER → resolver null", () => {
  const good = { mode: "EXACT" as const, tenderCents: 1000, changeDueCents: 0 };
  assert.equal(
    resolvePlatformDriverCashTenderSnapshot({
      deliveryMode: "PLATFORM_DRIVER",
      paymentMethod: "ONLINE",
      customerCollectionCents: 1000,
      candidate: good,
    }),
    null,
  );
  assert.equal(
    resolvePlatformDriverCashTenderSnapshot({
      deliveryMode: "PICKUP",
      paymentMethod: "CASH",
      customerCollectionCents: 1000,
      candidate: good,
    }),
    null,
  );
  // Валидная комбинация возвращает снимок.
  assert.deepEqual(
    resolvePlatformDriverCashTenderSnapshot({
      deliveryMode: "PLATFORM_DRIVER",
      paymentMethod: "CASH",
      customerCollectionCents: 1000,
      candidate: good,
    }),
    good,
  );
});

// --- Синтетический наличный заказ (селектор/offers) ---------------------------

const CASH = {
  customerTotalCents: 1000,
  restaurantPayoutBeforeBankFeeCents: 600,
  driverPayoutCents: 300,
  platformGrossRevenueCents: 100,
};
const CASH_SNAPSHOT = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 700,
  driverEarningCents: 300,
  restaurantOwesDirectCents: 100,
};
const EXACT_TENDER = { mode: "EXACT" as const, tenderCents: 1000, changeDueCents: 0 };
const CHANGE_TENDER = {
  mode: "CHANGE_FROM" as const,
  tenderCents: 1500,
  changeDueCents: 500,
};

function cashOrder(over: { tender?: unknown; snapshot?: unknown } = {}): Order {
  return {
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    financials: {
      currencyCode: "USD",
      ...CASH,
      platformDriverCash:
        over.snapshot === undefined ? CASH_SNAPSHOT : over.snapshot,
      platformDriverCashTender:
        over.tender === undefined ? EXACT_TENDER : over.tender,
    },
  } as unknown as Order;
}

// --- 31–34: селектор раскрытия ------------------------------------------------

test("tender-31: EXACT → READY, changeRequired false", () => {
  const view = getDriverCashOfferDisclosureView(cashOrder());
  assert.equal(view.status, "READY");
  if (view.status !== "READY") return;
  assert.equal(view.changeRequired, false);
  assert.equal(view.changeDueCents, 0);
  assert.equal(view.customerCollectionCents, 1000);
  assert.equal(view.restaurantHandoffCents, 700);
  assert.equal(view.tenderCents, 1000);
});

test("tender-32: CHANGE_FROM → READY с четырьмя суммами", () => {
  const view = getDriverCashOfferDisclosureView(cashOrder({ tender: CHANGE_TENDER }));
  assert.equal(view.status, "READY");
  if (view.status !== "READY") return;
  assert.equal(view.changeRequired, true);
  assert.equal(view.tenderCents, 1500);
  assert.equal(view.changeDueCents, 500);
  assert.equal(view.customerCollectionCents, 1000);
  assert.equal(view.restaurantHandoffCents, 700);
});

test("tender-33: отсутствие/рассинхрон снимка → REVIEW_REQUIRED / NOT_APPLICABLE", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(cashOrder({ tender: null })).status,
    "REVIEW_REQUIRED",
  );
  assert.equal(
    getDriverCashOfferDisclosureView(
      cashOrder({ tender: { mode: "CHANGE_FROM", tenderCents: 1500, changeDueCents: 400 } }),
    ).status,
    "REVIEW_REQUIRED",
  );
  // Нет валидного cash snapshot → раскрытие вообще неприменимо.
  assert.equal(
    getDriverCashOfferDisclosureView(cashOrder({ snapshot: null })).status,
    "NOT_APPLICABLE",
  );
});

test("tender-34: selector read-only (не мутирует заказ)", () => {
  const order = cashOrder({ tender: CHANGE_TENDER });
  const before = JSON.stringify(order);
  getDriverCashOfferDisclosureView(order);
  getPlatformDriverCashTenderSnapshot(order);
  assert.equal(JSON.stringify(order), before);
});

// --- 18–22: schema / migration ------------------------------------------------

test("tender-18: schemaVersion равна 31", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 31);
});

test("tender-19: v30 состояние принимается и мигрирует в 31", () => {
  const base = createDefaultState();
  const parsed = parseStoredState(
    JSON.stringify({ ...base, schemaVersion: 30 }),
  );
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, 31);
});

test("tender-20: v31 round-trip сохраняет снимок сдачи", () => {
  const base = createDefaultState();
  const cashEnabled: PrototypeState = {
    ...base,
    platformSettings: { ...base.platformSettings, platformDriverCashEnabled: true },
  };
  const withOrder: PrototypeState = {
    ...cashEnabled,
    orders: [cashOrder({ tender: CHANGE_TENDER })],
  };
  const parsed = parseStoredState(JSON.stringify(withOrder));
  assert.ok(parsed);
  assert.deepEqual(
    parsed.orders[0].financials.platformDriverCashTender,
    CHANGE_TENDER,
  );
});

test("tender-21: malformed снимок сдачи не ремонтируется (→ null)", () => {
  const base = createDefaultState();
  const withOrder: PrototypeState = {
    ...base,
    platformSettings: { ...base.platformSettings, platformDriverCashEnabled: true },
    orders: [
      cashOrder({ tender: { mode: "CHANGE_FROM", tenderCents: 1500, changeDueCents: 1 } }),
    ],
  };
  const parsed = parseStoredState(JSON.stringify(withOrder));
  assert.ok(parsed);
  assert.equal(parsed.orders[0].financials.platformDriverCashTender, null);
});

test("tender-22: cart cashTenderIntent по умолчанию null и не оживает без флага", () => {
  const base = createDefaultState();
  assert.equal(base.cart.cashTenderIntent, null);
  // Флаг выключен → «протёкший» CASH-intent сбрасывается нормализацией.
  const leaked = {
    ...base,
    cart: { ...base.cart, paymentMethod: "CASH", cashTenderIntent: { mode: "EXACT" } },
  };
  const parsed = parseStoredState(JSON.stringify(leaked));
  assert.ok(parsed);
  assert.equal(parsed.cart.paymentMethod, "ONLINE");
  assert.equal(parsed.cart.cashTenderIntent, null);
});

// --- 23–30: offers / accept (tender-specific) ---------------------------------

const FLAG_ON: PrototypeState = (() => {
  const base = createDefaultState();
  return {
    ...base,
    platformSettings: { ...base.platformSettings, platformDriverCashEnabled: true },
  };
})();

/** Полный eligibility-заказ (адрес/зона/статус) + наличные снимки. */
function eligibleCashOrder(over: { tender?: unknown } = {}): Order {
  return {
    id: "order-x",
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "CASH",
    paymentStatus: "CASH_ON_DELIVERY",
    status: "READY",
    assignedDriverId: null,
    address: { street: "ул. Пушкина", house: "1", zoneId: "zone-1" },
    restaurant: { id: "restaurant-2", name: "Ресторан 2", address: "адрес", zoneId: "zone-1" },
    history: [],
    financials: {
      currencyCode: "USD",
      customerZoneId: "zone-1",
      ...CASH,
      platformDriverCash: CASH_SNAPSHOT,
      platformDriverCashTender:
        over.tender === undefined ? EXACT_TENDER : over.tender,
    },
  } as unknown as Order;
}

test("tender-23: валидный снимок сдачи → offer eligible", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(FLAG_ON, eligibleCashOrder()),
    true,
  );
});

test("tender-24: отсутствие снимка сдачи → no offer", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(FLAG_ON, eligibleCashOrder({ tender: null })),
    false,
  );
});

test("tender-25: повреждённый снимок сдачи → no offer", () => {
  assert.equal(
    isOrderEligibleForDriverOffers(
      FLAG_ON,
      eligibleCashOrder({
        tender: { mode: "CHANGE_FROM", tenderCents: 1500, changeDueCents: 1 },
      }),
    ),
    false,
  );
});

test("tender-26: OPEN offer отменяется reconciliation после порчи снимка сдачи", () => {
  // Готовим состояние с наличным заказом и cash-водителем в зоне.
  const order = eligibleCashOrder();
  const drivers = FLAG_ON.drivers.map((d) =>
    d.id === "driver-1"
      ? { ...d, status: "AVAILABLE" as const, currentZoneId: "zone-1" as const }
      : d,
  );
  const state: PrototypeState = { ...FLAG_ON, drivers, orders: [order] };
  const created = reconcileDriverOffers(state, "2026-08-01T10:00:00.000Z");
  const offer = created.state.driverOffers.find(
    (o) => o.orderId === "order-x" && o.driverId === "driver-1",
  );
  assert.ok(offer);
  assert.equal(offer.status, "OPEN");
  // Портим снимок сдачи и повторяем reconciliation — offer должен отмениться.
  const broken: PrototypeState = {
    ...created.state,
    orders: created.state.orders.map((o) =>
      o.id === "order-x"
        ? {
            ...o,
            financials: { ...o.financials, platformDriverCashTender: null },
          }
        : o,
    ),
  };
  const after = reconcileDriverOffers(broken, "2026-08-01T10:00:05.000Z");
  const canceled = after.state.driverOffers.find(
    (o) => o.orderId === "order-x" && o.driverId === "driver-1",
  );
  assert.equal(canceled?.status, "CANCELED");
});

test("tender-28,29: accept без валидного снимка сдачи → без мутации", () => {
  const order = eligibleCashOrder({ tender: null });
  const drivers = FLAG_ON.drivers.map((d) =>
    d.id === "driver-1"
      ? { ...d, status: "AVAILABLE" as const, currentZoneId: "zone-1" as const }
      : d,
  );
  const offerId = driverOfferId("order-x", "driver-1", 1);
  const state: PrototypeState = {
    ...FLAG_ON,
    drivers,
    orders: [order],
    driverDispatchWaves: [
      {
        id: "driver-dispatch-wave-order-x-1",
        orderId: "order-x",
        waveNumber: 1,
        startedAt: "2026-08-01T10:00:00.000Z",
        offerExpiresAt: "2026-08-01T10:00:30.000Z",
        trigger: "READY_URGENT",
      },
    ],
    driverOffers: [
      {
        id: offerId,
        waveId: "driver-dispatch-wave-order-x-1",
        waveNumber: 1,
        orderId: "order-x",
        driverId: "driver-1",
        status: "OPEN",
        offeredAt: "2026-08-01T10:00:00.000Z",
        expiresAt: "2026-08-01T10:00:30.000Z",
        resolvedAt: null,
        cashReserveConfirmedAt: null,
      },
    ],
  };
  const r = acceptDriverOffer(state, "driver-1", offerId, "2026-08-01T10:00:05.000Z", {
    cashReserveConfirmed: true,
  });
  assert.equal(r.result.ok, false);
  // Ни offer, ни driver, ни revision не меняются.
  assert.equal(r.state.driverOffers[0].status, "OPEN");
  assert.equal(
    r.state.drivers.find((d) => d.id === "driver-1")?.status,
    "AVAILABLE",
  );
  assert.equal(r.state.revision, state.revision);
});

test("tender-30: AcceptDriverOfferInput не содержит денежных сумм", () => {
  const src = readFileSync("src/prototype/driver-offers.ts", "utf8");
  const start = src.indexOf("interface AcceptDriverOfferInput");
  assert.notEqual(start, -1);
  const block = src.slice(start, src.indexOf("}", start));
  assert.ok(block.includes("cashReserveConfirmed"));
  assert.ok(!/tenderCents|changeDueCents|amountCents/.test(block));
});

// --- 35–45: UI / active-order контракт (source-contract) ----------------------

const OFFER_CARD = readFileSync(
  "src/components/driver/driver-offer-card.tsx",
  "utf8",
);
const WORKSPACE = readFileSync(
  "src/components/driver/driver-workspace.tsx",
  "utf8",
);

test("tender-35,36: карточка раскрывает получение от клиента и передачу ресторану", () => {
  assert.ok(OFFER_CARD.includes("Получить от клиента"));
  assert.ok(OFFER_CARD.includes("Передать ресторану"));
  assert.ok(OFFER_CARD.includes("customerCollectionCents"));
  assert.ok(OFFER_CARD.includes("restaurantHandoffCents"));
});

test("tender-37,38: EXACT показывает «Сдача не нужна», CHANGE_FROM — tender и сдачу", () => {
  assert.ok(OFFER_CARD.includes("Сдача не нужна"));
  assert.ok(OFFER_CARD.includes("Клиент заплатит"));
  assert.ok(OFFER_CARD.includes("Подготовить сдачу"));
  assert.ok(OFFER_CARD.includes("changeRequired"));
});

test("tender-39: лист подтверждения повторяет все суммы", () => {
  assert.ok(WORKSPACE.includes("Получить от клиента"));
  assert.ok(WORKSPACE.includes("Передать ресторану до получения заказа"));
  assert.ok(WORKSPACE.includes("Клиент заплатит"));
  assert.ok(WORKSPACE.includes("Подготовить сдачу"));
  assert.ok(WORKSPACE.includes("Сдача: не нужна"));
});

test("tender-40: pre-accept приватность не регрессирует", () => {
  // Карточка до принятия не раскрывает дом/квартиру/телефон/имя/комментарий.
  assert.ok(!OFFER_CARD.includes("order.address?.house"));
  assert.ok(!OFFER_CARD.includes("order.customer.phone"));
  assert.ok(!OFFER_CARD.includes("order.customer.name"));
});

test("tender-41: ONLINE offer UI не показывает наличных блоков", () => {
  // Наличные блоки только под status READY/REVIEW_REQUIRED раскрытия.
  assert.ok(OFFER_CARD.includes('cashDisclosure.status === "READY"'));
  assert.ok(OFFER_CARD.includes('cashDisclosure.status !== "NOT_APPLICABLE"'));
});

test("tender-42: невалидное раскрытие показывает проверку Direct, не назначает", () => {
  assert.ok(OFFER_CARD.includes("Данные о сдаче требуют проверки Direct"));
  assert.ok(WORKSPACE.includes("Данные о сдаче требуют проверки Direct"));
});

test("tender-43,44,45: активный заказ раскрывает сдачу; lifecycle не тронут", () => {
  // Раскрытие сдачи на клиентском этапе (GO_TO_CUSTOMER/ARRIVING).
  assert.ok(WORKSPACE.includes("getDriverCashOfferDisclosureView"));
  assert.ok(WORKSPACE.includes("changeLine"));
  // Legacy без снимка сдачи → честная проверка Direct.
  assert.ok(WORKSPACE.includes("Данные о сдаче требуют проверки Direct"));
  // Существующее подтверждение получения не изменено.
  assert.ok(WORKSPACE.includes("cashCollectionConfirmed"));
});
