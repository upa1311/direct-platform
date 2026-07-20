import type {
  Order,
  PrototypeState,
  RestaurantAccountingEntry,
} from "./models";
import type { OrderPaymentChannel } from "./order-money-movement";

// Единый канонический read-model финансов ресторана.
//
// Чистый модуль без React, мутаций и localStorage: ресторанский интерфейс и
// будущий административный интерфейс получают ОДНИ И ТЕ ЖЕ финансовые суммы из
// одного builder — никакой финансовой математики в UI. Источники данных:
// - RestaurantAccountingEntry — открытые обязательства (баланс);
// - order.financials.moneyMovement — подробная каноническая математика заказа;
// - сохранённые данные заказа — номер, дата, способ получения и оплаты.
// Legacy-финансовые поля снимка для расчёта баланса НЕ используются.

/** Канал строки заказа: канонический либо исторический неизвестный. */
export type FinanceRowPaymentChannel = OrderPaymentChannel | "LEGACY_UNKNOWN";

/** Полнота данных строки: канон, историческая запись или ручной разбор. */
export type FinanceRowDataStatus = "COMPLETE" | "LEGACY" | "REVIEW_REQUIRED";

/** Строка открытого обязательства заказа для интерфейсов. */
export interface RestaurantFinanceOrderRow {
  orderId: string;
  publicNumber: string;
  recognizedAt: string;
  deliveryMode: "PLATFORM_DRIVER" | "RESTAURANT_DELIVERY" | "PICKUP";
  paymentChannel: FinanceRowPaymentChannel;
  direction: "RESTAURANT_OWES_DIRECT" | "DIRECT_OWES_RESTAURANT";
  amountCents: number;
  customerTotalCents: number | null;
  foodSubtotalCents: number | null;
  restaurantCommissionCents: number | null;
  totalBankFeeCents: number | null;
  restaurantBankFeeCents: number | null;
  directBankFeeCents: number | null;
  restaurantNetCents: number | null;
  directNetRevenueCents: number | null;
  dataStatus: FinanceRowDataStatus;
}

/** Направление итога после отображаемого взаимозачёта. */
export type FinanceNetDirection =
  | "RESTAURANT_OWES_DIRECT"
  | "DIRECT_OWES_RESTAURANT"
  | "BALANCED";

/** Канонический read-model финансов ресторана. */
export interface RestaurantFinanceReadModel {
  restaurantId: string;
  restaurantOwesDirectCents: number;
  directOwesRestaurantCents: number;
  netDirection: FinanceNetDirection;
  netAmountCents: number;
  openAccountingEntryCount: number;
  openOrderCount: number;
  oldestOpenRecognizedAt: string | null;
  reviewRequiredOrderCount: number;
  pendingPaymentChannelOrderCount: number;
  openOrders: RestaurantFinanceOrderRow[];
  /**
   * Полноценной модели закрытого расчёта (SettlementRecord) ещё нет: значение
   * всегда null. Закрытый расчёт НЕ реконструируется из resolution events.
   */
  lastClosedSettlement: null;
}

/** Fail-closed результат: повреждённые данные не превращаются в баланс. */
export type RestaurantFinanceReadModelResult =
  | { ok: true; model: RestaurantFinanceReadModel }
  | { ok: false; error: string };

/**
 * Нейтральная сводка баланса (общая для ресторанного и будущего админского
 * экрана): подмножество канонического read-model. Собственной формулы нет.
 */
export interface RestaurantFinanceSummary {
  restaurantId: string;
  restaurantOwesDirectCents: number;
  directOwesRestaurantCents: number;
  netDirection: FinanceNetDirection;
  netAmountCents: number;
}

export type RestaurantFinanceSummaryResult =
  | { ok: true; summary: RestaurantFinanceSummary }
  | { ok: false; error: string };

function fail(error: string): RestaurantFinanceReadModelResult {
  return { ok: false, error };
}

