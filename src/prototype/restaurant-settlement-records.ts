import type {
  CurrencyCode,
  PrototypeState,
  RestaurantAccountingEntry,
  RestaurantAccountingResolutionEvent,
  RestaurantSettlementMethod,
  RestaurantSettlementNetDirection,
  RestaurantSettlementRecord,
} from "./models";
import { addChecked, isSafeCents, subtractChecked } from "./bank-fee";
import { finalizeMutation } from "./prototype-store";
import {
  ACCOUNTING_RESOLUTION_NOTE_MAX,
  ACCOUNTING_RESOLUTION_REFERENCE_MAX,
} from "./restaurant-accounting";
import {
  isAllowedDirectionTypePair,
  isCanonicalIsoTimestamp,
  PARTIAL_SETTLEMENT_ERROR,
  SETTLEMENT_DIRECTION_TYPE_ERROR,
  validateRestaurantSettlementRecord,
} from "./restaurant-settlement-integrity";

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
  /**
   * Открытая позиция ресторана, которая ОСТАНЕТСЯ после подтверждения этого
   * расчёта: все прочие OPEN-обязательства ресторана. Это не «недоплаченная
   * часть» текущего расчёта — частичных расчётов не бывает.
   */
  remainingOpenEntryCount: number;
  remainingRestaurantOwesDirectCents: number;
  remainingDirectOwesRestaurantCents: number;
  remainingNetDirection: RestaurantSettlementNetDirection;
  remainingNetAmountCents: number;
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

/**
 * Положительная сумма обязательства: безопасные центы строго больше нуля.
 * Денежные helpers — общие (bank-fee), второй реализации в проекте нет.
 */
function isPositiveCents(value: unknown): value is number {
  return isSafeCents(value) && value > 0;
}

/** Направление итога по gross-сторонам. */
function netDirectionOf(
  restaurantOwesDirectCents: number,
  directOwesRestaurantCents: number,
): RestaurantSettlementNetDirection {
  if (directOwesRestaurantCents > restaurantOwesDirectCents) {
    return "DIRECT_OWES_RESTAURANT";
  }
  if (restaurantOwesDirectCents > directOwesRestaurantCents) {
    return "RESTAURANT_OWES_DIRECT";
  }
  return "BALANCED";
}

/**
 * Модуль разницы сторон checked-вычитанием: вычитается меньшее из большего,
 * поэтому отрицательного промежуточного значения и Math.abs над небезопасным
 * числом не возникает.
 */
function netAmountOf(
  restaurantOwesDirectCents: number,
  directOwesRestaurantCents: number,
): number | null {
  return directOwesRestaurantCents >= restaurantOwesDirectCents
    ? subtractChecked(directOwesRestaurantCents, restaurantOwesDirectCents)
    : subtractChecked(restaurantOwesDirectCents, directOwesRestaurantCents);
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
  const selectedIds = new Set(accountingEntryIds);
  if (selectedIds.size !== accountingEntryIds.length) {
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
  // Заказы выбранных обязательств: одному заказу соответствует не более одного
  // обязательства — и внутри расчёта, и на границе с остатком (см. ниже).
  const selectedOrderIds = new Set<string>();

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
      entry.type !== "RESTAURANT_PAYOUT" &&
      entry.type !== "RESTAURANT_REMITTANCE"
    ) {
      return previewFail("Неизвестный тип обязательства.");
    }
    // Направление и основание проверяются ПАРОЙ: комиссия и перечисление
    // ресторана всегда идут от ресторана к Direct, выплата — от Direct
    // ресторану. Смешанная пара — повреждённые данные: проверка до
    // суммирования, поэтому в gross/net такая запись не попадает.
    if (!isAllowedDirectionTypePair(entry.direction, entry.type)) {
      return previewFail(SETTLEMENT_DIRECTION_TYPE_ERROR);
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
    if (selectedOrderIds.has(entry.orderId)) {
      return previewFail("У заказа выбрано несколько обязательств.");
    }
    selectedOrderIds.add(entry.orderId);

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

  const netDirection = netDirectionOf(
    restaurantOwesDirectCents,
    directOwesRestaurantCents,
  );
  const netAmountCents = netAmountOf(
    restaurantOwesDirectCents,
    directOwesRestaurantCents,
  );
  if (netAmountCents === null) {
    return previewFail("Сумма расчёта слишком велика.");
  }

  // Остаток открытой позиции ПОСЛЕ этого расчёта: все прочие OPEN-обязательства
  // ресторана. Чтобы остаток можно было честно зафиксировать в записи, каждое
  // из них проходит ту же проверку целостности — иначе снимок остатка был бы
  // правдоподобным, но недостоверным.
  const remaining = computeRemainingOpenPosition(
    state,
    restaurantId,
    currencyCode,
    selectedIds,
    selectedOrderIds,
    resolvedEntryIds,
    alreadySettledIds,
  );
  if (!remaining.ok) {
    return previewFail(remaining.error);
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
      remainingOpenEntryCount: remaining.openEntryCount,
      remainingRestaurantOwesDirectCents: remaining.restaurantOwesDirectCents,
      remainingDirectOwesRestaurantCents: remaining.directOwesRestaurantCents,
      remainingNetDirection: remaining.netDirection,
      remainingNetAmountCents: remaining.netAmountCents,
    },
  };
}

