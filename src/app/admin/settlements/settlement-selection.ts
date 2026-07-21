import type { AdminAccountingRow } from "@/prototype/restaurant-accounting";
import type {
  RestaurantSettlementNetDirection,
  RestaurantSettlementRecord,
} from "@/prototype/models";

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

/** Можно ли подтверждать расчёт: чистая проверка формы (домен — окончательный). */
export function canConfirmSettlement(input: {
  hasSelection: boolean;
  previewOk: boolean;
  netAmountCents: number | null;
  note: string;
  reference: string;
  pending: boolean;
}): boolean {
  if (!input.hasSelection || !input.previewOk || input.pending) return false;
  if (input.note.trim().length === 0) return false;
  // Ненулевой итог означает внешний платёж — нужна ссылка на него.
  if ((input.netAmountCents ?? 0) > 0 && input.reference.trim().length === 0) {
    return false;
  }
  return true;
}

/** Данные успешного подтверждения для спокойного баннера. */
export interface SettlementSuccess {
  netDirection: RestaurantSettlementNetDirection;
  netAmountCents: number;
  entryCount: number;
}

/** Сообщение об успешном расчёте: направление, сумма и сколько закрыто. */
export function formatSettlementSuccess(
  success: SettlementSuccess,
  amountText: string,
): string {
  const closed = `Закрыто ${success.entryCount} ${pluralObligations(success.entryCount)}.`;
  if (success.netDirection === "BALANCED") {
    return `Зафиксирован взаимозачёт равных обязательств. ${closed}`;
  }
  return `${settlementHistoryLabel(success.netDirection)}: ${amountText}. ${closed}`;
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
}

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
  }));
}
