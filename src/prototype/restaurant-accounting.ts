import type {
  CurrencyCode,
  Order,
  PrototypeState,
  RestaurantAccountingEntry,
  RestaurantAccountingResolutionEvent,
  RestaurantAccountingStatus,
  RestaurantAccountingType,
  SettlementEntry,
} from "./models";
import { finalizeMutation } from "./prototype-store";
import { getOrderCompletedAt } from "./restaurant-settlements";

/**
 * Двусторонний журнал расчётов ресторана (фундамент). Записи создаются ТОЛЬКО из
 * неизменяемого order.financials завершённого заказа и не пересчитываются по
 * текущим тарифам, меню или комиссии. Модуль ничего не мутирует помимо явных
 * действий; взаимозачёт и выплаты здесь не выполняются.
 *
 * Отличие от SettlementEntry: старый ledger фиксирует только «ресторан должен
 * Direct» (комиссия). Этот журнал фиксирует ОБЕ стороны — и комиссию ресторана
 * перед Direct, и выплату Direct ресторану.
 */

/** Завершённые статусы, при которых признаются обязательства. */
const COMPLETED_STATUSES: ReadonlySet<Order["status"]> = new Set([
  "DELIVERED",
  "PICKED_UP",
]);

const LEGACY_CURRENCY: CurrencyCode = "USD";

/** Идентификатор обязательства из снимка заказа: один на (заказ, тип). */
function accountingEntryId(orderId: string, type: RestaurantAccountingType): string {
  return `accounting-${orderId}-${type}`;
}

/**
 * Обязательства, которые СЛЕДУЕТ создать для завершённого заказа, но которых ещё
 * нет. Чистая функция: заказ и financials не мутируются. Дедупликация по identity
 * (orderId, type) — источник (snapshot/legacy) в identity НЕ входит, поэтому
 * повторный вызов, гонка и уже мигрированная legacy-комиссия дубликат не создают.
 * recognizedAt берётся из реального completedAt заказа.
 *
 * A. Деньги клиента собрал ресторан (restaurantCollectedFromCustomerCents > 0):
 *    ресторан должен Direct комиссию (platformCommissionReceivableCents), если > 0.
 * B. Деньги клиента собрал Direct (platformCollectedFromCustomerCents > 0):
 *    Direct должен ресторану выплату (restaurantNetAfterPlatformCommissionCents),
 *    если > 0.
 * Смешанный случай (обе стороны собрали) — обе записи по правилам выше.
 */
export function computeCompletedOrderAccountingEntries(
  order: Order,
  existingEntries: readonly RestaurantAccountingEntry[],
): RestaurantAccountingEntry[] {
  if (!COMPLETED_STATUSES.has(order.status)) return [];
  const fin = order.financials;
  const recognizedAt = getOrderCompletedAt(order);

  // Identity обязательства — (orderId, type), источник в неё НЕ входит: legacy
  // PLATFORM_COMMISSION того же заказа блокирует создание второй snapshot-комиссии
  // (и наоборот). Одно экономическое обязательство — одна запись на orderId/type.
  const hasEntry = (type: RestaurantAccountingType): boolean =>
    existingEntries.some(
      (entry) => entry.orderId === order.id && entry.type === type,
    );

  const make = (
    direction: RestaurantAccountingEntry["direction"],
    type: RestaurantAccountingType,
    amountCents: number,
  ): RestaurantAccountingEntry => ({
    id: accountingEntryId(order.id, type),
    orderId: order.id,
    restaurantId: order.restaurant.id,
    direction,
    type,
    amountCents,
    currencyCode: fin.currencyCode,
    status: "OPEN",
    recognizedAt,
    settledAt: null,
    source: "ORDER_FINANCIAL_SNAPSHOT",
    legacySettlementId: null,
  });

  const entries: RestaurantAccountingEntry[] = [];
  // A. Ресторан собрал деньги → должен Direct комиссию.
  if (
    fin.restaurantCollectedFromCustomerCents > 0 &&
    fin.platformCommissionReceivableCents > 0 &&
    !hasEntry("PLATFORM_COMMISSION")
  ) {
    entries.push(
      make(
        "RESTAURANT_OWES_DIRECT",
        "PLATFORM_COMMISSION",
        fin.platformCommissionReceivableCents,
      ),
    );
  }
  // B. Direct собрал деньги → должен ресторану выплату.
  if (
    fin.platformCollectedFromCustomerCents > 0 &&
    fin.restaurantNetAfterPlatformCommissionCents > 0 &&
    !hasEntry("RESTAURANT_PAYOUT")
  ) {
    entries.push(
      make(
        "DIRECT_OWES_RESTAURANT",
        "RESTAURANT_PAYOUT",
        fin.restaurantNetAfterPlatformCommissionCents,
      ),
    );
  }
  return entries;
}

