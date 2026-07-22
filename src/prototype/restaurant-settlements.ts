import type {
  DeliveryMode,
  Order,
  PaymentStatus,
  PrototypeState,
  SettlementStatus,
  SettlementType,
} from "./models";
import type { OrderPaymentChannel } from "./order-money-movement";
import { addChecked, isSafeCents } from "./bank-fee";
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

/**
 * Источник цифр строки. COMPLETE — канонический moneyMovement заказа;
 * LEGACY — настоящий старый заказ без движения (только тогда допустим
 * fallback на compatibility-поля); REVIEW_REQUIRED — данные требуют разбора и
 * в достоверные итоги не входят.
 */
export type SettlementRowDataStatus = "COMPLETE" | "LEGACY" | "REVIEW_REQUIRED";

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
  /** ЧИСТАЯ комиссия Direct, а не полное перечисление ресторана. */
  platformCommissionReceivableCents: number;
  /** Compatibility-alias restaurantNetCents для существующего UI. */
  restaurantNetAfterPlatformCommissionCents: number;
  /** Комиссия Direct из снимка заказа (показывается отдельно от долга). */
  restaurantCommissionCents: number;
  /** Канал оплаты канонического движения; null у legacy-строки. */
  paymentChannel: OrderPaymentChannel | null;
  /** Источник цифр строки. */
  dataStatus: SettlementRowDataStatus;
  /** Полное обязательство ресторана перед Direct (движение), null у legacy. */
  restaurantOwesDirectCents: number | null;
  /** Обязательство Direct перед рестораном (движение), null у legacy. */
  directOwesRestaurantCents: number | null;
  /** Чистая сумма ресторана из движения; null у legacy. */
  restaurantNetCents: number | null;
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
  /** Строки, требующие разбора: в суммы выше они НЕ входят. */
  reviewRequiredOrderCount: number;
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

/**
 * Fail-closed результат обзора: при денежном переполнении отчёт НЕ возвращает
 * частичные, насыщенные или обнулённые суммы — только ошибку.
 */
export type RestaurantSettlementOverviewResult =
  | { ok: true; overview: RestaurantSettlementOverview }
  | { ok: false; error: string };

/** Fail-closed результат дневной сверки (тот же принцип). */
export type RestaurantDailySettlementResult =
  | { ok: true; days: RestaurantDailySettlementRow[] }
  | { ok: false; error: string };

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
  reviewRequiredOrderCount: 0,
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

/** Денежная часть строки, зависящая от источника данных. */
type SettlementRowMoneyFields = Pick<
  RestaurantSettlementRow,
  | "collector"
  | "restaurantCollectedFromCustomerCents"
  | "platformCollectedFromCustomerCents"
  | "platformCommissionReceivableCents"
  | "restaurantNetAfterPlatformCommissionCents"
  | "paymentChannel"
  | "dataStatus"
  | "restaurantOwesDirectCents"
  | "directOwesRestaurantCents"
  | "restaurantNetCents"
>;

/** Строка, требующая ручного разбора: сумм у неё нет вообще. */
const REVIEW_REQUIRED_ROW: SettlementRowMoneyFields = {
  collector: "RESTAURANT",
  restaurantCollectedFromCustomerCents: 0,
  platformCollectedFromCustomerCents: 0,
  platformCommissionReceivableCents: 0,
  restaurantNetAfterPlatformCommissionCents: 0,
  paymentChannel: null,
  dataStatus: "REVIEW_REQUIRED",
  restaurantOwesDirectCents: null,
  directOwesRestaurantCents: null,
  restaurantNetCents: null,
};

/**
 * НАСТОЯЩИЙ исторический снимок — заказ, оформленный до появления
 * канонического движения денег и его provenance (v12/v13). Доказуемый признак:
 * нет ни движения, ни снимка правила, ни снимка финансового режима. Отсутствие
 * одного лишь moneyMovement признаком legacy НЕ является: у современного
 * заказа это повреждение, а не история.
 *
 * Критерий сознательно не смотрит ни на текущий Restaurant, ни на
 * schemaVersion всего состояния: после миграции старые и новые заказы лежат
 * в одном состоянии, и общий schemaVersion о конкретном заказе ничего не
 * говорит.
 */
export function isTrueLegacyFinancialSnapshot(
  financials: Order["financials"],
): boolean {
  return (
    financials.moneyMovement === undefined &&
    financials.financialRule === undefined &&
    financials.financialCollectionMode === undefined
  );
}

