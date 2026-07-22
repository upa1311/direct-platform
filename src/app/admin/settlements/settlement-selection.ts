import type { AdminAccountingRow } from "@/prototype/restaurant-accounting";
import type {
  RestaurantSettlementExecution,
  RestaurantSettlementMethod,
  RestaurantSettlementNetDirection,
  RestaurantSettlementRecord,
} from "@/prototype/models";
// Относительный путь намеренно: этот модуль импортируется напрямую доменными
// тестами (node --test), где alias `@/` не резолвится для value-импортов.
import { isSafeCents } from "../../../prototype/bank-fee";

/**
 * Чистая логика выбора обязательств и презентации группового расчёта для
 * админского экрана. Финансовой арифметики здесь нет: направление и суммы
 * приходят готовыми из канонического доменного preview/record — React их
 * только выбирает и подписывает.
 */

/** Идентификаторы всех открытых обязательств текущего ресторана. */
export function openEntryIds(rows: readonly AdminAccountingRow[]): string[] {
  return rows.filter((row) => row.status === "OPEN").map((row) => row.entryId);
}

/**
 * Согласование выбора со свежим состоянием: остаются только те id, которые всё
 * ещё существуют у этого ресторана и всё ещё открыты. Другая вкладка могла
 * закрыть обязательство между preview и подтверждением — повторно закрывать
 * его нельзя.
 */
export function reconcileSelection(
  selectedEntryIds: readonly string[],
  rows: readonly AdminAccountingRow[],
): string[] {
  const open = new Set(openEntryIds(rows));
  return selectedEntryIds.filter((id) => open.has(id));
}

/** Доступная подпись чекбокса строки: заказ и сумма обязательства. */
export function selectionCheckboxLabel(
  row: AdminAccountingRow,
  amountText: string,
): string {
  const order = row.publicNumber ?? "старого начисления";
  return `Выбрать обязательство заказа ${order} на ${amountText}`;
}

/** Заголовок и подпись главного итога preview по готовому направлению. */
export function describeSettlementNet(
  netDirection: RestaurantSettlementNetDirection,
): { title: string; warning: string } {
  if (netDirection === "DIRECT_OWES_RESTAURANT") {
    return {
      title: "Direct должен выплатить ресторану",
      warning:
        "Direct не выполняет банковский перевод автоматически. Подтверждение фиксирует внешний расчёт и закроет выбранные обязательства.",
    };
  }
  if (netDirection === "RESTAURANT_OWES_DIRECT") {
    return {
      title: "Ресторан должен выплатить Direct",
      warning:
        "Direct не выполняет банковский перевод автоматически. Подтверждение фиксирует внешний расчёт и закроет выбранные обязательства.",
    };
  }
  return {
    title: "Взаимозачёт без дополнительного платежа",
    warning: "Будет зафиксирован взаимозачёт равных обязательств.",
  };
}

/** Текст кнопки подтверждения по готовому направлению итога. */
export function settlementConfirmLabel(
  netDirection: RestaurantSettlementNetDirection,
): string {
  if (netDirection === "DIRECT_OWES_RESTAURANT") {
    return "Подтвердить выплату ресторану";
  }
  if (netDirection === "RESTAURANT_OWES_DIRECT") {
    return "Подтвердить оплату Direct";
  }
  return "Подтвердить взаимозачёт";
}

/** Подпись итога в истории расчётов (прошедшее время). */
export function settlementHistoryLabel(
  netDirection: RestaurantSettlementNetDirection,
): string {
  if (netDirection === "DIRECT_OWES_RESTAURANT") return "Direct выплатил ресторану";
  if (netDirection === "RESTAURANT_OWES_DIRECT") return "Ресторан оплатил Direct";
  return "Взаимозачёт";
}

/** Русское склонение слова «обязательство» для счётчиков. */
export function pluralObligations(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "обязательство";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "обязательства";
  }
  return "обязательств";
}

/** Русские подписи способов расчёта (сырой enum наружу не выводится). */
export const RESTAURANT_SETTLEMENT_METHOD_LABELS: Record<
  RestaurantSettlementMethod,
  string
> = {
  BANK_TRANSFER: "Банковский перевод",
  CASH: "Наличные",
  OTHER: "Другой способ",
  NETTING: "Взаимозачёт",
};

/** Способы, доступные администратору вручную при ненулевом итоге расчёта. */
export const MANUAL_SETTLEMENT_METHODS: readonly RestaurantSettlementMethod[] = [
  "BANK_TRANSFER",
  "CASH",
  "OTHER",
];

export type SettlementAmountParseResult =
  | { ok: true; cents: number }
  | { ok: false; error: string };

/**
 * Строгий разбор фактически переданной суммы в центы.
 *
 * Финансовое подтверждение не имеет права молча превратить повреждённый ввод в
 * ноль или неоднозначно округлить: принимается только неотрицательное
 * десятичное число максимум с двумя знаками после разделителя, без экспоненты.
 * Центы собираются целочисленно (целая часть × 100 + дробная), поэтому
 * плавающей арифметики в результате нет; итог дополнительно проверяется на
 * безопасный целый диапазон.
 */
