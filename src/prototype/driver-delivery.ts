import type {
  DriverDeliveryEvent,
  DriverDeliveryEventType,
  DriverProfile,
  Order,
  OrderHistoryEvent,
  PrototypeState,
} from "./models";
import type { ActionResult } from "./actions";
import { applyDriverDeliveredOrder } from "./actions";
import { finalizeMutation } from "./prototype-store";
import { getDriverActiveOrder } from "./selectors";
import {
  hasRestaurantConfirmedDriverCashHandoff,
  getPlatformDriverCashHandoffView,
} from "./platform-driver-cash-handoff";
import {
  customerCashCollectionEventId,
  hasValidPlatformDriverCustomerCashCollection,
} from "./platform-driver-cash-collection";
import {
  hasValidDriverCashLedgerEntry,
  DRIVER_CASH_LEDGER_REVIEW_ERROR,
} from "./driver-cash-ledger";
import { getPlatformDriverCashSnapshot } from "./selectors";
import type { PlatformDriverCashEvent } from "./models";

/** Явный ввод завершения доставки: наличные требуют подтверждения получения. */
export interface CompleteDriverDeliveryInput {
  cashCollectionConfirmed: boolean;
}

/** Поддерживаемый водителем канал: онлайн-оплаченный ЛИБО наличный заказ. */
function isDriverDeliverableOrder(order: Order): boolean {
  const online = order.paymentMethod === "ONLINE" && order.paymentStatus === "PAID";
  const cash =
    order.paymentMethod === "CASH" && order.paymentStatus === "CASH_ON_DELIVERY";
  return online || cash;
}

/**
 * Рабочий путь назначенного водителя Direct по оплаченному онлайн-заказу (v18):
 * прибытие в ресторан → получение заказа → подъезд к клиенту → доставка.
 *
 * Домен чистый: момент времени — всегда аргумент. Каждое действие само проверяет
 * личность водителя на СВЕЖЕМ state (identity guard), а не полагается на выбор
 * в React. Журнал driverDeliveryEvents append-only и детерминированный. Финансы
 * при доставке признаются единственным каноническим завершителем
 * (applyDriverDeliveredOrder) — формулы здесь не копируются и не дублируются.
 */

export interface DriverDeliveryActionResult {
  ok: boolean;
  error: string | null;
  orderId: string | null;
}

/** Этап рабочего пути водителя для UI. */
export type DriverDeliveryStage =
  | "GO_TO_RESTAURANT"
  | "WAITING_AT_RESTAURANT"
  | "READY_TO_PICK_UP"
  | "GO_TO_CUSTOMER"
  | "ARRIVING_TO_CUSTOMER"
  | "REVIEW_REQUIRED";

/** Детерминированный id: одно событие на orderId+driverId+type. */
export function driverDeliveryEventId(
  orderId: string,
  driverId: string,
  type: DriverDeliveryEventType,
): string {
  return `driver-delivery-${orderId}-${driverId}-${type}`;
}

/** Есть ли событие данного типа именно этого водителя по этому заказу. */
function hasEvent(
  state: PrototypeState,
  orderId: string,
  driverId: string,
  type: DriverDeliveryEventType,
): boolean {
  return state.driverDeliveryEvents.some(
    (event) =>
      event.orderId === orderId &&
      event.driverId === driverId &&
      event.type === type,
  );
}

const TERMINAL_STATUSES: ReadonlySet<Order["status"]> = new Set([
  "DELIVERED",
  "PICKED_UP",
  "CANCELED",
]);

interface GuardOk {
  ok: true;
  order: Order;
  driver: DriverProfile;
}
interface GuardFail {
  ok: false;
  error: string;
}

/**
 * Обязательная проверка личности водителя над свежим state. Ни одно рабочее
 * действие не выполняется, если заказ назначен не этому водителю, водитель не
 * BUSY_DIRECT или активный заказ водителя — не этот. Ошибка ничего не меняет.
 */
