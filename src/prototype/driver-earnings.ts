import type {
  DriverEarningEntry,
  DriverEarningMode,
  Order,
  PrototypeState,
} from "./models";
import { getPlatformDriverCashSnapshot, getDriverActiveOrder } from "./selectors";
import { computeCompletedOrderAccounting } from "./restaurant-accounting";
import {
  customerCashCollectionEventId,
  hasValidPlatformDriverCustomerCashCollection,
  validatePreparedPlatformDriverCashCompletion,
} from "./platform-driver-cash-collection";
import { getPlatformDriverCashHandoffView } from "./platform-driver-cash-handoff";

/**
 * Единый журнал заработка водителя (v24).
 *
 * Чистый модуль: без React, provider, localStorage, finalizeMutation, UI,
 * Date.now и new Date — момент времени всегда приходит аргументом. Сумма
 * заработка ВСЕГДА равна order.financials.driverPayoutCents (или совпадающему с
 * ним snapshot.driverEarningCents для наличных) и НИКОГДА не пересчитывается по
 * актуальному тарифу, не округляется и не берётся из UI.
 *
 * Две экономические модели одной завершённой доставки PLATFORM_DRIVER:
 *  - ONLINE  → DIRECT_PAYOUT_DUE: деньги у Direct, он должен выплатить водителю;
 *  - CASH    → CASH_RETAINED: водитель уже удержал заработок из наличных.
 * Водитель никогда не должен Direct по этой модели.
 *
 * Модуль НЕ импортирует старый driver-cash-ledger и не использует его как
 * источник истины: единый заработок вычисляется только из снимка заказа.
 */

/** Fail-closed ошибка границы расчёта заработка водителя. */
export const DRIVER_EARNING_REVIEW_ERROR =
  "Данные расчёта водителя требуют проверки Direct.";

/** Детерминированный id записи заработка (не более одной на заказ). */
export function driverEarningEntryId(orderId: string): string {
  return `driver-earning-${orderId}`;
}

export type DriverEarningBuildResult =
  | { ok: true; entry: DriverEarningEntry }
  | { ok: false; error: string };

const fail = (): DriverEarningBuildResult => ({
  ok: false,
  error: DRIVER_EARNING_REVIEW_ERROR,
});

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Целое, безопасное, строго положительное. */
function safePositiveCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Записи заработка по заказу. */
function entriesForOrder(
  state: PrototypeState,
  orderId: string,
): DriverEarningEntry[] {
  return state.driverEarningEntries.filter((e) => e.orderId === orderId);
}

/** Ожидаемая запись заработка из заказа и момента признания. */
function makeEntry(
  order: Order,
  driverId: string,
  amountCents: number,
  mode: DriverEarningMode,
  recognizedAt: string,
): DriverEarningEntry {
  return {
    id: driverEarningEntryId(order.id),
    orderId: order.id,
    driverId,
    restaurantId: order.restaurant.id,
    currencyCode: order.financials.currencyCode,
    amountCents,
    mode,
    recognizedAt,
    source: "PLATFORM_DRIVER_ORDER",
  };
}

/** Совпадают ли все поля записи с ожидаемой (без «похожих» подстановок). */
function sameEntry(a: DriverEarningEntry, b: DriverEarningEntry): boolean {
  return (
    a.id === b.id &&
    a.orderId === b.orderId &&
    a.driverId === b.driverId &&
    a.restaurantId === b.restaurantId &&
    a.currencyCode === b.currencyCode &&
    a.amountCents === b.amountCents &&
    a.mode === b.mode &&
    a.recognizedAt === b.recognizedAt &&
    a.source === b.source
  );
}

/** Публичная проверка равенства (используется нормализацией хранилища). */
export function driverEarningEntriesEqual(
  a: DriverEarningEntry,
  b: DriverEarningEntry,
): boolean {
  return sameEntry(a, b);
}

/**
 * Общие инварианты новой записи заработка: заказ доставки водителем Direct,
 * назначенный существующий водитель и ресторан, валюта заказа, положительная
 * сумма и отсутствие уже признанного заработка этого заказа. Возвращает
 * driverId и currency, либо null.
 */
