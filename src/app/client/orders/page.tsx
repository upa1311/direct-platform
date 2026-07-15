"use client";

import { ClientOrderCard } from "@/components/order-flow/client-order-card";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  getCurrentCustomerActiveOrders,
  getCurrentCustomerCompletedOrders,
} from "@/prototype/selectors";

export default function ClientOrdersPage() {
  const { state, isHydrated } = usePrototype();
  const activeOrders = getCurrentCustomerActiveOrders(state);
  const completedOrders = getCurrentCustomerCompletedOrders(state);

  return (
    <>
      <PageHeading
        eyebrow="Клиент"
        title="Мои заказы"
        description="Текущие заказы и история завершённых."
      />
      {!isHydrated ? (
        <div className={flowStyles.emptyState}>Загружаем заказы…</div>
      ) : (
        <div className={`${flowStyles.panelStack} ${flowStyles.clientOrdersStack}`}>
          <section>
            <h2 className={flowStyles.sectionTitle}>Текущие заказы</h2>
            {activeOrders.length === 0 ? (
              <div className={flowStyles.emptyState}>
                Сейчас активных заказов нет.
              </div>
            ) : (
              <div className={flowStyles.orderList}>
                {activeOrders.map((order) => (
                  <ClientOrderCard order={order} key={order.id} />
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className={flowStyles.sectionTitle}>Завершённые заказы</h2>
            {completedOrders.length === 0 ? (
              <div className={flowStyles.emptyState}>
                Завершённых заказов пока нет.
              </div>
            ) : (
              <div className={flowStyles.orderList}>
                {completedOrders.map((order) => (
                  <ClientOrderCard order={order} key={order.id} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
