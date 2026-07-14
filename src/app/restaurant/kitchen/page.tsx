"use client";

import { useEffect, useRef, useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { useRestaurantWorkspace } from "@/components/workspaces/restaurant-workspace";
import {
  disableKitchenSound,
  enableKitchenSound,
  KITCHEN_SOUND_KEY,
  playKitchenBeep,
} from "@/components/workspaces/kitchen-sound";
import { usePrototype } from "@/prototype/prototype-provider";
import { RESTAURANT_RESPONSE_TIMEOUT_MS } from "@/prototype/actions";
import type { CancellationRequest, DeliveryMode, Order } from "@/prototype/models";
import {
  formatExpectedReady,
  formatKitchenCountdown,
  getCancellationRequestForOrder,
  getKitchenAwaitingPaymentOrders,
  getKitchenNewOrders,
  getKitchenPreparingOrders,
  getKitchenReadyOrders,
  getOrderReadySince,
  getOrderStatusSince,
  getPendingCancellationRequestsForRestaurant,
  getRestaurant,
  isKitchenBeepDue,
  paymentStatusLabels,
} from "@/prototype/selectors";

const ATTENTION_THRESHOLD_MS = 2 * 60 * 1000;
const URGENT_THRESHOLD_MS = 60 * 1000;

/** Обратный отсчёт до автозакрытия неотвеченного заказа (§3). */
function formatAutoClose(
  createdAtIso: string,
  nowMs: number,
): { text: string; needsAttention: boolean; urgent: boolean } {
  if (nowMs === 0) {
    return { text: "—", needsAttention: false, urgent: false };
  }
  const elapsed = nowMs - Date.parse(createdAtIso);
  const remainingMs = RESTAURANT_RESPONSE_TIMEOUT_MS - elapsed;
  const remSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const mmss = `${Math.floor(remSec / 60)}:${String(remSec % 60).padStart(2, "0")}`;
  const urgent = remainingMs <= URGENT_THRESHOLD_MS;
  return {
    text: urgent
      ? `Заказ будет автоматически закрыт через ${mmss}`
      : `До автоматического закрытия: ${mmss}`,
    needsAttention: elapsed >= ATTENTION_THRESHOLD_MS,
    urgent,
  };
}

/** Заметный блок уведомления кухни о запросе клиента на отмену (§11). */
function CancellationRequestNotice({
  request,
}: {
  request: CancellationRequest;
}) {
  return (
    <div className={flowStyles.kitchenCancelRequest} role="status">
      <span className={flowStyles.kitchenCancelRequestBadge}>
        Запрос на отмену
      </span>
      <p>
        Клиент запросил отмену. Администратор Direct рассматривает запрос. До
        решения продолжайте выполнение заказа.
      </p>
      <p className={flowStyles.summaryHint}>Причина клиента: {request.reason}</p>
    </div>
  );
}

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

/** Заголовок карточки: номер, способ, оплата, время в текущем статусе. */
function KitchenCardHead({
  order,
  waitingLabel,
  sinceIso,
  nowMs,
}: {
  order: Order;
  waitingLabel: string;
  sinceIso: string;
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
        {waitingLabel} {formatElapsed(sinceIso, nowMs)}
      </span>
    </div>
  );
}

function NewOrderCard({ order, nowMs }: { order: Order; nowMs: number }) {
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
  const autoClose = formatAutoClose(order.createdAt, nowMs);

  return (
    <article
      className={`${flowStyles.kitchenCard} ${autoClose.needsAttention ? flowStyles.kitchenCardAttention : ""}`}
    >
      <KitchenCardHead
        order={order}
        waitingLabel="Ждёт"
        sinceIso={getOrderStatusSince(order, "RESTAURANT_REVIEW")}
        nowMs={nowMs}
      />
      {autoClose.needsAttention ? (
        <span className={flowStyles.kitchenAttentionBadge}>
          Требуется реакция
        </span>
      ) : null}
      <KitchenItems order={order} />
      <p className={flowStyles.kitchenUnits}>Всего единиц: {totalUnits(order)}</p>
      <div
        className={`${flowStyles.kitchenCountdown} ${autoClose.urgent ? flowStyles.kitchenCountdownOverdue : ""}`}
      >
        {autoClose.text}
      </div>

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

function PreparingCard({
  order,
  nowMs,
  timeZone,
}: {
  order: Order;
  nowMs: number;
  timeZone: string;
}) {
  const { state, markReady } = usePrototype();
  const countdown = formatKitchenCountdown(order.expectedReadyAt, nowMs);
  const request = getCancellationRequestForOrder(state, order.id);
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
      <KitchenCardHead
        order={order}
        waitingLabel="Готовится"
        sinceIso={getOrderStatusSince(order, "PREPARING")}
        nowMs={nowMs}
      />
      {request?.status === "PENDING" ? (
        <CancellationRequestNotice request={request} />
      ) : null}
      {countdown.overdue ? (
        <span className={flowStyles.kitchenDelayBadge}>Задержка</span>
      ) : null}
      <KitchenItems order={order} />
      <p className={flowStyles.kitchenUnits}>Всего единиц: {totalUnits(order)}</p>
      <div className={flowStyles.inlineMeta}>
        <span>Время приготовления: {order.preparationMinutes ?? "—"} мин</span>
      </div>
      <p className={flowStyles.kitchenUnits}>
        {formatExpectedReady(order.expectedReadyAt, timeZone)}
      </p>
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
  const { state } = usePrototype();
  const request = getCancellationRequestForOrder(state, order.id);
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
      {request?.status === "PENDING" ? (
        <CancellationRequestNotice request={request} />
      ) : null}
      <div className={flowStyles.inlineMeta}>
        <span>Оплата: {paymentStatusLabels[order.paymentStatus]}</span>
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
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);

  const restaurant = getRestaurant(state, selectedRestaurantId);
  const newOrders = getKitchenNewOrders(state, selectedRestaurantId);
  const awaitingOrders = getKitchenAwaitingPaymentOrders(
    state,
    selectedRestaurantId,
  );
  const preparingOrders = getKitchenPreparingOrders(state, selectedRestaurantId);
  const readyOrders = getKitchenReadyOrders(state, selectedRestaurantId);
  const pendingRequests = getPendingCancellationRequestsForRestaurant(
    state,
    selectedRestaurantId,
  );

  // Refs — единый централизованный механизм сигналов (§2), без setInterval на
  // карточку. Обновляем каждым рендером, читаем из общего тика.
  const reviewIdsRef = useRef<string[]>([]);
  const soundEnabledRef = useRef(false);
  const lastBeepRef = useRef<number | null>(null);
  const announcedRef = useRef<string[]>([]);
  const reviewIdsKey = newOrders.map((order) => order.id).join(",");

  // Синхронизируем refs после рендера (не во время) для общего тика.
  useEffect(() => {
    reviewIdsRef.current = reviewIdsKey ? reviewIdsKey.split(",") : [];
    soundEnabledRef.current = soundEnabled;
  }, [reviewIdsKey, soundEnabled]);

  useEffect(() => {
    // Единый тик кухни: часы + централизованное расписание звука (§2, §19).
    const tick = () => {
      setNowMs(Date.now());
      const reviewIds = reviewIdsRef.current;
      if (reviewIds.length === 0) {
        // Нет новых заказов — сбрасываем расписание для мгновенного сигнала.
        lastBeepRef.current = null;
        announcedRef.current = [];
        return;
      }
      if (!soundEnabledRef.current) return;
      const due = isKitchenBeepDue({
        reviewOrderIds: reviewIds,
        announcedOrderIds: announcedRef.current,
        lastBeepAtMs: lastBeepRef.current,
        nowMs: Date.now(),
      });
      if (due) {
        playKitchenBeep();
        lastBeepRef.current = Date.now();
        announcedRef.current = [...reviewIds];
      }
    };
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const handleEnableSound = async () => {
    const ok = await enableKitchenSound();
    if (!ok) {
      setSoundBlocked(true);
      return;
    }
    setSoundBlocked(false);
    setSoundEnabled(true);
    window.localStorage.setItem(KITCHEN_SOUND_KEY, "1");
    // Если уже есть необработанные новые заказы — один рабочий сигнал сразу.
    playKitchenBeep();
    lastBeepRef.current = Date.now();
    announcedRef.current = [...reviewIdsRef.current];
  };

  const handleDisableSound = () => {
    disableKitchenSound();
    setSoundEnabled(false);
    window.localStorage.setItem(KITCHEN_SOUND_KEY, "0");
  };

  return (
    <div className={flowStyles.kitchenScreen}>
      <header className={flowStyles.kitchenHeader}>
        <div>
          <h1>Кухня: {restaurant?.name ?? "—"}</h1>
          <div className={flowStyles.kitchenSoundControls}>
            {!soundEnabled ? (
              <button
                className={flowStyles.secondaryButton}
                type="button"
                onClick={handleEnableSound}
              >
                Включить звук
              </button>
            ) : (
              <>
                <span className={flowStyles.kitchenSoundOn}>Звук включён</span>
                <button
                  className={flowStyles.secondaryButton}
                  type="button"
                  onClick={() => playKitchenBeep()}
                >
                  Проверить звук
                </button>
                <button
                  className={flowStyles.secondaryButton}
                  type="button"
                  onClick={handleDisableSound}
                >
                  Выключить звук
                </button>
              </>
            )}
            {soundBlocked ? (
              <span className={flowStyles.summaryHint}>
                Браузер заблокировал звук. Нажмите «Включить звук» ещё раз.
              </span>
            ) : null}
          </div>
        </div>
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
                    <div className={flowStyles.inlineMeta}>
                      <span>Оплата: {paymentStatusLabels[order.paymentStatus]}</span>
                    </div>
                    <KitchenItems order={order} />
                    <p className={flowStyles.kitchenUnits}>
                      Всего единиц: {totalUnits(order)}
                    </p>
                    <p className={flowStyles.kitchenUnits}>
                      Приготовление после оплаты: {order.preparationMinutes ?? "—"}{" "}
                      мин
                    </p>
                    <p className={flowStyles.summaryHint}>
                      Приготовление начнётся после подтверждения оплаты.
                    </p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {pendingRequests.length > 0 ? (
            <p className={flowStyles.kitchenCancelSummary} role="status">
              Запросы на отмену — {pendingRequests.length}
            </p>
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
                  <NewOrderCard order={order} nowMs={nowMs} key={order.id} />
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
                  <PreparingCard
                    order={order}
                    nowMs={nowMs}
                    timeZone={restaurant?.timeZone ?? "Europe/Chisinau"}
                    key={order.id}
                  />
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
