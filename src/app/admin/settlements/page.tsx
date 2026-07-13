"use client";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatMoney,
  getPickupStats,
  getRestaurantPickupDebtCents,
} from "@/prototype/selectors";

const SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Ожидает",
  NETTED: "Взаимозачёт",
  PAID: "Оплачено",
  WAIVED: "Списано",
};

export default function AdminSettlementsPage() {
  const { state } = usePrototype();
  const restaurants = state.restaurants.filter(
    (restaurant) => restaurant.status === "PUBLISHED",
  );

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Расчёты и самовывоз"
        description="Задолженность ресторанов перед Direct по комиссии самовывоза и статистика выдач."
      />

      <section className={flowStyles.card}>
        <h2>Задолженность и статистика по ресторанам</h2>
        <div className={flowStyles.orderList}>
          {restaurants.map((restaurant) => {
            const debt = getRestaurantPickupDebtCents(state, restaurant.id);
            const stats = getPickupStats(state, restaurant.id);
            return (
              <div className={flowStyles.cartLine} key={restaurant.id}>
                <div className={flowStyles.cartLineTop}>
                  <strong>{restaurant.name}</strong>
                  <span className={flowStyles.price}>
                    Долг перед Direct: {formatMoney(debt)}
                  </span>
                </div>
                <div className={flowStyles.inlineMeta}>
                  <span>Выдано самовывозом: {stats.issued}</span>
                  <span>Невыкуплено: {stats.noShow}</span>
                  <span>Процент неявок: {stats.noShowPercent}%</span>
                  <span>
                    Подозрительные отмены после готовности:{" "}
                    {stats.suspiciousAfterReady}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <p className={flowStyles.prototypeNote}>
          Порядок расчёта: комиссия самовывоза сначала вычитается из будущих
          онлайн-выплат ресторану, остаток попадает в недельный settlement.
          Реальное банковское списание в прототипе не выполняется.
        </p>
      </section>

      <section className={flowStyles.card}>
        <h2>Журнал начислений (ledger)</h2>
        {state.settlements.length === 0 ? (
          <div className={flowStyles.emptyState}>
            Начислений пока нет. Комиссия появляется после выдачи заказа по коду.
          </div>
        ) : (
          <dl className={flowStyles.definitionList}>
            {[...state.settlements].reverse().map((entry) => (
              <div className={flowStyles.definitionRow} key={entry.id}>
                <dt>
                  {entry.orderId} · {entry.restaurantId}
                </dt>
                <dd>
                  {formatMoney(entry.amountCents)} ·{" "}
                  {SETTLEMENT_STATUS_LABELS[entry.status] ?? entry.status}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </>
  );
}
