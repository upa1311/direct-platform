import type {
  DriverCashLedgerEntry,
  Order,
  PrototypeState,
} from "./models";
import { getPlatformDriverCashSnapshot } from "./selectors";
import {
  customerCashCollectionEventId,
  getPlatformDriverCustomerCashCollectionView,
  validatePreparedPlatformDriverCashCompletion,
} from "./platform-driver-cash-collection";

/**
 * Расчёты водителя по завершённым наличным доставкам (v23).
 *
 * Чистый модуль: без React, provider, localStorage, finalizeMutation, UI и
 * Date.now — момент времени всегда приходит аргументом. Суммы копируются из
 * неизменяемого cash snapshot заказа и НИКОГДА не пересчитываются, не
 * округляются и не выводятся как остаток.
 *
 * Две разные экономические категории и их нельзя смешивать:
 *  - driverEarningCents — заработок, уже удержанный водителем из наличных;
 *  - directReceivableFromDriverCents — деньги Direct, пока находящиеся у
 *    водителя. Netting (вычитание) здесь не выполняется ни при каких условиях.
 */

/** Fail-closed ошибка границы расчётов водителя. */
export const DRIVER_CASH_LEDGER_REVIEW_ERROR =
  "Данные расчёта водителя требуют проверки Direct.";

/** Детерминированный id записи расчёта (не более одной на заказ). */
export function driverCashLedgerEntryId(orderId: string): string {
  return `driver-cash-ledger-${orderId}`;
}

export type DriverCashLedgerBuildResult =
  | { ok: true; entry: DriverCashLedgerEntry }
  | { ok: false; error: string };

export interface DriverCashLedgerEntryView {
  entry: DriverCashLedgerEntry;
  order: Order;
}

export interface DriverCashLedgerView {
  entries: DriverCashLedgerEntryView[];
  cashDeliveryCount: number;
  cashEarningsCents: number;
  dueToDirectCents: number;
  reviewRequired: boolean;
}

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

const fail = (): DriverCashLedgerBuildResult => ({
  ok: false,
  error: DRIVER_CASH_LEDGER_REVIEW_ERROR,
});

/** Целое, безопасное, неотрицательное. */
function safeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Собственная граница проверки сумм: даже если snapshot builder уже проверил
 * равенство, ledger обязан доказать его сам перед признанием обязательства.
 */
function amountsConsistent(snapshot: {
  customerCollectionCents: number;
  restaurantHandoffCents: number;
  driverEarningCents: number;
  directReceivableFromDriverCents: number;
}): boolean {
  const {
    customerCollectionCents,
    restaurantHandoffCents,
    driverEarningCents,
    directReceivableFromDriverCents,
  } = snapshot;
  if (
    !safeCents(customerCollectionCents) ||
    !safeCents(restaurantHandoffCents) ||
    !safeCents(driverEarningCents) ||
    !safeCents(directReceivableFromDriverCents)
  ) {
    return false;
  }
  if (customerCollectionCents <= 0) return false;
  if (restaurantHandoffCents <= 0) return false;
  if (driverEarningCents <= 0) return false;
  return (
    customerCollectionCents ===
    restaurantHandoffCents + driverEarningCents + directReceivableFromDriverCents
  );
}

/** Записи расчёта по заказу. */
function entriesForOrder(
  state: PrototypeState,
  orderId: string,
): DriverCashLedgerEntry[] {
  return state.driverCashLedgerEntries.filter((e) => e.orderId === orderId);
}

/** Ожидаемая запись из snapshot заказа и момента признания. */
function makeEntry(
  order: Order,
  driverId: string,
  snapshot: {
    customerCollectionCents: number;
    restaurantHandoffCents: number;
    driverEarningCents: number;
    directReceivableFromDriverCents: number;
  },
  recognizedAt: string,
): DriverCashLedgerEntry {
  return {
    id: driverCashLedgerEntryId(order.id),
    orderId: order.id,
    driverId,
    restaurantId: order.restaurant.id,
    currencyCode: order.financials.currencyCode,
    customerCollectionCents: snapshot.customerCollectionCents,
    restaurantHandoffCents: snapshot.restaurantHandoffCents,
    driverEarningCents: snapshot.driverEarningCents,
    directReceivableFromDriverCents: snapshot.directReceivableFromDriverCents,
    recognizedAt,
    source: "PLATFORM_DRIVER_CASH_ORDER",
  };
}

