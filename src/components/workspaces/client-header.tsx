"use client";

import Link from "next/link";
import { ShoppingCart } from "lucide-react";

import { useClientCartUi } from "@/components/order-flow/client-cart-ui";
import { WorkspaceHeader } from "./workspace-header";
import styles from "./workspace-shell.module.css";

const clientNavigation = [
  { href: "/client/catalog", label: "Рестораны" },
  { href: "/client/orders", label: "Мои заказы" },
] as const;

export function ClientHeader() {
  const { cartQuantity, openCart, cartButtonRef, badgePulse } = useClientCartUi();

  return (
    <WorkspaceHeader
      applicationName="Для клиента"
      navAriaLabel="Навигация клиента"
      navItems={clientNavigation}
      brandHref="/client/catalog"
      showWorkspaceLink={false}
      rightSlot={
        <>
          <Link className={styles.demoRoleLink} href="/workspaces">
            Демо · Сменить роль
          </Link>
          <button
            ref={cartButtonRef}
            className={`${styles.cartHeaderButton} ${badgePulse ? styles.cartHeaderButtonPulse : ""}`}
            type="button"
            onClick={openCart}
            aria-label={`Открыть корзину, товаров: ${cartQuantity}`}
          >
            <ShoppingCart aria-hidden="true" />
            {cartQuantity > 0 ? <span>{cartQuantity}</span> : null}
          </button>
        </>
      }
    />
  );
}
