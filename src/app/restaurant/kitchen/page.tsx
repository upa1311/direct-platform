"use client";

import { useEffect, useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { useRestaurantWorkspace } from "@/components/workspaces/restaurant-workspace";
import { usePrototype } from "@/prototype/prototype-provider";
import type { DeliveryMode, Order } from "@/prototype/models";
import {
  getKitchenAwaitingPaymentOrders,
  getKitchenNewOrders,
  getKitchenPreparingOrders,
  getKitchenReadyOrders,
  getOrderReadySince,
  getRestaurant,
  paymentStatusLabels,
} from "@/prototype/selectors";

const PREP_OPTIONS = [10, 15, 20, 25, 30, 40] as const;

const REJECT_REASONS = [
  "Нет нужных позиций",
  "Кухня перегружена",
  "Ресторан скоро закрывается",
  "Не можем выполнить комментарий",
  "Другая причина",
] as const;

/** Способ получения для кухни (§5). */
function kitchenDeliveryLabel(mode: DeliveryMode): string {
  if (mode === "PLATFORM_DRIVER") return "Доставка Direct";
  if (mode === "RESTAURANT_DELIVERY") return "Доставка ресторана";
  return "Самовывоз";
}

function defaultPrep(value: number | undefined): number {
  return PREP_OPTIONS.includes(value as (typeof PREP_OPTIONS)[number])
    ? (value as number)
    : 25;
}

function totalUnits(order: Order): number {
  return order.items.reduce((sum, item) => sum + item.quantity, 0);
}

/** Сколько времени прошло с момента `fromIso`. */
function formatElapsed(fromIso: string, nowMs: number): string {
  if (nowMs === 0) return "—";
  const diffMs = Math.max(0, nowMs - Date.parse(fromIso));
  const min = Math.floor(diffMs / 60_000);
  if (min >= 1) return `${min} мин`;
  const sec = Math.floor(diffMs / 1000);
  return `${sec} сек`;
}

/** Обратный отсчёт до готовности / просрочка (§10). */
function formatCountdown(
  expectedReadyAt: string | null,
  nowMs: number,
): { text: string; overdue: boolean } {
  if (!expectedReadyAt) {
    return { text: "Время не задано", overdue: false };
  }
  if (nowMs === 0) return { text: "—", overdue: false };
  const diffMs = Date.parse(expectedReadyAt) - nowMs;
  if (diffMs <= 0) {
    const overdueMin = Math.floor(-diffMs / 60_000);
    return { text: `Просрочено на ${overdueMin} мин`, overdue: true };
  }
  const totalSec = Math.ceil(diffMs / 1000);
  if (totalSec >= 60) {
    return { text: `${Math.floor(totalSec / 60)} мин`, overdue: false };
  }
  return {
    text: `0:${String(totalSec % 60).padStart(2, "0")}`,
    overdue: false,
  };
}

/** Общий блок позиций заказа с заметными комментариями (§6). */
function KitchenItems({ order }: { order: Order }) {
  return (
    <ul className={flowStyles.kitchenItems}>
      {order.items.map((item) => (
        <li key={`${item.menuItemId}-${item.selectedVariantId ?? "base"}`}>
          <span className={flowStyles.kitchenItemLine}>
            {item.name}
            {item.selectedVariantName ? ` · ${item.selectedVariantName}` : ""} ×{" "}
            {item.quantity}
          </span>
          {item.cookingComment ? (
            <span className={flowStyles.kitchenItemComment}>
              Комментарий: {item.cookingComment}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Заголовок карточки: номер, время ожидания, способ, оплата. */
function KitchenCardHead({
  order,
  waitingLabel,
  nowMs,
}: {
  order: Order;
  waitingLabel: string;
  nowMs: number;
}) {
  return (
    <div className={flowStyles.orderHeader}>
      <div>
        <h3 className={flowStyles.orderNumber}>{order.publicNumber}</h3>
        <div className={flowStyles.inlineMeta}>
          <span>{kitchenDeliveryLabel(order.deliveryMode)}</span>
          <span>Оплата: {paymentStatusLabels[order.paymentStatus]}</span>
        </div>
      </div>
      <span className={flowStyles.statusBadge}>
        {waitingLabel} {formatElapsed(order.createdAt, nowMs)}
      </span>
    </div>
  );
}

function NewOrderCard({ order }: { order: Order }) {
  const { state, acceptOrder, rejectOrder } = usePrototype();
  const restaurant = getRestaurant(state, order.restaurant.id);
  const [prep, setPrep] = useState(() =>
    defaultPrep(restaurant?.defaultPreparationMinutes),
  );
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");

  const isOther = reason === "Другая причина";
  const effectiveReason = isOther ? customReason : reason;

  return (
    <article className={flowStyles.kitchenCard}>
      <KitchenCardHead order={order} waitingLabel="Ждёт" nowMs={0} />
      <KitchenItems order={order} />
      <p className={flowStyles.kitchenUnits}>Всего единиц: {totalUnits(order)}</p>

      {!rejectOpen ? (
        <div className={flowStyles.orderActions}>
          <label className={flowStyles.field}>
            <span>Время приготовления</span>
            <select
              value={prep}
              onChange={(event) => setPrep(Number(event.target.value))}
            >
              {PREP_OPTIONS.map((minutes) => (
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
              onClick={() => acceptOrder(order.id, prep)}
            >
              Принять
            </button>
            <button
              className={flowStyles.secondaryButton}
              type="button"
              onClick={() => setRejectOpen(true)}
            >
              Отклонить
            </button>
          </div>
        </div>
      ) : (
        <div className={flowStyles.cancelDialog} role="group" aria-label="Отклонение заказа">
          <h4 className={flowStyles.sectionTitle}>Причина отклонения</h4>
          <fieldset className={flowStyles.cancelReasons}>
            {REJECT_REASONS.map((r) => (
              <label className={flowStyles.cancelReasonOption} key={r}>
                <input
                  type="radio"
                  name={`reject-${order.id}`}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                />
                <span>{r}</span>
              </label>
            ))}
          </fieldset>
          {isOther ? (
            <label className={flowStyles.field}>
              <span>Ваша причина</span>
              <textarea
                value={customReason}
                onChange={(event) => setCustomReason(event.target.value)}
                placeholder="Опишите причину"
              />
            </label>
          ) : null}
          <div className={flowStyles.buttonRow}>
            <button
              className={flowStyles.dangerButton}
              type="button"
              disabled={!effectiveReason.trim()}
              onClick={() => rejectOrder(order.id, effectiveReason)}
            >
              Подтвердить отклонение
            </button>
            <button
              className={flowStyles.secondaryButton}
              type="button"
              onClick={() => setRejectOpen(false)}
            >
              Не отклонять
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function PreparingCard({ order, nowMs }: { order: Order; nowMs: number }) {
  const { markReady } = usePrototype();
  const countdown = formatCountdown(order.expectedReadyAt, nowMs);
  const readyLabel =
    order.deliveryMode === "PICKUP"
      ? "Готово к выдаче"
      : order.deliveryMode === "RESTAURANT_DELIVERY"
        ? "Готово"
        : "Готово и упаковано";

  return (
    <article
      className={`${flowStyles.kitchenCard} ${countdown.overdue ? flowStyles.kitchenCardDelayed : ""}`}
    >
      <KitchenCardHead order={order} waitingLabel="Принят" nowMs={nowMs} />
      {countdown.overdue ? (
        <span className={flowStyles.kitchenDelayBadge}>Задержка</span>
      ) : null}
      <KitchenItems order={order} />
      <p className={flowStyles.kitchenUnits}>Всего единиц: {totalUnits(order)}</p>
      <div className={flowStyles.inlineMeta}>
        <span>Время приготовления: {order.preparationMinutes ?? "—"} мин</span>
      </div>
      <div
        className={`${flowStyles.kitchenCountdown} ${countdown.overdue ? flowStyles.kitchenCountdownOverdue : ""}`}
      >
        {countdown.overdue ? countdown.text : `До готовности: ${countdown.text}`}
      </div>
      <div className={flowStyles.buttonRow}>
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={() => markReady(order.id)}
        >
          {readyLabel}
        </button>
      </div>
    </article>
  );
}

function ReadyCard({ order, nowMs }: { order: Order; nowMs: number }) {
  const waitingFor =
    order.status === "READY_FOR_PICKUP"
      ? "Ожидает клиента"
      : order.deliveryMode === "RESTAURANT_DELIVERY"
        ? "Ожидает курьера ресторана"
        : "Ожидает водителя Direct";

  return (
    <article className={flowStyles.kitchenCard}>
      <div className={flowStyles.orderHeader}>
        <div>
          <h3 className={flowStyles.orderNumber}>{order.publicNumber}</h3>
          <div className={flowStyles.inlineMeta}>
            <span>{kitchenDeliveryLabel(order.deliveryMode)}</span>
          </div>
        </div>
        <span className={flowStyles.statusBadge}>{waitingFor}</span>
      </div>
      <KitchenItems order={order} />
      <p className={flowStyles.kitchenUnits}>Всего единиц: {totalUnits(order)}</p>
      <p className={flowStyles.summaryHint}>
        Готов {formatElapsed(getOrderReadySince(order), nowMs)} назад
      </p>
    </article>
  );
}

export default function RestaurantKitchenPage() {
  const { state, isHydrated } = usePrototype();
  const {
    selectedRestaurantId,
    setSelectedRestaurantId,
    workspaceRestaurants,
  } = useRestaurantWorkspace();
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    // Часы кухни: стартуем сразу после монтирования (SSR-safe) и тикаем раз в
    // секунду для обратного отсчёта и таймеров просрочки.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- инициализация клиентских часов после гидрации
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const restaurant = getRestaurant(state, selectedRestaurantId);
  const newOrders = getKitchenNewOrders(state, selectedRestaurantId);
  const awaitingOrders = getKitchenAwaitingPaymentOrders(
    state,
    selectedRestaurantId,
  );
  const preparingOrders = getKitchenPreparingOrders(state, selectedRestaurantId);
  const readyOrders = getKitchenReadyOrders(state, selectedRestaurantId);

  return (
    <div className={flowStyles.kitchenScreen}>
      <header className={flowStyles.kitchenHeader}>
        <h1>Кухня: {restaurant?.name ?? "—"}</h1>
        <label className={flowStyles.field}>
          <span>Сменить ресторан</span>
          <select
            value={selectedRestaurantId}
            onChange={(event) => setSelectedRestaurantId(event.target.value)}
          >
            {workspaceRestaurants.map((r) => (
              <option value={r.id} key={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      {!isHydrated ? (
        <div className={flowStyles.emptyState}>Загружаем кухню…</div>
      ) : (
        <>
          {awaitingOrders.length > 0 ? (
            <section className={flowStyles.kitchenAwaitingStrip}>
              <h2>Ожидают оплаты — {awaitingOrders.length}</h2>
              <div className={flowStyles.kitchenAwaitingList}>
                {awaitingOrders.map((order) => (
                  <article className={flowStyles.kitchenAwaitingCard} key={order.id}>
                    <div className={flowStyles.orderHeader}>
                      <h3 className={flowStyles.orderNumber}>
                        {order.publicNumber}
                      </h3>
                      <span className={flowStyles.statusBadge}>
                        {kitchenDeliveryLabel(order.deliveryMode)}
                      </span>
                    </div>
                    <KitchenItems order={order} />
                    <p className={flowStyles.summaryHint}>
                      Приготовление начнётся после подтверждения оплаты.
                    </p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <div className={flowStyles.kitchenBoard}>
            <section className={flowStyles.kitchenColumn}>
              <h2 className={flowStyles.kitchenColumnHead}>
                Новые <span>— {newOrders.length}</span>
              </h2>
              {newOrders.length === 0 ? (
                <div className={flowStyles.emptyState}>Новых заказов нет.</div>
              ) : (
                newOrders.map((order) => (
                  <NewOrderCard order={order} key={order.id} />
                ))
              )}
            </section>

            <section className={flowStyles.kitchenColumn}>
              <h2 className={flowStyles.kitchenColumnHead}>
                Готовятся <span>— {preparingOrders.length}</span>
              </h2>
              {preparingOrders.length === 0 ? (
                <div className={flowStyles.emptyState}>
                  Сейчас ничего не готовится.
                </div>
              ) : (
                preparingOrders.map((order) => (
                  <PreparingCard order={order} nowMs={nowMs} key={order.id} />
                ))
              )}
            </section>

            <section className={flowStyles.kitchenColumn}>
              <h2 className={flowStyles.kitchenColumnHead}>
                Готовы <span>— {readyOrders.length}</span>
              </h2>
              {readyOrders.length === 0 ? (
                <div className={flowStyles.emptyState}>
                  Готовых заказов пока нет.
                </div>
              ) : (
                readyOrders.map((order) => (
                  <ReadyCard order={order} nowMs={nowMs} key={order.id} />
                ))
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
