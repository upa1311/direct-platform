"use client";

import Link from "next/link";

import { usePrototype } from "@/prototype/prototype-provider";
import { getPendingMenuSubmissions } from "@/prototype/selectors";
import { BrandLink } from "./brand-link";
import { WorkspaceNav } from "./workspace-nav";
import styles from "./workspace-shell.module.css";

const adminNavigation = [
  { href: "/admin", label: "Обзор" },
  { href: "/admin/orders", label: "Заказы" },
  { href: "/admin/restaurants", label: "Рестораны" },
  { href: "/admin/restaurant-builder", label: "Конструктор ресторанов" },
  { href: "/admin/menu-review", label: "Меню на проверке" },
  { href: "/admin/drivers", label: "Водители" },
  { href: "/admin/settlements", label: "Расчёты" },
  { href: "/admin/zones", label: "Зоны и тарифы" },
] as const;

export function AdminSidebar() {
  const { state, isHydrated } = usePrototype();
  // Счётчик очереди модерации блюд: виден прямо в навигации кабинета Direct.
  const pendingMenuCount = isHydrated
    ? getPendingMenuSubmissions(state).length
    : 0;

  const items = adminNavigation.map((item) =>
    item.href === "/admin/menu-review" && pendingMenuCount > 0
      ? { ...item, label: `${item.label} (${pendingMenuCount})` }
      : item,
  );

  return (
    <aside className={styles.adminSidebar}>
      <BrandLink
        applicationName="Администрирование"
        href="/admin"
        priority
      />
      <WorkspaceNav
        ariaLabel="Навигация администратора"
        items={items}
        variant="sidebar"
      />
      <Link className={styles.sidebarExit} href="/workspaces">
        Выбрать другую роль
      </Link>
    </aside>
  );
}
