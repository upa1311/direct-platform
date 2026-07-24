import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { parseStoredState } from "./prototype-store.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type {
  DriverCashLedgerEntry,
  Order,
  PrototypeState,
} from "./models.ts";
import {
  driverCashLedgerEntryId,
  buildCompletedDriverCashLedgerEntry,
  buildPreparedDriverCashLedgerEntry,
  hasValidDriverCashLedgerEntry,
  getDriverCashLedgerView,
} from "./driver-cash-ledger.ts";
import { customerCashCollectionEventId } from "./platform-driver-cash-collection.ts";
import {
  driverCashHandoffReportEventId,
  restaurantCashReceiptEventId,
} from "./platform-driver-cash-handoff.ts";
import { markDriverDeliveredOrder } from "./driver-delivery.ts";

/**
 * CASH DIRECT — часть 5: append-only расчёты водителя по наличным доставкам.
 * Суммы копируются из immutable snapshot; netting не выполняется.
 */

const DRIVER = "driver-1";
const OTHER_DRIVER = "driver-2";
const REST = "restaurant-2";
const ORDER = "o-cash";
const T0 = "2026-07-22T10:00:00.000Z";
const T2 = "2026-07-22T10:06:00.000Z"; // driver report
const T3 = "2026-07-22T10:07:00.000Z"; // restaurant confirmation
const T4 = "2026-07-22T10:08:00.000Z"; // picked up
const T5 = "2026-07-22T10:09:00.000Z"; // arriving
const T6 = "2026-07-22T10:10:00.000Z"; // collection / delivery / now

const SNAPSHOT = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 700,
  driverEarningCents: 300,
  restaurantOwesDirectCents: 100,
};

interface Opts {
  orderId?: string;
  status?: Order["status"];
  paymentMethod?: Order["paymentMethod"];
  paymentStatus?: Order["paymentStatus"];
  paidAt?: string | null;
  snapshot?: unknown;
  offerStatus?: "ACCEPTED" | "OPEN";
  reserveConfirmedAt?: string | null;
  reported?: boolean;
  confirmed?: boolean;
  pickedUp?: boolean;
  arriving?: boolean;
  delivered?: boolean;
  collected?: boolean;
  collectedAt?: string;
  ledger?: unknown[];
  driverStatus?: string;
}

