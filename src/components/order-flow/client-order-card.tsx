"use client";

import Link from "next/link";

import type { Order } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  deliveryModeLabels,
  formatDateTime,
  formatMoney,
  getCancellationRequestForOrder,
  getClientAutoCancelMessage,
  getClientCancellationMessage,
  orderStatusLabels,
} from "@/prototype/selectors";
import { ClientOrderActions } from "./client-order-actions";
import styles from "./order-flow.module.css";

interface ClientOrderCardProps {
  order: Order;
  linkLabel?: string;
}

/** Краткий состав заказа: «Пицца × 2, Лимонад × 1». Без технических ID. */
function briefComposition(order: Order): string {
  return order.items
    .map((item) => `${item.name} × ${item.quantity}`)
    .join(", ");
}

export function ClientOrderCard({
  order,
  linkLabel = "Подробнее",
}: ClientOrderCardProps) {
  const { state } = usePrototype();
  const autoCancelMessage = getClientAutoCancelMessage(order);
  const request = getCancellationRequestForOrder(state, order.id);
  const requestMessage = getClientCancellationMessage(request);
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
          <dt>Состав</dt>
          <dd>{briefComposition(order)}</dd>
        </div>
        <div className={styles.summaryRow}>
          <dt>Итог</dt>
          <dd>{formatMoney(order.financials.customerTotalCents)}</dd>
        </div>
      </dl>
      {autoCancelMessage ? (
        <p className={styles.summaryHint} role="status">
          {autoCancelMessage}
        </p>
      ) : requestMessage ? (
        <p className={styles.summaryHint} role="status">
          {requestMessage}
        </p>
      ) : null}
      <div className={styles.submitArea}>
        <Link className={styles.primaryLink} href={`/client/orders/${order.id}`}>
          {linkLabel}
        </Link>
      </div>
      <ClientOrderActions order={order} />
    </article>
  );
}
