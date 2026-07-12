import { DriverStatusToggle } from "./driver-status-toggle";
import { WorkspaceHeader } from "./workspace-header";

const driverNavigation = [
  { href: "/driver", label: "Обзор" },
  { href: "/driver/offers", label: "Предложения" },
  { href: "/driver/current-order", label: "Текущий заказ" },
] as const;

export function DriverHeader() {
  return (
    <WorkspaceHeader
      applicationName="Кабинет водителя"
      navAriaLabel="Навигация водителя"
      navItems={driverNavigation}
      rightSlot={<DriverStatusToggle />}
    />
  );
}