function guardDriverOrder(
  state: PrototypeState,
  driverId: string,
  orderId: string,
): GuardOk | GuardFail {
  const driver = state.drivers.find((d) => d.id === driverId);
  if (!driver) return { ok: false, error: "У вас нет этого активного заказа." };
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return { ok: false, error: "У вас нет этого активного заказа." };

  if (order.deliveryMode !== "PLATFORM_DRIVER") {
    return { ok: false, error: "Действие недоступно на текущем этапе заказа." };
  }
  if (!isDriverDeliverableOrder(order)) {
    return { ok: false, error: "Действие недоступно на текущем этапе заказа." };
  }
  if (order.assignedDriverId !== driverId) {
    return { ok: false, error: "Этот заказ назначен другому водителю." };
  }
  if (TERMINAL_STATUSES.has(order.status)) {
    return { ok: false, error: "Действие недоступно на текущем этапе заказа." };
  }
  if (driver.status !== "BUSY_DIRECT") {
    return { ok: false, error: "У вас нет этого активного заказа." };
  }
  if (getDriverActiveOrder(state, driverId)?.id !== orderId) {
    return { ok: false, error: "У вас нет этого активного заказа." };
  }
  return { ok: true, order, driver };
}

function fail(
  state: PrototypeState,
  error: string,
): ActionResult<DriverDeliveryActionResult> {
  return { state, result: { ok: false, error, orderId: null } };
}

function okNoop(
  state: PrototypeState,
  orderId: string,
): ActionResult<DriverDeliveryActionResult> {
  return { state, result: { ok: true, error: null, orderId } };
}

/** Строит событие журнала (append-only, только связь и переход статуса). */
function makeEvent(
  order: Order,
  driverId: string,
  type: DriverDeliveryEventType,
  before: Order["status"],
  after: Order["status"],
  nowIso: string,
): DriverDeliveryEvent {
  return {
    id: driverDeliveryEventId(order.id, driverId, type),
    orderId: order.id,
    driverId,
    type,
    occurredAt: nowIso,
    orderStatusBefore: before,
    orderStatusAfter: after,
  };
}

/** Событие истории заказа (нейтральный actor SYSTEM — точный водитель в журнале). */
function makeHistory(
  order: Order,
  before: Order["status"],
  after: Order["status"],
  message: string,
  nowIso: string,
): OrderHistoryEvent {
  return {
    id: `${order.id}-history-${order.history.length + 1}`,
    occurredAt: nowIso,
    actor: "SYSTEM",
    type: "STATUS",
    fromStatus: before,
    toStatus: after,
    message,
  };
}

/**
 * Общий финализатор шага с переходом статуса: обновляет заказ (статус + история),
 * добавляет событие журнала и финализирует мутацию один раз.
 */
function commitStep(
  state: PrototypeState,
  order: Order,
  driverId: string,
  type: DriverDeliveryEventType,
  before: Order["status"],
  after: Order["status"],
  historyMessage: string,
  nowIso: string,
): ActionResult<DriverDeliveryActionResult> {
  const updatedOrder: Order = {
    ...order,
    status: after,
    updatedAt: nowIso,
    history: [
      ...order.history,
      makeHistory(order, before, after, historyMessage, nowIso),
    ],
  };
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) => (o.id === order.id ? updatedOrder : o)),
      driverDeliveryEvents: [
        ...state.driverDeliveryEvents,
        makeEvent(order, driverId, type, before, after, nowIso),
      ],
    },
    nowIso,
  );
  return { state: nextState, result: { ok: true, error: null, orderId: order.id } };
}

// --- «Я в ресторане» -----------------------------------------------------------

/**
 * Водитель прибыл в ресторан. Разрешено при PREPARING/READY. Статус заказа НЕ
 * меняется — фиксируется только факт прибытия. Повторное нажатие — успешный
 * no-op без новой записи и без роста ревизии.
 */
export function markDriverArrivedAtRestaurant(
  state: PrototypeState,
  driverId: string,
  orderId: string,
  nowIso: string,
): ActionResult<DriverDeliveryActionResult> {
  const guard = guardDriverOrder(state, driverId, orderId);
  if (!guard.ok) return fail(state, guard.error);
  const { order } = guard;

  if (order.status !== "PREPARING" && order.status !== "READY") {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (hasEvent(state, orderId, driverId, "ARRIVED_AT_RESTAURANT")) {
    return okNoop(state, orderId);
  }

  // Статус не меняется: before === after.
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      orders: state.orders.map((o) =>
        o.id === orderId
          ? {
              ...o,
              updatedAt: nowIso,
              history: [
                ...o.history,
                makeHistory(
                  o,
                  o.status,
                  o.status,
                  `${guard.driver.name} прибыл в ресторан.`,
                  nowIso,
                ),
              ],
            }
          : o,
      ),
      driverDeliveryEvents: [
        ...state.driverDeliveryEvents,
        makeEvent(
          order,
          driverId,
          "ARRIVED_AT_RESTAURANT",
          order.status,
          order.status,
          nowIso,
        ),
      ],
    },
    nowIso,
  );
  return { state: nextState, result: { ok: true, error: null, orderId } };
}

