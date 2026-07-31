import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { resolveDriverDeliveryStage } from "./driver-delivery.ts";
import type { DeliveryAddress, Order, PrototypeState } from "./models.ts";
import { getDriverActiveOrder } from "./selectors.ts";
import {
  getDriverDeliveryHandoffPolicyView,
  isDeliveryHandoffStage,
} from "./driver-delivery-handoff.ts";

/**
 * Delivery Handoff Policy. An operational policy, not a text classifier: Direct's
 * default is hand-to-customer; the client's immutable instruction takes priority.
 * No NLP/regex, no new persisted field, no new completion button, no new event.
 * Tests exercise the pure policy read-model, the pure stage-visibility predicate,
 * ONLINE/CASH parity and read-model purity; source assertions only confirm shared
 * placement and the absence of parsers/buttons/duplicated text.
 */

const DRIVER = "driver-1";
const ORDER = "o-handoff";
const T0 = "2026-07-30T10:00:00.000Z";
const COMMENT = "Оставьте заказ у двери.\nДомофон не работает.";

const ADDRESS: DeliveryAddress = {
  street: "ул. Пушкина",
  house: "1",
  apartment: "12",
  entrance: "2",
  floor: "3",
  comment: COMMENT,
  zoneId: "zone-2",
};

function orderWith(
  comment: unknown,
  over: Partial<Order> = {},
  addressOver: Partial<DeliveryAddress> | null = {},
): Order {
  const address =
    addressOver === null
      ? null
      : ({ ...ADDRESS, comment, ...addressOver } as unknown as DeliveryAddress);
  return {
    id: ORDER,
    publicNumber: "OH-1",
    createdAt: T0,
    updatedAt: T0,
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
    paidAt: T0,
    status: "OUT_FOR_DELIVERY",
    assignedDriverId: DRIVER,
    restaurant: { id: "restaurant-2", name: "Р2", address: "адрес", zoneId: "zone-2" },
    address,
    items: [],
    history: [],
    etaAdjustments: [],
    financials: {
      currencyCode: "USD",
      customerZoneId: "zone-1",
      customerTotalCents: 1000,
      driverPayoutCents: 300,
      platformDriverCash: {
        customerCollectionCents: 1000,
        restaurantHandoffCents: 700,
        driverEarningCents: 300,
        restaurantOwesDirectCents: 100,
      },
    },
    ...over,
  } as unknown as Order;
}

function stageState(opts: {
  status: Order["status"];
  arrived?: boolean;
  pickedUp?: boolean;
  arriving?: boolean;
  delivered?: boolean;
  paymentMethod?: Order["paymentMethod"];
  paymentStatus?: Order["paymentStatus"];
  comment?: string;
}): PrototypeState {
  const base = createDefaultState();
  const paymentMethod = opts.paymentMethod ?? "ONLINE";
  const paymentStatus =
    opts.paymentStatus ?? (paymentMethod === "CASH" ? "CASH_ON_DELIVERY" : "PAID");
  const order = orderWith(opts.comment ?? COMMENT, {
    status: opts.status,
    paymentMethod,
    paymentStatus,
  });
  const events: unknown[] = [];
  const push = (type: string, occurredAt: string) =>
    events.push({
      id: `${type}-${occurredAt}`,
      orderId: ORDER,
      driverId: DRIVER,
      type,
      occurredAt,
      orderStatusBefore: opts.status,
      orderStatusAfter: opts.status,
    });
  if (opts.arrived) push("ARRIVED_AT_RESTAURANT", "2026-07-30T10:05:00.000Z");
  if (opts.pickedUp) push("ORDER_PICKED_UP", "2026-07-30T10:12:00.000Z");
  if (opts.arriving) push("ARRIVING_TO_CUSTOMER", "2026-07-30T10:20:00.000Z");
  if (opts.delivered) push("ORDER_DELIVERED", "2026-07-30T10:30:00.000Z");
  return {
    ...base,
    orders: [order],
    driverDeliveryEvents:
      events as unknown as PrototypeState["driverDeliveryEvents"],
    drivers: base.drivers.map((d) =>
      d.id === DRIVER
        ? { ...d, status: "BUSY_DIRECT" as typeof d.status, currentZoneId: "zone-2" }
        : d,
    ),
  };
}

