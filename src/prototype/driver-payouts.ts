import type {
  DriverEarningEntry,
  DriverPayoutBatch,
  DriverPayoutMethod,
  DriverPayoutReceiptEvent,
  DriverPayoutStatus,
  PrototypeState,
} from "./models";
import type { ActionResult } from "./actions";
import { finalizeMutation } from "./prototype-store";
import { hasValidDriverEarningEntry } from "./driver-earnings";
import { addChecked, isSafeCents } from "./bank-fee";

/**
 * Строгий двусторонний расчёт Direct с водителем (v26, driver payouts v1).
 *
 * Чистый модуль: без React, provider, localStorage, банковских API, UI-расчётов
 * и Date.now/new Date для текущего времени — момент всегда приходит аргументом
 * (допустимы Date.parse и переданный nowIso). Реального перевода денег система НЕ
 * выполняет: batch — административная фиксация факта отправки/передачи, receipt —
 * подтверждение водителем фактического получения.
 *
 * В payout batch входят ТОЛЬКО заработки mode === "DIRECT_PAYOUT_DUE": наличный
 * заработок (CASH_RETAINED) водитель уже получил из наличного заказа. Статус
 * батча не хранится — выводится из наличия строгого receipt event. Записи
 * immutable и append-only; update/delete-действий нет.
 */

// --- Пользовательские ошибки --------------------------------------------------

export const DRIVER_PAYOUT_REVIEW_ERROR = "Данные выплаты требуют проверки Direct.";
export const DRIVER_PAYOUT_EARNING_REVIEW_ERROR =
  "Данные заработка водителя требуют проверки Direct.";
export const DRIVER_PAYOUT_WRONG_DRIVER_ERROR = "Выплата назначена другому водителю.";
export const DRIVER_PAYOUT_EMPTY_ERROR = "Не выбраны доставки для выплаты.";
export const DRIVER_PAYOUT_ALREADY_BATCHED_ERROR =
  "Одна из доставок уже включена в другую выплату.";
export const DRIVER_PAYOUT_ALREADY_CONFIRMED_ERROR =
  "Получение этой выплаты уже подтверждено.";

const EXTERNAL_REFERENCE_MAX = 120;
const NOTE_MAX = 300;

const KNOWN_METHODS: ReadonlySet<DriverPayoutMethod> = new Set<DriverPayoutMethod>([
  "BANK_TRANSFER",
  "CASH",
]);

// --- Детерминированные идентификаторы -----------------------------------------

/** Безопасная нормализация ISO для использования в id (только буквы и цифры). */
function isoToIdPart(iso: string): string {
  return iso.replace(/[^0-9A-Za-z]/g, "");
}

/** Детерминированный id батча: одинаковые driverId + sentAt дают один id. */
export function driverPayoutBatchId(driverId: string, sentAt: string): string {
  return `driver-payout-${driverId}-${isoToIdPart(sentAt)}`;
}

/** Детерминированный id подтверждения получения (одно на батч). */
export function driverPayoutReceiptEventId(payoutBatchId: string): string {
  return `driver-payout-receipt-${payoutBatchId}`;
}

// --- Мелкие проверки ----------------------------------------------------------

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Целое, безопасное, строго положительное. */
function safePositiveCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function knownMethod(value: unknown): value is DriverPayoutMethod {
  return KNOWN_METHODS.has(value as DriverPayoutMethod);
}

type OptionalTextResult =
  | { ok: true; value: string | null }
  | { ok: false };

/** trim → пустая строка становится null; превышение лимита — ошибка. */
function normalizeOptionalText(raw: unknown, max: number): OptionalTextResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false };
  return { ok: true, value: trimmed };
}

// --- Пригодность earning к выплате --------------------------------------------

/**
 * Может ли заработок попасть в payout batch: существует, DIRECT_PAYOUT_DUE, USD,
 * положительная сумма, правильный source, назначенному существующему заказу и
 * полностью валиден по каноническому completed-валидатору. CASH_RETAINED сюда
 * никогда не попадает — водитель уже получил эту сумму из наличного заказа.
 */
