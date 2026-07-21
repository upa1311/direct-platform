import type {
  CurrencyCode,
  PrototypeState,
  RestaurantAccountingEntry,
  RestaurantAccountingResolutionEvent,
  RestaurantSettlementNetDirection,
  RestaurantSettlementRecord,
} from "./models";
import { finalizeMutation } from "./prototype-store";
import {
  ACCOUNTING_RESOLUTION_NOTE_MAX,
  ACCOUNTING_RESOLUTION_REFERENCE_MAX,
} from "./restaurant-accounting";

/**
 * Групповой закрытый расчёт между Direct и рестораном.
 *
 * Чистое ядро (preview) не мутирует состояние; административное подтверждение
 * атомарно: либо создаются запись расчёта, закрытие ВСЕХ выбранных
 * обязательств, по одному audit-событию на обязательство и синхронизация
 * старых комиссионных settlements, либо не меняется ничего (исходный state тем
 * же объектом, revision не растёт).
 *
 * Существующее одиночное закрытие resolveRestaurantAccountingEntry не
 * заменяется: списание требований (WAIVED) остаётся только там и в групповой
 * расчёт не входит. Реального перевода денег система не выполняет — фиксируется
 * административное решение о внешнем платеже.
 */

/** Валюты, поддерживаемые платформой для расчётов. */
const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = ["USD"];

/** Preview выбранных обязательств: суммы сторон и готовый net. */
export interface RestaurantSettlementPreview {
  restaurantId: string;
  currencyCode: CurrencyCode;
  accountingEntryIds: string[];
  restaurantOwesDirectCents: number;
  directOwesRestaurantCents: number;
  netDirection: RestaurantSettlementNetDirection;
  netAmountCents: number;
  entryCount: number;
}

export type RestaurantSettlementPreviewResult =
  | { ok: true; preview: RestaurantSettlementPreview }
  | { ok: false; error: string };

export interface RestaurantSettlementConfirmResult {
  ok: boolean;
  error: string | null;
  /** Идентификатор созданной записи расчёта; null при ошибке. */
  settlementRecordId: string | null;
}

function previewFail(error: string): RestaurantSettlementPreviewResult {
  return { ok: false, error };
}

