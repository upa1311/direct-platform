"use client";

import { OrderHistory } from "@/components/order-flow/order-history";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  deliveryModeLabels,
  formatMoney,
  getZoneName,
  orderStatusLabels,
  paymentMethodLabels,
  paymentStatusLabels,
} from "@/prototype/selectors";

export default function AdminOrdersPage() {
  const { state } = usePrototype();

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Заказы"
        description="Полный операционный и финансовый снимок каждого созданного заказа."
      />
      {state.orders.length === 0 ? (
        <div className={flowStyles.emptyState}>Созданных заказов пока нет.</div>
      ) : (
        <div className={flowStyles.orderList}>
          {[...state.orders].reverse().map((order) => (
            <article className={flowStyles.orderCard} key={order.id}>
              <div className={flowStyles.orderHeader}>
                <div>
                  <h2 className={flowStyles.orderNumber}>
                    {order.publicNumber}
                  </h2>
                  <p>
                    {order.customer.name} · {order.restaurant.name}
                  </p>
                </div>
                <span className={flowStyles.statusBadge}>
                  {orderStatusLabels[order.status]}
                </span>
              </div>

              <div className={flowStyles.adminOrderGrid}>
                <section>
                  <h3 className={flowStyles.sectionTitle}>Заказ</h3>
                  <dl className={flowStyles.definitionList}>
                    <div className={flowStyles.definitionRow}>
                      <dt>Клиент</dt>
                      <dd>{order.customer.name}</dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Ресторан</dt>
                      <dd>{order.restaurant.name}</dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Способ получения</dt>
                      <dd>{deliveryModeLabels[order.deliveryMode]}</dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Адрес</dt>
                      <dd>
                        {order.address
                          ? `${order.address.street}, дом ${order.address.house}${order.address.apartment ? `, кв. ${order.address.apartment}` : ""}`
                          : `Самовывоз: ${order.restaurant.address}`}
                      </dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Зона ресторана</dt>
                      <dd>
                        {getZoneName(state, order.financials.restaurantZoneId)}
                      </dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Зона клиента</dt>
                      <dd>
                        {order.financials.customerZoneId
                          ? getZoneName(state, order.financials.customerZoneId)
                          : "—"}
                      </dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Оплата</dt>
                      <dd>{paymentMethodLabels[order.paymentMethod]}</dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Статус оплаты</dt>
                      <dd>{paymentStatusLabels[order.paymentStatus]}</dd>
                    </div>
                  </dl>
                </section>

                <section>
                  <h3 className={flowStyles.sectionTitle}>Финансовый расчёт</h3>
                  <dl className={flowStyles.definitionList}>
                    <div className={flowStyles.definitionRow}>
                      <dt>Стоимость еды</dt>
                      <dd>{formatMoney(order.financials.foodSubtotalCents)}</dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Доставка</dt>
                      <dd>{formatMoney(order.financials.deliveryFeeCents)}</dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Комиссия ресторана</dt>
                      <dd>
                        {formatMoney(
                          order.financials.restaurantCommissionCents,
                        )}
                      </dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Доплата за небольшой заказ</dt>
                      <dd>{formatMoney(order.financials.smallOrderFeeCents)}</dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Выплата ресторану до банковской комиссии</dt>
                      <dd>
                        {formatMoney(
                          order.financials
                            .restaurantPayoutBeforeBankFeeCents,
                        )}
                      </dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Будущая выплата водителю</dt>
                      <dd>{formatMoney(order.financials.driverPayoutCents)}</dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Валовой доход Direct</dt>
                      <dd>
                        {formatMoney(
                          order.financials.platformGrossRevenueCents,
                        )}
                      </dd>
                    </div>
                    <div className={flowStyles.definitionRow}>
                      <dt>Итог клиента</dt>
                      <dd>{formatMoney(order.financials.customerTotalCents)}</dd>
                    </div>
                  </dl>
                </section>
              </div>

              <h3 className={flowStyles.sectionTitle}>История статусов</h3>
              <OrderHistory events={order.history} />
            </article>
          ))}
        </div>
      )}
    </>
  );
}
