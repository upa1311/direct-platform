"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, BellRing } from "lucide-react";

import kds from "@/components/kitchen/kitchen.module.css";
import {
  EtaAdjustPanel,
  MenuAvailabilitySection,
  RestaurantPauseControl,
} from "@/components/kitchen/kitchen-operations";
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
  formatKitchenCountdown,
  getAudibleKitchenReviewOrders,
  getCancellationRequestForOrder,
  getKitchenAwaitingPaymentOrders,
  getKitchenNewOrders,
  getKitchenPreparingOrders,
  getKitchenReadyOrders,
  getOrderReadySince,
  getOrderStatusSince,
  getKitchenAcceptanceState,
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
    <div className={kds.cancelNotice} role="status">
      <span className={kds.cancelBadge}>Запрос на отмену</span>
      <p>
        Клиент запросил отмену. Администратор Direct рассматривает запрос. До
        решения продолжайте выполнение заказа.
      </p>
      <p className={kds.subtle}>Причина клиента: {request.reason}</p>
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

/** Часы HH:MM ожидаемой готовности в часовом поясе ресторана. */
function etaClock(iso: string | null, timeZone: string): string {
  if (!iso) return "не задана";
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timeZone || "Europe/Chisinau",
  }).format(new Date(iso));
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
    <ul className={kds.items}>
      {order.items.map((item) => (
        <li key={`${item.menuItemId}-${item.selectedVariantId ?? "base"}`}>
          <span className={kds.itemLine}>
            {item.name}
            {item.selectedVariantName ? ` · ${item.selectedVariantName}` : ""} ×{" "}
            {item.quantity}
          </span>
          {item.cookingComment ? (
            <span className={kds.itemComment}>
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
    <div className={kds.cardHead}>
      <div>
        <h3 className={kds.orderNumber}>{order.publicNumber}</h3>
        <div className={kds.cardMeta}>
          <span>{kitchenDeliveryLabel(order.deliveryMode)}</span>
          <span>Оплата: {paymentStatusLabels[order.paymentStatus]}</span>
        </div>
      </div>
      <span className={kds.badge}>
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
      className={`${kds.card} ${autoClose.needsAttention ? kds.cardAttention : ""}`}
    >
      <KitchenCardHead
        order={order}
        waitingLabel="Ждёт"
        sinceIso={getOrderStatusSince(order, "RESTAURANT_REVIEW")}
        nowMs={nowMs}
      />
      {autoClose.needsAttention ? (
        <span className={kds.attentionBadge}>Требуется реакция</span>
      ) : null}
      <KitchenItems order={order} />
      <p className={kds.units}>Всего единиц: {totalUnits(order)}</p>
      <div
        className={`${kds.countdown} ${autoClose.urgent ? kds.countdownOverdue : ""}`}
      >
        {autoClose.text}
      </div>

      {!rejectOpen ? (
        <div className={kds.panel}>
          <label className={kds.field}>
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
          <div className={kds.btnRow}>
            <button
              className={`${kds.btn} ${kds.btnDark}`}
              type="button"
              onClick={() => acceptOrder(order.id, prep)}
            >
              Принять
            </button>
            <button
              className={`${kds.btn} ${kds.btnRedOutline}`}
              type="button"
              onClick={() => setRejectOpen(true)}
            >
              Отклонить
            </button>
          </div>
        </div>
      ) : (
        <div className={kds.dialog} role="group" aria-label="Отклонение заказа">
          <h4 className={kds.dialogTitle}>Причина отклонения</h4>
          <fieldset className={kds.reasonList}>
            {REJECT_REASONS.map((r) => (
              <label className={kds.reasonOption} key={r}>
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
            <label className={kds.field}>
              <span>Ваша причина</span>
              <textarea
                value={customReason}
                onChange={(event) => setCustomReason(event.target.value)}
                placeholder="Опишите причину"
              />
            </label>
          ) : null}
          <div className={kds.btnRowEnd}>
            <button
              className={`${kds.btn} ${kds.btnOutline}`}
              type="button"
              onClick={() => setRejectOpen(false)}
            >
              Не отклонять
            </button>
            <button
              className={`${kds.btn} ${kds.btnRedOutline}`}
              type="button"
              disabled={!effectiveReason.trim()}
              onClick={() => rejectOrder(order.id, effectiveReason)}
            >
              Подтвердить отклонение
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
  const restaurant = getRestaurant(state, order.restaurant.id);
  const countdown = formatKitchenCountdown(order.expectedReadyAt, nowMs);
  const request = getCancellationRequestForOrder(state, order.id);
  const [etaOpen, setEtaOpen] = useState(false);
  const [etaConfirm, setEtaConfirm] = useState(false);
  const lastEta = order.etaAdjustments.at(-1) ?? null;
  const readyLabel =
    order.deliveryMode === "PICKUP"
      ? "Готово к выдаче"
      : order.deliveryMode === "RESTAURANT_DELIVERY"
        ? "Готово"
        : "Готово и упаковано";

  return (
    <article
      className={`${kds.card} ${countdown.overdue ? kds.cardDelayed : ""}`}
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
        <span className={kds.delayBadge}>Задержка</span>
      ) : null}
      <KitchenItems order={order} />
      <p className={kds.units}>Всего единиц: {totalUnits(order)}</p>
      <div className={kds.metaLine}>
        Первоначальная оценка: {order.preparationMinutes ?? "—"} мин
      </div>
      <p className={kds.units}>
        Текущая ожидаемая готовность: {etaClock(order.expectedReadyAt, timeZone)}
      </p>
      {lastEta ? (
        <div className={kds.metaLine}>
          <span className={kds.badge}>Время обновлено</span> {lastEta.reason}
        </div>
      ) : null}
      <div
        className={`${kds.countdown} ${countdown.overdue ? kds.countdownOverdue : ""}`}
      >
        {countdown.overdue ? countdown.text : `До готовности: ${countdown.text}`}
      </div>
      <div className={kds.btnRow}>
        <button
          className={`${kds.btn} ${kds.btnGreen}`}
          type="button"
          onClick={() => markReady(order.id)}
        >
          {readyLabel}
        </button>
        <button
          className={`${kds.btn} ${kds.btnOutline}`}
          type="button"
          onClick={() => {
            setEtaOpen((v) => !v);
            setEtaConfirm(false);
          }}
        >
          Изменить время
        </button>
      </div>
      {etaOpen && restaurant ? (
        <EtaAdjustPanel
          order={order}
          restaurant={restaurant}
          onDone={(success) => {
            setEtaOpen(false);
            if (success) setEtaConfirm(true);
          }}
        />
      ) : null}
      {etaConfirm ? (
        <p className={kds.units}>Ожидаемое время готовности обновлено.</p>
      ) : null}
      {etaConfirm && order.assignedDriverId ? (
        <p className={kds.metaLine}>
          Водитель уже назначен. Администратор Direct увидит обновлённое время.
        </p>
      ) : null}
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
    <article className={kds.card}>
      <div className={kds.cardHead}>
        <div>
          <h3 className={kds.orderNumber}>{order.publicNumber}</h3>
          <div className={kds.cardMeta}>
            <span>{kitchenDeliveryLabel(order.deliveryMode)}</span>
          </div>
        </div>
        <span className={kds.badge}>{waitingFor}</span>
      </div>
      {request?.status === "PENDING" ? (
        <CancellationRequestNotice request={request} />
      ) : null}
      <div className={kds.metaLine}>
        Оплата: {paymentStatusLabels[order.paymentStatus]}
      </div>
      <KitchenItems order={order} />
      <p className={kds.units}>Всего единиц: {totalUnits(order)}</p>
      <p className={kds.subtle}>
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
  // Единое состояние приёма для toolbar (тот же helper, что и в pause-контроле).
  const acceptanceState = restaurant
    ? getKitchenAcceptanceState(restaurant, nowMs)
    : null;
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
  // карточку. Синхронизируем после рендера, читаем из общего тика.
  const stateRef = useRef(state);
  const restaurantIdRef = useRef(selectedRestaurantId);
  const soundEnabledRef = useRef(false);
  const lastBeepRef = useRef<number | null>(null);
  const announcedRef = useRef<string[]>([]);

  useEffect(() => {
    stateRef.current = state;
    restaurantIdRef.current = selectedRestaurantId;
    soundEnabledRef.current = soundEnabled;
  }, [state, selectedRestaurantId, soundEnabled]);

  useEffect(() => {
    // Единый тик кухни: часы + централизованное расписание звука (§2, §19).
    const tick = () => {
      setNowMs(Date.now());
      // Звучат только заказы моложе 7 минут выбранного ресторана (§2).
      const audibleIds = getAudibleKitchenReviewOrders(
        stateRef.current,
        restaurantIdRef.current,
        Date.now(),
      ).map((order) => order.id);
      if (audibleIds.length === 0) {
        // Нет звучащих заказов — сбрасываем расписание для мгновенного сигнала.
        lastBeepRef.current = null;
        announcedRef.current = [];
        return;
      }
      if (!soundEnabledRef.current) return;
      const due = isKitchenBeepDue({
        reviewOrderIds: audibleIds,
        announcedOrderIds: announcedRef.current,
        lastBeepAtMs: lastBeepRef.current,
        nowMs: Date.now(),
      });
      if (due) {
        playKitchenBeep();
        lastBeepRef.current = Date.now();
        announcedRef.current = [...audibleIds];
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
    // Если уже есть звучащие новые заказы — один рабочий сигнал сразу.
    const audibleIds = getAudibleKitchenReviewOrders(
      state,
      selectedRestaurantId,
      Date.now(),
    ).map((order) => order.id);
    playKitchenBeep();
    lastBeepRef.current = Date.now();
    announcedRef.current = audibleIds;
  };

  const handleDisableSound = () => {
    disableKitchenSound();
    setSoundEnabled(false);
    window.localStorage.setItem(KITCHEN_SOUND_KEY, "0");
  };

  return (
    <div className={kds.screen}>
      <div className={kds.toolbar}>
        <div className={kds.toolbarLeft}>
          <span className={kds.brand}>Кухня</span>
          <span className={kds.restaurantName}>{restaurant?.name ?? "—"}</span>
        </div>
        <div className={kds.toolbarRight}>
          <span className={kds.statusChip}>
            <span
              className={`${kds.dot} ${
                acceptanceState === "ACCEPTING"
                  ? kds.dotOk
                  : acceptanceState === "OPERATIONAL_PAUSE"
                    ? kds.dotWarn
                    : kds.dotOff
              }`}
              aria-hidden="true"
            />
            {acceptanceState === "ACCEPTING"
              ? "Приём включён"
              : acceptanceState === "OPERATIONAL_PAUSE"
                ? "Приём на паузе"
                : "Приём отключён"}
          </span>
          <select
            className={kds.restaurantSelect}
            aria-label="Сменить ресторан"
            value={selectedRestaurantId}
            onChange={(event) => setSelectedRestaurantId(event.target.value)}
          >
            {workspaceRestaurants.map((r) => (
              <option value={r.id} key={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button
            className={`${kds.soundBtn} ${soundEnabled ? kds.soundBtnOn : ""}`}
            type="button"
            onClick={soundEnabled ? handleDisableSound : handleEnableSound}
            aria-label={soundEnabled ? "Выключить звук" : "Включить звук"}
            title={
              soundEnabled
                ? "Звук включён. Нажмите, чтобы выключить"
                : "Включить звук"
            }
          >
            {soundEnabled ? (
              <BellRing size={18} aria-hidden="true" />
            ) : (
              <Bell size={18} aria-hidden="true" />
            )}
            {soundEnabled ? (
              <span className={kds.soundDot} aria-hidden="true" />
            ) : null}
          </button>
        </div>
      </div>
      {soundBlocked ? (
        <p className={kds.soundError} role="alert">
          Браузер заблокировал звук. Нажмите значок звука ещё раз.
        </p>
      ) : null}

      {!isHydrated ? (
        <div className={kds.empty}>Загружаем кухню…</div>
      ) : (
        <>
          {restaurant ? (
            <RestaurantPauseControl restaurant={restaurant} nowMs={nowMs} />
          ) : null}
          {awaitingOrders.length > 0 ? (
            <section className={kds.awaiting}>
              <h2 className={kds.awaitingTitle}>
                Ожидают оплаты — {awaitingOrders.length}
              </h2>
              <div className={kds.awaitingList}>
                {awaitingOrders.map((order) => (
                  <article className={kds.awaitingCard} key={order.id}>
                    <div className={kds.cardHead}>
                      <h3 className={kds.orderNumber}>{order.publicNumber}</h3>
                      <span className={kds.badge}>
                        {kitchenDeliveryLabel(order.deliveryMode)}
                      </span>
                    </div>
                    <div className={kds.metaLine}>
                      Оплата: {paymentStatusLabels[order.paymentStatus]}
                    </div>
                    <KitchenItems order={order} />
                    <p className={kds.units}>Всего единиц: {totalUnits(order)}</p>
                    <p className={kds.units}>
                      Приготовление после оплаты:{" "}
                      {order.preparationMinutes ?? "—"} мин
                    </p>
                    <p className={kds.subtle}>
                      Приготовление начнётся после подтверждения оплаты.
                    </p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {pendingRequests.length > 0 ? (
            <p className={kds.cancelSummary} role="status">
              Запросы на отмену — {pendingRequests.length}
            </p>
          ) : null}

          <div className={kds.board}>
            <section className={kds.column}>
              <h2 className={kds.columnHead}>
                Новые <span>— {newOrders.length}</span>
              </h2>
              {newOrders.length === 0 ? (
                <div className={kds.empty}>Новых заказов нет.</div>
              ) : (
                newOrders.map((order) => (
                  <NewOrderCard order={order} nowMs={nowMs} key={order.id} />
                ))
              )}
            </section>

            <section className={kds.column}>
              <h2 className={kds.columnHead}>
                Готовятся <span>— {preparingOrders.length}</span>
              </h2>
              {preparingOrders.length === 0 ? (
                <div className={kds.empty}>Сейчас ничего не готовится.</div>
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

            <section className={kds.column}>
              <h2 className={kds.columnHead}>
                Готовы <span>— {readyOrders.length}</span>
              </h2>
              {readyOrders.length === 0 ? (
                <div className={kds.empty}>Готовых заказов пока нет.</div>
              ) : (
                readyOrders.map((order) => (
                  <ReadyCard order={order} nowMs={nowMs} key={order.id} />
                ))
              )}
            </section>
          </div>
          {restaurant ? (
            <MenuAvailabilitySection restaurant={restaurant} nowMs={nowMs} />
          ) : null}
        </>
      )}
    </div>
  );
}
