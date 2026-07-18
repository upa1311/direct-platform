import type {
  DeliveryMode,
  Order,
  PaymentStatus,
  PrototypeState,
  SettlementStatus,
  SettlementType,
} from "./models";
import {
  getLocalDateParts,
  localMidnightToUtcMs,
  shiftCalendarDate,
} from "./local-calendar";

/**
 * Чистый модуль ресторанной сверки (первый этап RESTAURANT SETTLEMENTS).
 *
 * Единственный источник цифр заказа — неизменяемый order.financials
 * (FinancialSnapshot). Отчёт НИКОГДА не пересчитывает старые заказы через
 * текущее меню, цену, комиссию, тарифы, акции или новые формулы pricing engine:
 * изменение настроек не должно менять старый финансовый отчёт.
 *
 * state.settlements используется как ФАКТИЧЕСКИЙ существующий commission ledger
 * (только PICKUP_COMMISSION / RESTAURANT_DELIVERY_COMMISSION). Это не полный
 * двусторонний ledger выплат, поэтому модуль не утверждает, что Direct выплатил
 * ресторану или что баланс закрыт. Модуль ничего не мутирует.
 */

export type RestaurantSettlementPeriod =
  | "TODAY"
  | "LAST_7_DAYS"
  | "LAST_30_DAYS"
  | "ALL";

/** Кто фактически собрал деньги клиента (по FinancialSnapshot). */
export type SettlementCollector = "RESTAURANT" | "DIRECT" | "MIXED";

/** Существующее начисление комиссии по ledger, привязанное к заказу. */
export interface RestaurantSettlementLedgerEntry {
  type: SettlementType;
  amountCents: number;
  status: SettlementStatus;
}

export interface RestaurantSettlementRow {
  /** Внутренний id — для связи с ledger и React-ключа; в UI не показывается. */
  orderId: string;
  publicNumber: string;
  completedAt: string;
  deliveryMode: DeliveryMode;
  completionStatus: "DELIVERED" | "PICKED_UP";
  customerTotalCents: number;
  foodSubtotalCents: number;
  collector: SettlementCollector;
  restaurantCollectedFromCustomerCents: number;
  platformCollectedFromCustomerCents: number;
  platformCommissionReceivableCents: number;
  restaurantNetAfterPlatformCommissionCents: number;
  /** Существующее начисление ledger либо null («Начисления нет»). */
  ledger: RestaurantSettlementLedgerEntry | null;
}

export interface RestaurantSettlementSummary {
  completedOrderCount: number;
  customerTotalCents: number;
  foodSubtotalCents: number;
  restaurantNetCents: number;
  restaurantCollectedFromCustomerCents: number;
  platformCollectedFromCustomerCents: number;
  /** Комиссия Direct по финансовым снимкам (не факт выплаты/ledger). */
  platformCommissionReceivableCents: number;
  /** Фактический PENDING по существующему ledger — отдельно от snapshot. */
  pendingLedgerCents: number;
}

/** Оплаченный отменённый заказ — требует ручного решения по возврату. */
export interface RestaurantPaidCanceledRow {
  orderId: string;
  publicNumber: string;
  canceledAt: string;
  deliveryMode: DeliveryMode;
  paymentStatus: PaymentStatus;
  customerTotalCents: number;
}

export interface RestaurantSettlementOverview {
  restaurantId: string;
  period: RestaurantSettlementPeriod;
  currencyCode: string;
  summary: RestaurantSettlementSummary;
  rows: RestaurantSettlementRow[];
  paidCanceled: RestaurantPaidCanceledRow[];
}

/** Завершённые статусы, попадающие в основные финансовые итоги. */
const COMPLETED_STATUSES: ReadonlySet<Order["status"]> = new Set([
  "DELIVERED",
  "PICKED_UP",
]);

/** Оплаченные статусы: оплата фактически прошла. */
const PAID_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  "PAID",
  "PAID_AT_RESTAURANT",
  "PAID_TO_RESTAURANT_COURIER",
]);

const EMPTY_SUMMARY: RestaurantSettlementSummary = {
  completedOrderCount: 0,
  customerTotalCents: 0,
  foodSubtotalCents: 0,
  restaurantNetCents: 0,
  restaurantCollectedFromCustomerCents: 0,
  platformCollectedFromCustomerCents: 0,
  platformCommissionReceivableCents: 0,
  pendingLedgerCents: 0,
};

