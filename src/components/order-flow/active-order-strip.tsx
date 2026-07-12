"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { usePrototype } from "@/prototype/prototype-provider";
import {
  getActiveCustomerOrder,
  orderStatusLabels,
} from "@/prototype/selectors";
import styles from "@/components/workspaces/workspace-shell.module.css";

export function ActiveOrderStrip() {
  const { state, isHydrated } = usePrototype();
  const order = getActiveCustomerOrder(state);
  const pathname = usePathname();

  if (!isHydrated || !order) {
    return null;
  }

  return (
    <aside className={styles.activeOrderStrip} aria-label="Активный заказ">
      <div className={styles.activeOrderStripInner}>
        <div>
          <strong>Активный заказ {order.publicNumber}</strong>
          <span>{orderStatusLabels[order.status]}</span>
        </div>
        {pathname === `/client/orders/${order.id}` ? (
          <span className={styles.activeOrderCurrent}>Заказ открыт</span>
        ) : (
          <Link href={`/client/orders/${order.id}`}>Открыть заказ</Link>
        )}
      </div>
    </aside>
  );
}