/** Полностью валидное ARRIVING-состояние наличного заказа (по умолчанию). */
function cashState(opts: Opts = {}): PrototypeState {
  const base = createDefaultState();
  const orderId = opts.orderId ?? ORDER;
  const order = {
    id: orderId,
    publicNumber: "C-1",
    createdAt: T0,
    updatedAt: T0,
    customer: { id: "customer-1", name: "Клиент", phone: "+373 1" },
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: opts.paymentMethod ?? "CASH",
    paymentStatus: opts.paymentStatus ?? "CASH_ON_DELIVERY",
    paidAt: opts.paidAt === undefined ? null : opts.paidAt,
    status: opts.status ?? "ARRIVING",
    assignedDriverId: DRIVER,
    driverAssignedAt: T0,
    restaurant: { id: REST, name: "Р2", address: "адрес", zoneId: "zone-2" },
    address: {
      street: "ул. Пушкина",
      house: "1",
      apartment: "",
      entrance: "",
      floor: "",
      comment: "",
      zoneId: "zone-2",
    },
    items: [],
    etaAdjustments: [],
    history: [],
    financials: {
      currencyCode: "USD",
      customerZoneId: "zone-1",
      customerTotalCents: 1000,
      restaurantPayoutBeforeBankFeeCents: 600,
      driverPayoutCents: 300,
      platformGrossRevenueCents: 100,
      platformDriverCash: opts.snapshot === undefined ? SNAPSHOT : opts.snapshot,
    },
  } as unknown as Order;

  const de: unknown[] = [
    {
      id: `de-1-${orderId}`,
      orderId,
      driverId: DRIVER,
      type: "ARRIVED_AT_RESTAURANT",
      occurredAt: T2,
      orderStatusBefore: "READY",
      orderStatusAfter: "READY",
    },
  ];
  if (opts.pickedUp !== false) {
    de.push({
      id: `de-2-${orderId}`,
      orderId,
      driverId: DRIVER,
      type: "ORDER_PICKED_UP",
      occurredAt: T4,
      orderStatusBefore: "READY",
      orderStatusAfter: "OUT_FOR_DELIVERY",
    });
  }
  if (opts.arriving !== false) {
    de.push({
      id: `de-3-${orderId}`,
      orderId,
      driverId: DRIVER,
      type: "ARRIVING_TO_CUSTOMER",
      occurredAt: T5,
      orderStatusBefore: "OUT_FOR_DELIVERY",
      orderStatusAfter: "ARRIVING",
    });
  }
  if (opts.delivered) {
    de.push({
      id: `de-4-${orderId}`,
      orderId,
      driverId: DRIVER,
      type: "ORDER_DELIVERED",
      occurredAt: opts.collectedAt ?? T6,
      orderStatusBefore: "ARRIVING",
      orderStatusAfter: "DELIVERED",
    });
  }

  const cash: unknown[] = [];
  if (opts.reported !== false) {
    cash.push({
      id: driverCashHandoffReportEventId(orderId),
      orderId,
      driverId: DRIVER,
      restaurantId: REST,
      type: "DRIVER_REPORTED_RESTAURANT_CASH_HANDOFF",
      amountCents: 700,
      occurredAt: T2,
      actor: "DRIVER",
      restaurantWorkspaceRole: null,
    });
  }
  if (opts.confirmed !== false) {
    cash.push({
      id: restaurantCashReceiptEventId(orderId),
      orderId,
      driverId: DRIVER,
      restaurantId: REST,
      type: "RESTAURANT_CONFIRMED_CASH_RECEIPT",
      amountCents: 700,
      occurredAt: T3,
      actor: "RESTAURANT",
      restaurantWorkspaceRole: "COMBINED",
    });
  }
  if (opts.collected) {
    cash.push({
      id: customerCashCollectionEventId(orderId),
      orderId,
      driverId: DRIVER,
      restaurantId: REST,
      type: "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
      amountCents: 1000,
      occurredAt: opts.collectedAt ?? T6,
      actor: "DRIVER",
      restaurantWorkspaceRole: null,
    });
  }

  return {
    ...base,
    platformSettings: { ...base.platformSettings, platformDriverCashEnabled: true },
    orders: [order],
    driverOffers: [
      {
        id: `offer-${orderId}`,
        orderId,
        driverId: DRIVER,
        status: opts.offerStatus ?? "ACCEPTED",
        offeredAt: T0,
        expiresAt: "2030-01-01T00:00:00.000Z",
        resolvedAt: T0,
        cashReserveConfirmedAt:
          opts.reserveConfirmedAt === undefined ? T0 : opts.reserveConfirmedAt,
      } as unknown as PrototypeState["driverOffers"][number],
    ],
    driverDeliveryEvents: de as unknown as PrototypeState["driverDeliveryEvents"],
    platformDriverCashEvents:
      cash as unknown as PrototypeState["platformDriverCashEvents"],
    driverCashLedgerEntries:
      (opts.ledger ?? []) as unknown as PrototypeState["driverCashLedgerEntries"],
    drivers: base.drivers.map((d) =>
      d.id === DRIVER
        ? {
            ...d,
            status: (opts.driverStatus ?? "BUSY_DIRECT") as typeof d.status,
            currentZoneId: "zone-2",
          }
        : d,
    ),
  };
}

const theOrder = (s: PrototypeState): Order => s.orders[0];
const complete = (s: PrototypeState, now = T6) =>
  markDriverDeliveredOrder(s, DRIVER, ORDER, now, {
    cashCollectionConfirmed: true,
  });

/** Ожидаемая ledger-запись полностью завершённого заказа. */
function expectedEntry(orderId = ORDER): DriverCashLedgerEntry {
  return {
    id: driverCashLedgerEntryId(orderId),
    orderId,
    driverId: DRIVER,
    restaurantId: REST,
    currencyCode: "USD",
    customerCollectionCents: 1000,
    restaurantHandoffCents: 700,
    driverEarningCents: 300,
    directReceivableFromDriverCents: 0,
    recognizedAt: T6,
    source: "PLATFORM_DRIVER_CASH_ORDER",
  };
}

/** Завершённое состояние (после успешного CASH completion). */
const completedState = (): PrototypeState => {
  const r = complete(cashState());
  assert.equal(r.result.ok, true, r.result.error ?? "");
  return r.state;
};

// --- 1–3: schema / defaults ---------------------------------------------------

