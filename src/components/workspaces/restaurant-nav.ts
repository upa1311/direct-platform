import type { RestaurantOrderWorkflowMode } from "@/prototype/models";
import type { WorkspaceNavItem } from "./workspace-nav";

/**
 * Модель навигации ресторана. Вынесена из компонента, чтобы порядок рабочих
 * разделов и цель редиректа старых настроек проверялись тестом без DOM.
 *
 * Режим работы — административная настройка, поэтому в рабочих разделах его
 * нет: он живёт в popover шестерёнки справа (см. restaurant-settings-menu).
 */

/** Рабочий экран кухни; сюда же ведёт бывший URL настроек. */
export const RESTAURANT_KITCHEN_PATH = "/restaurant/kitchen";

/** Старый URL настроек: больше не рабочий экран, редиректит на кухню. */
export const RESTAURANT_LEGACY_SETTINGS_PATH = "/restaurant/settings";

/** Единая подпись шестерёнки: aria-label и title совпадают. */
export const RESTAURANT_SETTINGS_BUTTON_LABEL = "Настройки режима работы";

const COMBINED_NAV: readonly WorkspaceNavItem[] = [
  { href: RESTAURANT_KITCHEN_PATH, label: "Кухня" },
  { href: "/restaurant/menu", label: "Меню и доступность" },
];

const SPLIT_NAV: readonly WorkspaceNavItem[] = [
  { href: "/restaurant/operator", label: "Оператор заказов" },
  { href: RESTAURANT_KITCHEN_PATH, label: "Кухня" },
  { href: "/restaurant/menu", label: "Меню и доступность" },
];

/**
 * COMBINED — один общий экран заказов, оператора нет. SPLIT — оператор первым.
 * До гидрации используется COMBINED-набор (дефолт состояния), поэтому hydration
 * mismatch не возникает.
 */
export function restaurantNavItems(
  mode: RestaurantOrderWorkflowMode,
): readonly WorkspaceNavItem[] {
  return mode === "SPLIT_OPERATOR_KITCHEN" ? SPLIT_NAV : COMBINED_NAV;
}

/** Порядок вариантов в popover. Названия режимов берутся из workflowModeLabels. */
export const WORKFLOW_MODE_ORDER: readonly RestaurantOrderWorkflowMode[] = [
  "COMBINED",
  "SPLIT_OPERATOR_KITCHEN",
];

/** Спокойные подписи вариантов: что именно меняется для сотрудников. */
export const WORKFLOW_MODE_HINTS: Record<RestaurantOrderWorkflowMode, string> = {
  COMBINED:
    "Один сотрудник принимает заказ, указывает время приготовления и выполняет выдачу.",
  SPLIT_OPERATOR_KITCHEN:
    "Кухня отвечает за приготовление и время. Оператор работает с клиентом, оплатой, доставкой и выдачей.",
};
