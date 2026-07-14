import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import {
  addCartItem,
  adjustOrderEtaFromIntent,
  adjustOrderExpectedReadyAt,
  createOrderFromCart,
} from "./actions.ts";
import {
  computeDelayedEtaIso,
  computeEarlierEtaIso,
  computeEtaDeltaMinutes,
  computeEtaFromIntent,
  computeEtaFromNowIso,
  validateEtaCandidate,
} from "./order-eta.ts";
import { normalizePrototypeState } from "./prototype-store.ts";
import {
  formatOrderEtaClock,
  formatOrderEtaInRestaurantZone,
  getOrderStatusSince,
} from "./selectors.ts";
import type { Order, OrderStatus, PrototypeState } from "./models.ts";

const NOW = "2026-07-14T12:00:00.000Z";
const CURRENT_ETA = "2026-07-14T12:20:00.000Z"; // now + 20 мин
const NEXT_OK = "2026-07-14T12:30:00.000Z"; // now + 30 мин

/** Детерминированное состояние с одним PREPARING-заказом и фиксированным ETA. */
function preparingState(patch: Partial<Order> = {}): {
  state: PrototypeState;
  orderId: string;
} {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1").state;
  const created = createOrderFromCart({
    ...s,
    cart: { ...s.cart, fulfillmentChoice: "PICKUP" },
  });
  const orderId = created.result.orderId as string;
  const base = created.state.orders.find((o) => o.id === orderId)!;
  const order: Order = {
    ...base,
    status: "PREPARING",
    preparationMinutes: 20,
    expectedReadyAt: CURRENT_ETA,
    etaAdjustments: [],
    ...patch,
  };
  return {
    state: { ...created.state, orders: [order] },
    orderId,
  };
}

function orderOf(state: PrototypeState, orderId: string): Order {
  const o = state.orders.find((x) => x.id === orderId);
  assert.ok(o);
  return o;
}

// =========================== §17 domain ======================================

test("§17.1–3: PREPARING получает новое ETA, сохраняются previous/next", () => {
  const { state, orderId } = preparingState();
  const res = adjustOrderExpectedReadyAt(state, orderId, NEXT_OK, "Высокая загрузка", "RESTAURANT", NOW);
  assert.equal(res.result.ok, true);
  assert.equal(res.result.previousExpectedReadyAt, CURRENT_ETA);
  assert.equal(res.result.nextExpectedReadyAt, NEXT_OK);
  const o = orderOf(res.state, orderId);
  assert.equal(o.expectedReadyAt, NEXT_OK);
  assert.equal(o.etaAdjustments[0].previousExpectedReadyAt, CURRENT_ETA);
  assert.equal(o.etaAdjustments[0].nextExpectedReadyAt, NEXT_OK);
});

test("§17.4: причина обязательна", () => {
  const { state, orderId } = preparingState();
  assert.equal(adjustOrderExpectedReadyAt(state, orderId, NEXT_OK, "  ", "RESTAURANT", NOW).result.ok, false);
});

test("§17.5: невалидная дата отклоняется", () => {
  const { state, orderId } = preparingState();
  assert.equal(adjustOrderExpectedReadyAt(state, orderId, "не дата", "причина", "RESTAURANT", NOW).result.ok, false);
});

test("§17.6: время в прошлом отклоняется", () => {
  const { state, orderId } = preparingState();
  assert.equal(adjustOrderExpectedReadyAt(state, orderId, "2026-07-14T11:00:00.000Z", "причина", "RESTAURANT", NOW).result.ok, false);
});

test("§17.7: меньше чем через минуту отклоняется", () => {
  const { state, orderId } = preparingState();
  const in30s = "2026-07-14T12:00:30.000Z";
  assert.equal(adjustOrderExpectedReadyAt(state, orderId, in30s, "причина", "RESTAURANT", NOW).result.ok, false);
});

test("§17.8: дальше 180 минут отклоняется", () => {
  const { state, orderId } = preparingState();
  const far = "2026-07-14T15:30:00.000Z"; // now + 210 мин
  assert.equal(adjustOrderExpectedReadyAt(state, orderId, far, "причина", "RESTAURANT", NOW).result.ok, false);
});

