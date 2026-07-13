"use client";

import { useEffect, useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  deliveryModeLabels,
  formatMoney,
  getWorkingRestaurantOrders,
  orderStatusLabels,
  paymentStatusLabels,
} from "@/prototype/selectors";

function PickupCompletion({ orderId }: { orderId: string }) {
  const { completePickup, markPickupNoShow } = usePrototype();
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  return (
    <div className={flowStyles.submitArea}>
      <label className={flowStyles.field}>
        <span>Код клиента</span>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Код из приложения клиента"
        />
      </label>
      <div className={flowStyles.buttonRow}>
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={() => {
            const result = completePickup(orderId, code);
            setError(result.ok ? "" : (result.error ?? "Ошибка выдачи."));
          }}
        >
          Оплата получена, заказ выдан
        </button>
      </div>
      {error ? (
        <div className={flowStyles.warningNotice} role="alert">
          {error}
        </div>
      ) : null}
      <label className={flowStyles.field}>
        <span>Клиент не пришёл — причина</span>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Например: не явился за заказом"
        />
      </label>
      <div className={flowStyles.buttonRow}>
        <button
          className={flowStyles.dangerButton}
          type="button"
          disabled={!reason.trim()}
          onClick={() => markPickupNoShow(orderId, reason)}
        >
          Заказ не выкуплен
        </button>
      </div>
    </div>
  );
}

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
  const {
    state,
    markReady,
    markOutForDelivery,
    markArriving,
    markDelivered,
  } = usePrototype();
  const [now, setNow] = useState(0);
  const orders = getWorkingRestaurantOrders(state, [
    "AWAITING_PAYMENT",
    "PREPARING",
    "READY",
    "READY_FOR_PICKUP",
    "OUT_FOR_DELIVERY",
    "ARRIVING",
  ]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <>
      <PageHeading
        eyebrow="Рестораны 1–3"
        title="Активные заказы"
        description="Принятые заказы, ожидание оплаты, приготовление и доставка."
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
                  <p>{order.restaurant.name}</p>
                  <p>{orderStatusLabels[order.status]}</p>
                  <p>{deliveryModeLabels[order.deliveryMode]}</p>
                </div>
                <span className={flowStyles.statusBadge}>
                  Оплата: {paymentStatusLabels[order.paymentStatus]}
                </span>
              </div>
              <ul className={flowStyles.orderItemList}>
                {order.items.map((item) => (
                  <li key={`${item.menuItemId}-${item.selectedVariantId ?? "base"}`}>
                    <span>
                      {item.name}
                      {item.selectedVariantName &&
                      item.variantPriceDeltaCents !== 0
                        ? ` · ${item.selectedVariantName}`
                        : ""}{" "}
                      × {item.quantity}
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
                      {order.deliveryMode === "PICKUP"
                        ? "Готов к выдаче"
                        : order.deliveryMode === "RESTAURANT_DELIVERY"
                          ? "Готово"
                          : "Готово и упаковано"}
                    </button>
                  </div>
                </>
              ) : null}
              {order.status === "READY_FOR_PICKUP" ? (
                <PickupCompletion orderId={order.id} />
              ) : null}
              {order.deliveryMode === "RESTAURANT_DELIVERY" &&
              order.status === "READY" ? (
                <div className={flowStyles.submitArea}>
                  <button
                    className={flowStyles.primaryButton}
                    type="button"
                    onClick={() => markOutForDelivery(order.id)}
                  >
                    Курьер выехал
                  </button>
                </div>
              ) : null}
              {order.status === "OUT_FOR_DELIVERY" ? (
                <div className={flowStyles.submitArea}>
                  <button
                    className={flowStyles.primaryButton}
                    type="button"
                    onClick={() => markArriving(order.id)}
                  >
                    Курьер скоро будет
                  </button>
                </div>
              ) : null}
              {order.status === "ARRIVING" ? (
                <div className={flowStyles.submitArea}>
                  <button
                    className={flowStyles.primaryButton}
                    type="button"
                    onClick={() => markDelivered(order.id)}
                  >
                    Заказ доставлен
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
