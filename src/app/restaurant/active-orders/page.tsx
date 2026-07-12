"use client";

import { useEffect, useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { TEST_RESTAURANT_ID } from "@/prototype/default-state";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatMoney,
  getRestaurant,
  getRestaurantOrders,
  orderStatusLabels,
} from "@/prototype/selectors";

function formatCountdown(expectedReadyAt: string | null, now: number) {
  if (!expectedReadyAt) {
    return "Отсчёт начнётся после оплаты";
  }
  if (now === 0) {
    return "—";
  }

  const remainingSeconds = Math.max(
    0,
    Math.ceil((new Date(expectedReadyAt).getTime() - now) / 1000),
  );
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export default function RestaurantActiveOrdersPage() {
  const { state, markReady } = usePrototype();
  const currentRestaurant = getRestaurant(state, TEST_RESTAURANT_ID);
  const [now, setNow] = useState(0);
  const orders = getRestaurantOrders(state, TEST_RESTAURANT_ID, [
    "AWAITING_PAYMENT",
    "PREPARING",
    "READY",
  ]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <>
      <PageHeading
        eyebrow={currentRestaurant?.name ?? "Ресторан 1"}
        title="Активные заказы"
        description="Принятые заказы, ожидание оплаты и приготовление."
      />
      {orders.length === 0 ? (
        <div className={flowStyles.emptyState}>Активных заказов пока нет.</div>
      ) : (
        <div className={flowStyles.orderList}>
          {orders.map((order) => (
            <article className={flowStyles.orderCard} key={order.id}>
              <div className={flowStyles.orderHeader}>
                <div>
                  <h2 className={flowStyles.orderNumber}>
                    {order.publicNumber}
                  </h2>
                  <p>{orderStatusLabels[order.status]}</p>
                </div>
                <span className={flowStyles.statusBadge}>
                  Оплата: {order.paymentStatus}
                </span>
              </div>
              <ul className={flowStyles.orderItemList}>
                {order.items.map((item) => (
                  <li key={item.menuItemId}>
                    <span>
                      {item.name} × {item.quantity}
                    </span>
                    <span>{formatMoney(item.lineTotalCents)}</span>
                  </li>
                ))}
              </ul>
              <div className={flowStyles.inlineMeta}>
                <span>
                  Время приготовления: {order.preparationMinutes ?? "—"} минут
                </span>
              </div>
              {order.status === "PREPARING" ? (
                <>
                  <div className={flowStyles.countdown}>
                    До готовности: {formatCountdown(order.expectedReadyAt, now)}
                  </div>
                  <div className={flowStyles.submitArea}>
                    <button
                      className={flowStyles.primaryButton}
                      type="button"
                      onClick={() => markReady(order.id)}
                    >
                      Готово и упаковано
                    </button>
                  </div>
                </>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
