"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatDateTime,
  formatMoney,
  formatSettlementStatus,
  formatSettlementType,
  getPickupStats,
  getRestaurantDeliveryCommissionDebtCents,
  getRestaurantPickupDebtCents,
} from "@/prototype/selectors";

function SettlementsContent() {
  const { state } = usePrototype();
  const searchParams = useSearchParams();
  const filterRestaurantId = searchParams.get("restaurantId");
  const filterRestaurant = filterRestaurantId
    ? state.restaurants.find((r) => r.id === filterRestaurantId)
    : null;
  const restaurants = state.restaurants
    .filter((restaurant) => restaurant.status === "PUBLISHED")
    .filter((restaurant) =>
      filterRestaurantId ? restaurant.id === filterRestaurantId : true,
    );
  const settlements = state.settlements.filter((entry) =>
    filterRestaurantId ? entry.restaurantId === filterRestaurantId : true,
  );

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Расчёты с ресторанами"
        description="Комиссии, задолженность и взаиморасчёты с ресторанами."
      />

      {filterRestaurant ? (
        <p className={flowStyles.summaryHint}>
          Фильтр по ресторану: <strong>{filterRestaurant.name}</strong>.{" "}
          <Link href="/admin/settlements">Показать все</Link>
        </p>
      ) : null}

      <section className={flowStyles.card}>
        <h2>Задолженность и статистика по ресторанам</h2>
        <div className={flowStyles.orderList}>
          {restaurants.map((restaurant) => {
            const pickupDebt = getRestaurantPickupDebtCents(
              state,
              restaurant.id,
            );
            const deliveryDebt = getRestaurantDeliveryCommissionDebtCents(
              state,
              restaurant.id,
            );
            const stats = getPickupStats(state, restaurant.id);
            return (
              <div className={flowStyles.cartLine} key={restaurant.id}>
                <div className={flowStyles.cartLineTop}>
                  <strong>{restaurant.name}</strong>
                  <span className={flowStyles.price}>
                    Долг перед Direct: {formatMoney(pickupDebt + deliveryDebt)}
                  </span>
                </div>
                <div className={flowStyles.inlineMeta}>
                  <span>Комиссия самовывоза: {formatMoney(pickupDebt)}</span>
                  <span>
                    Комиссия доставки ресторана: {formatMoney(deliveryDebt)}
                  </span>
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
          онлайн-выплат ресторану, остаток учитывается в еженедельном
          взаиморасчёте. Реальное банковское списание в прототипе не выполняется.
        </p>
      </section>

      <section className={flowStyles.card}>
        <h2>Журнал начислений</h2>
        {settlements.length === 0 ? (
          <div className={flowStyles.emptyState}>
            Начислений пока нет. Комиссия за самовывоз появляется после выдачи по
            коду, а комиссия за доставку ресторана — после завершения доставки.
          </div>
        ) : (
          <dl className={flowStyles.definitionList}>
            {[...settlements].reverse().map((entry) => {
              // Показываем человекочитаемый номер заказа и название ресторана,
              // а не внутренние идентификаторы. Заказ ищем по entry.orderId.
              const order = state.orders.find((o) => o.id === entry.orderId);
              const orderLabel = order
                ? `Заказ ${order.publicNumber}`
                : "Заказ (не найден)";
              const restaurantName =
                order?.restaurant.name ??
                state.restaurants.find((r) => r.id === entry.restaurantId)
                  ?.name ??
                "Ресторан";
              return (
                <div className={flowStyles.definitionRow} key={entry.id}>
                  <dt>
                    {orderLabel}
                    <br />
                    {restaurantName}
                    <br />
                    {formatSettlementType(entry.type)}
                  </dt>
                  <dd>
                    {formatMoney(entry.amountCents)} ·{" "}
                    {formatSettlementStatus(entry.status)}
                    <br />
                    {formatDateTime(entry.createdAt)}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </section>
    </>
  );
}

export default function AdminSettlementsPage() {
  return (
    <Suspense
      fallback={<div className={flowStyles.emptyState}>Загрузка…</div>}
    >
      <SettlementsContent />
    </Suspense>
  );
}