export function isEligibleDirectPayoutEarning(
  state: PrototypeState,
  entry: DriverEarningEntry,
): boolean {
  if (entry.mode !== "DIRECT_PAYOUT_DUE") return false;
  if (entry.currencyCode !== "USD") return false;
  if (entry.source !== "PLATFORM_DRIVER_ORDER") return false;
  if (!safePositiveCents(entry.amountCents)) return false;
  const order = state.orders.find((o) => o.id === entry.orderId);
  if (!order) return false;
  if (order.assignedDriverId !== entry.driverId) return false;
  if (order.deliveryMode !== "PLATFORM_DRIVER") return false;
  if (order.paymentMethod !== "ONLINE") return false;
  if (order.status !== "DELIVERED") return false;
  if (!hasValidDriverEarningEntry(state, order)) return false;
  return true;
}

// --- Строгая проверка сохранённого батча (§14) --------------------------------

export interface ValidatedPayoutBatch {
  earningEntries: DriverEarningEntry[];
  amountCents: number;
}

/**
 * Проверяет ВСЕ инварианты одного сохранённого батча и пересчитывает сумму
 * именно по immutable earning entries, сравнивая с batch.amountCents (не
 * полагаясь на сохранённое значение). Это валидация записи, а не изменение
 * финансовой истории. Не проверяет межбатчевые конфликты (см. indexValidBatches).
 */
export function validateDriverPayoutBatch(
  state: PrototypeState,
  batch: DriverPayoutBatch,
): ValidatedPayoutBatch | null {
  if (!batch || typeof batch !== "object") return null;
  if (typeof batch.id !== "string" || batch.id === "") return null;
  if (typeof batch.driverId !== "string") return null;
  if (batch.currencyCode !== "USD") return null;
  if (batch.createdBy !== "ADMIN") return null;
  if (!knownMethod(batch.method)) return null;
  if (!isValidIso(batch.sentAt)) return null;
  // Детерминированный id.
  if (batch.id !== driverPayoutBatchId(batch.driverId, batch.sentAt)) return null;
  if (!state.drivers.some((d) => d.id === batch.driverId)) return null;

  const ids = batch.earningEntryIds;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (ids.some((id) => typeof id !== "string")) return null;
  if (new Set(ids).size !== ids.length) return null; // дубли earning ids
  // Канонический порядок (raw UI-порядок источником истины не является).
  const sorted = [...ids].sort();
  if (ids.some((id, i) => id !== sorted[i])) return null;

  if (
    batch.externalReference !== null &&
    (typeof batch.externalReference !== "string" ||
      batch.externalReference.length > EXTERNAL_REFERENCE_MAX)
  ) {
    return null;
  }
  if (
    batch.note !== null &&
    (typeof batch.note !== "string" || batch.note.length > NOTE_MAX)
  ) {
    return null;
  }

  const entries: DriverEarningEntry[] = [];
  let amount = 0;
  for (const id of ids) {
    const entry = state.driverEarningEntries.find((e) => e.id === id);
    if (!entry) return null;
    if (entry.driverId !== batch.driverId) return null;
    if (!isEligibleDirectPayoutEarning(state, entry)) return null;
    const next = addChecked(amount, entry.amountCents);
    if (next === null) return null;
    amount = next;
    entries.push(entry);
  }
  if (!safePositiveCents(amount)) return null;
  if (batch.amountCents !== amount) return null; // пересчёт обязан совпасть

  return { earningEntries: entries, amountCents: amount };
}

// --- Индекс валидных батчей и конфликтов (§16) --------------------------------

interface ValidBatchIndex {
  /** batch.id → валидный батч и его пересчитанный состав. */
  valid: Map<string, { batch: DriverPayoutBatch } & ValidatedPayoutBatch>;
  /** earning ids, поглощённые валидными батчами (не подлежат повторной выплате). */
  consumedEarningIds: Set<string>;
  /** Обнаружен конфликт: битый/дубль-id/перекрывающийся батч — reviewRequired. */
  conflict: boolean;
}

/**
 * Индексирует все сохранённые батчи: структурная валидность, дубли id и
 * перекрытие earning между батчами. Любой дубликат batch id или earning,
 * встречающийся в нескольких структурно-валидных батчах, делает ВСЕ такие
 * батчи невалидными (первый не выбирается) и ставит conflict.
 */