function baseEarningContext(
  state: PrototypeState,
  order: Order,
): { driverId: string; driverPayoutCents: number } | null {
  if (order.deliveryMode !== "PLATFORM_DRIVER") return null;
  const driverId = order.assignedDriverId;
  if (driverId === null) return null;
  if (!state.drivers.some((d) => d.id === driverId)) return null;
  if (!state.restaurants.some((r) => r.id === order.restaurant.id)) return null;
  if (order.financials.currencyCode !== "USD") return null;
  const driverPayoutCents = order.financials.driverPayoutCents;
  if (!safePositiveCents(driverPayoutCents)) return null;
  // Подготовленное/repeat-состояние проверяет отсутствие/наличие записи отдельно.
  return { driverId, driverPayoutCents };
}

/**
 * Запись заработка для ПОДГОТОВЛЕННОГО (ещё не финализированного) завершения.
 * Признаётся ровно один раз при переходе ARRIVING → DELIVERED.
 *
 * ONLINE: builder САМ fail-closed доказывает полный lifecycle (repair split №2),
 * не полагаясь на внешний action: заказ ARRIVING (не OUT_FOR_DELIVERY), водитель
 * BUSY_DIRECT и это его активный заказ, ровно одно ORDER_PICKED_UP
 * (READY→OUT_FOR_DELIVERY) и одно ARRIVING_TO_CUSTOMER (OUT_FOR_DELIVERY→ARRIVING)
 * ИМЕННО этого водителя, ноль ORDER_DELIVERED, валидная хронология
 * pickup ≤ arriving ≤ nowIso. События другого водителя доказательством не служат;
 * дубли одного типа — fail-closed (точное количество через filter, без find).
 *
 * CASH: сначала переиспользуется полная prepared-проверка наличного завершения
 * (validatePreparedPlatformDriverCashCompletion), затем строго сверяются
 * корректный снимок и каноническое движение денег CASH_TO_PLATFORM_DRIVER.
 */
