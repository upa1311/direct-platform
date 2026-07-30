import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  acceptRestaurantOrder,
  addCartItem,
  assignDriverToOrder,
  createOrderFromCart,
  goDriverOnline,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import { resolveDriverDeliveryStage } from "./driver-delivery.ts";
import { parseStoredState } from "./prototype-store.ts";
import type { DeliveryAddress, Order, PrototypeState, ZoneId } from "./models.ts";
import { getDriverActiveOrder } from "./selectors.ts";
import { getDriverCustomerInstructionView } from "./driver-customer-instruction.ts";

/**
 * Client Comment Priority. The driver's priority delivery instruction comes only
 * from the immutable order snapshot `order.address.comment`, is revealed only
 * after the assigned driver takes the order, stays visible across every active
 * stage (ONLINE and CASH alike) and is never replaced by an invented default.
 * These tests exercise the pure read-model and the real lifecycle, not TSX text.
 */

const DRIVER = "driver-1";
const OTHER_DRIVER = "driver-2";
const ZONE: ZoneId = "zone-2";
const ORDER = "o-instruction";
const T0 = "2026-07-25T10:00:00.000Z";

const COMMENT = "Позвоните за 5 минут.\nДомофон не работает.\nОставьте у двери.";

const ADDRESS: DeliveryAddress = {
  street: "ул. Пушкина",
  house: "1",
  apartment: "12",
  entrance: "2",
  floor: "3",
  comment: COMMENT,
  zoneId: "zone-2",
};

/** Minimal PLATFORM_DRIVER order carrying only what the read-model reads. */
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
    publicNumber: "OI-1",
    createdAt: T0,
    updatedAt: T0,
    deliveryMode: "PLATFORM_DRIVER",
    paymentMethod: "ONLINE",
    paymentStatus: "PAID",
    status: "PREPARING",
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
    },
    ...over,
  } as unknown as Order;
}

/**
 * A full state whose assigned driver resolves to a chosen delivery stage, so
 * instruction visibility can be asserted against real lifecycle stages.
 */