function indexValidBatches(state: PrototypeState): ValidBatchIndex {
  const batches = state.driverPayoutBatches;
  let conflict = false;

  const idCount = new Map<string, number>();
  for (const b of batches) {
    if (b && typeof b.id === "string") {
      idCount.set(b.id, (idCount.get(b.id) ?? 0) + 1);
    }
  }

  const structurallyValid: ({ batch: DriverPayoutBatch } & ValidatedPayoutBatch)[] = [];
  for (const b of batches) {
    if (!b || typeof b.id !== "string" || b.id === "") {
      conflict = true;
      continue;
    }
    if ((idCount.get(b.id) ?? 0) > 1) {
      conflict = true; // дубликат batch id
      continue;
    }
    const validated = validateDriverPayoutBatch(state, b);
    if (validated === null) {
      conflict = true;
      continue;
    }
    structurallyValid.push({ batch: b, ...validated });
  }

  const earningOwners = new Map<string, number>();
  for (const sv of structurallyValid) {
    for (const id of sv.batch.earningEntryIds) {
      earningOwners.set(id, (earningOwners.get(id) ?? 0) + 1);
    }
  }

  const valid = new Map<string, { batch: DriverPayoutBatch } & ValidatedPayoutBatch>();
  const consumedEarningIds = new Set<string>();
  for (const sv of structurallyValid) {
    const overlaps = sv.batch.earningEntryIds.some(
      (id) => (earningOwners.get(id) ?? 0) > 1,
    );
    if (overlaps) {
      conflict = true; // одна earning в нескольких батчах
      continue;
    }
    valid.set(sv.batch.id, sv);
    for (const id of sv.batch.earningEntryIds) consumedEarningIds.add(id);
  }

  return { valid, consumedEarningIds, conflict };
}

// --- Строгая проверка подтверждения получения (§15) ---------------------------

type ReceiptState =
  | { kind: "NONE" }
  | { kind: "CONFIRMED"; confirmedAt: string }
  | { kind: "CONFLICT" };

/**
 * Состояние подтверждения получения одного ВАЛИДНОГО батча. Требует ровно одного
 * receipt event с детерминированным id, тем же водителем, actor DRIVER, валидным
 * ISO не раньше sentAt. Дубликаты — CONFLICT (батч не считается подтверждённым).
 */
function receiptStateFor(
  state: PrototypeState,
  batch: DriverPayoutBatch,
): ReceiptState {
  const receipts = state.driverPayoutReceiptEvents.filter(
    (r) => r && r.payoutBatchId === batch.id,
  );
  if (receipts.length === 0) return { kind: "NONE" };
  if (receipts.length > 1) return { kind: "CONFLICT" };
  const r = receipts[0];
  const expectedId = driverPayoutReceiptEventId(batch.id);
  if (r.id !== expectedId) return { kind: "CONFLICT" };
  if (state.driverPayoutReceiptEvents.filter((e) => e && e.id === r.id).length !== 1) {
    return { kind: "CONFLICT" };
  }
  if (r.driverId !== batch.driverId) return { kind: "CONFLICT" };
  if (r.actor !== "DRIVER") return { kind: "CONFLICT" };
  if (!isValidIso(r.occurredAt)) return { kind: "CONFLICT" };
  if (Date.parse(r.occurredAt) < Date.parse(batch.sentAt)) return { kind: "CONFLICT" };
  return { kind: "CONFIRMED", confirmedAt: r.occurredAt };
}

// --- Нормализация хранилища (§22–23) ------------------------------------------

/**
 * Оставляет только валидные батчи (schema ≥ 26). Битые/неизвестного водителя/с
 * неизвестной или CASH_RETAINED earning/с неверной суммой/дублирующими earning
 * ids батчи удаляются; дубликаты batch id и перекрытие earning между батчами
 * удаляют ВСЕ затронутые батчи (первый не выбирается). Порядок сохраняется.
 * evidence.driverEarningEntries должны быть УЖЕ нормализованы.
 */
export function keepValidPayoutBatches(state: PrototypeState): DriverPayoutBatch[] {
  const index = indexValidBatches(state);
  return state.driverPayoutBatches.filter((b) => b && index.valid.has(b.id));
}