/** Открытая позиция, остающаяся после закрытия выбранных обязательств. */
type RemainingOpenPosition =
  | {
      ok: true;
      openEntryCount: number;
      restaurantOwesDirectCents: number;
      directOwesRestaurantCents: number;
      netDirection: RestaurantSettlementNetDirection;
      netAmountCents: number;
    }
  | { ok: false; error: string };

/**
 * Остаток открытой позиции ресторана без выбранных обязательств.
 *
 * Учитываются ТОЛЬКО OPEN-обязательства этого ресторана, не входящие в текущий
 * расчёт. SETTLED, WAIVED и обязательства других ресторанов не участвуют.
 * Каждое оставшееся обязательство проверяется так же строго, как выбранное:
 * известные direction/type, допустимая пара, положительная безопасная сумма,
 * та же валюта, отсутствие второго обязательства того же заказа, отсутствие
 * resolution event у OPEN-записи и отсутствие в уже закрытых расчётах.
 * Повреждённая оставшаяся позиция — fail-closed, а не правдоподобный ноль.
 */
function computeRemainingOpenPosition(
  state: PrototypeState,
  restaurantId: string,
  currencyCode: CurrencyCode,
  selectedIds: ReadonlySet<string>,
  selectedOrderIds: ReadonlySet<string>,
  resolvedEntryIds: ReadonlySet<string>,
  alreadySettledIds: ReadonlySet<string>,
): RemainingOpenPosition {
  const fail = (error: string): RemainingOpenPosition => ({ ok: false, error });

  let restaurantOwesDirectCents = 0;
  let directOwesRestaurantCents = 0;
  let openEntryCount = 0;
  const seenOrderIds = new Set<string>();

  for (const entry of state.restaurantAccountingEntries) {
    if (entry.restaurantId !== restaurantId) continue;
    if (entry.status !== "OPEN") continue;
    if (selectedIds.has(entry.id)) continue;

    if (resolvedEntryIds.has(entry.id)) {
      return fail("По открытому обязательству уже есть решение администратора.");
    }
    if (alreadySettledIds.has(entry.id)) {
      return fail("Открытое обязательство уже входит в закрытый расчёт.");
    }
    if (
      entry.direction !== "RESTAURANT_OWES_DIRECT" &&
      entry.direction !== "DIRECT_OWES_RESTAURANT"
    ) {
      return fail("Неизвестное направление обязательства.");
    }
    if (
      entry.type !== "PLATFORM_COMMISSION" &&
      entry.type !== "RESTAURANT_PAYOUT" &&
      entry.type !== "RESTAURANT_REMITTANCE"
    ) {
      return fail("Неизвестный тип обязательства.");
    }
    if (!isAllowedDirectionTypePair(entry.direction, entry.type)) {
      return fail(SETTLEMENT_DIRECTION_TYPE_ERROR);
    }
    if (!isPositiveCents(entry.amountCents)) {
      return fail("Некорректная сумма обязательства.");
    }
    if (entry.currencyCode !== currencyCode) {
      return fail("В открытой позиции ресторана разные валюты.");
    }
    // Инвариант шире, чем «дубли внутри остатка»: один заказ не может дать
    // одно обязательство в текущий расчёт и второе — в остаток. Иначе сумма
    // заказа учлась бы дважды: один раз закрытой, второй раз открытой.
    if (selectedOrderIds.has(entry.orderId)) {
      return fail(
        "У заказа обнаружено несколько обязательств между выбранным расчётом и остатком.",
      );
    }
    if (seenOrderIds.has(entry.orderId)) {
      return fail("У заказа обнаружено несколько открытых обязательств.");
    }
    seenOrderIds.add(entry.orderId);

    if (entry.direction === "RESTAURANT_OWES_DIRECT") {
      const next = addChecked(restaurantOwesDirectCents, entry.amountCents);
      if (next === null) return fail("Остаток расчёта слишком велик.");
      restaurantOwesDirectCents = next;
    } else {
      const next = addChecked(directOwesRestaurantCents, entry.amountCents);
      if (next === null) return fail("Остаток расчёта слишком велик.");
      directOwesRestaurantCents = next;
    }
    openEntryCount += 1;
  }

  const netAmountCents = netAmountOf(
    restaurantOwesDirectCents,
    directOwesRestaurantCents,
  );
  if (netAmountCents === null) {
    return fail("Остаток расчёта слишком велик.");
  }
  return {
    ok: true,
    openEntryCount,
    restaurantOwesDirectCents,
    directOwesRestaurantCents,
    netDirection: netDirectionOf(
      restaurantOwesDirectCents,
      directOwesRestaurantCents,
    ),
    netAmountCents,
  };
}

