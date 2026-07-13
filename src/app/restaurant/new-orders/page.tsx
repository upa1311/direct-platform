"use client";

import { useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  deliveryModeLabels,
  formatMoney,
  getRestaurant,
  getWorkingRestaurantOrders,
  paymentMethodLabels,
} from "@/prototype/selectors";

const preparationOptions = [10, 15, 20, 25, 30, 40] as const;

function getDefaultPreparationMinutes(value: number | undefined): number {
  return preparationOptions.includes(
    value as (typeof preparationOptions)[number],
  )
    ? (value ?? 25)
    : 25;
}

export default function RestaurantNewOrdersPage() {
  const { state, acceptOrder, rejectOrder } = usePrototype();
  const [preparationByOrder, setPreparationByOrder] = useState<
    Record<string, number>
  >({});
  const [reasonByOrder, setReasonByOrder] = useState<Record<string, string>>({});
  const orders = getWorkingRestaurantOrders(state, ["RESTAURANT_REVIEW"]);

  return (
    <>
      <PageHeading
        eyebrow="Рестораны 1–3"
        title="Новые заказы"
        description="Заказы, которые ресторан должен проверить и принять либо отклонить."
      />
      {orders.length === 0 ? (
        <div className={flowStyles.emptyState}>Новых заказов пока нет.</div>
      ) : (
        <div className={flowStyles.orderList}>
          {orders.map((order) => {
            const preparationMinutes =
              preparationByOrder[order.id] ??
              getDefaultPreparationMinutes(
                getRestaurant(state, order.restaurant.id)
                  ?.defaultPreparationMinutes,
              );
            const rejectionReason = reasonByOrder[order.id] ?? "";

            return (
              <article className={flowStyles.orderCard} key={order.id}>
                <div className={flowStyles.orderHeader}>
                  <div>
                    <h2 className={flowStyles.orderNumber}>
                      {order.publicNumber}
                    </h2>
                    <p>{order.restaurant.name}</p>
                    <div className={flowStyles.inlineMeta}>
                      <span>{deliveryModeLabels[order.deliveryMode]}</span>
                      <span>{paymentMethodLabels[order.paymentMethod]}</span>
                    </div>
                  </div>
                  <span className={flowStyles.price}>
                    Еда: {formatMoney(order.financials.foodSubtotalCents)}
                  </span>
                </div>

                <ul className={flowStyles.orderItemList}>
                  {order.items.map((item) => (
                    <li key={item.menuItemId}>
                      <span>
                        {item.name} × {item.quantity}
                        {item.cookingComment ? (
                          <small className={flowStyles.itemComment}>
                            Комментарий: {item.cookingComment}
                          </small>
                        ) : null}
                      </span>
                      <span>{formatMoney(item.lineTotalCents)}</span>
                    </li>
                  ))}
                </ul>

                <div className={flowStyles.orderActions}>
                  <label className={flowStyles.field}>
                    <span>Время приготовления</span>
                    <select
                      value={preparationMinutes}
                      onChange={(event) =>
                        setPreparationByOrder((current) => ({
                          ...current,
                          [order.id]: Number(event.target.value),
                        }))
                      }
                    >
                      {preparationOptions.map((minutes) => (
                        <option value={minutes} key={minutes}>
                          {minutes} минут
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className={flowStyles.buttonRow}>
                    <button
                      className={flowStyles.primaryButton}
                      type="button"
                      onClick={() => acceptOrder(order.id, preparationMinutes)}
                    >
                      Принять заказ
                    </button>
                  </div>
                  <label className={flowStyles.field}>
                    <span>Причина отклонения</span>
                    <input
                      value={rejectionReason}
                      onChange={(event) =>
                        setReasonByOrder((current) => ({
                          ...current,
                          [order.id]: event.target.value,
                        }))
                      }
                      placeholder="Укажите причину"
                    />
                  </label>
                  <div className={flowStyles.buttonRow}>
                    <button
                      className={flowStyles.dangerButton}
                      type="button"
                      disabled={!rejectionReason.trim()}
                      onClick={() => rejectOrder(order.id, rejectionReason)}
                    >
                      Отклонить заказ
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