/**
 * Оставляет только валидные подтверждения (schema ≥ 26). Требует уже
 * нормализованных валидных батчей в state. Receipt удалённого батча, битый
 * receipt, дубликаты receipt одного батча и повтор id удаляются; отсутствующий
 * receipt не синтезируется.
 */
export function keepValidPayoutReceiptEvents(
  state: PrototypeState,
): DriverPayoutReceiptEvent[] {
  const kept: DriverPayoutReceiptEvent[] = [];
  for (const batch of state.driverPayoutBatches) {
    const rs = receiptStateFor(state, batch);
    if (rs.kind !== "CONFIRMED") continue;
    const raw = state.driverPayoutReceiptEvents.find(
      (e) => e && e.payoutBatchId === batch.id,
    );
    if (!raw) continue;
    kept.push({
      id: raw.id,
      payoutBatchId: batch.id,
      driverId: raw.driverId,
      occurredAt: raw.occurredAt,
      actor: "DRIVER",
    });
  }
  return kept;
}

// --- Admin action: создать батч выплаты (§10) ---------------------------------

export interface DriverPayoutActionResult {
  ok: boolean;
  error: string | null;
  payoutBatchId: string | null;
}

export interface CreateDriverPayoutBatchInput {
  driverId: string;
  earningEntryIds: string[];
  method: DriverPayoutMethod;
  externalReference: string | null;
  note: string | null;
}

const failResult = (
  state: PrototypeState,
  error: string,
): ActionResult<DriverPayoutActionResult> => ({
  state,
  result: { ok: false, error, payoutBatchId: null },
});

/**
 * Администратор фиксирует ФАКТ отправки/передачи выплаты водителю по набору
 * невыплаченных DIRECT_PAYOUT_DUE заработков. Все проверки — до мутации; при
 * успехе добавляется ровно один immutable батч и один рост ревизии. Заработки,
 * заказы и accounting не изменяются; receipt event не создаётся (получение
 * подтверждает только водитель).
 */
export function createDriverPayoutBatch(
  state: PrototypeState,
  input: CreateDriverPayoutBatchInput,
  nowIso: string,
): ActionResult<DriverPayoutActionResult> {
  if (!isValidIso(nowIso)) return failResult(state, "Некорректное время операции.");
  if (!state.drivers.some((d) => d.id === input.driverId)) {
    return failResult(state, DRIVER_PAYOUT_WRONG_DRIVER_ERROR);
  }
  if (!knownMethod(input.method)) {
    return failResult(state, "Неизвестный способ выплаты.");
  }
  const ids = input.earningEntryIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return failResult(state, DRIVER_PAYOUT_EMPTY_ERROR);
  }
  if (ids.some((id) => typeof id !== "string")) {
    return failResult(state, DRIVER_PAYOUT_REVIEW_ERROR);
  }
  if (new Set(ids).size !== ids.length) {
    return failResult(state, DRIVER_PAYOUT_REVIEW_ERROR);
  }

  // earning ids, уже включённые в ЛЮБОЙ существующий батч — повторная выплата
  // запрещена независимо от подтверждения.
  const alreadyBatched = new Set<string>();
  for (const b of state.driverPayoutBatches) {
    if (b && Array.isArray(b.earningEntryIds)) {
      for (const id of b.earningEntryIds) alreadyBatched.add(id);
    }
  }

  const entries: DriverEarningEntry[] = [];
  let amount = 0;
  for (const id of ids) {
    const entry = state.driverEarningEntries.find((e) => e.id === id);
    if (!entry) return failResult(state, DRIVER_PAYOUT_EARNING_REVIEW_ERROR);
    if (entry.driverId !== input.driverId) {
      return failResult(state, DRIVER_PAYOUT_WRONG_DRIVER_ERROR);
    }
    if (!isEligibleDirectPayoutEarning(state, entry)) {
      return failResult(state, DRIVER_PAYOUT_EARNING_REVIEW_ERROR);
    }
    if (alreadyBatched.has(id)) {
      return failResult(state, DRIVER_PAYOUT_ALREADY_BATCHED_ERROR);
    }
    const next = addChecked(amount, entry.amountCents);
    if (next === null) return failResult(state, DRIVER_PAYOUT_REVIEW_ERROR);
    amount = next;
    entries.push(entry);
  }
  if (!safePositiveCents(amount)) return failResult(state, DRIVER_PAYOUT_REVIEW_ERROR);

  const externalReference = normalizeOptionalText(
    input.externalReference,
    EXTERNAL_REFERENCE_MAX,
  );
  if (!externalReference.ok) {
    return failResult(state, "Слишком длинная ссылка на операцию.");
  }
  const note = normalizeOptionalText(input.note, NOTE_MAX);
  if (!note.ok) return failResult(state, "Слишком длинный комментарий.");

  const id = driverPayoutBatchId(input.driverId, nowIso);
  if (state.driverPayoutBatches.some((b) => b && b.id === id)) {
    return failResult(state, DRIVER_PAYOUT_REVIEW_ERROR); // повтор id
  }

  const batch: DriverPayoutBatch = {
    id,
    driverId: input.driverId,
    currencyCode: "USD",
    earningEntryIds: [...ids].sort(),
    amountCents: amount,
    method: input.method,
    sentAt: nowIso,
    createdBy: "ADMIN",
    externalReference: externalReference.value,
    note: note.value,
  };

  const nextState = finalizeMutation(
    state,
    { ...state, driverPayoutBatches: [...state.driverPayoutBatches, batch] },
    nowIso,
  );
  return { state: nextState, result: { ok: true, error: null, payoutBatchId: id } };
}