test("1/2/3: схема 23, пустой ledger и выключенные наличные по умолчанию", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 24);
  const d = createDefaultState();
  assert.deepEqual(d.driverCashLedgerEntries, []);
  assert.equal(d.platformSettings.platformDriverCashEnabled, false);
});

// --- 4–26: атомарное создание записи ------------------------------------------

test("4–19: CASH completion создаёт ровно одну точную запись из snapshot", () => {
  const s = cashState();
  const r = complete(s);
  assert.equal(r.result.ok, true);
  assert.equal(r.state.driverCashLedgerEntries.length, 1);
  assert.deepEqual(r.state.driverCashLedgerEntries[0], expectedEntry());
});

test("5/6: ledger создаётся в той же ревизии, без второго bump", () => {
  const s = cashState();
  const r = complete(s);
  assert.equal(r.state.revision, s.revision + 1);
});

test("13/14/15: recognizedAt === paidAt === collection === ORDER_DELIVERED", () => {
  const st = completedState();
  const entry = st.driverCashLedgerEntries[0];
  const order = theOrder(st);
  const collection = st.platformDriverCashEvents.find(
    (e) => e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
  );
  const delivered = st.driverDeliveryEvents.find((e) => e.type === "ORDER_DELIVERED");
  assert.equal(entry.recognizedAt, order.paidAt);
  assert.equal(entry.recognizedAt, collection?.occurredAt);
  assert.equal(entry.recognizedAt, delivered?.occurredAt);
});

test("20–24: снимок не меняется; CASH не создаёт accounting/settlements", () => {
  const s = cashState();
  const before = JSON.stringify(theOrder(s).financials);
  const st = completedState();
  assert.equal(JSON.stringify(theOrder(st).financials), before);
  assert.equal(st.restaurantAccountingEntries.length, 0);
  assert.equal(st.settlements.length, 0);
  assert.equal(st.restaurantSettlementRecords.length, 0);
});

test("25: ONLINE completion не создаёт driver cash ledger", () => {
  // Онлайн-заказ этого синтетического снимка до accounting не доходит, но и
  // ledger-записи не появляется ни при каком исходе.
  const online = cashState({
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
    paidAt: T0,
  });
  const r = markDriverDeliveredOrder(online, DRIVER, ORDER, T6, {
    cashCollectionConfirmed: false,
  });
  assert.equal(r.state.driverCashLedgerEntries.length, 0);
});

// --- 27–41: отказы ------------------------------------------------------------

const failCases: [string, Opts][] = [
  ["без snapshot", { snapshot: null }],
  ["без подтверждения ресторана", { confirmed: false }],
  ["без driver report", { reported: false }],
  ["без pickup", { pickedUp: false }],
  ["без arriving", { arriving: false }],
  ["без accepted offer", { offerStatus: "OPEN" }],
  ["без cash reserve", { reserveConfirmedAt: null }],
];

for (const [label, opts] of failCases) {
  test(`27–34: ledger не создаётся ${label}`, () => {
    const s = cashState(opts);
    const r = complete(s);
    assert.equal(r.result.ok, false);
    assert.equal(r.state, s); // 35
    assert.equal(r.state.revision, s.revision); // 36
    assert.equal(theOrder(r.state).status, "ARRIVING"); // 37
    assert.equal(theOrder(r.state).paymentStatus, "CASH_ON_DELIVERY"); // 38
    assert.equal(theOrder(r.state).paidAt, null); // 39
    assert.equal(
      r.state.drivers.find((d) => d.id === DRIVER)?.status,
      "BUSY_DIRECT",
    ); // 40
    assert.equal(
      r.state.driverDeliveryEvents.filter((e) => e.type === "ORDER_DELIVERED").length,
      0,
    ); // 41
    assert.equal(r.state.driverCashLedgerEntries.length, 0);
  });
}

test("34: существующая запись до завершения — fail-closed", () => {
  const s = cashState({ ledger: [expectedEntry()] });
  const r = complete(s);
  assert.equal(r.result.ok, false);
  assert.equal(r.state, s);
  assert.equal(r.state.driverCashLedgerEntries.length, 1);
});

// --- 42–49: повтор и целостность ---------------------------------------------

test("42/43/44: повторное завершение — no-op без второй записи и ревизии", () => {
  const st = completedState();
  const again = complete(st, "2026-07-22T11:00:00.000Z");
  assert.equal(again.result.ok, true);
  assert.equal(again.state, st);
  assert.equal(again.state.driverCashLedgerEntries.length, 1);
  assert.equal(again.state.revision, st.revision);
});

