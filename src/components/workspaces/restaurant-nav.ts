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

/** Маршрут раздела «Меню и доступность». */
export const RESTAURANT_MENU_PATH = "/restaurant/menu";

/**
 * Ссылка «Меню и доступность» с ЯВНЫМ навигационным контекстом роли: из
 * кабинета оператора — OPERATOR, из кухни SPLIT — KITCHEN, в COMBINED —
 * COMBINED. Query переживает reload; sessionStorage остаётся резервной
 * подсказкой. С экрана без известного контекста (например, страницы
 * конструктора) ссылка ведёт без query: страница меню сама восстановит роль из
 * сохранённого workspace-контекста и канонизирует URL через router.replace —
 * оператор не превратится в кухню, а кнопки не исчезнут.
 */
export function menuNavHref(
  mode: RestaurantOrderWorkflowMode,
  pathname: string,
): string {
  if (mode !== "SPLIT_OPERATOR_KITCHEN") {
    return `${RESTAURANT_MENU_PATH}?role=COMBINED`;
  }
  if (pathname.startsWith("/restaurant/operator")) {
    return `${RESTAURANT_MENU_PATH}?role=OPERATOR`;
  }
  if (pathname.startsWith(RESTAURANT_KITCHEN_PATH)) {
    return `${RESTAURANT_MENU_PATH}?role=KITCHEN`;
  }
  return RESTAURANT_MENU_PATH;
}

/** Навигация ресторана с ролевой ссылкой меню для текущего экрана. */
export function restaurantNavItemsForPath(
  mode: RestaurantOrderWorkflowMode,
  pathname: string,
): readonly WorkspaceNavItem[] {
  return restaurantNavItems(mode).map((item) =>
    item.href === RESTAURANT_MENU_PATH
      ? { ...item, href: menuNavHref(mode, pathname) }
      : item,
  );
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