/** Целые неотрицательные конечные центы. */
function isCents(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

const KNOWN_DIRECTIONS: readonly RestaurantAccountingEntry["direction"][] = [
  "RESTAURANT_OWES_DIRECT",
  "DIRECT_OWES_RESTAURANT",
];
const KNOWN_STATUSES: readonly RestaurantAccountingEntry["status"][] = [
  "OPEN",
  "SETTLED",
  "WAIVED",
];

/**
 * Соответствие OPEN-записи каноническому движению денег заказа:
 * RESTAURANT_OWES_DIRECT/PLATFORM_COMMISSION ↔ movement.restaurantOwesDirectCents,
 * DIRECT_OWES_RESTAURANT/RESTAURANT_PAYOUT ↔ movement.directOwesRestaurantCents.
 */
function snapshotEntryMatchesMovement(
  entry: RestaurantAccountingEntry,
  order: Order,
): boolean {
  const movement = order.financials.moneyMovement;
  if (order.financials.moneyMovementStatus !== "COMPLETE" || !movement) {
    return false;
  }
  if (entry.direction === "RESTAURANT_OWES_DIRECT") {
    return (
      entry.type === "PLATFORM_COMMISSION" &&
      entry.amountCents === movement.restaurantOwesDirectCents
    );
  }
  return (
    entry.type === "RESTAURANT_PAYOUT" &&
    entry.amountCents === movement.directOwesRestaurantCents
  );
}

/** Строка открытого заказа: детали ТОЛЬКО из канонического движения. */
function buildRow(
  entry: RestaurantAccountingEntry,
  order: Order,
): RestaurantFinanceOrderRow {
  const base = {
    orderId: entry.orderId,
    publicNumber: order.publicNumber,
    recognizedAt: entry.recognizedAt,
    deliveryMode: order.deliveryMode,
    direction: entry.direction,
    amountCents: entry.amountCents,
  } as const;

  if (entry.source === "ORDER_FINANCIAL_SNAPSHOT") {
    // Сверка с движением уже выполнена вызывающим кодом — movement существует.
    const movement = order.financials.moneyMovement!;
    return {
      ...base,
      paymentChannel: movement.paymentChannel,
      customerTotalCents: order.financials.customerTotalCents,
      foodSubtotalCents: order.financials.foodSubtotalCents,
      restaurantCommissionCents: order.financials.restaurantCommissionCents,
      totalBankFeeCents: movement.totalBankFeeCents,
      restaurantBankFeeCents: movement.restaurantBankFeeCents,
      directBankFeeCents: movement.directBankFeeCents,
      restaurantNetCents: movement.restaurantNetCents,
      directNetRevenueCents: movement.directNetRevenueCents,
      dataStatus: "COMPLETE",
    };
  }

  // Историческая запись: сумма обязательства историческая, банковские и прочие
  // детали НЕ выдумываются — неизвестное возвращается как null. Заказ,
  // ожидающий ручного разбора движения, помечает строку REVIEW_REQUIRED.
  return {
    ...base,
    paymentChannel: "LEGACY_UNKNOWN",
    customerTotalCents: null,
    foodSubtotalCents: null,
    restaurantCommissionCents: null,
    totalBankFeeCents: null,
    restaurantBankFeeCents: null,
    directBankFeeCents: null,
    restaurantNetCents: null,
    directNetRevenueCents: null,
    dataStatus:
      order.financials.moneyMovementStatus === "REVIEW_REQUIRED"
        ? "REVIEW_REQUIRED"
        : "LEGACY",
  };
}

/**
 * Единственный канонический builder финансов ресторана.
 *
 * Fail-closed: неизвестный ресторан, дубли записей одного заказа (сумма не
 * считается дважды молча), отрицательные/дробные суммы, неизвестные
 * direction/status, OPEN-запись без соответствующего заказа или чужого
 * ресторана, расхождение snapshot-записи с каноническим moneyMovement и
 * невалидный recognizedAt открытой записи возвращают ошибку, а не
 * правдоподобный баланс. SETTLED/WAIVED в открытый баланс не входят и модель
 * не ломают. Builder ничего не мутирует: одинаковый state — одинаковый
 * результат.
 */
export function buildRestaurantFinanceReadModel(
  state: PrototypeState,
  restaurantId: string,
): RestaurantFinanceReadModelResult {
  if (!state.restaurants.some((r) => r.id === restaurantId)) {
    return fail("Ресторан не найден.");
  }

  const ordersById = new Map<string, Order>();
  for (const order of state.orders) {
    ordersById.set(order.id, order);
  }

  const entries = state.restaurantAccountingEntries.filter(
    (entry) => entry.restaurantId === restaurantId,
  );

  // Дубли обязательств одного заказа: read-model не имеет права молча удвоить
  // сумму — только обнаружение и явная ошибка (без удаления/объединения).
  const seenOrderIds = new Set<string>();
  for (const entry of entries) {
    if (seenOrderIds.has(entry.orderId)) {
      return fail("У заказа обнаружено несколько бухгалтерских обязательств.");
    }
    seenOrderIds.add(entry.orderId);
  }

  let restaurantOwesDirectCents = 0;
  let directOwesRestaurantCents = 0;
  const openRows: RestaurantFinanceOrderRow[] = [];
  let oldestOpenRecognizedAt: string | null = null;

  for (const entry of entries) {
    if (!KNOWN_STATUSES.includes(entry.status)) {
      return fail("Неизвестный статус бухгалтерского обязательства.");
    }
    if (!KNOWN_DIRECTIONS.includes(entry.direction)) {
      return fail("Неизвестное направление бухгалтерского обязательства.");
    }
    if (!isCents(entry.amountCents)) {
      return fail("Некорректная сумма бухгалтерского обязательства.");
    }
    // Закрытые обязательства открытый баланс не формируют.
    if (entry.status !== "OPEN") continue;

    if (!isValidIso(entry.recognizedAt)) {
      return fail("Некорректная дата признания обязательства.");
    }
    const order = ordersById.get(entry.orderId);
    if (!order) {
      return fail("Открытое обязательство ссылается на несуществующий заказ.");
    }
    if (order.restaurant.id !== restaurantId) {
      return fail("Обязательство ссылается на заказ другого ресторана.");
    }
    if (entry.source === "ORDER_FINANCIAL_SNAPSHOT") {
      if (!snapshotEntryMatchesMovement(entry, order)) {
        return fail(
          "Обязательство заказа противоречит каноническому движению денег.",
        );
      }
    }
    // LEGACY_COMMISSION_SETTLEMENT: сумма историческая, по movement не
    // пересчитывается; структура и отсутствие дубля уже проверены выше.

    if (entry.direction === "RESTAURANT_OWES_DIRECT") {
      restaurantOwesDirectCents += entry.amountCents;
    } else {
      directOwesRestaurantCents += entry.amountCents;
    }
    if (
      oldestOpenRecognizedAt === null ||
      Date.parse(entry.recognizedAt) < Date.parse(oldestOpenRecognizedAt)
    ) {
      oldestOpenRecognizedAt = entry.recognizedAt;
    }
    openRows.push(buildRow(entry, order));
  }

  // Детерминированная сортировка: старые признания сверху, затем номер, id.
  openRows.sort((a, b) => {
    const ta = Date.parse(a.recognizedAt);
    const tb = Date.parse(b.recognizedAt);
    if (ta !== tb) return ta - tb;
    if (a.publicNumber !== b.publicNumber) {
      return a.publicNumber < b.publicNumber ? -1 : 1;
    }
    return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
  });

  // Заказы, требующие внимания, но не являющиеся финансовым долгом:
  // незавершённый самовывоз и legacy-разбор в открытый баланс не входят.
  let reviewRequiredOrderCount = 0;
  let pendingPaymentChannelOrderCount = 0;
  for (const order of state.orders) {
    if (order.restaurant.id !== restaurantId) continue;
    if (order.financials.moneyMovementStatus === "REVIEW_REQUIRED") {
      reviewRequiredOrderCount += 1;
    } else if (
      order.financials.moneyMovementStatus === "PENDING_PAYMENT_CHANNEL"
    ) {
      pendingPaymentChannelOrderCount += 1;
    }
  }

  const netDirection: FinanceNetDirection =
    directOwesRestaurantCents > restaurantOwesDirectCents
      ? "DIRECT_OWES_RESTAURANT"
      : restaurantOwesDirectCents > directOwesRestaurantCents
        ? "RESTAURANT_OWES_DIRECT"
        : "BALANCED";
  const netAmountCents = Math.abs(
    directOwesRestaurantCents - restaurantOwesDirectCents,
  );

  return {
    ok: true,
    model: {
      restaurantId,
      restaurantOwesDirectCents,
      directOwesRestaurantCents,
      netDirection,
      netAmountCents,
      openAccountingEntryCount: openRows.length,
      // Дубли отклонены выше, поэтому уникальные заказы = число записей; счёт
      // всё равно ведётся по уникальным orderId, а не по всем заказам ресторана.
      openOrderCount: new Set(openRows.map((row) => row.orderId)).size,
      oldestOpenRecognizedAt,
      reviewRequiredOrderCount,
      pendingPaymentChannelOrderCount,
      openOrders: openRows,
      lastClosedSettlement: null,
    },
  };
}

/**
 * Нейтральная сводка баланса для любого интерфейса (ресторан/админ): тонкая
 * проекция канонического builder. Отдельной финансовой формулы НЕ содержит —
 * все суммы приходят из buildRestaurantFinanceReadModel.
 */
export function getRestaurantFinanceSummary(
  state: PrototypeState,
  restaurantId: string,
): RestaurantFinanceSummaryResult {
  const result = buildRestaurantFinanceReadModel(state, restaurantId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const { model } = result;
  return {
    ok: true,
    summary: {
      restaurantId: model.restaurantId,
      restaurantOwesDirectCents: model.restaurantOwesDirectCents,
      directOwesRestaurantCents: model.directOwesRestaurantCents,
      netDirection: model.netDirection,
      netAmountCents: model.netAmountCents,
    },
  };
}