const orderOf = (s: PrototypeState): Order => s.orders[0];

const HANDOFF_SRC = readFileSync(
  "src/prototype/driver-delivery-handoff.ts",
  "utf8",
);
const WORKSPACE = readFileSync(
  "src/components/driver/driver-workspace.tsx",
  "utf8",
);

// --- 1-2: default hand-to-customer ---------------------------------------------

test("1-2: без комментария — DEFAULT_HAND_TO_CUSTOMER, метод HAND_TO_CUSTOMER", () => {
  const view = getDriverDeliveryHandoffPolicyView(orderWith(""));
  assert.equal(view.status, "DEFAULT_HAND_TO_CUSTOMER");
  assert.equal(view.defaultMethod, "HAND_TO_CUSTOMER");
  assert.equal(view.customerInstruction, null);
});

// --- 3-4: customer instruction priority ----------------------------------------

test("3-4: непустой комментарий — CUSTOMER_INSTRUCTION_PRIORITY, текст дословно", () => {
  const view = getDriverDeliveryHandoffPolicyView(orderWith(COMMENT));
  assert.equal(view.status, "CUSTOMER_INSTRUCTION_PRIORITY");
  assert.equal(view.defaultMethod, "HAND_TO_CUSTOMER");
  assert.equal(view.customerInstruction, COMMENT);
});

// --- 5-6: no enum, no parsing --------------------------------------------------

test("5: «Оставьте заказ у двери» не превращается в persisted enum/метод", () => {
  const view = getDriverDeliveryHandoffPolicyView(
    orderWith("Оставьте заказ у двери"),
  );
  assert.equal(view.status, "CUSTOMER_INSTRUCTION_PRIORITY");
  // Default метод не меняется на основании текста; leave-at-door НЕ распознаётся.
  assert.equal(view.defaultMethod, "HAND_TO_CUSTOMER");
  assert.equal(view.customerInstruction, "Оставьте заказ у двери");
  // Форма view фиксирована — нет полей deliveryMethod/leaveAtDoor/handoffType.
  assert.deepEqual(
    Object.keys(view).sort(),
    ["customerInstruction", "defaultMethod", "status"],
  );
});

test("6: read-model не использует regex/NLP и не читает comment напрямую", () => {
  assert.ok(HANDOFF_SRC.includes("getDriverCustomerInstructionView"));
  assert.ok(!HANDOFF_SRC.includes(".comment"));
  for (const forbidden of [
    "RegExp",
    ".match(",
    ".search(",
    ".replace(",
    "toLowerCase",
    "toUpperCase",
    "LEAVE_AT_DOOR",
    "leaveAtDoor",
    ".split(",
  ]) {
    assert.ok(!HANDOFF_SRC.includes(forbidden), forbidden);
  }
});

// --- 7-8: empty variants keep default ------------------------------------------

test("7: пустая строка сохраняет default лично в руки", () => {
  assert.equal(
    getDriverDeliveryHandoffPolicyView(orderWith("")).status,
    "DEFAULT_HAND_TO_CUSTOMER",
  );
});

test("8: только пробелы и переносы сохраняют default лично в руки", () => {
  const view = getDriverDeliveryHandoffPolicyView(orderWith("   \n\t \n"));
  assert.equal(view.status, "DEFAULT_HAND_TO_CUSTOMER");
  assert.equal(view.defaultMethod, "HAND_TO_CUSTOMER");
});

// --- 9-10: review-required fail-closed -----------------------------------------

test("9-10: повреждённый instruction view — REVIEW_REQUIRED без выдуманного метода", () => {
  const missingAddress = getDriverDeliveryHandoffPolicyView(
    orderWith(null, {}, null),
  );
  assert.equal(missingAddress.status, "REVIEW_REQUIRED");
  assert.equal(missingAddress.defaultMethod, null);
  assert.equal(missingAddress.customerInstruction, null);
  const corrupt = getDriverDeliveryHandoffPolicyView(orderWith(42 as unknown));
  assert.equal(corrupt.status, "REVIEW_REQUIRED");
  assert.equal(corrupt.defaultMethod, null);
});