test("45–49: завершённый CASH с отсутствующей/повреждённой записью → review", () => {
  const st = completedState();
  const broken = (entries: unknown[]): PrototypeState => ({
    ...st,
    driverCashLedgerEntries:
      entries as unknown as PrototypeState["driverCashLedgerEntries"],
  });
  const cases: [string, unknown[]][] = [
    ["без записи", []],
    ["неверная сумма", [{ ...expectedEntry(), driverEarningCents: 999 }]],
    ["дубль", [expectedEntry(), { ...expectedEntry(), id: "other" }]],
    ["чужой водитель", [{ ...expectedEntry(), driverId: OTHER_DRIVER }]],
    ["неверный recognizedAt", [{ ...expectedEntry(), recognizedAt: T5 }]],
  ];
  for (const [label, entries] of cases) {
    const s = broken(entries);
    const r = complete(s, "2026-07-22T11:00:00.000Z");
    assert.equal(r.result.ok, false, label);
    assert.equal(r.result.error, "Данные расчёта водителя требуют проверки Direct.", label);
    assert.equal(r.state, s, label);
  }
});

// --- 50–74: миграция и нормализация -------------------------------------------

/** Разбор завершённого состояния под указанной схемой. */
function parseAt(
  schemaVersion: number,
  over: Partial<PrototypeState> = {},
  base = completedState(),
): PrototypeState {
  const parsed = parseStoredState(
    JSON.stringify({ ...base, ...over, schemaVersion }),
  );
  assert.ok(parsed, `схема ${schemaVersion} должна парситься`);
  return parsed;
}

test("50: схемы <= 21 получают пустой ledger", () => {
  for (const v of [7, 15, 20, 21]) {
    assert.deepEqual(parseAt(v).driverCashLedgerEntries, []);
  }
});

test("51/52: схема 22 мигрирует из доказательств и игнорирует сырое поле", () => {
  const migrated = parseAt(22, {
    driverCashLedgerEntries: [
      { ...expectedEntry(), driverEarningCents: 1 },
    ] as unknown as PrototypeState["driverCashLedgerEntries"],
  });
  assert.equal(migrated.driverCashLedgerEntries.length, 1);
  assert.deepEqual(migrated.driverCashLedgerEntries[0], expectedEntry());
});

test("53/54/55: схема 22 не мигрирует недоказанное завершение", () => {
  const st = completedState();
  const noCollection: PrototypeState = {
    ...st,
    platformDriverCashEvents: st.platformDriverCashEvents.filter(
      (e) => e.type !== "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
    ),
  };
  assert.deepEqual(parseAt(22, {}, noCollection).driverCashLedgerEntries, []);

  const noDelivered: PrototypeState = {
    ...st,
    driverDeliveryEvents: st.driverDeliveryEvents.filter(
      (e) => e.type !== "ORDER_DELIVERED",
    ),
  };
  assert.deepEqual(parseAt(22, {}, noDelivered).driverCashLedgerEntries, []);

  const noSnapshot: PrototypeState = {
    ...st,
    orders: st.orders.map((o) => ({
      ...o,
      financials: { ...o.financials, platformDriverCash: null },
    })),
  };
  assert.deepEqual(parseAt(22, {}, noSnapshot).driverCashLedgerEntries, []);
});

test("56/57: схема 23 сохраняет валидную запись и не синтезирует отсутствующую", () => {
  assert.equal(parseAt(23).driverCashLedgerEntries.length, 1);
  assert.deepEqual(
    parseAt(23, {
      driverCashLedgerEntries: [] as unknown as PrototypeState["driverCashLedgerEntries"],
    }).driverCashLedgerEntries,
    [],
  );
});