/**
 * Вход подтверждения расчёта: объект вместо длинного позиционного списка —
 * добавление способа и фактической суммы не должно превращать вызов в набор
 * безымянных аргументов.
 */
export interface ConfirmRestaurantSettlementInput {
  restaurantId: string;
  accountingEntryIds: readonly string[];
  method: RestaurantSettlementMethod;
  transferredAmountCents: number;
  note: string;
  externalReference: string | null;
  /** Момент операции; по умолчанию — текущее время. */
  nowIso?: string;
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
  input: ConfirmRestaurantSettlementInput,
): { state: PrototypeState; result: RestaurantSettlementConfirmResult } {
  const {
    restaurantId,
    accountingEntryIds,
    method,
    transferredAmountCents,
    note,
    externalReference,
    nowIso = new Date().toISOString(),
  } = input;
  const fail = (error: string) => ({
    state,
    result: { ok: false, error, settlementRecordId: null },
  });

  // Момент операции проверяется ПЕРВЫМ — до preview, id расчёта, черновика
  // записи и любых изменений: принимается только полный ISO-8601 с часовым
  // поясом, автонормализация неканонического значения запрещена.
  if (!isCanonicalIsoTimestamp(nowIso)) {
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

  // v14: способ и фактически переданная сумма проверяются ДО любых изменений.
  // Частичные расчёты не поддерживаются: при ненулевом итоге сумма обязана
  // совпасть точно, иначе закрывать все обязательства как SETTLED нельзя.
  if (!isSafeCents(transferredAmountCents)) {
    return fail("Некорректная фактически переданная сумма.");
  }
  if (preview.netDirection === "BALANCED") {
    if (method !== "NETTING") {
      return fail("При нулевом итоге возможен только взаимозачёт.");
    }
    if (transferredAmountCents !== 0) {
      return fail("При взаимозачёте фактически переданная сумма равна нулю.");
    }
  } else {
    if (method !== "BANK_TRANSFER" && method !== "CASH" && method !== "OTHER") {
      return fail("Выберите способ фактического расчёта.");
    }
    if (transferredAmountCents !== preview.netAmountCents) {
      return fail(PARTIAL_SETTLEMENT_ERROR);
    }
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
  const draftRecord: RestaurantSettlementRecord = {
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
    // Остаток берётся ТОЛЬКО из свежего preview: переданным из UI значениям
    // gross/net/remaining доверия нет, они всегда строятся заново из state.
    execution: {
      dataStatus: "COMPLETE",
      method,
      transferredAmountCents,
      remainingOpenEntryCount: preview.remainingOpenEntryCount,
      remainingRestaurantOwesDirectCents:
        preview.remainingRestaurantOwesDirectCents,
      remainingDirectOwesRestaurantCents:
        preview.remainingDirectOwesRestaurantCents,
      remainingNetDirection: preview.remainingNetDirection,
      remainingNetAmountCents: preview.remainingNetAmountCents,
    },
  };
  // Defensive invariant: создаваемая запись проходит тот же канонический
  // validator, что и сохранённые. Неожиданно невалидная запись не должна
  // ничего закрывать — fail-closed без частичных изменений.
  const validated = validateRestaurantSettlementRecord(draftRecord);
  if (!validated.ok) {
    return fail(validated.error);
  }
  const record = validated.record;

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
