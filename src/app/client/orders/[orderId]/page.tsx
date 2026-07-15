"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { ClientOrderActions } from "@/components/order-flow/client-order-actions";
import { OrderHistory } from "@/components/order-flow/order-history";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import type { Order } from "@/prototype/models";
import {
  deliveryModeLabels,
  formatMoney,
  formatOrderEtaClock,
  getClientAutoCancelMessage,
  getDeliveryModeProviderLabel,
  getOrder,
  hasActiveEtaUpdate,
  orderStatusLabels,
  paymentMethodLabels,
  paymentStatusLabels,
  pickupPaymentMethodLabels,
} from "@/prototype/selectors";

/**
 * Невыкуп определяется ТОЛЬКО по структурированному признаку pickupNoShowAt,
 * который ставит исключительно markPickupNoShow. Обычная adminCancelOrder из
 * READY_FOR_PICKUP не является невыкупом и его не устанавливает.
 */
function isPickupNoShow(order: Order): boolean {
  return order.pickupNoShowAt !== null;
}

/**
 * §13: клиентский блок самовывоза. До готовности — подсказка; в READY_FOR_PICKUP
 * — карточка «Заказ готов к выдаче» с рестораном, адресом, суммой, способами
 * оплаты, крупным четырёхзначным кодом и инструкцией. После выдачи код скрыт и
 * показано «Заказ получен.»; при невыкупе — нейтральное сообщение без внутренних
 * причин/счётчиков/начислений.
 */
function ClientPickupBlock({ order }: { order: Order }) {
  if (order.status === "PICKED_UP" || order.pickupCodeUsed) {
    return (
      <div className={flowStyles.successNotice} role="status">
        Заказ получен.
      </div>
    );
  }
  if (isPickupNoShow(order)) {
    return (
      <div className={flowStyles.warningNotice} role="status">
        Заказ был закрыт как невыкупленный.
      </div>
    );
  }
  if (order.status === "READY_FOR_PICKUP" && order.pickupCode) {
    const methods =
      order.pickupPaymentMethodsSnapshot.length > 0
        ? order.pickupPaymentMethodsSnapshot
            .map((m) => pickupPaymentMethodLabels[m])
            .join(" или ")
        : "уточните в ресторане";
    return (
      <div className={`${flowStyles.zoneNotice} ${flowStyles.pickupReadyCard}`}>
        <strong>Заказ готов к выдаче</strong>
        <div>
          {order.restaurant.name} · {order.restaurant.address}
        </div>
        <div>К оплате в ресторане: {formatMoney(order.financials.customerTotalCents)}</div>
        <div>Способы оплаты на точке: {methods}</div>
        <span className={flowStyles.pickupCode}>{order.pickupCode}</span>
        <p className={flowStyles.pickupInstruction}>
          Назовите этот четырёхзначный код в ресторане при получении и оплате
          заказа.
        </p>
      </div>
    );
  }
  if (
    order.status === "RESTAURANT_REVIEW" ||
    order.status === "AWAITING_PAYMENT" ||
    order.status === "PREPARING"
  ) {
    return (
      <p className={flowStyles.summaryHint}>
        Код получения появится, когда заказ будет готов.
      </p>
    );
  }
  return null;
}

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
      <div
        className={`${flowStyles.panelStack} ${flowStyles.orderDetailStack}`}
        id="order-status"
      >
        <section className={flowStyles.orderCard}>
          {/* §1: номер/ресторан/статус уже показаны в PageHeading выше —
              внутренний повторяющийся заголовок убран, карточка сразу со сводки. */}
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
          {hasActiveEtaUpdate(order) ? (
            <div className={flowStyles.zoneNotice} role="status">
              Ресторан обновил время готовности заказа.
              <br />
              Ожидаемая готовность: {formatOrderEtaClock(state, order)}.
            </div>
          ) : null}
          {order.deliveryMode === "PICKUP" ? (
            <ClientPickupBlock order={order} />
          ) : null}
          <h2 className={flowStyles.orderSectionTitle}>Состав заказа</h2>
          <div className={flowStyles.orderItemList}>
            {order.items.map((item) => (
              <div key={`${item.menuItemId}-${item.selectedVariantId ?? "base"}`}>
                <span className={flowStyles.orderItemName}>
                  {item.name}
                  {item.selectedVariantName && item.variantPriceDeltaCents !== 0
                    ? ` · ${item.selectedVariantName}`
                    : ""}{" "}
                  × {item.quantity}
                  {item.cookingComment ? (
                    <small>Комментарий: {item.cookingComment}</small>
                  ) : null}
                </span>
                <span className={flowStyles.orderItemPrice}>
                  {formatMoney(item.finalLineTotalCents, item.currencyCode)}
                </span>
              </div>
            ))}
          </div>
          <dl className={`${flowStyles.summaryList} ${flowStyles.orderTotals}`}>
            <div className={flowStyles.summaryRow}><dt>Еда</dt><dd>{formatMoney(order.financials.foodSubtotalBeforeDiscountsCents)}</dd></div>
            {order.financials.appliedPromotion ? (
              <div className={flowStyles.summaryRow}>
                <dt>Скидка: {order.financials.appliedPromotion.title}</dt>
                <dd>−{formatMoney(order.financials.promotionDiscountCents)}</dd>
              </div>
            ) : null}
            <div className={flowStyles.summaryRow}><dt>{order.deliveryMode === "PICKUP" ? "Самовывоз" : "Доставка"}</dt><dd>{formatMoney(order.financials.deliveryFeeCents)}</dd></div>
            {order.financials.smallOrderFeeCents > 0 ? <div className={flowStyles.summaryRow}><dt>Доплата за небольшой заказ</dt><dd>{formatMoney(order.financials.smallOrderFeeCents)}</dd></div> : null}
            <div className={`${flowStyles.summaryRow} ${flowStyles.orderGrandTotal}`}><dt>Итого</dt><dd>{formatMoney(order.financials.customerTotalCents)}</dd></div>
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
          {/* Для самовывоза внутренняя причина отмены/невыкупа клиенту не
              раскрывается (§4): статусная сводка идёт нейтрально в истории. */}
          {/* §1: завершённый факт, а не активное предупреждение — спокойная
              inline-строка без плашки/рамки. Для PICKUP внутреннюю причину
              по-прежнему не показываем. */}
          {order.cancellationReason && order.deliveryMode !== "PICKUP" ? (
            <p className={flowStyles.cancellationReasonInline}>
              <span>Причина отмены:</span> {order.cancellationReason}
            </p>
          ) : null}
          <ClientOrderActions order={order} />
        </section>

        <section className={flowStyles.card}>
          <h2>История статусов</h2>
          <OrderHistory
            events={order.history}
            order={order}
            clientSafe
            neutralizeEtaReason
          />
        </section>
      </div>
    </>
  );
}