test("58–70: схема 23 удаляет повреждённые записи", () => {
  const bad = (over: Record<string, unknown>) =>
    parseAt(23, {
      driverCashLedgerEntries: [
        { ...expectedEntry(), ...over },
      ] as unknown as PrototypeState["driverCashLedgerEntries"],
    }).driverCashLedgerEntries.length;
  assert.equal(bad({ id: "wrong" }), 0); // 58
  assert.equal(bad({ orderId: "нет" }), 0); // 59
  assert.equal(bad({ driverId: OTHER_DRIVER }), 0); // 60
  assert.equal(bad({ restaurantId: "restaurant-1" }), 0); // 61
  assert.equal(bad({ currencyCode: "EUR" }), 0); // 62
  assert.equal(bad({ source: "OTHER" }), 0); // 63
  assert.equal(bad({ recognizedAt: "не-дата" }), 0); // 64
  assert.equal(bad({ driverEarningCents: 300.5 }), 0); // 65
  assert.equal(bad({ driverEarningCents: Number.MAX_SAFE_INTEGER + 2 }), 0); // 66
  assert.equal(bad({ driverEarningCents: 301 }), 0); // 67
});

test("68/69: запись ONLINE-заказа и незавершённого CASH удаляется", () => {
  const online = cashState({
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
    paidAt: T0,
    ledger: [expectedEntry()],
  });
  assert.equal(parseAt(23, {}, online).driverCashLedgerEntries.length, 0);

  const active = cashState({ ledger: [expectedEntry()] });
  assert.equal(parseAt(23, {}, active).driverCashLedgerEntries.length, 0);
});

test("71/72: дубли по заказу и по id удаляют обе записи", () => {
  const dupOrder = parseAt(23, {
    driverCashLedgerEntries: [
      expectedEntry(),
      { ...expectedEntry(), id: "second" },
    ] as unknown as PrototypeState["driverCashLedgerEntries"],
  });
  assert.equal(dupOrder.driverCashLedgerEntries.length, 0);

  const dupId = parseAt(23, {
    driverCashLedgerEntries: [
      expectedEntry(),
      { ...expectedEntry(), orderId: "other-order" },
    ] as unknown as PrototypeState["driverCashLedgerEntries"],
  });
  assert.equal(dupId.driverCashLedgerEntries.length, 0);
});

test("73/74: parse идемпотентен; мигрированная схема 22 не дублируется", () => {
  const once = parseAt(22);
  const twice = parseStoredState(JSON.stringify(once));
  assert.ok(twice);
  assert.deepEqual(twice.driverCashLedgerEntries, once.driverCashLedgerEntries);
  assert.equal(twice.driverCashLedgerEntries.length, 1);
});

// --- 75–89: view --------------------------------------------------------------

test("75–81: view фильтрует водителя и считает раздельные итоги", () => {
  const st = completedState();
  const view = getDriverCashLedgerView(st, DRIVER);
  assert.equal(view.entries.length, 1);
  assert.equal(view.cashDeliveryCount, 1);
  assert.equal(view.cashEarningsCents, 300);
  assert.equal(view.dueToDirectCents, 0);
  assert.equal(view.reviewRequired, false);
  // Другой водитель записи не видит.
  const other = getDriverCashLedgerView(st, OTHER_DRIVER);
  assert.equal(other.entries.length, 0);
  assert.equal(other.cashEarningsCents, 0);
});

test("82: netting не выполняется (итоги раздельные)", () => {
  const view = getDriverCashLedgerView(completedState(), DRIVER);
  // 300 и 100 остаются раздельными; разность 200 нигде не появляется.
  assert.equal(view.cashEarningsCents, 300);
  assert.equal(view.dueToDirectCents, 0);
  assert.notEqual(view.cashEarningsCents, 200);
});

test("84/85/86: отсутствующая, повреждённая и дублирующая запись → reviewRequired", () => {
  const st = completedState();
  const withLedger = (entries: unknown[]): PrototypeState => ({
    ...st,
    driverCashLedgerEntries:
      entries as unknown as PrototypeState["driverCashLedgerEntries"],
  });
  assert.equal(getDriverCashLedgerView(withLedger([]), DRIVER).reviewRequired, true);
  assert.equal(
    getDriverCashLedgerView(
      withLedger([{ ...expectedEntry(), driverEarningCents: 999 }]),
      DRIVER,
    ).reviewRequired,
    true,
  );
  assert.equal(
    getDriverCashLedgerView(
      withLedger([expectedEntry(), { ...expectedEntry(), id: "x" }]),
      DRIVER,
    ).reviewRequired,
    true,
  );
});

test("88/89: пустое состояние — нули; незавершённый CASH не считается пропуском", () => {
  const empty = getDriverCashLedgerView(createDefaultState(), DRIVER);
  assert.equal(empty.cashDeliveryCount, 0);
  assert.equal(empty.cashEarningsCents, 0);
  assert.equal(empty.dueToDirectCents, 0);
  assert.equal(empty.reviewRequired, false);
  // Активный (ещё не завершённый) наличный заказ не требует записи.
  const active = getDriverCashLedgerView(cashState(), DRIVER);
  assert.equal(active.reviewRequired, false);
});