// --- «Заказ получен» -----------------------------------------------------------

/**
 * Водитель забрал заказ: READY → OUT_FOR_DELIVERY. Требуется предварительное
 * прибытие ИМЕННО этого водителя. Повторное действие — успешный no-op.
 */
export function markDriverPickedUpOrder(
  state: PrototypeState,
  driverId: string,
  orderId: string,
  nowIso: string,
): ActionResult<DriverDeliveryActionResult> {
  const guard = guardDriverOrder(state, driverId, orderId);
  if (!guard.ok) return fail(state, guard.error);
  const { order } = guard;

  if (hasEvent(state, orderId, driverId, "ORDER_PICKED_UP")) {
    return okNoop(state, orderId);
  }
  if (!hasEvent(state, orderId, driverId, "ARRIVED_AT_RESTAURANT")) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (order.status !== "READY") {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  // Наличный заказ нельзя забрать, пока ресторан не подтвердил получение денег.
  if (
    order.paymentMethod === "CASH" &&
    !hasRestaurantConfirmedDriverCashHandoff(state, order)
  ) {
    return fail(state, "Ресторан ещё не подтвердил получение наличных.");
  }
  return commitStep(
    state,
    order,
    driverId,
    "ORDER_PICKED_UP",
    "READY",
    "OUT_FOR_DELIVERY",
    `${guard.driver.name} получил заказ в ресторане.`,
    nowIso,
  );
}

// --- «Я подъезжаю» -------------------------------------------------------------

/**
 * Водитель подъезжает к клиенту: OUT_FOR_DELIVERY → ARRIVING. Требуется, чтобы
 * заказ был получен этим водителем. Повторное действие — успешный no-op.
 */
export function markDriverArrivingToCustomer(
  state: PrototypeState,
  driverId: string,
  orderId: string,
  nowIso: string,
): ActionResult<DriverDeliveryActionResult> {
  const guard = guardDriverOrder(state, driverId, orderId);
  if (!guard.ok) return fail(state, guard.error);
  const { order } = guard;

  if (hasEvent(state, orderId, driverId, "ARRIVING_TO_CUSTOMER")) {
    return okNoop(state, orderId);
  }
  if (!hasEvent(state, orderId, driverId, "ORDER_PICKED_UP")) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (order.status !== "OUT_FOR_DELIVERY") {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  return commitStep(
    state,
    order,
    driverId,
    "ARRIVING_TO_CUSTOMER",
    "OUT_FOR_DELIVERY",
    "ARRIVING",
    `${guard.driver.name} подъезжает к клиенту.`,
    nowIso,
  );
}

// --- «Заказ доставлен» ---------------------------------------------------------

/**
 * Водитель доставил заказ: ARRIVING → DELIVERED (атомарно с признанием
 * обязательств и переводом водителя на подтверждение зоны). Accounting
 * создаётся ровно один раз через канонический applyDriverDeliveredOrder.
 *
 * Fail-closed: при ошибке accounting заказ остаётся ARRIVING, водитель —
 * BUSY_DIRECT, событие и история не пишутся, revision не растёт. Повторная
 * доставка уже завершённого этим водителем заказа — успешный no-op без второго
 * accounting и без второго события.
 */
export function markDriverDeliveredOrder(
  state: PrototypeState,
  driverId: string,
  orderId: string,
  nowIso: string,
  input: CompleteDriverDeliveryInput,
): ActionResult<DriverDeliveryActionResult> {
  // No-op ДО guard: после доставки водитель уже не BUSY_DIRECT и заказ не
  // активен, поэтому обычный guard не пройдёт — но повтор должен быть успешным.
  const existingOrder = state.orders.find((o) => o.id === orderId);
  if (
    existingOrder &&
    existingOrder.status === "DELIVERED" &&
    existingOrder.assignedDriverId === driverId &&
    hasEvent(state, orderId, driverId, "ORDER_DELIVERED")
  ) {
    // Наличный завершённый заказ считается успешным повтором ТОЛЬКО при
    // полностью согласованном получении денег; иначе — fail-closed review.
    if (existingOrder.paymentMethod === "CASH") {
      // Успешный повтор требует и доказанного получения денег, и корректной
      // записи расчёта водителя. Задним числом ledger здесь НЕ создаётся.
      if (!hasValidPlatformDriverCustomerCashCollection(state, existingOrder)) {
        return fail(state, "Данные наличной доставки требуют проверки Direct.");
      }
      if (!hasValidDriverCashLedgerEntry(state, existingOrder)) {
        return fail(state, DRIVER_CASH_LEDGER_REVIEW_ERROR);
      }
      return okNoop(state, orderId);
    }
    return okNoop(state, orderId);
  }

  const guard = guardDriverOrder(state, driverId, orderId);
  if (!guard.ok) return fail(state, guard.error);
  const { order } = guard;

  if (!hasEvent(state, orderId, driverId, "ARRIVING_TO_CUSTOMER")) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (order.status !== "ARRIVING") {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }

  // Наличный заказ: получение полной суммы от клиента и завершение доставки —
  // одна атомарная мутация (см. completeCashDelivery).
  if (order.paymentMethod === "CASH") {
    return completeCashDelivery(state, order, driverId, nowIso, input);
  }

  // ONLINE: единственный канонический завершитель — признаёт обязательства из
  // снимка, освобождает водителя на подтверждение зоны, формулы не дублирует.
  const completion = applyDriverDeliveredOrder(state, order, nowIso);
  if (!completion.ok) {
    return fail(state, completion.error);
  }

  const nextState = finalizeMutation(
    state,
    {
      ...completion.state,
      driverDeliveryEvents: [
        ...completion.state.driverDeliveryEvents,
        makeEvent(order, driverId, "ORDER_DELIVERED", "ARRIVING", "DELIVERED", nowIso),
      ],
    },
    nowIso,
  );
  return { state: nextState, result: { ok: true, error: null, orderId } };
}

/**
 * Атомарное получение полной суммы наличными от клиента + завершение доставки.
 *
 * Сумма берётся только из cash snapshot (customerCollectionCents) — ни из UI, ни
 * из аргумента. Одной мутацией: событие получения денег, paymentStatus=PAID,
 * paidAt=nowIso, ARRIVING→DELIVERED, ORDER_DELIVERED, одна история, освобождение
 * водителя на подтверждение зоны, ровно один рост ревизии. Промежуточного
 * сохранённого состояния «деньги получены, но заказ ещё ARRIVING» не существует:
 * при любой ошибке возвращается ИСХОДНЫЙ state.
 *
 * Для наличного заказа обязательства ресторана НЕ создаются (ресторан уже
 * получил свою сумму от водителя) — см. applyDriverDeliveredOrder.
 */
function completeCashDelivery(
  state: PrototypeState,
  order: Order,
  driverId: string,
  nowIso: string,
  input: CompleteDriverDeliveryInput,
): ActionResult<DriverDeliveryActionResult> {
  if (!input.cashCollectionConfirmed) {
    return fail(
      state,
      "Перед завершением подтвердите получение полной суммы наличными от клиента.",
    );
  }

  const snapshot = getPlatformDriverCashSnapshot(order);
  if (snapshot === null) {
    return fail(state, "Данные наличной доставки требуют проверки Direct.");
  }
  if (order.paymentStatus !== "CASH_ON_DELIVERY" || order.paidAt !== null) {
    return fail(state, "Данные наличной доставки требуют проверки Direct.");
  }

  // Передача ресторану обязана быть подтверждена (это же проверяет и pickup).
  const handoff = getPlatformDriverCashHandoffView(state, order);
  if (handoff.status !== "CONFIRMED" || handoff.restaurantConfirmedAt === null) {
    return fail(state, "Ресторан ещё не подтвердил получение наличных.");
  }

  const picked = state.driverDeliveryEvents.find(
    (e) =>
      e.orderId === order.id &&
      e.driverId === driverId &&
      e.type === "ORDER_PICKED_UP",
  );
  const arriving = state.driverDeliveryEvents.find(
    (e) =>
      e.orderId === order.id &&
      e.driverId === driverId &&
      e.type === "ARRIVING_TO_CUSTOMER",
  );
  if (!picked || !arriving) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }
  if (
    state.platformDriverCashEvents.some(
      (e) =>
        e.orderId === order.id &&
        e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
    )
  ) {
    return fail(state, "Получение наличных уже подтверждено.");
  }
  if (hasEvent(state, order.id, driverId, "ORDER_DELIVERED")) {
    return fail(state, "Действие недоступно на текущем этапе заказа.");
  }

  // Хронология: получение денег не раньше подтверждения ресторана, получения
  // заказа и подъезда к клиенту. Равное время разрешено.
  const nowMs = Date.parse(nowIso);
  const confirmedMs = Date.parse(handoff.restaurantConfirmedAt);
  const pickedMs = Date.parse(picked.occurredAt);
  const arrivingMs = Date.parse(arriving.occurredAt);
  if (
    Number.isNaN(nowMs) ||
    Number.isNaN(confirmedMs) ||
    Number.isNaN(pickedMs) ||
    Number.isNaN(arrivingMs)
  ) {
    return fail(state, "Данные наличной доставки требуют проверки Direct.");
  }
  if (nowMs < confirmedMs || nowMs < pickedMs || nowMs < arrivingMs) {
    return fail(state, "Некорректное время подтверждения получения наличных.");
  }

  const collectionEvent: PlatformDriverCashEvent = {
    id: customerCashCollectionEventId(order.id),
    orderId: order.id,
    driverId,
    restaurantId: order.restaurant.id,
    type: "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
    amountCents: snapshot.customerCollectionCents,
    occurredAt: nowIso,
    actor: "DRIVER",
    restaurantWorkspaceRole: null,
  };
  const paidOrder: Order = {
    ...order,
    paymentStatus: "PAID",
    paidAt: nowIso,
  };
  // Нефинализированное промежуточное состояние: событие + оплаченный заказ.
  const interim: PrototypeState = {
    ...state,
    orders: state.orders.map((o) => (o.id === order.id ? paidOrder : o)),
    platformDriverCashEvents: [...state.platformDriverCashEvents, collectionEvent],
  };
  const completion = applyDriverDeliveredOrder(interim, paidOrder, nowIso);
  if (!completion.ok) {
    // Ничего не сохраняем: исходный state, revision не растёт.
    return fail(state, completion.error);
  }

  const nextState = finalizeMutation(
    state,
    {
      ...completion.state,
      driverDeliveryEvents: [
        ...completion.state.driverDeliveryEvents,
        makeEvent(order, driverId, "ORDER_DELIVERED", "ARRIVING", "DELIVERED", nowIso),
      ],
    },
    nowIso,
  );
  return { state: nextState, result: { ok: true, error: null, orderId: order.id } };
}

// --- Resolver этапа ------------------------------------------------------------

/**
 * Текущий этап рабочего пути водителя. Любая противоречивая комбинация (заказ не
 * его, водитель не BUSY_DIRECT, статус перескочил этап, событие принадлежит
 * старому водителю, неподдерживаемый способ оплаты и т.п.) даёт REVIEW_REQUIRED:
 * такие данные не «чинятся» автоматически.
 */
export function resolveDriverDeliveryStage(
  state: PrototypeState,
  driverId: string,
  orderId: string,
): DriverDeliveryStage {
  const driver = state.drivers.find((d) => d.id === driverId);
  const order = state.orders.find((o) => o.id === orderId);
  if (!driver || !order) return "REVIEW_REQUIRED";
  if (order.deliveryMode !== "PLATFORM_DRIVER") return "REVIEW_REQUIRED";
  if (!isDriverDeliverableOrder(order)) return "REVIEW_REQUIRED";
  if (order.assignedDriverId !== driverId) return "REVIEW_REQUIRED";
  if (driver.status !== "BUSY_DIRECT") return "REVIEW_REQUIRED";
  if (getDriverActiveOrder(state, driverId)?.id !== orderId) {
    return "REVIEW_REQUIRED";
  }

  const arrived = hasEvent(state, orderId, driverId, "ARRIVED_AT_RESTAURANT");
  const pickedUp = hasEvent(state, orderId, driverId, "ORDER_PICKED_UP");
  const arriving = hasEvent(state, orderId, driverId, "ARRIVING_TO_CUSTOMER");

  switch (order.status) {
    case "PREPARING":
      return arrived ? "WAITING_AT_RESTAURANT" : "GO_TO_RESTAURANT";
    case "READY":
      if (!arrived) return "GO_TO_RESTAURANT";
      // Получение ещё не отмечено (иначе статус был бы OUT_FOR_DELIVERY).
      return pickedUp ? "REVIEW_REQUIRED" : "READY_TO_PICK_UP";
    case "OUT_FOR_DELIVERY":
      // Без события получения именно этого водителя — противоречие.
      return pickedUp ? "GO_TO_CUSTOMER" : "REVIEW_REQUIRED";
    case "ARRIVING":
      return arriving ? "ARRIVING_TO_CUSTOMER" : "REVIEW_REQUIRED";
    default:
      return "REVIEW_REQUIRED";
  }
}
