import { WorkspaceHeader } from "./workspace-header";

const restaurantNavigation = [
  { href: "/restaurant/kitchen", label: "Кухня" },
] as const;

export function RestaurantHeader() {
  return (
    <WorkspaceHeader
      applicationName="Кабинет ресторана"
      navAriaLabel="Навигация ресторана"
      navItems={restaurantNavigation}
    />
  );
}
