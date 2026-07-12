import { WorkspaceHeader } from "./workspace-header";

const restaurantNavigation = [
  { href: "/restaurant", label: "Обзор" },
  { href: "/restaurant/new-orders", label: "Новые заказы" },
  { href: "/restaurant/active-orders", label: "Активные заказы" },
] as const;

export function RestaurantHeader() {
  return (
    <WorkspaceHeader
      applicationName="Кабинет · Ресторан 1"
      navAriaLabel="Навигация ресторана"
      navItems={restaurantNavigation}
    />
  );
}
