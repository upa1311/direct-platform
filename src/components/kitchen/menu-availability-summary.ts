import type { MenuItem } from "@/prototype/models";
// Импорт относительный: модуль проверяется node:test, где alias «@/» не
// резолвится. Типы стираются при стриппинге, значения — нет.
import { isMenuItemAvailableAt } from "../../prototype/selectors";

/**
 * Сводка доступности меню для компактной строки внизу экрана заказов.
 *
 * Доступность считается ТОЛЬКО через isMenuItemAvailableAt: у блюда может быть
 * временная availabilityPause, поэтому смотреть на item.available напрямую
 * нельзя — истёкшая пауза делает блюдо доступным ещё до sweep.
 *
 * Чистая функция: React, state и мутаций нет. tone — отдельное машинное поле,
 * чтобы визуальное состояние не выводилось из русского текста.
 */

export type MenuAvailabilityTone =
  | "EMPTY"
  | "OK"
  | "PARTIAL"
  | "ALL_UNAVAILABLE";

export interface MenuAvailabilitySummary {
  total: number;
  unavailable: number;
  text: string;
  tone: MenuAvailabilityTone;
}

/**
 * Русское склонение: «1 позиция недоступна», «2 позиции недоступны»,
 * «5 позиций недоступны», «11 позиций недоступны», «21 позиция недоступна».
 */
function formatUnavailableCount(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) {
    return `${count} позиций недоступны`;
  }
  if (mod10 === 1) {
    return `${count} позиция недоступна`;
  }
  if (mod10 >= 2 && mod10 <= 4) {
    return `${count} позиции недоступны`;
  }
  return `${count} позиций недоступны`;
}

/** Сводка доступности меню ресторана на момент nowMs. */
export function getMenuAvailabilitySummary(
  menu: readonly MenuItem[],
  nowMs: number,
): MenuAvailabilitySummary {
  const total = menu.length;
  if (total === 0) {
    return { total: 0, unavailable: 0, text: "Блюд пока нет", tone: "EMPTY" };
  }

  const unavailable = menu.filter(
    (item) => !isMenuItemAvailableAt(item, nowMs),
  ).length;

  if (unavailable === 0) {
    return { total, unavailable: 0, text: "Все позиции доступны", tone: "OK" };
  }
  if (unavailable === total) {
    return {
      total,
      unavailable,
      text: "Все позиции недоступны",
      tone: "ALL_UNAVAILABLE",
    };
  }
  return {
    total,
    unavailable,
    text: formatUnavailableCount(unavailable),
    tone: "PARTIAL",
  };
}