/**
 * Момент завершения заказа: последнее РЕАЛЬНОЕ STATUS-событие перехода в
 * DELIVERED/PICKED_UP (fromStatus !== toStatus). Технические same-status события
 * игнорируются. Для legacy-заказа без такого события — fallback updatedAt.
 */
export function getOrderCompletedAt(order: Order): string {
  for (let i = order.history.length - 1; i >= 0; i -= 1) {
    const event = order.history[i];
    if (
      event.type === "STATUS" &&
      event.fromStatus !== event.toStatus &&
      (event.toStatus === "DELIVERED" || event.toStatus === "PICKED_UP")
    ) {
      return event.occurredAt;
    }
  }
  return order.updatedAt;
}

/**
 * Момент отмены: последнее реальное STATUS-событие перехода в CANCELED
 * (fromStatus !== toStatus). Fallback — updatedAt для legacy.
 */
export function getOrderCanceledAt(order: Order): string {
  for (let i = order.history.length - 1; i >= 0; i -= 1) {
    const event = order.history[i];
    if (
      event.type === "STATUS" &&
      event.fromStatus !== event.toStatus &&
      event.toStatus === "CANCELED"
    ) {
      return event.occurredAt;
    }
  }
  return order.updatedAt;
}

function isPaidOrder(order: Order): boolean {
  return PAID_STATUSES.has(order.paymentStatus) || order.paidAt !== null;
}

function collectorOf(
  restaurantCents: number,
  platformCents: number,
): SettlementCollector {
  if (restaurantCents > 0 && platformCents > 0) return "MIXED";
  if (platformCents > 0) return "DIRECT";
  return "RESTAURANT";
}

// --- Границы периода в часовом поясе ресторана ------------------------------

/**
 * Нижняя граница периода (включительно) в мс, либо null для ALL. «7 дней» и
 * «30 дней» включают текущий календарный день ресторана: берём КАЛЕНДАРНУЮ дату
 * ресторана и сдвигаем её на -6 / -29 дней, и только затем переводим локальную
 * полночь целевой даты в UTC. Никакого вычитания фиксированных 24-часовых суток —
 * поэтому границы корректны через переходы DST. Часовой пояс — ресторана.
 */
function periodStartMs(
  period: RestaurantSettlementPeriod,
  nowMs: number,
  timeZone: string,
): number | null {
  if (period === "ALL") return null;
  const today = getLocalDateParts(nowMs, timeZone);
  if (period === "TODAY") return localMidnightToUtcMs(today, timeZone);
  const deltaDays = period === "LAST_7_DAYS" ? -6 : -29;
  return localMidnightToUtcMs(shiftCalendarDate(today, deltaDays), timeZone);
}

// --- Основная сборка --------------------------------------------------------

/**
 * Строит read-only обзор расчётов ресторана за период. Чистая функция: state не
 * мутируется. Невалидный nowIso обрабатывается fail-safe — пустой безопасный
 * обзор без падения. Период считается по completedAt, не по createdAt.
 */