/**
 * Запись для ПОДГОТОВЛЕННОГО (ещё не финализированного) наличного завершения.
 * Сначала переиспользует полную prepared-проверку доставки, затем доказывает
 * суммы и отсутствие уже признанного расчёта по этому заказу.
 */
export function buildPreparedDriverCashLedgerEntry(
  state: PrototypeState,
  order: Order,
  nowIso: string,
): DriverCashLedgerBuildResult {
  const prepared = validatePreparedPlatformDriverCashCompletion(
    state,
    order,
    nowIso,
  );
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const snapshot = getPlatformDriverCashSnapshot(order);
  if (snapshot === null) return fail();
  if (!amountsConsistent(snapshot)) return fail();
  const driverId = order.assignedDriverId;
  if (driverId === null) return fail();
  // Подготовленное ARRIVING-состояние не может уже иметь признанный расчёт.
  if (entriesForOrder(state, order.id).length !== 0) return fail();
  if (
    state.driverCashLedgerEntries.some(
      (e) => e.id === driverCashLedgerEntryId(order.id),
    )
  ) {
    return fail();
  }
  return { ok: true, entry: makeEntry(order, driverId, snapshot, nowIso) };
}

/**
 * Ожидаемая запись для УЖЕ завершённого наличного заказа. Используется миграцией
 * schema 22 → 23 и проверкой целостности. Ничего не мутирует и не записывает.
 */
export function buildCompletedDriverCashLedgerEntry(
  state: PrototypeState,
  order: Order,
): DriverCashLedgerBuildResult {
  if (order.deliveryMode !== "PLATFORM_DRIVER") return fail();
  if (order.paymentMethod !== "CASH") return fail();
  if (order.status !== "DELIVERED") return fail();
  if (order.paymentStatus !== "PAID") return fail();
  if (!isValidIso(order.paidAt)) return fail();
  const driverId = order.assignedDriverId;
  if (driverId === null) return fail();

  const snapshot = getPlatformDriverCashSnapshot(order);
  if (snapshot === null) return fail();
  if (!amountsConsistent(snapshot)) return fail();

  // Полностью доказанное получение денег от клиента.
  const collection = getPlatformDriverCustomerCashCollectionView(state, order);
  if (collection.status !== "COLLECTED") return fail();

  const collectionEvents = state.platformDriverCashEvents.filter(
    (e) =>
      e.orderId === order.id &&
      e.type === "DRIVER_CONFIRMED_CUSTOMER_CASH_COLLECTION",
  );
  if (collectionEvents.length !== 1) return fail();
  const collectionEvent = collectionEvents[0];
  if (collectionEvent.id !== customerCashCollectionEventId(order.id)) return fail();

  const delivered = state.driverDeliveryEvents.filter(
    (e) =>
      e.orderId === order.id &&
      e.driverId === driverId &&
      e.type === "ORDER_DELIVERED",
  );
  if (delivered.length !== 1) return fail();

  const recognizedAt = collectionEvent.occurredAt;
  if (!isValidIso(recognizedAt)) return fail();
  if (recognizedAt !== order.paidAt) return fail();
  if (recognizedAt !== delivered[0].occurredAt) return fail();

  return { ok: true, entry: makeEntry(order, driverId, snapshot, recognizedAt) };
}

/** Совпадают ли все поля записи с ожидаемой (без «похожих» подстановок). */
export function driverCashLedgerEntriesEqual(
  a: DriverCashLedgerEntry,
  b: DriverCashLedgerEntry,
): boolean {
  return sameEntry(a, b);
}

function sameEntry(a: DriverCashLedgerEntry, b: DriverCashLedgerEntry): boolean {
  return (
    a.id === b.id &&
    a.orderId === b.orderId &&
    a.driverId === b.driverId &&
    a.restaurantId === b.restaurantId &&
    a.currencyCode === b.currencyCode &&
    a.customerCollectionCents === b.customerCollectionCents &&
    a.restaurantHandoffCents === b.restaurantHandoffCents &&
    a.driverEarningCents === b.driverEarningCents &&
    a.directReceivableFromDriverCents === b.directReceivableFromDriverCents &&
    a.recognizedAt === b.recognizedAt &&
    a.source === b.source
  );
}