function stageState(opts: {
  status: Order["status"];
  arrived?: boolean;
  pickedUp?: boolean;
  arriving?: boolean;
  paymentMethod?: Order["paymentMethod"];
  paymentStatus?: Order["paymentStatus"];
  comment?: string;
  assigned?: boolean;
}): PrototypeState {
  const base = createDefaultState();
  const paymentMethod = opts.paymentMethod ?? "ONLINE";
  const paymentStatus =
    opts.paymentStatus ?? (paymentMethod === "CASH" ? "CASH_ON_DELIVERY" : "PAID");
  const assigned = opts.assigned ?? true;
  const order = orderWith(
    opts.comment ?? COMMENT,
    {
      status: opts.status,
      paymentMethod,
      paymentStatus,
      assignedDriverId: assigned ? DRIVER : null,
    },
  );
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
  if (opts.arrived) push("ARRIVED_AT_RESTAURANT", "2026-07-25T10:05:00.000Z");
  if (opts.pickedUp) push("ORDER_PICKED_UP", "2026-07-25T10:12:00.000Z");
  if (opts.arriving) push("ARRIVING_TO_CUSTOMER", "2026-07-25T10:20:00.000Z");
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

/** A genuinely placed ONLINE order created through the cart pipeline. */
function placedState(comment: string): { state: PrototypeState; orderId: string } {
  let state = goDriverOnline(createDefaultState(), DRIVER, ZONE).state;
  state = goDriverOnline(state, OTHER_DRIVER, ZONE).state;
  state = updateCartAddress(state, {
    street: "Садовый переулок",
    house: "5",
    comment,
  });
  state = addCartItem(state, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(state);
  assert.ok(created.result.orderId);
  const orderId = created.result.orderId;
  state = acceptRestaurantOrder(created.state, orderId, 20);
  state = simulateSuccessfulOnlinePayment(state, orderId);
  state = assignDriverToOrder(state, orderId, DRIVER).state;
  return { state, orderId };
}

const orderOf = (state: PrototypeState, orderId: string): Order => {
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  return order;
};

// --- 1: не раскрывается до принятия --------------------------------------------

test("1: непринятый offer не даёт активного заказа — инструкция не рендерится", () => {
  // Заказ не назначен водителю → у водителя нет активного заказа → ActiveOrderCard
  // (единственное место инструкции) не рендерится.
  const state = stageState({ status: "PREPARING", assigned: false });
  assert.equal(getDriverActiveOrder(state, DRIVER), null);
  // Карточка предложения (до принятия) раскрывает только улицу, не комментарий.
  const offerCard = readFileSync(
    "src/components/driver/driver-offer-card.tsx",
    "utf8",
  );
  assert.ok(!offerCard.includes(".comment"));
});

// --- 2-4: PRESENT после назначения; ONLINE/CASH parity -------------------------

test("2: после назначения валидный комментарий даёт PRESENT с точным текстом", () => {
  const view = getDriverCustomerInstructionView(orderWith(COMMENT));
  assert.equal(view.status, "PRESENT");
  assert.equal(view.text, COMMENT);
});

test("3-4: ONLINE и CASH дают идентичный instruction view", () => {
  const online = getDriverCustomerInstructionView(
    orderWith(COMMENT, { paymentMethod: "ONLINE", paymentStatus: "PAID" }),
  );
  const cash = getDriverCustomerInstructionView(
    orderWith(COMMENT, { paymentMethod: "CASH", paymentStatus: "CASH_ON_DELIVERY" }),
  );
  assert.deepEqual(online, cash);
  assert.equal(online.status, "PRESENT");
  assert.equal(online.text, COMMENT);
});

// --- 5-9: доступна на каждом активном этапе ------------------------------------

test("5-9: инструкция доступна на всех активных этапах (ONLINE и CASH)", () => {
  const stages: Array<{ stage: string; state: PrototypeState }> = [
    { stage: "GO_TO_RESTAURANT", state: stageState({ status: "PREPARING" }) },
    {
      stage: "WAITING_AT_RESTAURANT",
      state: stageState({ status: "PREPARING", arrived: true }),
    },
    {
      stage: "READY_TO_PICK_UP",
      state: stageState({ status: "READY", arrived: true }),
    },
    {
      stage: "GO_TO_CUSTOMER",
      state: stageState({
        status: "OUT_FOR_DELIVERY",
        arrived: true,
        pickedUp: true,
      }),
    },
    {
      stage: "ARRIVING_TO_CUSTOMER",
      state: stageState({
        status: "ARRIVING",
        arrived: true,
        pickedUp: true,
        arriving: true,
      }),
    },
  ];
  for (const { stage, state } of stages) {
    assert.equal(
      resolveDriverDeliveryStage(state, DRIVER, ORDER),
      stage,
      `stage ${stage}`,
    );
    const view = getDriverCustomerInstructionView(orderOf(state, ORDER));
    assert.equal(view.status, "PRESENT", `instruction on ${stage}`);
    assert.equal(view.text, COMMENT, `text on ${stage}`);
  }

  // CASH parity across the arrival stages.
  for (const status of ["PREPARING", "READY"] as const) {
    const state = stageState({
      status,
      arrived: true,
      paymentMethod: "CASH",
      paymentStatus: "CASH_ON_DELIVERY",
    });
    const view = getDriverCustomerInstructionView(orderOf(state, ORDER));
    assert.equal(view.status, "PRESENT");
    assert.equal(view.text, COMMENT);
  }
});

// --- 10: переходы lifecycle не меняют текст snapshot ---------------------------

test("10: смена этапа не меняет текст инструкции", () => {
  const texts = [
    stageState({ status: "PREPARING" }),
    stageState({ status: "PREPARING", arrived: true }),
    stageState({ status: "READY", arrived: true }),
    stageState({ status: "OUT_FOR_DELIVERY", arrived: true, pickedUp: true }),
    stageState({ status: "ARRIVING", arrived: true, pickedUp: true, arriving: true }),
  ].map((s) => getDriverCustomerInstructionView(orderOf(s, ORDER)).text);
  assert.deepEqual(new Set(texts), new Set([COMMENT]));
});

// --- 11: parse/normalization сохраняет комментарий -----------------------------

test("11: reload/parse существующего state сохраняет комментарий (с переносами)", () => {
  const { state, orderId } = placedState(COMMENT);
  const parsed = parseStoredState(JSON.stringify(state));
  assert.ok(parsed);
  const view = getDriverCustomerInstructionView(orderOf(parsed, orderId));
  assert.equal(view.status, "PRESENT");
  assert.equal(view.text, COMMENT);
  assert.ok(view.text.includes("\n"));
});

// --- 12: изменение профиля/cart после создания не меняет заказ ------------------

test("12: правка cart-комментария после оформления не меняет существующий заказ", () => {
  const { state, orderId } = placedState(COMMENT);
  const before = getDriverCustomerInstructionView(orderOf(state, orderId));
  assert.equal(before.text, COMMENT);
  // Пользователь меняет комментарий в корзине уже после оформления.
  const laterCart = updateCartAddress(state, {
    comment: "Совсем другой комментарий",
  });
  const after = getDriverCustomerInstructionView(orderOf(laterCart, orderId));
  assert.deepEqual(after, before);
  assert.equal(after.text, COMMENT);
});

// --- 13-15: пустые/повреждённые формы -------------------------------------------

test("13: пустая строка даёт NONE", () => {
  const view = getDriverCustomerInstructionView(orderWith(""));
  assert.deepEqual(view, { status: "NONE", text: null });
});

test("14: только пробелы и переносы дают NONE", () => {
  const view = getDriverCustomerInstructionView(orderWith("   \n\t  \n "));
  assert.deepEqual(view, { status: "NONE", text: null });
});

test("15: отсутствующий/повреждённый address — REVIEW_REQUIRED, без выдуманного текста", () => {
  const missing = getDriverCustomerInstructionView(orderWith(null, {}, null));
  assert.equal(missing.status, "REVIEW_REQUIRED");
  assert.equal(missing.text, null);
  // comment не строка (повреждённый runtime state) — тоже fail-closed.
  const corrupt = getDriverCustomerInstructionView(orderWith(42 as unknown));
  assert.equal(corrupt.status, "REVIEW_REQUIRED");
  assert.equal(corrupt.text, null);
});

// --- 16-17: сохранение и неусечение текста -------------------------------------

test("16: внутренние переносы строк сохраняются дословно", () => {
  const multi = "Строка 1\nСтрока 2\n\nСтрока 4";
  const view = getDriverCustomerInstructionView(orderWith(multi));
  assert.equal(view.status, "PRESENT");
  assert.equal(view.text, multi);
});

test("17: длинный комментарий не обрезается presentation-моделью", () => {
  const long = "П".repeat(2000);
  const view = getDriverCustomerInstructionView(orderWith(long));
  assert.equal(view.status, "PRESENT");
  assert.equal(view.text?.length, 2000);
});

// --- 18: cooking comment не попадает в delivery instruction ---------------------

test("18: cookingComment позиции не становится delivery instruction", () => {
  const items = [
    { id: "i1", cookingComment: "Без лука, побольше соуса" },
  ] as unknown as Order["items"];
  // Пустой delivery comment → NONE, несмотря на cookingComment позиции.
  const none = getDriverCustomerInstructionView(orderWith("", { items }));
  assert.equal(none.status, "NONE");
  // Непустой delivery comment → именно он, не cookingComment.
  const present = getDriverCustomerInstructionView(orderWith(COMMENT, { items }));
  assert.equal(present.text, COMMENT);
  assert.notEqual(present.text, "Без лука, побольше соуса");
});

// --- 21-26: read-model чист, ничего не мутирует --------------------------------

test("21-26: read-model не мутирует order/state; финансы, зоны, waves и пр. неизменны", () => {
  const state = stageState({ status: "READY", arrived: true });
  const before = JSON.stringify(state);
  const protectedBefore = JSON.stringify({
    financials: orderOf(state, ORDER).financials,
    cash: orderOf(state, ORDER).financials,
    zones: state.zones,
    tariffs: state.tariffs,
    settlements: state.settlements,
    earnings: state.driverEarningEntries,
    payouts: state.driverPayoutBatches,
    waves: state.driverDispatchWaves,
    incidents: state.driverOrderIncidents,
    cashEvents: state.platformDriverCashEvents,
  });
  getDriverCustomerInstructionView(orderOf(state, ORDER));
  getDriverCustomerInstructionView(orderWith(COMMENT));
  assert.equal(JSON.stringify(state), before);
  assert.equal(
    JSON.stringify({
      financials: orderOf(state, ORDER).financials,
      cash: orderOf(state, ORDER).financials,
      zones: state.zones,
      tariffs: state.tariffs,
      settlements: state.settlements,
      earnings: state.driverEarningEntries,
      payouts: state.driverPayoutBatches,
      waves: state.driverDispatchWaves,
      incidents: state.driverOrderIncidents,
      cashEvents: state.platformDriverCashEvents,
    }),
    protectedBefore,
  );
});

// --- 19-20: единый shared block; старое дублирование удалено (источник) ---------

test("19: старое дублирование «Комментарий: …» удалено из RoutePoint", () => {
  const workspace = readFileSync(
    "src/components/driver/driver-workspace.tsx",
    "utf8",
  );
  const routePoint = workspace.slice(
    workspace.indexOf("function RoutePoint"),
    workspace.indexOf("function OrderMeta"),
  );
  assert.ok(routePoint.length > 0);
  assert.ok(!routePoint.includes("Комментарий:"));
});

test("20: единый CustomerInstructionCard для ONLINE и CASH, размещён после прогресса", () => {
  const workspace = readFileSync(
    "src/components/driver/driver-workspace.tsx",
    "utf8",
  );
  assert.equal(
    (workspace.match(/function CustomerInstructionCard/g) ?? []).length,
    1,
  );
  assert.equal(
    (workspace.match(/<CustomerInstructionCard/g) ?? []).length,
    1,
  );
  // Рендерится в ActiveOrderCard вне ветки isCash: после прогресса, до RoutePoint.
  const progress = workspace.indexOf('aria-label="Этапы доставки"');
  const card = workspace.indexOf("<CustomerInstructionCard", progress);
  const route = workspace.indexOf("<RoutePoint", card);
  assert.ok(progress !== -1 && card > progress && route > card);
  assert.ok(workspace.includes("getDriverCustomerInstructionView"));
});
