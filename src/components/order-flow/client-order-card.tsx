import Link from "next/link";

import type { Order } from "@/prototype/models";
import {
  deliveryModeLabels,
  formatDateTime,
  formatMoney,
  orderStatusLabels,
} from "@/prototype/selectors";
import styles from "./order-flow.module.css";

interface ClientOrderCardProps {
  order: Order;
  linkLabel: string;
}

export function ClientOrderCard({
  order,
  linkLabel,
}: ClientOrderCardProps) {
  return (
    <article className={styles.orderCard}>
      <div className={styles.orderHeader}>
        <div>
          <h2 className={styles.orderNumber}>{order.publicNumber}</h2>
          <p>{order.restaurant.name}</p>
        </div>
        <span className={styles.statusBadge}>
          {orderStatusLabels[order.status]}
        </span>
      </div>
      <dl className={styles.summaryList}>
        <div className={styles.summaryRow}>
          <dt>Получение</dt>
          <dd>{deliveryModeLabels[order.deliveryMode]}</dd>
        </div>
        <div className={styles.summaryRow}>
          <dt>Дата</dt>
          <dd>{formatDateTime(order.createdAt)}</dd>
        </div>
        <div className={styles.summaryRow}>
          <dt>Итог</dt>
          <dd>{formatMoney(order.financials.customerTotalCents)}</dd>
        </div>
      </dl>
      <div className={styles.submitArea}>
        <Link className={styles.primaryLink} href={`/client/orders/${order.id}`}>
          {linkLabel}
        </Link>
      </div>
    </article>
  );
}