// --- Driver action: подтвердить получение (§12) -------------------------------

/**
 * Водитель подтверждает ФАКТИЧЕСКОЕ получение выплаты. Повторное подтверждение —
 * идемпотентный success no-op с тем же state и без роста ревизии. Чужой водитель,
 * неизвестный/невалидный батч, раннее время или уже конфликтное подтверждение —
 * fail-closed без мутации. Администратор подтвердить получение не может.
 */
export function confirmDriverPayoutReceipt(
  state: PrototypeState,
  driverId: string,
  payoutBatchId: string,
  nowIso: string,
): ActionResult<DriverPayoutActionResult> {
  if (!isValidIso(nowIso)) return failResult(state, "Некорректное время операции.");
  if (!state.drivers.some((d) => d.id === driverId)) {
    return failResult(state, DRIVER_PAYOUT_WRONG_DRIVER_ERROR);
  }
  const rawBatch = state.driverPayoutBatches.find((b) => b && b.id === payoutBatchId);
  if (!rawBatch) return failResult(state, DRIVER_PAYOUT_REVIEW_ERROR);
  if (rawBatch.driverId !== driverId) {
    return failResult(state, DRIVER_PAYOUT_WRONG_DRIVER_ERROR);
  }

  const index = indexValidBatches(state);
  const valid = index.valid.get(payoutBatchId);
  if (!valid) return failResult(state, DRIVER_PAYOUT_REVIEW_ERROR);
  const batch = valid.batch;

  const receipt = receiptStateFor(state, batch);
  if (receipt.kind === "CONFIRMED") {
    // Идемпотентный success no-op: тот же state, без роста ревизии.
    return { state, result: { ok: true, error: null, payoutBatchId } };
  }
  if (receipt.kind === "CONFLICT") {
    return failResult(state, DRIVER_PAYOUT_ALREADY_CONFIRMED_ERROR);
  }
  if (Date.parse(nowIso) < Date.parse(batch.sentAt)) {
    return failResult(state, DRIVER_PAYOUT_REVIEW_ERROR);
  }

  const eventId = driverPayoutReceiptEventId(payoutBatchId);
  if (state.driverPayoutReceiptEvents.some((e) => e && e.id === eventId)) {
    return failResult(state, DRIVER_PAYOUT_REVIEW_ERROR);
  }

  const event: DriverPayoutReceiptEvent = {
    id: eventId,
    payoutBatchId,
    driverId,
    occurredAt: nowIso,
    actor: "DRIVER",
  };
  const nextState = finalizeMutation(
    state,
    {
      ...state,
      driverPayoutReceiptEvents: [...state.driverPayoutReceiptEvents, event],
    },
    nowIso,
  );
  return { state: nextState, result: { ok: true, error: null, payoutBatchId } };
}

// --- Read-model водителя (§17) ------------------------------------------------