export function buildPreparedDriverEarningEntry(
  state: PrototypeState,
  order: Order,
  nowIso: string,
): DriverEarningBuildResult {
  if (!isValidIso(nowIso)) return fail();
  const ctx = baseEarningContext(state, order);
  if (ctx === null) return fail();
  const { driverId, driverPayoutCents } = ctx;

  // Уже признанный заработок этого заказа исключает повторную подготовку.
  if (entriesForOrder(state, order.id).length !== 0) return fail();
  if (state.driverEarningEntries.some((e) => e.id === driverEarningEntryId(order.id))) {
    return fail();
  }

  if (order.paymentMethod === "ONLINE") {
    if (order.paymentStatus !== "PAID") return fail();
    // §7: только ARRIVING — завершение без шага «Я подъезжаю» запрещено.
    if (order.status !== "ARRIVING") return fail();

    // Идентичность и активный заказ проверяются на свежем state.
    const driver = state.drivers.find((d) => d.id === driverId);
    if (!driver || driver.status !== "BUSY_DIRECT") return fail();
    if (getDriverActiveOrder(state, driverId)?.id !== order.id) return fail();

    // Полное доказательство рабочего пути ИМЕННО этого водителя: точное
    // количество событий (filter, не find), точные переходы статусов.
    const picked = state.driverDeliveryEvents.filter(
      (e) =>
        e.orderId === order.id &&
        e.driverId === driverId &&
        e.type === "ORDER_PICKED_UP",
    );
    const arriving = state.driverDeliveryEvents.filter(
      (e) =>
        e.orderId === order.id &&
        e.driverId === driverId &&
        e.type === "ARRIVING_TO_CUSTOMER",
    );
    const delivered = state.driverDeliveryEvents.filter(
      (e) =>
        e.orderId === order.id &&
        e.driverId === driverId &&
        e.type === "ORDER_DELIVERED",
    );
    if (picked.length !== 1 || arriving.length !== 1 || delivered.length !== 0) {
      return fail();
    }
    if (
      picked[0].orderStatusBefore !== "READY" ||
      picked[0].orderStatusAfter !== "OUT_FOR_DELIVERY"
    ) {
      return fail();
    }
    if (
      arriving[0].orderStatusBefore !== "OUT_FOR_DELIVERY" ||
      arriving[0].orderStatusAfter !== "ARRIVING"
    ) {
      return fail();
    }

    // Хронология: pickup ≤ arriving ≤ nowIso (равное время разрешено).
    if (!isValidIso(picked[0].occurredAt) || !isValidIso(arriving[0].occurredAt)) {
      return fail();
    }
    const pickedMs = Date.parse(picked[0].occurredAt);
    const arrivingMs = Date.parse(arriving[0].occurredAt);
    const nowMs = Date.parse(nowIso);
    if (!(pickedMs <= arrivingMs && arrivingMs <= nowMs)) return fail();

    return {
      ok: true,
      entry: makeEntry(order, driverId, driverPayoutCents, "DIRECT_PAYOUT_DUE", nowIso),
    };
  }

  if (order.paymentMethod === "CASH") {
    const prepared = validatePreparedPlatformDriverCashCompletion(
      state,
      order,
      nowIso,
    );
    // Специфичная ошибка наличного завершения (например хронология) сохраняется.
    if (!prepared.ok) return { ok: false, error: prepared.error };

    const snapshot = getPlatformDriverCashSnapshot(order);
    if (snapshot === null) return fail();
    if (snapshot.driverEarningCents !== driverPayoutCents) return fail();
    if (
      snapshot.restaurantOwesDirectCents !==
      order.financials.platformGrossRevenueCents
    ) {
      return fail();
    }
    const fin = order.financials;
    if (fin.moneyMovementStatus !== "COMPLETE") return fail();
    const movement = fin.moneyMovement;
    if (!movement) return fail();
    if (movement.paymentChannel !== "CASH_TO_PLATFORM_DRIVER") return fail();
    if (movement.restaurantOwesDirectCents !== snapshot.restaurantOwesDirectCents) {
      return fail();
    }
    if (movement.directOwesRestaurantCents !== 0) return fail();

    return {
      ok: true,
      entry: makeEntry(
        order,
        driverId,
        snapshot.driverEarningCents,
        "CASH_RETAINED",
        nowIso,
      ),
    };
  }

  return fail();
}

/** Единственное событие доставки данного водителя по заказу. */
function deliveredEvent(
  state: PrototypeState,
  orderId: string,
  driverId: string,
): { occurredAt: string } | null {
  const delivered = state.driverDeliveryEvents.filter(
    (e) =>
      e.orderId === orderId &&
      e.driverId === driverId &&
      e.type === "ORDER_DELIVERED",
  );
  if (delivered.length !== 1) return null;
  if (!isValidIso(delivered[0].occurredAt)) return null;
  return { occurredAt: delivered[0].occurredAt };
}

/**
 * Ожидаемая запись заработка для УЖЕ завершённого заказа. Используется repeat
 * completion, проверкой целостности и нормализацией schema 24. Ничего не
 * мутирует и не создаёт задним числом.
 *
 * recognizedAt = момент события ORDER_DELIVERED. Для наличного заказа
 * дополнительно доказываются получение денег, передача ресторану, канал
 * CASH_TO_PLATFORM_DRIVER и уже признанное (или законно нулевое) обязательство
 * ресторана — без обращения к старому driver-cash-ledger.
 */
