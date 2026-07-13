import Link from "next/link";

import { BrandLink } from "./brand-link";
import { WorkspaceNav } from "./workspace-nav";
import styles from "./workspace-shell.module.css";

const adminNavigation = [
  { href: "/admin", label: "Обзор" },
  { href: "/admin/restaurants", label: "Рестораны" },
  { href: "/admin/menu", label: "Меню и акции" },
  { href: "/admin/orders", label: "Заказы" },
  { href: "/admin/settlements", label: "Расчёты" },
  { href: "/admin/drivers", label: "Водители" },
  { href: "/admin/zones", label: "Зоны и тарифы" },
] as const;

export function AdminSidebar() {
  return (
    <aside className={styles.adminSidebar}>
      <BrandLink
        applicationName="Администрирование"
        href="/admin"
        priority
      />
      <WorkspaceNav
        ariaLabel="Навигация администратора"
        items={adminNavigation}
        variant="sidebar"
      />
      <Link className={styles.sidebarExit} href="/workspaces">
        Выбрать другую роль
      </Link>
    </aside>
  );
}