test("builders: completed строит ожидаемую, prepared запрещён после завершения", () => {
  const st = completedState();
  const built = buildCompletedDriverCashLedgerEntry(st, theOrder(st));
  assert.equal(built.ok, true);
  if (built.ok) assert.deepEqual(built.entry, expectedEntry());
  assert.equal(hasValidDriverCashLedgerEntry(st, theOrder(st)), true);
  // Завершённый заказ уже не является подготовленным ARRIVING-состоянием.
  assert.equal(buildPreparedDriverCashLedgerEntry(st, theOrder(st), T6).ok, false);
});

// --- 90–115: UI ---------------------------------------------------------------

const PAGE = readFileSync("src/app/driver/settlements/page.tsx", "utf8");
const PAGE_CSS = readFileSync(
  "src/app/driver/settlements/settlements.module.css",
  "utf8",
);

test("90–92: сессия обязательна, driverId не из URL", () => {
  assert.ok(PAGE.includes("useAuthenticatedDriverId"));
  assert.ok(
    PAGE.includes("Войдите в систему под своим именем и номером телефона"),
  );
  assert.ok(!PAGE.includes("useSearchParams"));
  assert.ok(!PAGE.includes("useParams"));
  assert.ok(PAGE.includes("getDriverCashLedgerView(state, sessionDriverId)"));
});

test("93–99: заголовки, подписи и честная формулировка", () => {
  assert.ok(PAGE.includes('title="Расчёты"'));
  assert.ok(PAGE.includes("Заработок с наличных заказов"));
  assert.ok(PAGE.includes("Передать Direct"));
  assert.ok(PAGE.includes("Наличных доставок"));
  assert.ok(PAGE.includes("Эта сумма уже осталась у вас после наличных доставок."));
  assert.ok(
    PAGE.includes("Деньги Direct, которые остались у вас после наличных заказов."),
  );
  assert.ok(PAGE.includes("История наличных доставок"));
});

test("100–105: строка истории показывает заказ, ресторан и четыре суммы", () => {
  assert.ok(PAGE.includes("Заказ №{order.publicNumber}"));
  assert.ok(PAGE.includes("order.restaurant.name"));
  assert.ok(PAGE.includes("Заработок:"));
  assert.ok(PAGE.includes("Передать Direct:"));
  assert.ok(PAGE.includes("Получено от клиента:"));
  assert.ok(PAGE.includes("Передано ресторану:"));
});

test("106–109: нет приватных данных клиента, кнопок выплат и netting", () => {
  for (const forbidden of [
    "customer.name",
    "customer.phone",
    "address.street",
    "apartment",
    "Погасить задолженность",
    "Оплатить сейчас",
    "Доступно к выплате",
    "Чистый баланс",
    "Direct должен вам",
    "Общий заработок",
  ]) {
    assert.ok(!PAGE.includes(forbidden), forbidden);
  }
  // Никакого вычитания итогов.
  assert.ok(!/cashEarningsCents\s*-\s*/.test(PAGE));
});

test("110–112: online-подпись, review-предупреждение и пустое состояние", () => {
  assert.ok(PAGE.includes("Онлайн-выплаты пока не входят в этот раздел."));
  assert.ok(PAGE.includes("Некоторые расчёты требуют проверки Direct."));
  assert.ok(PAGE.includes("Наличных расчётов пока нет"));
  assert.ok(
    PAGE.includes(
      "После завершённой наличной доставки здесь появятся ваш заработок и",
    ),
  );
  assert.ok(PAGE.includes('role="status"'));
});

test("113–115: мобильная одна колонка и общий formatMoney", () => {
  // Сводка по умолчанию одна колонка; три — только на широком экране.
  const grid = PAGE_CSS.slice(PAGE_CSS.indexOf(".summaryGrid {"));
  assert.ok(grid.includes("grid-template-columns: 1fr"));
  assert.ok(PAGE_CSS.includes("@media (min-width: 640px)"));
  // Длинные значения переносятся, а не обрезаются.
  assert.ok(PAGE_CSS.includes("overflow-wrap: anywhere"));
  assert.ok(PAGE.includes("formatMoney"));
});
