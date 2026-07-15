"use client";

import { usePrototype } from "@/prototype/prototype-provider";
import { useRestaurantWorkspace } from "./restaurant-workspace";
import { WorkspaceHeader } from "./workspace-header";
import type { WorkspaceNavItem } from "./workspace-nav";

/**
 * Этап 11: навигация ресторана зависит от режима работы выбранного ресторана.
 * COMBINED — один общий экран «Заказы ресторана»; SPLIT — отдельные «Оператор
 * заказов» и «Кухня». Управляющий может открывать оба split-экрана. До гидрации
 * показывается COMBINED-набор (дефолт состояния) — без hydration mismatch.
 */
const COMBINED_NAV: readonly WorkspaceNavItem[] = [
  { href: "/restaurant/kitchen", label: "Заказы ресторана" },
  { href: "/restaurant/menu", label: "Меню и доступность" },
  { href: "/restaurant/settings", label: "Настройки" },
];

const SPLIT_NAV: readonly WorkspaceNavItem[] = [
  { href: "/restaurant/operator", label: "Оператор заказов" },
  { href: "/restaurant/kitchen", label: "Кухня" },
  { href: "/restaurant/menu", label: "Меню и доступность" },
  { href: "/restaurant/settings", label: "Настройки" },
];

export function RestaurantHeader() {
  const { state } = usePrototype();
  const { selectedRestaurantId } = useRestaurantWorkspace();
  const mode =
    state.restaurants.find((r) => r.id === selectedRestaurantId)
      ?.orderWorkflowMode ?? "COMBINED";
  const navItems = mode === "SPLIT_OPERATOR_KITCHEN" ? SPLIT_NAV : COMBINED_NAV;

  return (
    <WorkspaceHeader
      applicationName="Кабинет ресторана"
      navAriaLabel="Навигация ресторана"
      navItems={navItems}
    />
  );
}