for (const status of ["RESTAURANT_REVIEW", "AWAITING_PAYMENT", "READY", "READY_FOR_PICKUP", "DELIVERED", "PICKED_UP", "CANCELED"] as OrderStatus[]) {
  test(`§17.9–13: статус ${status} отклоняется`, () => {
    const { state, orderId } = preparingState({ status });
    assert.equal(adjustOrderExpectedReadyAt(state, orderId, NEXT_OK, "причина", "RESTAURANT", NOW).result.ok, false);
  });
}

test("§17.14: повторное идентичное действие не создаёт дубликат", () => {
  const { state, orderId } = preparingState();
  const once = adjustOrderExpectedReadyAt(state, orderId, NEXT_OK, "причина", "RESTAURANT", NOW);
  const twice = adjustOrderExpectedReadyAt(once.state, orderId, NEXT_OK, "причина", "RESTAURANT", "2026-07-14T12:01:00.000Z");
  assert.equal(twice.result.ok, false);
  assert.equal(orderOf(twice.state, orderId).etaAdjustments.length, 1);
});

test("§17.15–16: две корректировки — две записи, актуальное ETA правильное", () => {
  const { state, orderId } = preparingState();
  const first = adjustOrderExpectedReadyAt(state, orderId, "2026-07-14T12:40:00.000Z", "задержка", "RESTAURANT", NOW);
  const second = adjustOrderExpectedReadyAt(first.state, orderId, "2026-07-14T12:35:00.000Z", "раньше", "RESTAURANT", "2026-07-14T12:05:00.000Z");
  const o = orderOf(second.state, orderId);
  assert.equal(o.etaAdjustments.length, 2);
  assert.equal(o.etaAdjustments[0].nextExpectedReadyAt, "2026-07-14T12:40:00.000Z");
  assert.equal(o.etaAdjustments[1].previousExpectedReadyAt, "2026-07-14T12:40:00.000Z");
  assert.equal(o.expectedReadyAt, "2026-07-14T12:35:00.000Z");
});

test("§17.17–25: снимки/оплата/водитель/состав/запросы не меняются", () => {
  const { state, orderId } = preparingState({ assignedDriverId: "driver-1", paidAt: "2026-07-14T11:59:00.000Z" });
  const before = orderOf(state, orderId);
  const res = adjustOrderExpectedReadyAt(state, orderId, NEXT_OK, "причина", "RESTAURANT", NOW);
  const after = orderOf(res.state, orderId);
  assert.equal(after.preparationMinutes, before.preparationMinutes);
  assert.equal(after.paymentStatus, before.paymentStatus);
  assert.equal(after.paidAt, before.paidAt);
  assert.deepEqual(after.financials, before.financials);
  assert.deepEqual(res.state.settlements, state.settlements);
  assert.equal(after.assignedDriverId, "driver-1");
  assert.deepEqual(res.state.drivers, state.drivers);
  assert.deepEqual(res.state.cancellationRequests, state.cancellationRequests);
  assert.deepEqual(after.items, before.items);
});

test("§17.26: getOrderStatusSince(PREPARING) не сбрасывается ETA-событием", () => {
  const { state, orderId } = preparingState();
  // Проставим настоящий PREPARING-переход в историю.
  const withTransition = {
    ...state,
    orders: state.orders.map((o) =>
      o.id === orderId
        ? {
            ...o,
            history: [
              {
                id: "h1",
                occurredAt: "2026-07-14T11:55:00.000Z",
                actor: "RESTAURANT" as const,
                type: "STATUS" as const,
                fromStatus: "RESTAURANT_REVIEW" as OrderStatus,
                toStatus: "PREPARING" as OrderStatus,
                message: "принят",
              },
            ],
          }
        : o,
    ),
  };
  const before = getOrderStatusSince(orderOf(withTransition, orderId), "PREPARING");
  const res = adjustOrderExpectedReadyAt(withTransition, orderId, NEXT_OK, "причина", "RESTAURANT", NOW);
  assert.equal(getOrderStatusSince(orderOf(res.state, orderId), "PREPARING"), before);
});