// --- 11-16: stage visibility ---------------------------------------------------

test("11-15: policy виден только на этапах пути к клиенту", () => {
  const cases: Array<{ stage: string; state: PrototypeState; visible: boolean }> = [
    { stage: "GO_TO_RESTAURANT", state: stageState({ status: "PREPARING" }), visible: false },
    {
      stage: "WAITING_AT_RESTAURANT",
      state: stageState({ status: "PREPARING", arrived: true }),
      visible: false,
    },
    {
      stage: "READY_TO_PICK_UP",
      state: stageState({ status: "READY", arrived: true }),
      visible: false,
    },
    {
      stage: "GO_TO_CUSTOMER",
      state: stageState({ status: "OUT_FOR_DELIVERY", arrived: true, pickedUp: true }),
      visible: true,
    },
    {
      stage: "ARRIVING_TO_CUSTOMER",
      state: stageState({
        status: "ARRIVING",
        arrived: true,
        pickedUp: true,
        arriving: true,
      }),
      visible: true,
    },
  ];
  for (const { stage, state, visible } of cases) {
    const resolved = resolveDriverDeliveryStage(state, DRIVER, ORDER);
    assert.equal(resolved, stage, `resolve ${stage}`);
    assert.equal(isDeliveryHandoffStage(resolved), visible, `visible ${stage}`);
  }
});

test("16: после DELIVERED активный handoff block не отображается", () => {
  const state = stageState({
    status: "DELIVERED",
    arrived: true,
    pickedUp: true,
    arriving: true,
    delivered: true,
  });
  // Терминальный заказ не является активным → ActiveOrderCard не рендерится.
  assert.equal(getDriverActiveOrder(state, DRIVER), null);
  // И даже resolved-stage не входит в handoff-этапы.
  assert.equal(
    isDeliveryHandoffStage(resolveDriverDeliveryStage(state, DRIVER, ORDER)),
    false,
  );
});

// --- 17: ONLINE/CASH parity ----------------------------------------------------

test("17: ONLINE и CASH дают идентичную policy view", () => {
  const online = getDriverDeliveryHandoffPolicyView(
    orderWith(COMMENT, { paymentMethod: "ONLINE", paymentStatus: "PAID" }),
  );
  const cash = getDriverDeliveryHandoffPolicyView(
    orderWith(COMMENT, { paymentMethod: "CASH", paymentStatus: "CASH_ON_DELIVERY" }),
  );
  assert.deepEqual(online, cash);
  const onlineEmpty = getDriverDeliveryHandoffPolicyView(
    orderWith("", { paymentMethod: "ONLINE", paymentStatus: "PAID" }),
  );
  const cashEmpty = getDriverDeliveryHandoffPolicyView(
    orderWith("", { paymentMethod: "CASH", paymentStatus: "CASH_ON_DELIVERY" }),
  );
  assert.deepEqual(onlineEmpty, cashEmpty);
});

// --- 18-20: single shared block, no duplicated text (source) -------------------

test("18: один общий DeliveryHandoffPolicyCard, вне ветки isCash, после инструкции", () => {
  assert.equal(
    (WORKSPACE.match(/function DeliveryHandoffPolicyCard/g) ?? []).length,
    1,
  );
  assert.equal((WORKSPACE.match(/<DeliveryHandoffPolicyCard/g) ?? []).length, 1);
  const instr = WORKSPACE.indexOf("<CustomerInstructionCard");
  const handoff = WORKSPACE.indexOf("<DeliveryHandoffPolicyCard", instr);
  const route = WORKSPACE.indexOf("<RoutePoint", handoff);
  assert.ok(instr !== -1 && handoff > instr && route > handoff);
  // Гейт по этапу через общий предикат.
  assert.ok(WORKSPACE.includes("isDeliveryHandoffStage(stage)"));
});

