"use client";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import { driverStatusLabels } from "@/prototype/selectors";

export default function AdminDriversPage() {
  const { state } = usePrototype();

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Водители"
        description="Водители Direct и их текущий статус. Назначение на заказы — на странице «Заказы»."
      />
      {state.drivers.length === 0 ? (
        <div className={flowStyles.emptyState}>Водители не добавлены.</div>
      ) : (
        <section className={flowStyles.card}>
          <h2>Список водителей</h2>
          <dl className={flowStyles.definitionList}>
            {state.drivers.map((driver) => {
              const activeOrder = state.orders.find(
                (order) => order.assignedDriverId === driver.id,
              );
              return (
                <div className={flowStyles.definitionRow} key={driver.id}>
                  <dt>
                    {driver.name}
                    {driver.phone ? (
                      <>
                        {" · "}
                        <a href={`tel:${driver.phone}`}>{driver.phone}</a>
                      </>
                    ) : null}
                  </dt>
                  <dd>
                    {driverStatusLabels[driver.status]}
                    {activeOrder
                      ? ` · заказ ${activeOrder.publicNumber}`
                      : ""}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}
    </>
  );
}