/**
 * Есть ли у завершённого наличного заказа ровно одна корректная запись расчёта.
 * Любое расхождение — false; запись не исправляется и не подменяется.
 */
export function hasValidDriverCashLedgerEntry(
  state: PrototypeState,
  order: Order,
): boolean {
  const expected = buildCompletedDriverCashLedgerEntry(state, order);
  if (!expected.ok) return false;
  const entries = entriesForOrder(state, order.id);
  if (entries.length !== 1) return false;
  const entry = entries[0];
  if (entry.id !== driverCashLedgerEntryId(order.id)) return false;
  if (!sameEntry(entry, expected.entry)) return false;
  // Тот же id не должен использоваться другой записью.
  if (state.driverCashLedgerEntries.filter((e) => e.id === entry.id).length !== 1) {
    return false;
  }
  return true;
}

/**
 * Раздел «Расчёты» водителя: только его записи, только завершённые наличные
 * доставки. Netting не выполняется — заработок и сумма к передаче Direct
 * остаются раздельными итогами.
 */
export function getDriverCashLedgerView(
  state: PrototypeState,
  driverId: string,
): DriverCashLedgerView {
  const empty: DriverCashLedgerView = {
    entries: [],
    cashDeliveryCount: 0,
    cashEarningsCents: 0,
    dueToDirectCents: 0,
    reviewRequired: false,
  };
  if (!state.drivers.some((d) => d.id === driverId)) return empty;

  const driverEntries = state.driverCashLedgerEntries.filter(
    (e) => e.driverId === driverId,
  );
  let reviewRequired = false;

  // Дубли id внутри записей водителя — финансовый конфликт.
  const ids = driverEntries.map((e) => e.id);
  if (new Set(ids).size !== ids.length) reviewRequired = true;

  const byOrder = new Map<string, DriverCashLedgerEntry[]>();
  for (const entry of driverEntries) {
    const list = byOrder.get(entry.orderId) ?? [];
    list.push(entry);
    byOrder.set(entry.orderId, list);
  }

  const views: DriverCashLedgerEntryView[] = [];
  for (const [orderId, list] of byOrder) {
    // Дубли по заказу не легализуются выбором первой записи.
    if (list.length !== 1) {
      reviewRequired = true;
      continue;
    }
    const order = state.orders.find((o) => o.id === orderId) ?? null;
    if (order === null || order.assignedDriverId !== driverId) {
      reviewRequired = true;
      continue;
    }
    if (!hasValidDriverCashLedgerEntry(state, order)) {
      reviewRequired = true;
      continue;
    }
    views.push({ entry: list[0], order });
  }

  // Полностью валидный завершённый наличный заказ обязан иметь запись.
  for (const order of state.orders) {
    if (order.assignedDriverId !== driverId) continue;
    if (order.deliveryMode !== "PLATFORM_DRIVER") continue;
    if (order.paymentMethod !== "CASH") continue;
    if (order.status !== "DELIVERED") continue;
    // Незавершённый/недоказанный заказ отсутствующей записью не считается.
    if (!buildCompletedDriverCashLedgerEntry(state, order).ok) continue;
    if (!hasValidDriverCashLedgerEntry(state, order)) reviewRequired = true;
  }

  // Итоги считаются безопасной целочисленной арифметикой; при выходе за
  // безопасный диапазон правдоподобная сумма НЕ показывается.
  let cashEarningsCents = 0;
  let dueToDirectCents = 0;
  for (const view of views) {
    cashEarningsCents += view.entry.driverEarningCents;
    dueToDirectCents += view.entry.directReceivableFromDriverCents;
    if (!safeCents(cashEarningsCents) || !safeCents(dueToDirectCents)) {
      return {
        entries: [],
        cashDeliveryCount: 0,
        cashEarningsCents: 0,
        dueToDirectCents: 0,
        reviewRequired: true,
      };
    }
  }

  // Новые записи сверху.
  views.sort(
    (a, b) =>
      Date.parse(b.entry.recognizedAt) - Date.parse(a.entry.recognizedAt),
  );

  return {
    entries: views,
    cashDeliveryCount: views.length,
    cashEarningsCents,
    dueToDirectCents,
    reviewRequired,
  };
}