/** Результат признания обязательств завершённого заказа. */
export interface RestaurantAccountingRecognition {
  ok: boolean;
  error: string | null;
  /** Сколько новых обязательств создано (0 — идемпотентный no-op). */
  recognizedCount: number;
}

/**
 * Признаёт обязательства завершённого заказа. Чистое действие: при ошибке
 * возвращает исходный state ТЕМ ЖЕ объектом; при отсутствии новых записей —
 * идемпотентный no-op без изменения state (revision не растёт). financials,
 * orders и старые settlements не мутируются. nowIso используется только как
 * bookkeeping-время мутации; recognizedAt записей берётся из completedAt заказа.
 */
export function recognizeCompletedOrderAccounting(
  state: PrototypeState,
  orderId: string,
  nowIso: string = new Date().toISOString(),
): { state: PrototypeState; result: RestaurantAccountingRecognition } {
  const fail = (error: string) => ({
    state,
    result: { ok: false, error, recognizedCount: 0 },
  });

  if (typeof nowIso !== "string" || Number.isNaN(Date.parse(nowIso))) {
    return fail("Некорректное время операции.");
  }
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return fail("Заказ не найден.");
  if (!COMPLETED_STATUSES.has(order.status)) {
    return fail("Обязательства признаются только у завершённого заказа.");
  }

  const newEntries = computeCompletedOrderAccountingEntries(
    order,
    state.restaurantAccountingEntries,
  );
  if (newEntries.length === 0) {
    // Идемпотентно: обязательства уже признаны — state не меняется.
    return { state, result: { ok: true, error: null, recognizedCount: 0 } };
  }

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      restaurantAccountingEntries: [
        ...state.restaurantAccountingEntries,
        ...newEntries,
      ],
    },
    nowIso,
  );
  return {
    state: nextState,
    result: { ok: true, error: null, recognizedCount: newEntries.length },
  };
}

/** Статус старого settlement → статус обязательства журнала. */
function legacyStatusToAccounting(
  status: SettlementEntry["status"],
): RestaurantAccountingStatus {
  if (status === "PAID" || status === "NETTED") return "SETTLED";
  if (status === "WAIVED") return "WAIVED";
  return "OPEN";
}

/**
 * Миграция существующих SettlementEntry в записи журнала (source
 * LEGACY_COMMISSION_SETTLEMENT, direction RESTAURANT_OWES_DIRECT / тип
 * PLATFORM_COMMISSION). Существующие записи сохраняются, старые settlements не
 * удаляются и не меняются. Сумма берётся из settlement, не пересчитывается.
 *
 * Дедупликация по identity обязательства (orderId, type): legacy-запись НЕ
 * создаётся, если этот settlement уже мигрирован (по legacySettlementId) ИЛИ для
 * заказа уже есть PLATFORM_COMMISSION любого источника (snapshot-запись, ранее
 * мигрированный settlement или добавленный в этом же цикле). Так один заказ не
 * получает две комиссии даже при завершении со snapshot-записью или при
 * нескольких legacy settlements одного заказа. Если snapshot-запись уже есть,
 * она остаётся авторитетной — миграция её не трогает.
 */
