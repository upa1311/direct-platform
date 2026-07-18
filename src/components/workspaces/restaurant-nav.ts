import type { RestaurantOrderWorkflowMode } from "@/prototype/models";
import type { WorkspaceNavItem } from "./workspace-nav";

/**
 * Модель навигации ресторана. Вынесена из компонента, чтобы порядок рабочих
 * разделов и цель редиректа старых настроек проверялись тестом без DOM.
 *
 * Режим работы — административная настройка, поэтому в рабочих разделах его
 * нет: он живёт в popover шестерёнки справа (см. restaurant-settings-menu).
 */

/**
 * Рабочий экран заказов ресторана; сюда же ведёт бывший URL настроек. Путь
 * исторический: в COMBINED экран ведёт заказ целиком, а не только готовит,
 * поэтому пользователю он называется «Заказы». Маршрут и папки не переименованы
 * — URL сам по себе пользователю ничего не обещает.
 */
export const RESTAURANT_KITCHEN_PATH = "/restaurant/kitchen";

/** Read-only раздел ресторанной сверки (первый этап settlements/accounting). */
export const RESTAURANT_SETTLEMENTS_PATH = "/restaurant/settlements";

/** Старый URL настроек: больше не рабочий экран, редиректит на заказы. */
export const RESTAURANT_LEGACY_SETTINGS_PATH = "/restaurant/settings";

/** Единая подпись шестерёнки: aria-label и title совпадают. */
export const RESTAURANT_SETTINGS_BUTTON_LABEL = "Настройки режима работы";

/** Название общего экрана: он ведёт полный цикл заказа, а не только кухню. */
export const COMBINED_ORDERS_LABEL = "Заказы";

/** Название производственного экрана в SPLIT: там действительно только кухня. */
export const SPLIT_KITCHEN_LABEL = "Кухня";

const COMBINED_NAV: readonly WorkspaceNavItem[] = [
  { href: RESTAURANT_KITCHEN_PATH, label: COMBINED_ORDERS_LABEL },
  { href: "/restaurant/menu", label: "Меню и доступность" },
  { href: RESTAURANT_SETTLEMENTS_PATH, label: "Расчёты" },
];

const SPLIT_NAV: readonly WorkspaceNavItem[] = [
  { href: "/restaurant/operator", label: "Оператор заказов" },
  { href: RESTAURANT_KITCHEN_PATH, label: SPLIT_KITCHEN_LABEL },
  { href: "/restaurant/menu", label: "Меню и доступность" },
  { href: RESTAURANT_SETTLEMENTS_PATH, label: "Расчёты" },
];

/**
 * COMBINED — один общий экран «Заказы», оператора нет. SPLIT — оператор первым,
 * за ним отдельный производственный экран «Кухня». До гидрации используется
 * COMBINED-набор (дефолт состояния), поэтому hydration mismatch не возникает.
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

/**
 * Короткие подписи вариантов: служебный dropdown, а не страница настроек.
 * Различие между режимами — сколько устройств задействовано, а не «кто что
 * делает»: решение по новому заказу в SPLIT принимает оператор, поэтому свести
 * его роль к доставке и выдаче нельзя.
 */
export const WORKFLOW_MODE_HINTS: Record<RestaurantOrderWorkflowMode, string> = {
  COMBINED: "Все заказы ведутся на одном устройстве.",
  SPLIT_OPERATOR_KITCHEN:
    "Оператор принимает и ведёт заказ, кухня готовит на отдельном устройстве Direct.",
};