export function buildCompletedDriverEarningEntry(
  state: PrototypeState,
  order: Order,
): DriverEarningBuildResult {
  const ctx = baseEarningContext(state, order);
  if (ctx === null) return fail();
  const { driverId, driverPayoutCents } = ctx;

  if (order.status !== "DELIVERED") return fail();
  if (order.paymentStatus !== "PAID") return fail();

  const delivered = deliveredEvent(state, order.id, driverId);
  if (delivered === null) return fail();
  const recognizedAt = delivered.occurredAt;

  if (order.paymentMethod === "ONLINE") {
    return {
      ok: true,
      entry: makeEntry(
        order,
        driverId,
        driverPayoutCents,
        "DIRECT_PAYOUT_DUE",
        recognizedAt,
      ),
    };
  }

  if (order.paymentMethod === "CASH") {
    const snapshot = getPlatformDriverCashSnapshot(order);
    if (snapshot === null) return fail();
    if (snapshot.driverEarningCents !== driverPayoutCents) return fail();

    // Доказанное получение денег от клиента (внутри — и подтверждённая передача
    // ресторану, и согласованное завершённое состояние).
    if (!hasValidPlatformDriverCustomerCashCollection(state, order)) return fail();
    const handoff = getPlatformDriverCashHandoffView(state, order);
    if (handoff.status !== "CONFIRMED" || !isValidIso(handoff.restaurantConfirmedAt)) {
      return fail();
    }

    // Каноническое движение денег наличного заказа.
    const fin = order.financials;
    if (fin.moneyMovementStatus !== "COMPLETE") return fail();
    const movement = fin.moneyMovement;
    if (!movement) return fail();
    if (movement.paymentChannel !== "CASH_TO_PLATFORM_DRIVER") return fail();
    if (movement.restaurantOwesDirectCents !== snapshot.restaurantOwesDirectCents) {
      return fail();
    }
    if (movement.directOwesRestaurantCents !== 0) return fail();

    // Обязательство ресторана уже признано и совпадает, либо законно нулевое:
    // computeCompletedOrderAccounting возвращает пустой список новых записей.
    const accounting = computeCompletedOrderAccounting(
      order,
      state.restaurantAccountingEntries,
    );
    if (!accounting.ok || accounting.entries.length !== 0) return fail();

    // Момент получения денег совпадает с признанием и оплатой.
    const collectionEvents = state.platformDriverCashEvents.filter(
      (e) =>
        e.orderId === order.id &&
        e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
    );
    if (collectionEvents.length !== 1) return fail();
    const collectionEvent = collectionEvents[0];
    if (collectionEvent.id !== customerCashCollectionEventId(order.id)) return fail();
    if (!isValidIso(collectionEvent.occurredAt)) return fail();
    if (collectionEvent.occurredAt !== recognizedAt) return fail();
    if (order.paidAt !== recognizedAt) return fail();

    return {
      ok: true,
      entry: makeEntry(
        order,
        driverId,
        snapshot.driverEarningCents,
        "CASH_RETAINED",
        recognizedAt,
      ),
    };
  }

  return fail();
}

/**
 * Признано ли обязательство ресторана завершённого заказа (или законно нулевое):
 * computeCompletedOrderAccounting не предлагает новых записей. Обёртка, чтобы
 * рабочий путь водителя не импортировал финансовые модули напрямую (формулы не
 * дублируются — единственный источник по-прежнему движение денег снимка).
 */
export function hasRecognizedCompletedOrderAccounting(
  state: PrototypeState,
  order: Order,
): boolean {
  const accounting = computeCompletedOrderAccounting(
    order,
    state.restaurantAccountingEntries,
  );
  return accounting.ok && accounting.entries.length === 0;
}

/**
 * Есть ли у завершённого заказа ровно одна корректная запись заработка. Любое
 * расхождение — false; запись не исправляется, «похожая» не выбирается.
 */
export function hasValidDriverEarningEntry(
  state: PrototypeState,
  order: Order,
): boolean {
  const expected = buildCompletedDriverEarningEntry(state, order);
  if (!expected.ok) return false;
  const entries = entriesForOrder(state, order.id);
  if (entries.length !== 1) return false;
  const entry = entries[0];
  if (entry.id !== driverEarningEntryId(order.id)) return false;
  if (!sameEntry(entry, expected.entry)) return false;
  // Тот же id не должен использоваться другой записью.
  if (state.driverEarningEntries.filter((e) => e.id === entry.id).length !== 1) {
    return false;
  }
  return true;
}