export interface DriverPayoutBatchView {
  id: string;
  method: DriverPayoutMethod;
  status: DriverPayoutStatus;
  amountCents: number;
  sentAt: string;
  confirmedAt: string | null;
  earningCount: number;
  firstEarningAt: string;
  lastEarningAt: string;
  externalReference: string | null;
  note: string | null;
}

export interface DriverPayoutsView {
  batches: DriverPayoutBatchView[];
  unpaidEarningEntryIds: string[];
  dueFromDirectCents: number | null;
  sentAwaitingConfirmationCents: number | null;
  confirmedReceivedCents: number | null;
  reviewRequired: boolean;
}

const emptyPayoutsView = (): DriverPayoutsView => ({
  batches: [],
  unpaidEarningEntryIds: [],
  dueFromDirectCents: 0,
  sentAwaitingConfirmationCents: 0,
  confirmedReceivedCents: 0,
  reviewRequired: false,
});

/** Безопасная сумма списка центов: null при переполнении/невалидной сумме. */
function checkedSum(amounts: number[]): number | null {
  let total = 0;
  for (const a of amounts) {
    if (!isSafeCents(a)) return null;
    const next = addChecked(total, a);
    if (next === null) return null;
    total = next;
  }
  return total;
}

function batchView(
  batch: DriverPayoutBatch,
  earningEntries: DriverEarningEntry[],
  amountCents: number,
  receipt: ReceiptState,
): DriverPayoutBatchView {
  const times = earningEntries
    .map((e) => e.recognizedAt)
    .filter((t) => isValidIso(t))
    .sort();
  const status: DriverPayoutStatus =
    receipt.kind === "CONFIRMED"
      ? "CONFIRMED_RECEIVED"
      : "AWAITING_DRIVER_CONFIRMATION";
  return {
    id: batch.id,
    method: batch.method,
    status,
    amountCents,
    sentAt: batch.sentAt,
    confirmedAt: receipt.kind === "CONFIRMED" ? receipt.confirmedAt : null,
    earningCount: earningEntries.length,
    firstEarningAt: times[0] ?? batch.sentAt,
    lastEarningAt: times[times.length - 1] ?? batch.sentAt,
    externalReference: batch.externalReference,
    note: batch.note,
  };
}

/**
 * Раздел выплат водителя: валидные батчи со статусом, три раздельных итога
 * (ещё не включённые в батч DIRECT_PAYOUT_DUE; отправлено и ожидает подтверждения;
 * подтверждено получено) и флаг проверки. При конфликте payout-записей все три
 * итога null, но валидная история сохраняется.
 */
