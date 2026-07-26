/**
 * Admin console navigation, as plain data so it can be unit-tested without
 * rendering the client sidebar. "Реестр зон" (the versioned zone registry) is a
 * first-class item, kept separate from "Зоны и тарифы" (the money editor).
 */
export interface AdminNavItem {
  href: string;
  label: string;
}

export const ADMIN_NAVIGATION: readonly AdminNavItem[] = [
  { href: "/admin", label: "Обзор" },
  { href: "/admin/orders", label: "Заказы" },
  { href: "/admin/restaurants", label: "Рестораны" },
  { href: "/admin/restaurant-builder", label: "Конструктор ресторанов" },
  { href: "/admin/menu-review", label: "Меню на проверке" },
  { href: "/admin/drivers", label: "Водители" },
  { href: "/admin/driver-analytics", label: "Аналитика водителей" },
  { href: "/admin/driver-payouts", label: "Выплаты водителям" },
  { href: "/admin/settlements", label: "Расчёты" },
  { href: "/admin/zones", label: "Зоны и тарифы" },
  { href: "/admin/zone-registry", label: "Реестр зон" },
] as const;
