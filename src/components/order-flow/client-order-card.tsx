"use client";

import Link from "next/link";

import type { Order } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  deliveryModeLabels,
  formatDateTime,
  formatMoney,
  formatOrderEtaClock,
  getClientAutoCancelMessage,
  hasActiveEtaUpdate,
  orderStatusLabels,
} from "@/prototype/selectors";
import { ClientOrderActions } from "./client-order-actions";
import { getBriefOrderComposition } from "./order-composition";
import styles from "./order-flow.module.css";

interface ClientOrderCardProps {
  order: Order;
  linkLabel?: string;
}

/** Русское склонение слова «позиция» для «Ещё N …». */
function pluralPositions(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "позиция";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "позиции";
  return "позиций";
}

export function ClientOrderCard({
  order,
  linkLabel = "Открыть заказ",
}: ClientOrderCardProps) {
  const { state } = usePrototype();
  const autoCancelMessage = getClientAutoCancelMessage(order);
  const composition = getBriefOrderComposition(order.items);
  return (
    <article className={`${styles.orderCard} ${styles.clientOrderCard}`}>
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
          <dd>
            {composition.primaryText}
            {composition.remainingCount > 0 ? (
              <span className={styles.compositionMore}>
                Ещё {composition.remainingCount}{" "}
                {pluralPositions(composition.remainingCount)}
              </span>
            ) : null}
          </dd>
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
      ) : null}
      {hasActiveEtaUpdate(order) ? (
        <p className={styles.summaryHint} role="status">
          Ресторан обновил время готовности заказа. Ожидаемая готовность:{" "}
          {formatOrderEtaClock(state, order)}.
        </p>
      ) : null}
      <div className={styles.submitArea}>
        <Link className={styles.primaryLink} href={`/client/orders/${order.id}`}>
          {linkLabel}
        </Link>
      </div>
      <ClientOrderActions order={order} compact />
    </article>
  );
}