export function migrateLegacySettlementsToAccounting(
  existingEntries: readonly RestaurantAccountingEntry[],
  settlements: readonly SettlementEntry[],
): RestaurantAccountingEntry[] {
  const merged: RestaurantAccountingEntry[] = [...existingEntries];
  const migratedIds = new Set(
    existingEntries
      .map((entry) => entry.legacySettlementId)
      .filter((id): id is string => id !== null),
  );
  // Заказы, у которых уже есть комиссия (любого источника) — включая записи,
  // добавляемые ниже по ходу цикла.
  const ordersWithCommission = new Set(
    existingEntries
      .filter((entry) => entry.type === "PLATFORM_COMMISSION")
      .map((entry) => entry.orderId),
  );
  for (const settlement of settlements) {
    if (migratedIds.has(settlement.id)) continue;
    if (ordersWithCommission.has(settlement.orderId)) continue;
    const status = legacyStatusToAccounting(settlement.status);
    merged.push({
      id: `accounting-legacy-${settlement.id}`,
      orderId: settlement.orderId,
      restaurantId: settlement.restaurantId,
      direction: "RESTAURANT_OWES_DIRECT",
      type: "PLATFORM_COMMISSION",
      amountCents: settlement.amountCents,
      currencyCode: LEGACY_CURRENCY,
      status,
      recognizedAt: settlement.createdAt,
      settledAt: status === "SETTLED" ? settlement.createdAt : null,
      source: "LEGACY_COMMISSION_SETTLEMENT",
      legacySettlementId: settlement.id,
    });
    migratedIds.add(settlement.id);
    ordersWithCommission.add(settlement.orderId);
  }
  return merged;
}

// --- Read-only агрегаты открытой позиции ------------------------------------

/** Открытая сумма «ресторан должен Direct» (OPEN, комиссия). */
export function getRestaurantOpenReceivableCents(
  state: PrototypeState,
  restaurantId: string,
): number {
  return state.restaurantAccountingEntries.reduce((sum, entry) => {
    if (
      entry.restaurantId === restaurantId &&
      entry.direction === "RESTAURANT_OWES_DIRECT" &&
      entry.status === "OPEN"
    ) {
      return sum + entry.amountCents;
    }
    return sum;
  }, 0);
}

/** Открытая сумма «Direct должен ресторану» (OPEN, выплата). */
export function getRestaurantOpenPayableCents(
  state: PrototypeState,
  restaurantId: string,
): number {
  return state.restaurantAccountingEntries.reduce((sum, entry) => {
    if (
      entry.restaurantId === restaurantId &&
      entry.direction === "DIRECT_OWES_RESTAURANT" &&
      entry.status === "OPEN"
    ) {
      return sum + entry.amountCents;
    }
    return sum;
  }, 0);
}

/**
 * Чистая позиция = payable − receivable (только открытые обязательства).
 * Положительное значение: Direct должен ресторану; отрицательное: ресторан
 * должен Direct; ноль: открытые обязательства взаимно равны. Взаимозачёт НЕ
 * выполняется — это информационная разница.
 */
export function getRestaurantNetPositionCents(
  state: PrototypeState,
  restaurantId: string,
): number {
  return (
    getRestaurantOpenPayableCents(state, restaurantId) -
    getRestaurantOpenReceivableCents(state, restaurantId)
  );
}

// --- Административное закрытие обязательства (append-only аудит) --------------

/** Исход закрытия: внешний расчёт подтверждён либо требование Direct списано. */
export type RestaurantAccountingOutcome = "SETTLED" | "WAIVED";

export const ACCOUNTING_RESOLUTION_NOTE_MAX = 300;
export const ACCOUNTING_RESOLUTION_REFERENCE_MAX = 120;

/** Результат административного закрытия обязательства. */
export interface RestaurantAccountingResolutionResult {
  ok: boolean;
  error: string | null;
}

/**
 * Администратор Direct фиксирует закрытие обязательства: SETTLED (внешний расчёт
 * подтверждён) или WAIVED (Direct списывает собственное комиссионное требование).
 * Реального перевода/выплаты/взаимозачёта система НЕ выполняет.
 *
 * Человекочитаемое основание (note) обязательно для ОБОИХ исходов;
 * externalReference — лишь дополнительный реквизит, пустая ссылка нормализуется
 * в null. Fail-closed: повторное решение блокируется и по статусу (не-OPEN), и по
 * наличию существующего audit-события для этой entry (несогласованное состояние).
 *
 * Все проверки — до мутации; при любой ошибке возвращается исходный state ТЕМ ЖЕ
 * объектом (без нового события и без роста revision). При успехе атомарно: статус
 * записи → outcome и settledAt = nowIso; добавляется ровно одно append-only event;
 * для PLATFORM_COMMISSION синхронизируется старый SettlementEntry того же
 * (restaurantId, orderId): SETTLED→PAID, WAIVED→WAIVED (новый SettlementEntry не
 * создаётся). amountCents, direction, type, source, recognizedAt,
 * legacySettlementId и order.financials не меняются.
 */