test("§17.27: ровно одно ETA-событие истории на корректировку", () => {
  const { state, orderId } = preparingState();
  const beforeLen = orderOf(state, orderId).history.length;
  const res = adjustOrderExpectedReadyAt(state, orderId, NEXT_OK, "причина", "RESTAURANT", NOW);
  const after = orderOf(res.state, orderId);
  const etaEvents = after.history.filter((e) => e.type === "ETA");
  assert.equal(etaEvents.length, 1);
  assert.equal(after.history.length, beforeLen + 1);
});

test("§17.28: ошибка не мутирует state", () => {
  const { state, orderId } = preparingState();
  const before = JSON.stringify(state);
  adjustOrderExpectedReadyAt(state, orderId, "плохо", "причина", "RESTAURANT", NOW);
  assert.equal(JSON.stringify(state), before);
});

// §5: настоящий тест legacy-нормализации (через реальный normalizer).
test("§5: legacy-заказ без etaAdjustments нормализуется в [] без потери данных", () => {
  const { state, orderId } = preparingState();
  const order = orderOf(state, orderId);
  // Имитируем старое состояние: у заказа НЕТ поля etaAdjustments.
  const legacyOrder: Record<string, unknown> = { ...order };
  delete legacyOrder.etaAdjustments;
  const legacyState = {
    ...state,
    orders: [legacyOrder],
  } as unknown as PrototypeState;

  const normalized = normalizePrototypeState(legacyState);
  const after = normalized.orders.find((o) => o.id === orderId)!;
  assert.equal(after.id, order.id);
  assert.equal(after.publicNumber, order.publicNumber);
  assert.deepEqual(after.customer, order.customer);
  assert.deepEqual(after.items, order.items);
  assert.deepEqual(after.financials, order.financials);
  assert.deepEqual(after.history, order.history);
  assert.deepEqual(after.etaAdjustments, []);
  // Заказ не заменён seed-данными.
  assert.equal(normalized.orders.length, 1);
});

test("§5: пользовательские заказы не заменяются seed после нормализации", () => {
  const { state, orderId } = preparingState();
  const normalized = normalizePrototypeState(state);
  assert.equal(normalized.orders.length, 1);
  assert.equal(normalized.orders[0].id, orderId);
});

// §6: усиленная валидация.
test("§6: невалидный nowIso отклоняется без мутации", () => {
  const { state, orderId } = preparingState();
  const before = JSON.stringify(state);
  const res = adjustOrderExpectedReadyAt(state, orderId, NEXT_OK, "причина", "RESTAURANT", "не дата");
  assert.equal(res.result.ok, false);
  assert.equal(JSON.stringify(state), before);
});

test("§6: причина длиной 301 символ отклоняется без мутации", () => {
  const { state, orderId } = preparingState();
  const before = JSON.stringify(state);
  const res = adjustOrderExpectedReadyAt(state, orderId, NEXT_OK, "x".repeat(301), "RESTAURANT", NOW);
  assert.equal(res.result.ok, false);
  assert.equal(JSON.stringify(state), before);
  // Ровно 300 — допускается.
  const ok = adjustOrderExpectedReadyAt(state, orderId, NEXT_OK, "y".repeat(300), "RESTAURANT", NOW);
  assert.equal(ok.result.ok, true);
});

// §7: actor в тексте истории.
test("§7: actor RESTAURANT — «Ресторан…», ADMIN — «Администратор Direct…»", () => {
  const rest = adjustOrderExpectedReadyAt(preparingState().state, "order-1001", NEXT_OK, "причина", "RESTAURANT", NOW);
  const restMsg = orderOf(rest.state, "order-1001").history.at(-1)!.message;
  assert.ok(restMsg.startsWith("Ресторан "));

  const adm = adjustOrderExpectedReadyAt(preparingState().state, "order-1001", NEXT_OK, "причина", "ADMIN", NOW);
  const admMsg = orderOf(adm.state, "order-1001").history.at(-1)!.message;
  assert.ok(admMsg.startsWith("Администратор Direct "));
});

// §1: intent + единая временная точка.
test("§1: FROM_NOW 1 успешно проходит (кандидат из intent = граница)", () => {
  const { state, orderId } = preparingState();
  const res = adjustOrderEtaFromIntent(state, orderId, { kind: "FROM_NOW", minutes: 1 }, "причина", "RESTAURANT", NOW);
  assert.equal(res.result.ok, true);
  assert.equal(res.result.nextExpectedReadyAt, "2026-07-14T12:01:00.000Z");
});