export function parseSettlementAmountToCents(
  value: string,
): SettlementAmountParseResult {
  const raw = (value ?? "").trim().replace(",", ".");
  if (raw.length === 0) {
    return { ok: false, error: "Укажите фактически переданную сумму." };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    return {
      ok: false,
      error:
        "Сумма указывается в долларах, максимум с двумя знаками после точки.",
    };
  }
  const [whole, fraction = ""] = raw.split(".");
  const wholeCents = Number(whole) * 100;
  const cents = wholeCents + Number(fraction.padEnd(2, "0"));
  if (!isSafeCents(wholeCents) || !isSafeCents(cents)) {
    return { ok: false, error: "Сумма выходит за безопасный диапазон." };
  }
  return { ok: true, cents };
}

/** Допустим ли способ расчёта для готового направления итога. */
export function isMethodAllowedForNet(
  method: RestaurantSettlementMethod,
  netDirection: RestaurantSettlementNetDirection,
): boolean {
  return netDirection === "BALANCED"
    ? method === "NETTING"
    : MANUAL_SETTLEMENT_METHODS.includes(method);
}

/**
 * Можно ли подтверждать расчёт: чистая проверка формы. Домен остаётся
 * окончательным guard — здесь только защита от заведомо неотправляемой формы.
 */
export function canConfirmSettlement(input: {
  hasSelection: boolean;
  previewOk: boolean;
  netDirection: RestaurantSettlementNetDirection | null;
  netAmountCents: number | null;
  method: RestaurantSettlementMethod;
  amountInput: string;
  note: string;
  reference: string;
  pending: boolean;
}): boolean {
  if (!input.hasSelection || !input.previewOk || input.pending) return false;
  if (input.note.trim().length === 0) return false;
  if (input.netDirection === null) return false;
  if (!isMethodAllowedForNet(input.method, input.netDirection)) return false;

  // Взаимозачёт: внешнего платежа нет, ссылка и сумма не требуются.
  if (input.netDirection === "BALANCED") return true;

  // Ненулевой итог означает внешний платёж — нужна ссылка на него.
  if (input.reference.trim().length === 0) return false;
  const parsed = parseSettlementAmountToCents(input.amountInput);
  if (!parsed.ok) return false;
  // Частичные расчёты не поддерживаются: сумма обязана совпасть точно.
  return parsed.cents === input.netAmountCents;
}

/** Данные успешного подтверждения для спокойного баннера. */
export interface SettlementSuccess {
  netDirection: RestaurantSettlementNetDirection;
  netAmountCents: number;
  entryCount: number;
  method: RestaurantSettlementMethod;
  transferredAmountCents: number;
  remainingOpenEntryCount: number;
  remainingNetDirection: RestaurantSettlementNetDirection;
  remainingNetAmountCents: number;
}

/**
 * Сообщение об успешном расчёте: кто кому выплатил, фактическая сумма, способ,
 * сколько обязательств закрыто и какой остаток остался. Показывается только
 * после реального доменного успеха.
 */
export function formatSettlementSuccess(
  success: SettlementSuccess,
  transferredText: string,
  remainingText: string,
): string {
  const closed = `Закрыто ${success.entryCount} ${pluralObligations(success.entryCount)}.`;
  const method = `Способ: ${RESTAURANT_SETTLEMENT_METHOD_LABELS[success.method]}.`;
  const remaining =
    success.remainingOpenEntryCount === 0
      ? "Открытая позиция закрыта полностью."
      : `Остаток: ${settlementHistoryLabel(success.remainingNetDirection)} — ${remainingText}, осталось ${success.remainingOpenEntryCount} ${pluralObligations(success.remainingOpenEntryCount)}.`;
  const head =
    success.netDirection === "BALANCED"
      ? "Зафиксирован взаимозачёт равных обязательств."
      : `${settlementHistoryLabel(success.netDirection)}: ${transferredText}.`;
  return `${head} ${method} ${closed} ${remaining}`;
}

/** Запись истории без внутренних идентификаторов обязательств. */
export interface SettlementHistoryRow {
  id: string;
  settledAt: string;
  entryCount: number;
  restaurantOwesDirectCents: number;
  directOwesRestaurantCents: number;
  netDirection: RestaurantSettlementNetDirection;
  netAmountCents: number;
  note: string;
  externalReference: string | null;
  /** v14: детали исполнения как они сохранены в записи (не пересчитываются). */
  execution: RestaurantSettlementExecution;
}

/** Честное сообщение для архивной записи без деталей исполнения. */
export const LEGACY_EXECUTION_MESSAGE =
  "Архивная запись: способ, фактическая сумма и остаток после расчёта не были сохранены.";

/**
 * История групповых расчётов для показа: внутренние accountingEntryIds наружу
 * не выводятся — только их количество. Суммы и направление берутся из записи
 * как есть, повторно ничего не считается.
 */
export function toSettlementHistoryRows(
  records: readonly RestaurantSettlementRecord[],
): SettlementHistoryRow[] {
  return records.map((record) => ({
    id: record.id,
    settledAt: record.settledAt,
    entryCount: record.accountingEntryIds.length,
    restaurantOwesDirectCents: record.restaurantOwesDirectCents,
    directOwesRestaurantCents: record.directOwesRestaurantCents,
    netDirection: record.netDirection,
    netAmountCents: record.netAmountCents,
    note: record.note,
    externalReference: record.externalReference,
    execution: record.execution,
  }));
}