export function buildRestaurantSettlementOverview(
  state: PrototypeState,
  restaurantId: string,
  period: RestaurantSettlementPeriod,
  nowIso: string,
  timeZone: string,
): RestaurantSettlementOverview {
  const zone = timeZone || "Europe/Chisinau";
  const nowMs = Date.parse(nowIso);
  if (typeof nowIso !== "string" || Number.isNaN(nowMs)) {
    return {
      restaurantId,
      period,
      currencyCode: "USD",
      summary: { ...EMPTY_SUMMARY },
      rows: [],
      paidCanceled: [],
    };
  }

  const startMs = periodStartMs(period, nowMs, zone);
  // Окно: startMs <= eventMs <= nowMs (для ALL нижней границы нет). Верхняя
  // граница и проверка валидности применяются ко ВСЕМ периодам, включая ALL,
  // поэтому будущие (> nowMs) и невалидные события не попадают в отчёт.
  const inPeriod = (iso: string): boolean => {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return false;
    if (ms > nowMs) return false;
    if (startMs !== null && ms < startMs) return false;
    return true;
  };

  const restaurantOrders = state.orders.filter(
    (order) => order.restaurant.id === restaurantId,
  );

  // Начисления ledger по orderId (для строки и PENDING-итога).
  const ledgerByOrderId = new Map<string, RestaurantSettlementLedgerEntry>();
  const pendingByOrderId = new Map<string, number>();
  for (const entry of state.settlements) {
    if (entry.restaurantId !== restaurantId) continue;
    if (!ledgerByOrderId.has(entry.orderId)) {
      ledgerByOrderId.set(entry.orderId, {
        type: entry.type,
        amountCents: entry.amountCents,
        status: entry.status,
      });
    }
    if (entry.status === "PENDING") {
      pendingByOrderId.set(
        entry.orderId,
        (pendingByOrderId.get(entry.orderId) ?? 0) + entry.amountCents,
      );
    }
  }

  const rows: RestaurantSettlementRow[] = [];
  const paidCanceled: RestaurantPaidCanceledRow[] = [];
  let currencyCode = "USD";

  for (const order of restaurantOrders) {
    const fin = order.financials;
    if (order.status === "CANCELED") {
      if (!isPaidOrder(order)) continue;
      const canceledAt = getOrderCanceledAt(order);
      if (!inPeriod(canceledAt)) continue;
      paidCanceled.push({
        orderId: order.id,
        publicNumber: order.publicNumber,
        canceledAt,
        deliveryMode: order.deliveryMode,
        paymentStatus: order.paymentStatus,
        customerTotalCents: fin.customerTotalCents,
      });
      continue;
    }

    if (!COMPLETED_STATUSES.has(order.status)) continue;
    const completedAt = getOrderCompletedAt(order);
    if (!inPeriod(completedAt)) continue;

    currencyCode = fin.currencyCode;
    rows.push({
      orderId: order.id,
      publicNumber: order.publicNumber,
      completedAt,
      deliveryMode: order.deliveryMode,
      completionStatus: order.status === "DELIVERED" ? "DELIVERED" : "PICKED_UP",
      customerTotalCents: fin.customerTotalCents,
      foodSubtotalCents: fin.foodSubtotalCents,
      collector: collectorOf(
        fin.restaurantCollectedFromCustomerCents,
        fin.platformCollectedFromCustomerCents,
      ),
      restaurantCollectedFromCustomerCents: fin.restaurantCollectedFromCustomerCents,
      platformCollectedFromCustomerCents: fin.platformCollectedFromCustomerCents,
      platformCommissionReceivableCents: fin.platformCommissionReceivableCents,
      restaurantNetAfterPlatformCommissionCents:
        fin.restaurantNetAfterPlatformCommissionCents,
      ledger: ledgerByOrderId.get(order.id) ?? null,
    });
  }

  // Новые сверху.
  rows.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  paidCanceled.sort(
    (a, b) => Date.parse(b.canceledAt) - Date.parse(a.canceledAt),
  );

  const summary: RestaurantSettlementSummary = { ...EMPTY_SUMMARY };
  summary.completedOrderCount = rows.length;
  for (const row of rows) {
    summary.customerTotalCents += row.customerTotalCents;
    summary.foodSubtotalCents += row.foodSubtotalCents;
    summary.restaurantNetCents += row.restaurantNetAfterPlatformCommissionCents;
    summary.restaurantCollectedFromCustomerCents +=
      row.restaurantCollectedFromCustomerCents;
    summary.platformCollectedFromCustomerCents +=
      row.platformCollectedFromCustomerCents;
    summary.platformCommissionReceivableCents +=
      row.platformCommissionReceivableCents;
    // PENDING берётся из фактического ledger по этому заказу, НЕ из snapshot.
    summary.pendingLedgerCents += pendingByOrderId.get(row.orderId) ?? 0;
  }

  return {
    restaurantId,
    period,
    currencyCode,
    summary,
    rows,
    paidCanceled,
  };
}

// --- Сверка по дням ---------------------------------------------------------

/** Одна строка дневной сверки: агрегаты завершённых заказов за локальный день. */
export interface RestaurantDailySettlementRow {
  /** Локальная календарная дата ресторана в формате YYYY-MM-DD. */
  localDate: string;
  completedOrderCount: number;
  customerTotalCents: number;
  foodSubtotalCents: number;
  restaurantNetCents: number;
  restaurantCollectedFromCustomerCents: number;
  platformCollectedFromCustomerCents: number;
  platformCommissionReceivableCents: number;
  pendingLedgerCents: number;
  paidCanceledCount: number;
  /** Завершённые заказы дня (новые сверху) — для раскрытия строки. */
  orders: RestaurantSettlementRow[];
}

