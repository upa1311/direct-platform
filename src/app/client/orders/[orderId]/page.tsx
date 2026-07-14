"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { ClientOrderActions } from "@/components/order-flow/client-order-actions";
import { OrderHistory } from "@/components/order-flow/order-history";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  deliveryModeLabels,
  formatMoney,
  getClientAutoCancelMessage,
  getDeliveryModeProviderLabel,
  getOrder,
  orderStatusLabels,
  paymentMethodLabels,
  paymentStatusLabels,
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
              <dt>Способ получения</dt>
              <dd>{deliveryModeLabels[order.deliveryMode]}</dd>
            </div>
            {order.deliveryMode !== "PICKUP" ? (
              <>
                <div className={flowStyles.summaryRow}>
                  <dt>Адрес доставки</dt>
                  <dd>
                    {order.address
                      ? `${order.address.street}, дом ${order.address.house}${order.address.apartment ? `, кв. ${order.address.apartment}` : ""}`
                      : "Адрес не сохранён"}
                  </dd>
                </div>
                <div className={flowStyles.summaryRow}>
                  <dt>Исполнитель</dt>
                  <dd>
                    {getDeliveryModeProviderLabel(order.deliveryMode) ?? "—"}
                  </dd>
                </div>
              </>
            ) : (
              <>
                <div className={flowStyles.summaryRow}>
                  <dt>Забрать из</dt>
                  <dd>{order.restaurant.name}</dd>
                </div>
                <div className={flowStyles.summaryRow}>
                  <dt>Адрес ресторана</dt>
                  <dd>{order.restaurant.address}</dd>
                </div>
              </>
            )}
            <div className={flowStyles.summaryRow}>
              <dt>Оплата</dt>
              <dd>{paymentMethodLabels[order.paymentMethod]}</dd>
            </div>
            {order.deliveryMode === "PICKUP" ? (
              <div className={flowStyles.summaryRow}>
                <dt>Статус оплаты</dt>
                <dd>{paymentStatusLabels[order.paymentStatus]}</dd>
              </div>
            ) : null}
          </dl>
          {order.deliveryMode === "PICKUP" &&
          order.pickupCode &&
          !order.pickupCodeUsed &&
          (order.status === "RESTAURANT_REVIEW" ||
            order.status === "PREPARING") ? (
            <p className={flowStyles.summaryHint}>
              Код получения появится, когда заказ будет готов.
            </p>
          ) : null}
          {order.deliveryMode === "PICKUP" &&
          order.pickupCode &&
          !order.pickupCodeUsed &&
          order.status === "READY_FOR_PICKUP" ? (
            <div className={flowStyles.zoneNotice}>
              Код получения: <strong>{order.pickupCode}</strong>. Назовите его в
              ресторане при получении и оплате заказа.
            </div>
          ) : null}
          <h3>Состав заказа</h3>
          <div className={flowStyles.orderItemList}>
            {order.items.map((item) => (
              <div key={`${item.menuItemId}-${item.selectedVariantId ?? "base"}`}>
                <span>
                  <strong>
                    {item.name}
                    {item.selectedVariantName && item.variantPriceDeltaCents !== 0
                      ? ` · ${item.selectedVariantName}`
                      : ""}
                  </strong>{" "}
                  × {item.quantity}
                  {item.cookingComment ? (
                    <small>Комментарий: {item.cookingComment}</small>
                  ) : null}
                </span>
                <span>{formatMoney(item.finalLineTotalCents, item.currencyCode)}</span>
              </div>
            ))}
          </div>
          <dl className={flowStyles.summaryList}>
            <div className={flowStyles.summaryRow}><dt>Еда</dt><dd>{formatMoney(order.financials.foodSubtotalBeforeDiscountsCents)}</dd></div>
            {order.financials.appliedPromotion ? (
              <div className={flowStyles.summaryRow}>
                <dt>Скидка: {order.financials.appliedPromotion.title}</dt>
                <dd>−{formatMoney(order.financials.promotionDiscountCents)}</dd>
              </div>
            ) : null}
            <div className={flowStyles.summaryRow}><dt>{order.deliveryMode === "PICKUP" ? "Самовывоз" : "Доставка"}</dt><dd>{formatMoney(order.financials.deliveryFeeCents)}</dd></div>
            {order.financials.smallOrderFeeCents > 0 ? <div className={flowStyles.summaryRow}><dt>Доплата за небольшой заказ</dt><dd>{formatMoney(order.financials.smallOrderFeeCents)}</dd></div> : null}
            <div className={`${flowStyles.summaryRow} ${flowStyles.summaryTotal}`}><dt>Итого</dt><dd>{formatMoney(order.financials.customerTotalCents)}</dd></div>
          </dl>
          {order.financials.restaurantDelivery ? (
            <div className={flowStyles.zoneNotice}>
              Минимальный заказ{" "}
              {formatMoney(order.financials.restaurantDelivery.minimumOrderCents)}
              {order.financials.restaurantDelivery.freeDeliveryApplied
                ? " · Доставка бесплатно"
                : ` · Доставка ${formatMoney(order.financials.restaurantDelivery.appliedDeliveryFeeCents)}`}
            </div>
          ) : null}
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
          {getClientAutoCancelMessage(order) ? (
            <div className={flowStyles.warningNotice} role="status">
              {getClientAutoCancelMessage(order)}
            </div>
          ) : null}
          {order.cancellationReason ? (
            <div className={flowStyles.warningNotice}>
              Причина отмены: {order.cancellationReason}
            </div>
          ) : null}
          <ClientOrderActions order={order} />
        </section>

        <section className={flowStyles.card}>
          <h2>История статусов</h2>
          <OrderHistory events={order.history} />
        </section>
      </div>
    </>
  );
}
