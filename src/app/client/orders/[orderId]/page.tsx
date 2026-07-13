"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { OrderHistory } from "@/components/order-flow/order-history";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatMoney,
  getOrder,
  orderStatusLabels,
  paymentMethodLabels,
} from "@/prototype/selectors";

export default function ClientOrderPage() {
  const params = useParams<{ orderId: string }>();
  const { state, isHydrated, simulateOnlinePayment } = usePrototype();
  const order = getOrder(state, params.orderId);

  if (!isHydrated) {
    return <div className={flowStyles.emptyState}>Загружаем заказ…</div>;
  }

  if (!order) {
    return (
      <div className={flowStyles.emptyState}>
        Заказ не найден. <Link href="/client/orders">Перейти в мои заказы</Link>
      </div>
    );
  }

  return (
    <>
      <PageHeading
        eyebrow="Клиент"
        title={`Заказ ${order.publicNumber}`}
        description={`${order.restaurant.name} · ${orderStatusLabels[order.status]}`}
      />
      <div className={flowStyles.panelStack} id="order-status">
        <section className={flowStyles.orderCard}>
          <div className={flowStyles.orderHeader}>
            <div>
              <h2 className={flowStyles.orderNumber}>{order.publicNumber}</h2>
              <p>{order.restaurant.name}</p>
            </div>
            <span className={flowStyles.statusBadge}>
              {orderStatusLabels[order.status]}
            </span>
          </div>
          <dl className={flowStyles.summaryList}>
            <div className={flowStyles.summaryRow}>
              <dt>Адрес</dt>
              <dd>{order.address.street}, дом {order.address.house}{order.address.apartment ? `, кв. ${order.address.apartment}` : ""}</dd>
            </div>
            <div className={flowStyles.summaryRow}>
              <dt>Оплата</dt>
              <dd>{paymentMethodLabels[order.paymentMethod]}</dd>
            </div>
          </dl>
          <h3>Состав заказа</h3>
          <div className={flowStyles.orderItemList}>
            {order.items.map((item) => (
              <div key={item.menuItemId}>
                <span><strong>{item.name}</strong> × {item.quantity}{item.cookingComment ? <small>Комментарий: {item.cookingComment}</small> : null}</span>
                <span>{formatMoney(item.lineTotalCents, item.currencyCode)}</span>
              </div>
            ))}
          </div>
          <dl className={flowStyles.summaryList}>
            <div className={flowStyles.summaryRow}><dt>Еда</dt><dd>{formatMoney(order.financials.foodSubtotalCents)}</dd></div>
            <div className={flowStyles.summaryRow}><dt>Доставка</dt><dd>{formatMoney(order.financials.deliveryFeeCents)}</dd></div>
            {order.financials.smallOrderFeeCents > 0 ? <div className={flowStyles.summaryRow}><dt>Доплата за небольшой заказ</dt><dd>{formatMoney(order.financials.smallOrderFeeCents)}</dd></div> : null}
            <div className={`${flowStyles.summaryRow} ${flowStyles.summaryTotal}`}><dt>Итого</dt><dd>{formatMoney(order.financials.customerTotalCents)}</dd></div>
          </dl>
          {order.status === "AWAITING_PAYMENT" &&
          order.paymentMethod === "ONLINE" ? (
            <div className={flowStyles.submitArea}>
              <button
                className={flowStyles.primaryButton}
                type="button"
                onClick={() => simulateOnlinePayment(order.id)}
              >
                Имитировать успешную онлайн-оплату
              </button>
              <p>
                Это демонстрационное подтверждение. Банк не подключён, деньги
                не списываются.
              </p>
            </div>
          ) : null}
          {order.cancellationReason ? (
            <div className={flowStyles.warningNotice}>
              Причина отмены: {order.cancellationReason}
            </div>
          ) : null}
        </section>

        <section className={flowStyles.card}>
          <h2>История статусов</h2>
          <OrderHistory events={order.history} />
        </section>
      </div>
    </>
  );
}