export function resolveRestaurantAccountingEntry(
  state: PrototypeState,
  entryId: string,
  outcome: RestaurantAccountingOutcome,
  note: string,
  externalReference: string | null,
  nowIso: string = new Date().toISOString(),
): { state: PrototypeState; result: RestaurantAccountingResolutionResult } {
  const fail = (error: string) => ({ state, result: { ok: false, error } });

  if (typeof nowIso !== "string" || Number.isNaN(Date.parse(nowIso))) {
    return fail("Некорректное время операции.");
  }
  if (outcome !== "SETTLED" && outcome !== "WAIVED") {
    return fail("Неизвестный исход закрытия.");
  }
  const entry = state.restaurantAccountingEntries.find((e) => e.id === entryId);
  if (!entry) {
    return fail("Обязательство не найдено.");
  }
  if (entry.status !== "OPEN") {
    return fail("Обязательство уже закрыто.");
  }
  // Fail-closed поверх статус-guard: одно успешное resolution event на entry.
  // Защищает от несогласованного импортированного состояния, где entry ещё OPEN,
  // но audit-событие уже существует — второе решение не создаётся.
  if (
    state.restaurantAccountingResolutionEvents.some(
      (event) => event.accountingEntryId === entry.id,
    )
  ) {
    return fail("Обязательство уже закрыто.");
  }
  if (entry.amountCents <= 0) {
    return fail("Некорректная сумма обязательства.");
  }

  const normalizedNote = (note ?? "").trim();
  // Пустая ссылка / только пробелы после trim → null (не ""). Непустая — trimmed.
  const trimmedRef =
    externalReference == null ? null : externalReference.trim();
  const normalizedRef = trimmedRef ? trimmedRef : null;
  if (normalizedNote.length > ACCOUNTING_RESOLUTION_NOTE_MAX) {
    return fail("Комментарий слишком длинный.");
  }
  if (
    normalizedRef !== null &&
    normalizedRef.length > ACCOUNTING_RESOLUTION_REFERENCE_MAX
  ) {
    return fail("Внешняя ссылка слишком длинная.");
  }
  // Человекочитаемое основание обязательно для ОБОИХ исходов: externalReference —
  // только дополнительный реквизит и не заменяет note.
  if (!normalizedNote) {
    return fail("Укажите основание решения.");
  }

  if (outcome === "WAIVED") {
    // Списать можно только собственное комиссионное требование Direct.
    if (
      entry.direction !== "RESTAURANT_OWES_DIRECT" ||
      entry.type !== "PLATFORM_COMMISSION"
    ) {
      return fail("Списать можно только комиссионное требование Direct к ресторану.");
    }
  }

  const now = nowIso;
  const resolvedEntry: RestaurantAccountingEntry = {
    ...entry,
    status: outcome,
    settledAt: now,
  };

  // Синхронизация старого журнала комиссий: только для комиссии, только если
  // settlement того же заказа существует; новый settlement не создаётся.
  let settlements = state.settlements;
  if (entry.type === "PLATFORM_COMMISSION") {
    const legacyStatus = outcome === "SETTLED" ? "PAID" : "WAIVED";
    settlements = state.settlements.map((s) =>
      s.restaurantId === entry.restaurantId && s.orderId === entry.orderId
        ? { ...s, status: legacyStatus }
        : s,
    );
  }

  // Ровно одно append-only событие; id привязан к записи, поэтому второго
  // успешного закрытия одной entry не возникает (статус-guard выше это гарантирует).
  const event: RestaurantAccountingResolutionEvent = {
    id: `accounting-resolution-${entry.id}`,
    accountingEntryId: entry.id,
    restaurantId: entry.restaurantId,
    previousStatus: "OPEN",
    nextStatus: outcome,
    occurredAt: now,
    actor: "ADMIN",
    note: normalizedNote,
    externalReference: normalizedRef,
  };

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      restaurantAccountingEntries: state.restaurantAccountingEntries.map((e) =>
        e.id === entry.id ? resolvedEntry : e,
      ),
      restaurantAccountingResolutionEvents: [
        ...state.restaurantAccountingResolutionEvents,
        event,
      ],
      settlements,
    },
    now,
  );
  return { state: nextState, result: { ok: true, error: null } };
}