/**
 * Классификация строки отчёта. Порядок источников:
 *
 * 1) COMPLETE С движением — цифры берутся ТОЛЬКО из moneyMovement заказа:
 *    получатель денег, чистая сумма ресторана и обе стороны обязательств уже
 *    посчитаны каноническим расчётом и здесь не пересчитываются. Повреждённые
 *    compatibility-поля на такую строку не влияют.
 * 2) REVIEW_REQUIRED — любое несогласованное состояние современного заказа:
 *    явный REVIEW_REQUIRED; COMPLETE без движения; PENDING_PAYMENT_CHANNEL у
 *    уже завершённого заказа (канал обязан был зафиксироваться при выдаче);
 *    движение при статусе, отличном от COMPLETE; неизвестный статус. Ни одна
 *    из этих строк не читает compatibility-поля и не попадает в итоги —
 *    правдоподобная старая сумма хуже честного «требует проверки».
 * 3) LEGACY — только доказуемо исторический заказ (см.
 *    isTrueLegacyFinancialSnapshot): единственный случай, когда fallback на
 *    compatibility-поля разрешён.
 */
function buildRowMoneyFields(order: Order): SettlementRowMoneyFields {
  const fin = order.financials;
  const movement = fin.moneyMovement;
  const status = fin.moneyMovementStatus;
  const completed =
    order.status === "DELIVERED" || order.status === "PICKED_UP";

  if (status === "COMPLETE" && movement) {
    const restaurantCollected =
      movement.customerMoneyRecipient === "RESTAURANT";
    return {
      collector: restaurantCollected ? "RESTAURANT" : "DIRECT",
      restaurantCollectedFromCustomerCents: restaurantCollected
        ? fin.customerTotalCents
        : 0,
      platformCollectedFromCustomerCents: restaurantCollected
        ? 0
        : fin.customerTotalCents,
      // Чистая комиссия Direct, а не полное перечисление ресторана: полная
      // сумма обязательства остаётся в restaurantOwesDirectCents.
      platformCommissionReceivableCents: restaurantCollected
        ? fin.restaurantCommissionCents
        : 0,
      restaurantNetAfterPlatformCommissionCents: movement.restaurantNetCents,
      paymentChannel: movement.paymentChannel,
      dataStatus: "COMPLETE",
      restaurantOwesDirectCents: movement.restaurantOwesDirectCents,
      directOwesRestaurantCents: movement.directOwesRestaurantCents,
      restaurantNetCents: movement.restaurantNetCents,
    };
  }
  // Движение при статусе, отличном от COMPLETE, — несогласованный снимок.
  if (movement !== undefined) {
    return REVIEW_REQUIRED_ROW;
  }
  // COMPLETE без движения — повреждение: заказ объявлен рассчитанным, но
  // расчёта нет. Compatibility-поля такого заказа не читаются.
  if (status === "COMPLETE") {
    return REVIEW_REQUIRED_ROW;
  }
  // PENDING_PAYMENT_CHANNEL законен только у НЕзавершённого самовывоза: у
  // завершённого заказа канал обязан был зафиксироваться при выдаче. Это
  // несогласованность независимо от происхождения снимка.
  if (status === "PENDING_PAYMENT_CHANNEL" && completed) {
    return REVIEW_REQUIRED_ROW;
  }
  // Доказуемо исторический заказ (до v12/v13) — единственный законный
  // fallback на compatibility-поля. Современный заказ с REVIEW_REQUIRED или
  // неизвестным статусом сюда не проходит.
  if (!isTrueLegacyFinancialSnapshot(fin)) {
    return REVIEW_REQUIRED_ROW;
  }
  return {
    collector: collectorOf(
      fin.restaurantCollectedFromCustomerCents,
      fin.platformCollectedFromCustomerCents,
    ),
    restaurantCollectedFromCustomerCents:
      fin.restaurantCollectedFromCustomerCents,
    platformCollectedFromCustomerCents: fin.platformCollectedFromCustomerCents,
    platformCommissionReceivableCents: fin.platformCommissionReceivableCents,
    restaurantNetAfterPlatformCommissionCents:
      fin.restaurantNetAfterPlatformCommissionCents,
    paymentChannel: null,
    dataStatus: "LEGACY",
    restaurantOwesDirectCents: null,
    directOwesRestaurantCents: null,
    restaurantNetCents: null,
  };
}

/** Денежные поля, накапливаемые в итогах обзора и дня. */
const MONEY_AGGREGATE_KEYS = [
  "customerTotalCents",
  "foodSubtotalCents",
  "restaurantNetCents",
  "restaurantCollectedFromCustomerCents",
  "platformCollectedFromCustomerCents",
  "platformCommissionReceivableCents",
  "pendingLedgerCents",
] as const;

type MoneyAggregateKey = (typeof MONEY_AGGREGATE_KEYS)[number];
type MoneyAggregate = Record<MoneyAggregateKey, number>;