/** Положительные целые конечные центы (сумма обязательства). */
function isPositiveCents(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

/** Сложение с проверкой безопасного целочисленного диапазона. */
function addChecked(a: number, b: number): number | null {
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
}

/**
 * Детерминированный идентификатор расчёта: строится из ресторана, момента
 * подтверждения и отсортированных обязательств. Случайности нет — повтор той
 * же операции даёт тот же id и отсекается проверкой существующих записей.
 */
export function settlementRecordId(
  restaurantId: string,
  nowIso: string,
  accountingEntryIds: readonly string[],
): string {
  const key = [...accountingEntryIds].sort().join("|");
  // Компактный детерминированный хеш (FNV-1a 32-бит) — только для id.
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `settlement-record-${restaurantId}-${nowIso}-${hash.toString(36)}`;
}

/**
 * Чистый preview группового расчёта: суммирует ТОЛЬКО явно перечисленные
 * открытые обязательства ресторана. Автоматический выбор «всех записей» не
 * выполняется. Fail-closed без частичного результата при любой проблеме:
 * пустой список, повтор id во входе, отсутствующее/чужое/закрытое
 * обязательство, уже существующее audit-событие или включение в другой расчёт,
 * разные или неподдерживаемые валюты, некорректная сумма, несколько
 * обязательств одного заказа, недопустимая структура и переполнение.
 */
export function buildRestaurantSettlementPreview(
  state: PrototypeState,
  restaurantId: string,
  accountingEntryIds: readonly string[],
): RestaurantSettlementPreviewResult {
  if (!Array.isArray(accountingEntryIds) || accountingEntryIds.length === 0) {
    return previewFail("Выберите обязательства для расчёта.");
  }
  const uniqueIds = new Set(accountingEntryIds);
  if (uniqueIds.size !== accountingEntryIds.length) {
    return previewFail("Обязательство указано в расчёте несколько раз.");
  }

  const entriesById = new Map<string, RestaurantAccountingEntry>();
  for (const entry of state.restaurantAccountingEntries) {
    entriesById.set(entry.id, entry);
  }
  const resolvedEntryIds = new Set(
    state.restaurantAccountingResolutionEvents.map(
      (event) => event.accountingEntryId,
    ),
  );
  const alreadySettledIds = new Set(
    state.restaurantSettlementRecords.flatMap(
      (record) => record.accountingEntryIds,
    ),
  );

  let restaurantOwesDirectCents = 0;
  let directOwesRestaurantCents = 0;
  let currencyCode: CurrencyCode | null = null;
  const seenOrderIds = new Set<string>();

  for (const entryId of accountingEntryIds) {
    const entry = entriesById.get(entryId);
    if (!entry) {
      return previewFail("Обязательство не найдено.");
    }
    if (entry.restaurantId !== restaurantId) {
      return previewFail("Обязательство относится к другому ресторану.");
    }
    if (entry.status !== "OPEN") {
      return previewFail("Обязательство уже закрыто.");
    }
    if (resolvedEntryIds.has(entry.id)) {
      return previewFail("По обязательству уже есть решение администратора.");
    }
    if (alreadySettledIds.has(entry.id)) {
      return previewFail("Обязательство уже входит в закрытый расчёт.");
    }
    if (
      entry.direction !== "RESTAURANT_OWES_DIRECT" &&
      entry.direction !== "DIRECT_OWES_RESTAURANT"
    ) {
      return previewFail("Неизвестное направление обязательства.");
    }
    if (
      entry.type !== "PLATFORM_COMMISSION" &&
      entry.type !== "RESTAURANT_PAYOUT"
    ) {
      return previewFail("Неизвестный тип обязательства.");
    }
    if (!isPositiveCents(entry.amountCents)) {
      return previewFail("Некорректная сумма обязательства.");
    }
    if (!SUPPORTED_CURRENCIES.includes(entry.currencyCode)) {
      return previewFail("Валюта обязательства не поддерживается.");
    }
    if (currencyCode === null) {
      currencyCode = entry.currencyCode;
    } else if (entry.currencyCode !== currencyCode) {
      return previewFail("В расчёт нельзя включать разные валюты.");
    }
    if (seenOrderIds.has(entry.orderId)) {
      return previewFail("У заказа выбрано несколько обязательств.");
    }
    seenOrderIds.add(entry.orderId);

    if (entry.direction === "RESTAURANT_OWES_DIRECT") {
      const next = addChecked(restaurantOwesDirectCents, entry.amountCents);
      if (next === null) return previewFail("Сумма расчёта слишком велика.");
      restaurantOwesDirectCents = next;
    } else {
      const next = addChecked(directOwesRestaurantCents, entry.amountCents);
      if (next === null) return previewFail("Сумма расчёта слишком велика.");
      directOwesRestaurantCents = next;
    }
  }

  if (currencyCode === null) {
    return previewFail("Не удалось определить валюту расчёта.");
  }

  const netDirection: RestaurantSettlementNetDirection =
    directOwesRestaurantCents > restaurantOwesDirectCents
      ? "DIRECT_OWES_RESTAURANT"
      : restaurantOwesDirectCents > directOwesRestaurantCents
        ? "RESTAURANT_OWES_DIRECT"
        : "BALANCED";
  const netAmountCents = Math.abs(
    directOwesRestaurantCents - restaurantOwesDirectCents,
  );
  if (!Number.isSafeInteger(netAmountCents)) {
    return previewFail("Сумма расчёта слишком велика.");
  }

  return {
    ok: true,
    preview: {
      restaurantId,
      currencyCode,
      accountingEntryIds: [...accountingEntryIds],
      restaurantOwesDirectCents,
      directOwesRestaurantCents,
      netDirection,
      netAmountCents,
      entryCount: accountingEntryIds.length,
    },
  };
}

/**
 * Административное подтверждение группового расчёта. Preview строится ЗАНОВО
 * внутри действия — переданному из UI результату доверия нет.
 *
 * Обязательное основание (note) — всегда; внешняя ссылка обязательна, когда
 * netAmountCents > 0 (подтверждается внешний платёж одной из сторон), и может
 * отсутствовать только при чистом взаимозачёте равных сторон (BALANCED).
 *
 * При успехе одной транзакцией: одна RestaurantSettlementRecord, все выбранные
 * обязательства → SETTLED с общим settledAt, по одному resolution event на
 * обязательство, синхронизация старых комиссионных SettlementEntry в PAID
 * (новые не создаются) и один рост revision. При любой ошибке — исходный state
 * тем же объектом без частичных изменений.
 */
export function confirmRestaurantSettlement(
  state: PrototypeState,
  restaurantId: string,
  accountingEntryIds: readonly string[],
  note: string,
  externalReference: string | null,
  nowIso: string = new Date().toISOString(),
): { state: PrototypeState; result: RestaurantSettlementConfirmResult } {
  const fail = (error: string) => ({
    state,
    result: { ok: false, error, settlementRecordId: null },
  });

  if (typeof nowIso !== "string" || Number.isNaN(Date.parse(nowIso))) {
    return fail("Некорректное время операции.");
  }

  const normalizedNote = (note ?? "").trim();
  if (!normalizedNote) {
    return fail("Укажите основание расчёта.");
  }
  if (normalizedNote.length > ACCOUNTING_RESOLUTION_NOTE_MAX) {
    return fail("Комментарий слишком длинный.");
  }
  const trimmedReference =
    externalReference == null ? null : externalReference.trim();
  const normalizedReference = trimmedReference ? trimmedReference : null;
  if (
    normalizedReference !== null &&
    normalizedReference.length > ACCOUNTING_RESOLUTION_REFERENCE_MAX
  ) {
    return fail("Внешняя ссылка слишком длинная.");
  }

  // Канонический preview — единственный источник сумм расчёта.
  const previewResult = buildRestaurantSettlementPreview(
    state,
    restaurantId,
    accountingEntryIds,
  );
  if (!previewResult.ok) {
    return fail(previewResult.error);
  }
  const preview = previewResult.preview;

  // Ненулевой итог означает внешний платёж — нужна ссылка на него. Чистый
  // взаимозачёт равных обязательств допустим без внешней ссылки.
  if (preview.netAmountCents > 0 && normalizedReference === null) {
    return fail("Укажите внешнюю ссылку на платёж.");
  }

  const recordId = settlementRecordId(
    restaurantId,
    nowIso,
    preview.accountingEntryIds,
  );
  if (state.restaurantSettlementRecords.some((r) => r.id === recordId)) {
    return fail("Такой расчёт уже подтверждён.");
  }

  const selectedIds = new Set(preview.accountingEntryIds);
  const record: RestaurantSettlementRecord = {
    id: recordId,
    restaurantId,
    currencyCode: preview.currencyCode,
    accountingEntryIds: [...preview.accountingEntryIds],
    restaurantOwesDirectCents: preview.restaurantOwesDirectCents,
    directOwesRestaurantCents: preview.directOwesRestaurantCents,
    netDirection: preview.netDirection,
    netAmountCents: preview.netAmountCents,
    settledAt: nowIso,
    actor: "ADMIN",
    note: normalizedNote,
    externalReference: normalizedReference,
  };

  // Все выбранные обязательства закрываются одним и тем же моментом.
  const nextEntries = state.restaurantAccountingEntries.map((entry) =>
    selectedIds.has(entry.id)
      ? { ...entry, status: "SETTLED" as const, settledAt: nowIso }
      : entry,
  );

  // Ровно одно append-only событие на каждое обязательство.
  const newEvents: RestaurantAccountingResolutionEvent[] =
    preview.accountingEntryIds.map((entryId) => ({
      id: `accounting-resolution-${entryId}`,
      accountingEntryId: entryId,
      restaurantId,
      previousStatus: "OPEN",
      nextStatus: "SETTLED",
      occurredAt: nowIso,
      actor: "ADMIN",
      note: normalizedNote,
      externalReference: normalizedReference,
    }));

  // Синхронизация старого журнала комиссий: только для комиссионных
  // обязательств и только существующих settlements; новые не создаются.
  const commissionOrderIds = new Set(
    state.restaurantAccountingEntries
      .filter(
        (entry) =>
          selectedIds.has(entry.id) && entry.type === "PLATFORM_COMMISSION",
      )
      .map((entry) => entry.orderId),
  );
  const nextSettlements = state.settlements.map((settlement) =>
    settlement.restaurantId === restaurantId &&
    commissionOrderIds.has(settlement.orderId)
      ? { ...settlement, status: "PAID" as const }
      : settlement,
  );

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      restaurantAccountingEntries: nextEntries,
      restaurantAccountingResolutionEvents: [
        ...state.restaurantAccountingResolutionEvents,
        ...newEvents,
      ],
      restaurantSettlementRecords: [
        ...state.restaurantSettlementRecords,
        record,
      ],
      settlements: nextSettlements,
    },
    nowIso,
  );
  return {
    state: nextState,
    result: { ok: true, error: null, settlementRecordId: recordId },
  };
}

/** Записи закрытых расчётов ресторана, новые сверху (read-only). */
export function getRestaurantSettlementRecords(
  state: PrototypeState,
  restaurantId: string,
): RestaurantSettlementRecord[] {
  return state.restaurantSettlementRecords
    .filter((record) => record.restaurantId === restaurantId)
    .sort((a, b) => {
      const ta = Date.parse(a.settledAt);
      const tb = Date.parse(b.settledAt);
      if (ta !== tb) return tb - ta;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}