test("19-20: Client Comment Priority отдельный; полный комментарий не дублируется", () => {
  assert.equal((WORKSPACE.match(/<CustomerInstructionCard/g) ?? []).length, 1);
  const card = WORKSPACE.slice(
    WORKSPACE.indexOf("function DeliveryHandoffPolicyCard"),
    WORKSPACE.indexOf("function RoutePoint"),
  );
  assert.ok(card.length > 0);
  // Карточка политики не рендерит полный текст комментария клиента.
  assert.ok(!card.includes("customerInstruction"));
  assert.ok(!card.includes("view.text"));
});

// --- 21, 35: completion actions unchanged; no new buttons (source) -------------

test("21: ONLINE и CASH completion actions не изменены", () => {
  // ONLINE: одно нажатие без подтверждения наличных.
  assert.ok(WORKSPACE.includes("cashCollectionConfirmed: false"));
  // CASH: атомарное завершение с подтверждением получения наличных.
  assert.ok(WORKSPACE.includes("cashCollectionConfirmed: true"));
  assert.ok(WORKSPACE.includes("Заказ доставлен"));
  assert.ok(WORKSPACE.includes("и передал заказ"));
});

test("35: никаких новых completion-кнопок способа передачи", () => {
  for (const forbidden of [
    "Передал лично",
    "Оставил у двери",
    "Инструкцию выполнил",
    "Подтвердить способ передачи",
  ]) {
    assert.ok(!WORKSPACE.includes(forbidden), forbidden);
  }
});

// --- 33, 34, 24-32: purity — policy view touches nothing -----------------------

test("33-34: read-model не мутирует order/state; новых persisted полей нет", () => {
  const state = stageState({ status: "OUT_FOR_DELIVERY", arrived: true, pickedUp: true });
  const before = JSON.stringify(state);
  getDriverDeliveryHandoffPolicyView(orderOf(state));
  assert.equal(JSON.stringify(state), before);
  // Никаких persisted handoff-полей на заказе.
  const order = orderOf(state) as unknown as Record<string, unknown>;
  for (const field of [
    "deliveryMethod",
    "leaveAtDoor",
    "handoffType",
    "driverHandoffInstruction",
  ]) {
    assert.ok(!(field in order), field);
  }
});

test("24-32: policy view не меняет финансы, cash snapshot, статусы и защищённые слои", () => {
  const state = stageState({
    status: "ARRIVING",
    arrived: true,
    pickedUp: true,
    arriving: true,
    paymentMethod: "CASH",
    paymentStatus: "CASH_ON_DELIVERY",
  });
  const order = orderOf(state);
  const financialsBefore = JSON.stringify(order.financials);
  const paymentBefore = `${order.paymentStatus}|${order.paidAt ?? "null"}`;
  const protectedBefore = JSON.stringify({
    settlements: state.settlements,
    earnings: state.driverEarningEntries,
    payouts: state.driverPayoutBatches,
    accounting: state.restaurantAccountingEntries,
    incidents: state.driverOrderIncidents,
    cashEvents: state.platformDriverCashEvents,
    waves: state.driverDispatchWaves,
    zones: state.zones,
    tariffs: state.tariffs,
  });

  getDriverDeliveryHandoffPolicyView(order);

  assert.equal(JSON.stringify(order.financials), financialsBefore);
  assert.equal(`${order.paymentStatus}|${order.paidAt ?? "null"}`, paymentBefore);
  const cash = order.financials.platformDriverCash;
  assert.equal(cash?.customerCollectionCents, 1000);
  assert.equal(cash?.restaurantHandoffCents, 700);
  assert.equal(
    JSON.stringify({
      settlements: state.settlements,
      earnings: state.driverEarningEntries,
      payouts: state.driverPayoutBatches,
      accounting: state.restaurantAccountingEntries,
      incidents: state.driverOrderIncidents,
      cashEvents: state.platformDriverCashEvents,
      waves: state.driverDispatchWaves,
      zones: state.zones,
      tariffs: state.tariffs,
    }),
    protectedBefore,
  );
});
