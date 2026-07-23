"use client";

import { WorkspaceHeader } from "./workspace-header";
import { useAuthenticatedDriverId } from "@/components/driver/driver-session";

/**
 * Навигация кабинета водителя. До входа разделы не показываются (только название
 * кабинета). После входа — ровно два раздела: «Заказы» и «Расчёты». Отдельных
 * вкладок «Обзор», «Предложения» и «Текущий заказ» больше нет: новые и активный
 * заказ живут на едином рабочем экране «Заказы».
 */
const driverNavigation = [
  { href: "/driver", label: "Заказы" },
  { href: "/driver/settlements", label: "Расчёты" },
] as const;

export function DriverHeader() {
  const sessionDriverId = useAuthenticatedDriverId();
  return (
    <WorkspaceHeader
      applicationName="Кабинет водителя"
      navAriaLabel="Навигация водителя"
      navItems={sessionDriverId ? driverNavigation : []}
      brandHref="/driver"
    />
  );
}