// --- Русские подписи для UI (сырой enum наружу не выводится) -----------------

export const ACCOUNTING_DIRECTION_LABELS: Record<
  RestaurantAccountingEntry["direction"],
  string
> = {
  RESTAURANT_OWES_DIRECT: "Ресторан должен Direct",
  DIRECT_OWES_RESTAURANT: "Direct должен ресторану",
};

export const ACCOUNTING_TYPE_LABELS: Record<
  RestaurantAccountingEntry["type"],
  string
> = {
  PLATFORM_COMMISSION: "Комиссия Direct",
  RESTAURANT_PAYOUT: "Выплата ресторану",
};

export const ACCOUNTING_STATUS_LABELS: Record<
  RestaurantAccountingEntry["status"],
  string
> = {
  OPEN: "Ожидает расчёта",
  SETTLED: "Закрыто",
  WAIVED: "Списано",
};

export const ACCOUNTING_SOURCE_LABELS: Record<
  RestaurantAccountingEntry["source"],
  string
> = {
  ORDER_FINANCIAL_SNAPSHOT: "Финансовый снимок заказа",
  LEGACY_COMMISSION_SETTLEMENT: "Перенесённое комиссионное начисление",
};

// --- Read-only журнал обязательств для UI -----------------------------------

/**
 * Безопасная строка журнала обязательств. Только поля, допустимые к показу:
 * ни клиента/телефона/адреса/кода/оплаты, ни внутреннего orderId. entryId —
 * только React-ключ (в UI не показывается), сырые enum переводятся в UI.
 */
export interface RestaurantAccountingJournalRow {
  /** Внутренний ключ строки для React; в интерфейсе не показывается. */
  entryId: string;
  /** Публичный номер заказа или null, если старого заказа уже нет. */
  publicNumber: string | null;
  recognizedAt: string;
  settledAt: string | null;
  direction: RestaurantAccountingEntry["direction"];
  type: RestaurantAccountingEntry["type"];
  amountCents: number;
  currencyCode: RestaurantAccountingEntry["currencyCode"];
  status: RestaurantAccountingEntry["status"];
  source: RestaurantAccountingEntry["source"];
  /** Есть ли ещё связанный заказ (для подписи «Старое начисление»). */
  hasOrder: boolean;
}

/**
 * Read-only журнал двусторонних обязательств ресторана. Не мутирует state. Для
 * каждой записи подтягивает публичный номер связанного заказа; если заказа уже
 * нет, запись СОХРАНЯЕТСЯ (publicNumber = null, hasOrder = false), внутренний
 * orderId наружу не выводится. Сортировка: новые recognizedAt сверху, записи с
 * невалидной датой — вниз, стабильный tie-breaker по entryId.
 */
export function buildRestaurantAccountingJournal(
  state: PrototypeState,
  restaurantId: string,
): RestaurantAccountingJournalRow[] {
  const publicNumberByOrderId = new Map<string, string>();
  for (const order of state.orders) {
    publicNumberByOrderId.set(order.id, order.publicNumber);
  }

  const rows: RestaurantAccountingJournalRow[] = state.restaurantAccountingEntries
    .filter((entry) => entry.restaurantId === restaurantId)
    .map((entry) => {
      const publicNumber = publicNumberByOrderId.get(entry.orderId) ?? null;
      return {
        entryId: entry.id,
        publicNumber,
        recognizedAt: entry.recognizedAt,
        settledAt: entry.settledAt,
        direction: entry.direction,
        type: entry.type,
        amountCents: entry.amountCents,
        currencyCode: entry.currencyCode,
        status: entry.status,
        source: entry.source,
        hasOrder: publicNumber !== null,
      };
    });

  rows.sort((a, b) => {
    const ta = Date.parse(a.recognizedAt);
    const tb = Date.parse(b.recognizedAt);
    const aValid = !Number.isNaN(ta);
    const bValid = !Number.isNaN(tb);
    if (aValid !== bValid) return aValid ? -1 : 1; // невалидные — вниз
    if (aValid && bValid && ta !== tb) return tb - ta; // новые сверху
    // Стабильный tie-breaker по внутреннему id.
    return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
  });

  return rows;
}

