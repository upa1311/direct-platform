"use client";

import { ClientOrderCard } from "@/components/order-flow/client-order-card";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import { getCurrentCustomerOrders } from "@/prototype/selectors";

export default function ClientOrdersPage() {
  const { state, isHydrated } = usePrototype();
  const orders = getCurrentCustomerOrders(state);

  return (
    <>
      <PageHeading
        eyebrow="Клиент"
        title="Мои заказы"
        description="Все заказы текущего клиента — от новых к старым."
      />
      {!isHydrated ? (
        <div className={flowStyles.emptyState}>Загружаем заказы…</div>
      ) : orders.length === 0 ? (
        <div className={flowStyles.emptyState}>Заказов пока нет.</div>
      ) : (
        <div className={flowStyles.orderList}>
          {orders.map((order) => (
            <ClientOrderCard
              order={order}
              linkLabel="Открыть заказ"
              key={order.id}
            />
          ))}
        </div>
      )}
    </>
  );
}