export function getDriverPayoutsView(
  state: PrototypeState,
  driverId: string,
): DriverPayoutsView {
  if (!state.drivers.some((d) => d.id === driverId)) return emptyPayoutsView();

  const index = indexValidBatches(state);

  // Конфликт, затрагивающий этого водителя: любой его сырой батч выпал из
  // валидного индекса, либо подтверждение его валидного батча конфликтно.
  let driverConflict = false;
  for (const b of state.driverPayoutBatches) {
    if (b && b.driverId === driverId && !index.valid.has(b.id)) driverConflict = true;
  }

  const views: DriverPayoutBatchView[] = [];
  const awaitingAmounts: number[] = [];
  const confirmedAmounts: number[] = [];
  for (const { batch, earningEntries, amountCents } of index.valid.values()) {
    if (batch.driverId !== driverId) continue;
    const receipt = receiptStateFor(state, batch);
    if (receipt.kind === "CONFLICT") driverConflict = true;
    views.push(batchView(batch, earningEntries, amountCents, receipt));
    if (receipt.kind === "CONFIRMED") confirmedAmounts.push(amountCents);
    else awaitingAmounts.push(amountCents);
  }

  // Невыплаченные DIRECT_PAYOUT_DUE: валидные и не поглощённые батчами.
  const unpaidEntries = state.driverEarningEntries.filter(
    (e) =>
      e.driverId === driverId &&
      e.mode === "DIRECT_PAYOUT_DUE" &&
      isEligibleDirectPayoutEarning(state, e) &&
      !index.consumedEarningIds.has(e.id),
  );
  const unpaidEarningEntryIds = unpaidEntries.map((e) => e.id).sort();

  // Новые sentAt сверху; tie-breaker по id.
  views.sort((a, b) => {
    const ta = Date.parse(a.sentAt);
    const tb = Date.parse(b.sentAt);
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const due = checkedSum(unpaidEntries.map((e) => e.amountCents));
  const awaiting = checkedSum(awaitingAmounts);
  const confirmed = checkedSum(confirmedAmounts);

  const reviewRequired =
    driverConflict || due === null || awaiting === null || confirmed === null;

  // При конфликте payout-записей все три итога null; при чистом переполнении
  // одного итога null становится только он, история и остальные итоги сохраняются.
  return {
    batches: views,
    unpaidEarningEntryIds,
    dueFromDirectCents: driverConflict ? null : due,
    sentAwaitingConfirmationCents: driverConflict ? null : awaiting,
    confirmedReceivedCents: driverConflict ? null : confirmed,
    reviewRequired,
  };
}

// --- Admin read-model (§21) ---------------------------------------------------

export interface AdminDriverPayoutEligibleEarning {
  id: string;
  orderPublicNumber: string;
  restaurantName: string;
  amountCents: number;
  recognizedAt: string;
}

export interface AdminDriverPayoutRow {
  driverId: string;
  driverName: string;
  /** Добровольная заметка водителя (v27), только для чтения; либо null. */
  statusNote: string | null;
  eligibleEarnings: AdminDriverPayoutEligibleEarning[];
  dueFromDirectCents: number | null;
  sentAwaitingConfirmationCents: number | null;
  confirmedReceivedCents: number | null;
  batches: DriverPayoutBatchView[];
  reviewRequired: boolean;
}

/**
 * Read-model выплат для администратора: по каждому водителю — невыплаченные
 * DIRECT_PAYOUT_DUE заработки (пригодные к батчу), три итога, история батчей и
 * флаг проверки. CASH_RETAINED в eligible не входит. Сортировка: сначала с
 * положительным dueFromDirect, затем ожидающие подтверждения, затем по имени,
 * стабильный tie-breaker по driverId.
 */
export function getAdminDriverPayoutsView(
  state: PrototypeState,
): AdminDriverPayoutRow[] {
  const rows: AdminDriverPayoutRow[] = state.drivers.map((driver) => {
    const view = getDriverPayoutsView(state, driver.id);
    const eligible: AdminDriverPayoutEligibleEarning[] = view.unpaidEarningEntryIds
      .map((id) => state.driverEarningEntries.find((e) => e.id === id))
      .filter((e): e is DriverEarningEntry => e !== undefined)
      .map((e) => {
        const order = state.orders.find((o) => o.id === e.orderId);
        return {
          id: e.id,
          orderPublicNumber: order ? order.publicNumber : "",
          restaurantName: order ? order.restaurant.name : "",
          amountCents: e.amountCents,
          recognizedAt: e.recognizedAt,
        };
      });
    // Стабильный порядок доступных к выплате заработков: новые сверху, tie по id.
    eligible.sort((a, b) => {
      const ta = Date.parse(a.recognizedAt);
      const tb = Date.parse(b.recognizedAt);
      if (ta !== tb) return tb - ta;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return {
      driverId: driver.id,
      driverName: driver.name,
      statusNote: driver.statusNote,
      eligibleEarnings: eligible,
      dueFromDirectCents: view.dueFromDirectCents,
      sentAwaitingConfirmationCents: view.sentAwaitingConfirmationCents,
      confirmedReceivedCents: view.confirmedReceivedCents,
      batches: view.batches,
      reviewRequired: view.reviewRequired,
    };
  });

  rows.sort((a, b) => {
    const aDue = (a.dueFromDirectCents ?? 0) > 0 ? 1 : 0;
    const bDue = (b.dueFromDirectCents ?? 0) > 0 ? 1 : 0;
    if (aDue !== bDue) return bDue - aDue;
    const aAwait = (a.sentAwaitingConfirmationCents ?? 0) > 0 ? 1 : 0;
    const bAwait = (b.sentAwaitingConfirmationCents ?? 0) > 0 ? 1 : 0;
    if (aAwait !== bAwait) return bAwait - aAwait;
    if (a.driverName !== b.driverName) return a.driverName < b.driverName ? -1 : 1;
    return a.driverId < b.driverId ? -1 : a.driverId > b.driverId ? 1 : 0;
  });

  return rows;
}