/**
 * Fail-closed накопление денежного итога поверх общего addChecked (второй
 * реализации проверенного сложения в проекте нет). Мутирует переданный
 * аккумулятор ТОЛЬКО при успехе всех слагаемых; при переполнении возвращает
 * null, и вызывающий обязан отказаться от всего отчёта.
 */
function accumulateMoney(
  target: MoneyAggregate,
  amounts: MoneyAggregate,
): MoneyAggregate | null {
  const next = {} as MoneyAggregate;
  for (const key of MONEY_AGGREGATE_KEYS) {
    const sum = addChecked(target[key], amounts[key]);
    if (sum === null) return null;
    next[key] = sum;
  }
  for (const key of MONEY_AGGREGATE_KEYS) {
    target[key] = next[key];
  }
  return target;
}

/**
 * Все денежные поля строки — безопасные центы. Отчёт обязан защищаться от
 * повреждённого импортированного состояния даже для COMPLETE-строк, суммы
 * которых должны были прийти из канонического расчёта.
 */
function hasSafeRowMoney(
  fin: Order["financials"],
  money: SettlementRowMoneyFields,
): boolean {
  const values: readonly (number | null)[] = [
    fin.customerTotalCents,
    fin.foodSubtotalCents,
    fin.restaurantCommissionCents,
    money.restaurantCollectedFromCustomerCents,
    money.platformCollectedFromCustomerCents,
    money.platformCommissionReceivableCents,
    money.restaurantNetAfterPlatformCommissionCents,
    money.restaurantOwesDirectCents,
    money.directOwesRestaurantCents,
    money.restaurantNetCents,
  ];
  return values.every((value) => value === null || isSafeCents(value));
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

/** Единый текст отказа: неточный денежный итог не показывается. */
export const SETTLEMENT_OVERFLOW_ERROR =
  "Суммы отчёта выходят за безопасный диапазон.";

/**
 * Строит read-only обзор расчётов ресторана за период. Чистая функция: state не
 * мутируется. Невалидный nowIso обрабатывается fail-safe — пустой безопасный
 * обзор без падения. Период считается по completedAt, не по createdAt.
 *
 * Денежные итоги накапливаются ТОЛЬКО проверенным сложением: несколько
 * по отдельности безопасных заказов вместе могут выйти за безопасный диапазон,
 * и тогда возвращается ошибка — без частичных, насыщенных или обнулённых сумм.
 */
export function buildRestaurantSettlementOverview(
  state: PrototypeState,
  restaurantId: string,
  period: RestaurantSettlementPeriod,
  nowIso: string,
  timeZone: string,
): RestaurantSettlementOverviewResult {
  const zone = timeZone || "Europe/Chisinau";
  const nowMs = Date.parse(nowIso);
  if (typeof nowIso !== "string" || Number.isNaN(nowMs)) {
    return {
      ok: true,
      overview: {
        restaurantId,
        period,
        currencyCode: "USD",
        summary: { ...EMPTY_SUMMARY },
        rows: [],
        paidCanceled: [],
      },
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
      // Накопление по одному заказу — тоже деньги: обычный + запрещён.
      const accumulated = addChecked(
        pendingByOrderId.get(entry.orderId) ?? 0,
        entry.amountCents,
      );
      if (accumulated === null) {
        return { ok: false, error: SETTLEMENT_OVERFLOW_ERROR };
      }
      pendingByOrderId.set(entry.orderId, accumulated);
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
      // Оплаченная отмена в суммы не входит, но её сумма ПОКАЗЫВАЕТСЯ:
      // повреждённое значение не выдаётся за достоверное.
      if (!isSafeCents(fin.customerTotalCents)) {
        return { ok: false, error: SETTLEMENT_OVERFLOW_ERROR };
      }
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
    const money = buildRowMoneyFields(order);
    // Импортированное состояние может быть повреждено: строка, чьи денежные
    // поля не являются безопасными центами, классифицируется как требующая
    // разбора — её суммы не участвуют ни в отображении, ни в итогах.
    const safeMoney = hasSafeRowMoney(fin, money) ? money : REVIEW_REQUIRED_ROW;
    rows.push({
      orderId: order.id,
      publicNumber: order.publicNumber,
      completedAt,
      deliveryMode: order.deliveryMode,
      completionStatus: order.status === "DELIVERED" ? "DELIVERED" : "PICKED_UP",
      customerTotalCents: isSafeCents(fin.customerTotalCents)
        ? fin.customerTotalCents
        : 0,
      foodSubtotalCents: isSafeCents(fin.foodSubtotalCents)
        ? fin.foodSubtotalCents
        : 0,
      restaurantCommissionCents: isSafeCents(fin.restaurantCommissionCents)
        ? fin.restaurantCommissionCents
        : 0,
      ...safeMoney,
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
    // Строка, требующая разбора, считается отдельно: правдоподобные суммы в
    // достоверные итоги не добавляются.
    if (row.dataStatus === "REVIEW_REQUIRED") {
      summary.reviewRequiredOrderCount += 1;
      continue;
    }
    // Каждое слагаемое проверяется: отдельно безопасные заказы вместе могут
    // выйти за безопасный диапазон, и тогда отчёт отказывается целиком.
    const accumulated = accumulateMoney(summary, {
      customerTotalCents: row.customerTotalCents,
      foodSubtotalCents: row.foodSubtotalCents,
      restaurantNetCents: row.restaurantNetAfterPlatformCommissionCents,
      restaurantCollectedFromCustomerCents:
        row.restaurantCollectedFromCustomerCents,
      platformCollectedFromCustomerCents:
        row.platformCollectedFromCustomerCents,
      platformCommissionReceivableCents: row.platformCommissionReceivableCents,
      // PENDING берётся из фактического ledger по этому заказу, НЕ из snapshot.
      pendingLedgerCents: pendingByOrderId.get(row.orderId) ?? 0,
    });
    if (accumulated === null) {
      return { ok: false, error: SETTLEMENT_OVERFLOW_ERROR };
    }
  }

  return {
    ok: true,
    overview: {
      restaurantId,
      period,
      currencyCode,
      summary,
      rows,
      paidCanceled,
    },
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
  /** Заказы дня, требующие разбора: в суммы дня они не входят. */
  reviewRequiredOrderCount: number;
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
): RestaurantDailySettlementResult {
  const zone = timeZone || "Europe/Chisinau";
  const overviewResult = buildRestaurantSettlementOverview(
    state,
    restaurantId,
    period,
    nowIso,
    zone,
  );
  // Ошибка обзора передаётся как есть: частичных дней не бывает.
  if (!overviewResult.ok) {
    return { ok: false, error: overviewResult.error };
  }
  const overview = overviewResult.overview;

  // Фактический PENDING по существующему журналу комиссий, по заказам. Тот же
  // источник (state.settlements), что и в overview — не пересчёт snapshot.
  const pendingByOrderId = new Map<string, number>();
  for (const entry of state.settlements) {
    if (entry.restaurantId !== restaurantId) continue;
    if (entry.status !== "PENDING") continue;
    const accumulated = addChecked(
      pendingByOrderId.get(entry.orderId) ?? 0,
      entry.amountCents,
    );
    if (accumulated === null) {
      return { ok: false, error: SETTLEMENT_OVERFLOW_ERROR };
    }
    pendingByOrderId.set(entry.orderId, accumulated);
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
        reviewRequiredOrderCount: 0,
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
    if (row.dataStatus === "REVIEW_REQUIRED") {
      // Тот же принцип, что в общей summary: суммы дня остаются достоверными.
      day.reviewRequiredOrderCount += 1;
      day.orders.push(row);
      continue;
    }
    // Тот же checked-накопитель, что и в общей summary: переполнение внутри
    // дня или между строками дня обрывает построение целиком.
    const accumulated = accumulateMoney(day, {
      customerTotalCents: row.customerTotalCents,
      foodSubtotalCents: row.foodSubtotalCents,
      restaurantNetCents: row.restaurantNetAfterPlatformCommissionCents,
      restaurantCollectedFromCustomerCents:
        row.restaurantCollectedFromCustomerCents,
      platformCollectedFromCustomerCents:
        row.platformCollectedFromCustomerCents,
      platformCommissionReceivableCents: row.platformCommissionReceivableCents,
      pendingLedgerCents: pendingByOrderId.get(row.orderId) ?? 0,
    });
    if (accumulated === null) {
      return { ok: false, error: SETTLEMENT_OVERFLOW_ERROR };
    }
    day.orders.push(row);
  }

  for (const paid of overview.paidCanceled) {
    const day = ensureDay(formatLocalDate(Date.parse(paid.canceledAt), zone));
    day.paidCanceledCount += 1;
  }

  // Новые даты сверху; YYYY-MM-DD сравнивается лексикографически = хронологически.
  return {
    ok: true,
    days: [...dayMap.values()].sort((a, b) =>
      b.localDate.localeCompare(a.localDate),
    ),
  };
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

/** Русская подпись источника данных строки (сырой enum не показывается). */
export const SETTLEMENT_ROW_DATA_STATUS_LABELS: Record<
  SettlementRowDataStatus,
  string
> = {
  COMPLETE: "Данные подтверждены",
  LEGACY: "Архивные данные",
  REVIEW_REQUIRED: "Требует проверки",
};

/** Русская подпись, кто собрал деньги клиента. */
export const SETTLEMENT_COLLECTOR_LABELS: Record<SettlementCollector, string> = {
  RESTAURANT: "Ресторан",
  DIRECT: "Direct",
  MIXED: "Смешанный",
};