// --- Admin view-model расчётов ----------------------------------------------

/** Безопасное решение по обязательству для админ-истории (без внутренних id). */
export interface AdminAccountingResolutionView {
  outcome: "SETTLED" | "WAIVED";
  occurredAt: string;
  note: string;
  externalReference: string | null;
}

/** Строка админ-журнала: безопасные поля + доступные действия и решение. */
export interface AdminAccountingRow extends RestaurantAccountingJournalRow {
  restaurantName: string;
  /** Подтвердить исполнение (SETTLED) доступно для любой открытой записи. */
  canSettle: boolean;
  /** Списание (WAIVED) — только для открытого требования Direct к ресторану. */
  canWaive: boolean;
  /** Существующее решение по этой записи либо null. */
  resolution: AdminAccountingResolutionView | null;
}

export interface AdminAccountingView {
  restaurantName: string;
  openReceivableCents: number;
  openPayableCents: number;
  netPositionCents: number;
  openCount: number;
  closedCount: number;
  rows: AdminAccountingRow[];
}

/**
 * Read-only presentation-model экрана расчётов администратора. Композиция
 * существующих чистых selectors — нового финансового domain не вводит и state не
 * мутирует. Возможность списания (canWaive) вычисляется здесь, чтобы UI не
 * повторял доменное правило. Решение по записи связывается с audit-событием по
 * entryId и отдаётся без внутренних идентификаторов/enum actor/статусов события.
 */
export function buildAdminAccountingView(
  state: PrototypeState,
  restaurantId: string,
): AdminAccountingView {
  const restaurantName =
    state.restaurants.find((r) => r.id === restaurantId)?.name ?? "Ресторан";

  const resolutionByEntryId = new Map<
    string,
    AdminAccountingResolutionView
  >();
  for (const event of state.restaurantAccountingResolutionEvents) {
    if (!resolutionByEntryId.has(event.accountingEntryId)) {
      resolutionByEntryId.set(event.accountingEntryId, {
        outcome: event.nextStatus,
        occurredAt: event.occurredAt,
        note: event.note,
        externalReference: event.externalReference,
      });
    }
  }

  const journalRows = buildRestaurantAccountingJournal(state, restaurantId);
  const rows: AdminAccountingRow[] = journalRows.map((row) => {
    const isOpen = row.status === "OPEN";
    return {
      ...row,
      restaurantName,
      canSettle: isOpen,
      canWaive:
        isOpen &&
        row.direction === "RESTAURANT_OWES_DIRECT" &&
        row.type === "PLATFORM_COMMISSION",
      resolution: resolutionByEntryId.get(row.entryId) ?? null,
    };
  });

  return {
    restaurantName,
    openReceivableCents: getRestaurantOpenReceivableCents(state, restaurantId),
    openPayableCents: getRestaurantOpenPayableCents(state, restaurantId),
    netPositionCents: getRestaurantNetPositionCents(state, restaurantId),
    openCount: rows.filter((r) => r.status === "OPEN").length,
    closedCount: rows.filter((r) => r.status !== "OPEN").length,
    rows,
  };
}

/** Данные для спокойного подтверждения закрытия (без внутренних id). */
export interface AccountingResolutionConfirmation {
  outcome: "SETTLED" | "WAIVED";
  /** Публичный номер заказа или null (тогда «Старое начисление»). */
  publicNumber: string | null;
  /** Уже отформатированная сумма (например «$8.00»). */
  amountText: string;
}

/**
 * Русский текст спокойного подтверждения успешного закрытия обязательства.
 * Чистая функция без внутренних идентификаторов: для orphan-записи вместо номера
 * используется «Старое начисление». Явно сообщает, что реального движения денег
 * не было (SETTLED) и что списание — не возврат/выплата (WAIVED).
 */
export function formatAccountingResolutionMessage(
  confirmation: AccountingResolutionConfirmation,
): string {
  const orderLabel = confirmation.publicNumber ?? "Старое начисление";
  if (confirmation.outcome === "SETTLED") {
    return `Расчёт по заказу ${orderLabel} на сумму ${confirmation.amountText} зафиксирован. Денежный перевод системой не выполнялся.`;
  }
  return `Комиссия Direct по заказу ${orderLabel} на сумму ${confirmation.amountText} списана. Это не возврат и не выплата ресторану.`;
}
