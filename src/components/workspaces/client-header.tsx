import { WorkspaceHeader } from "./workspace-header";

const clientNavigation = [
  { href: "/client", label: "Главная" },
  { href: "/client/catalog", label: "Каталог" },
  { href: "/client/cart", label: "Корзина" },
  { href: "/client/orders", label: "Мои заказы" },
] as const;

export function ClientHeader() {
  return (
    <WorkspaceHeader
      applicationName="Для клиента"
      navAriaLabel="Навигация клиента"
      navItems={clientNavigation}
    />
  );
}