/** Локальная календарная дата момента utcMs в формате YYYY-MM-DD. */
function formatLocalDate(utcMs: number, timeZone: string): string {
  const { year, month, day } = getLocalDateParts(utcMs, timeZone);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Дневная сверка ресторана за период. Read-only и построена ПОВЕРХ
 * buildRestaurantSettlementOverview: те же completedAt, границы периода, часовой
 * пояс, правила DELIVERED/PICKED_UP, исключение будущих/невалидных событий и
 * классификация paid-canceled — второй формулы периодов нет. Завершённые заказы
 * группируются по локальной дате completedAt, оплаченные отмены — по локальной
 * дате canceledAt. Сумма всех дней по каждому финансовому полю равна общей
 * summary за тот же период. Дни — новые сверху; заказы внутри дня — новые сверху.
 */
export function buildRestaurantDailySettlement(
  state: PrototypeState,
  restaurantId: string,
  period: RestaurantSettlementPeriod,
  nowIso: string,
  timeZone: string,
): RestaurantDailySettlementRow[] {
  const zone = timeZone || "Europe/Chisinau";
  const overview = buildRestaurantSettlementOverview(
    state,
    restaurantId,
    period,
    nowIso,
    zone,
  );

  // Фактический PENDING по существующему журналу комиссий, по заказам. Тот же
  // источник (state.settlements), что и в overview — не пересчёт snapshot.
  const pendingByOrderId = new Map<string, number>();
  for (const entry of state.settlements) {
    if (entry.restaurantId !== restaurantId) continue;
    if (entry.status !== "PENDING") continue;
    pendingByOrderId.set(
      entry.orderId,
      (pendingByOrderId.get(entry.orderId) ?? 0) + entry.amountCents,
    );
  }

  const dayMap = new Map<string, RestaurantDailySettlementRow>();
  const ensureDay = (localDate: string): RestaurantDailySettlementRow => {
    let day = dayMap.get(localDate);
    if (!day) {
      day = {
        localDate,
        completedOrderCount: 0,
        customerTotalCents: 0,
        foodSubtotalCents: 0,
        restaurantNetCents: 0,
        restaurantCollectedFromCustomerCents: 0,
        platformCollectedFromCustomerCents: 0,
        platformCommissionReceivableCents: 0,
        pendingLedgerCents: 0,
        paidCanceledCount: 0,
        orders: [],
      };
      dayMap.set(localDate, day);
    }
    return day;
  };

  // overview.rows уже отсортированы по убыванию completedAt: порядок внутри дня
  // сохраняется при раскладке по корзинам.
  for (const row of overview.rows) {
    const day = ensureDay(formatLocalDate(Date.parse(row.completedAt), zone));
    day.completedOrderCount += 1;
    day.customerTotalCents += row.customerTotalCents;
    day.foodSubtotalCents += row.foodSubtotalCents;
    day.restaurantNetCents += row.restaurantNetAfterPlatformCommissionCents;
    day.restaurantCollectedFromCustomerCents +=
      row.restaurantCollectedFromCustomerCents;
    day.platformCollectedFromCustomerCents +=
      row.platformCollectedFromCustomerCents;
    day.platformCommissionReceivableCents += row.platformCommissionReceivableCents;
    day.pendingLedgerCents += pendingByOrderId.get(row.orderId) ?? 0;
    day.orders.push(row);
  }

  for (const paid of overview.paidCanceled) {
    const day = ensureDay(formatLocalDate(Date.parse(paid.canceledAt), zone));
    day.paidCanceledCount += 1;
  }

  // Новые даты сверху; YYYY-MM-DD сравнивается лексикографически = хронологически.
  return [...dayMap.values()].sort((a, b) => b.localDate.localeCompare(a.localDate));
}

/** Русские подписи периодов для переключателя. */
export const RESTAURANT_SETTLEMENT_PERIOD_LABELS: Record<
  RestaurantSettlementPeriod,
  string
> = {
  TODAY: "Сегодня",
  LAST_7_DAYS: "7 дней",
  LAST_30_DAYS: "30 дней",
  ALL: "Всё время",
};

/** Порядок вкладок периода. */
export const RESTAURANT_SETTLEMENT_PERIOD_ORDER: readonly RestaurantSettlementPeriod[] =
  ["TODAY", "LAST_7_DAYS", "LAST_30_DAYS", "ALL"];

/** Русская подпись, кто собрал деньги клиента. */
export const SETTLEMENT_COLLECTOR_LABELS: Record<SettlementCollector, string> = {
  RESTAURANT: "Ресторан",
  DIRECT: "Direct",
  MIXED: "Смешанный",
};