test("§1: domain и расчёт из intent используют один nowIso", () => {
  // Кандидат из intent на NOW и валидация на том же NOW → успех у самой границы.
  const intent = { kind: "FROM_NOW", minutes: 1 } as const;
  const candidate = computeEtaFromIntent(intent, CURRENT_ETA, NOW);
  assert.equal(validateEtaCandidate(candidate, NOW), null);
});

test("§1: EARLIER возле границы обрабатывается предсказуемо", () => {
  const { state, orderId } = preparingState();
  // ETA 12:20, EARLIER 25 → 11:55 (раньше now) → отклонено доменом.
  const tooEarly = adjustOrderEtaFromIntent(state, orderId, { kind: "EARLIER", minutes: 25 }, "причина", "RESTAURANT", NOW);
  assert.equal(tooEarly.result.ok, false);
  // EARLIER 5 → 12:15 (валидно) → успех.
  const ok = adjustOrderEtaFromIntent(state, orderId, { kind: "EARLIER", minutes: 5 }, "причина", "RESTAURANT", NOW);
  assert.equal(ok.result.ok, true);
  assert.equal(ok.result.nextExpectedReadyAt, "2026-07-14T12:15:00.000Z");
});

// =========================== §18 UI helpers ==================================

test("§18.1: +5 добавляет пять минут к текущему ETA", () => {
  assert.equal(computeDelayedEtaIso(CURRENT_ETA, 5, NOW), "2026-07-14T12:25:00.000Z");
});

test("§18.2: +10 при просроченном ETA использует now как базу", () => {
  const pastEta = "2026-07-14T11:50:00.000Z"; // раньше now
  assert.equal(computeDelayedEtaIso(pastEta, 10, NOW), "2026-07-14T12:10:00.000Z");
});

test("§18.3: -5 уменьшает текущее ETA", () => {
  assert.equal(computeEarlierEtaIso(CURRENT_ETA, 5), "2026-07-14T12:15:00.000Z");
});

test("§18.4: ранняя готовность не может уйти раньше now + 1 минута", () => {
  // Текущее ETA 12:20, вычитаем 25 мин → 11:55 (раньше now) → валидатор отклоняет.
  const candidate = computeEarlierEtaIso(CURRENT_ETA, 25);
  assert.ok(validateEtaCandidate(candidate, NOW) !== null);
});

test("§18.5: custom «через N минут» считается от now", () => {
  assert.equal(computeEtaFromNowIso(NOW, 45), "2026-07-14T12:45:00.000Z");
});

test("§18.6: разница определяется как delay/earlier", () => {
  assert.ok(computeEtaDeltaMinutes(CURRENT_ETA, NEXT_OK) > 0); // задержка
  assert.ok(computeEtaDeltaMinutes(CURRENT_ETA, "2026-07-14T12:15:00.000Z") < 0); // раньше
});

test("§3: ETA форматируется в timeZone ресторана (Chisinau/New_York/UTC)", () => {
  const iso = "2026-07-14T12:00:00.000Z";
  const { state, orderId } = preparingState();
  const order = orderOf(state, orderId);
  const withTz = (tz: string): PrototypeState => ({
    ...state,
    restaurants: state.restaurants.map((r) =>
      r.id === order.restaurant.id ? { ...r, timeZone: tz } : r,
    ),
  });
  const chi = formatOrderEtaInRestaurantZone(withTz("Europe/Chisinau"), order, iso);
  const ny = formatOrderEtaInRestaurantZone(withTz("America/New_York"), order, iso);
  const utc = formatOrderEtaInRestaurantZone(withTz("UTC"), order, iso);
  assert.notEqual(chi, ny);
  assert.notEqual(ny, utc);
  assert.notEqual(chi, utc);
});

test("§18.9: клиентская строка ETA — только HH:MM, без внутренней причины", () => {
  const { state, orderId } = preparingState();
  const res = adjustOrderExpectedReadyAt(state, orderId, NEXT_OK, "Недостаточно сотрудников", "RESTAURANT", NOW);
  const clock = formatOrderEtaClock(res.state, orderOf(res.state, orderId));
  assert.match(clock, /^\d{2}:\d{2}$/);
  assert.ok(!clock.toLowerCase().includes("сотрудник"));
});
