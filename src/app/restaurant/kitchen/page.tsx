"use client";

import { useEffect, useRef, useState } from "react";
import { BellOff, BellRing, TriangleAlert } from "lucide-react";

import kds from "@/components/kitchen/kitchen.module.css";
import { getVisibleCookingComment } from "@/components/kitchen/cooking-comment";
import {
  EtaAdjustPanel,
  MenuAvailabilitySection,
  RestaurantPauseControl,
} from "@/components/kitchen/kitchen-operations";
import { useMutationGuard } from "@/components/util/use-mutation-guard";
import { useRestaurantWorkspace } from "@/components/workspaces/restaurant-workspace";
import {
  disableKitchenSound,
  enableKitchenSound,
  KITCHEN_SOUND_KEY,
  playKitchenBeep,
} from "@/components/workspaces/kitchen-sound";
import { usePrototype } from "@/prototype/prototype-provider";
import type { MutationAck } from "@/prototype/prototype-store";
import {
  PREPARATION_PROBLEM_REASONS,
  RESTAURANT_RESPONSE_TIMEOUT_MS,
} from "@/prototype/actions";
import type {
  CancellationRequest,
  DeliveryMode,
  Order,
  PickupPaymentMethod,
} from "@/prototype/models";
import {
  formatClock24,
  formatKitchenCountdown,
  formatKitchenDuration,
  formatMoney,
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
  getPickupNoShowEligibleAtIso,
  getRestaurant,
  isKitchenBeepDue,
  isPickupNoShowEligibleAt,
  paymentStatusLabels,
  pickupPaymentMethodLabels,
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

/** Часы HH:MM ожидаемой готовности в часовом поясе ресторана (§4). */
function etaClock(iso: string | null, timeZone: string): string {
  if (!iso) return "не задана";
  return formatClock24(iso, timeZone || "Europe/Chisinau");
}

/** Сколько времени прошло с момента `fromIso` («32 мин», «1 ч 17 мин»). */
function formatElapsed(fromIso: string, nowMs: number): string {
  if (nowMs === 0) return "—";
  const diffMs = Math.max(0, nowMs - Date.parse(fromIso));
  const min = Math.floor(diffMs / 60_000);
  if (min >= 1) return formatKitchenDuration(min);
  const sec = Math.floor(diffMs / 1000);
  return `${sec} сек`;
}

/**
 * Компактная янтарная строка инструкции к позиции — прямо под блюдом. Показывается
 * только если после trim у cookingComment есть текст; сам текст выводится после
 * trim, но внутреннее содержимое пользователя не меняется. Треугольник —
 * «обратите внимание», не запрет и не ошибка (иконка декоративна, aria-hidden).
 */
function CookingCommentBlock({ comment }: { comment: string }) {
  const trimmed = getVisibleCookingComment(comment);
  if (!trimmed) return null;
  return (
    <div className={kds.itemComment}>
      <TriangleAlert
        className={kds.itemCommentIcon}
        size={16}
        aria-hidden="true"
      />
      <strong className={kds.itemCommentText}>{trimmed}</strong>
    </div>
  );
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
          <CookingCommentBlock comment={item.cookingComment ?? ""} />
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

/**
 * Этап 6/8: инлайновая панель «Не можем приготовить». Кухня сообщает оператору
 * о проблеме — статус, оплата и финансы НЕ меняются, заказ не отменяется.
 */
function PreparationProblemPanel({
  order,
  isSplit,
}: {
  order: Order;
  isSplit: boolean;
}) {
  const { reportPreparationProblem } = usePrototype();
  // Pending и защита от двойного нажатия — через общий thunk-guard; локального
  // error-state больше нет, единственный источник ошибки — mutationError.
  const { error: mutationError, pending, run, clearError } = useMutationGuard();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [sent, setSent] = useState(false);

  const isOther = reason === "Другая причина";
  const effectiveReason = isOther ? customReason : reason;

  const doReport = async () => {
    // Thunk: операция НЕ стартует до входа в guard, второй клик в том же tick
    // не запускает вторую отправку. Доменный результат приводится к MutationAck.
    const res = await run(async () => {
      const r = await reportPreparationProblem(
        order.id,
        effectiveReason,
        "RESTAURANT",
        "KITCHEN",
      );
      return { ok: r.ok, error: r.error, changed: r.ok };
    });
    // Панель закрывается и показывает спокойное подтверждение только при успехе;
    // при ошибке остаётся открытой с сохранённой причиной и одной ошибкой.
    if (res.ok) {
      setSent(true);
      setOpen(false);
    }
  };

  if (!open) {
    return (
      <>
        <button
          className={`${kds.btn} ${kds.btnRedOutline}`}
          type="button"
          onClick={() => {
            setOpen(true);
            setSent(false);
          }}
        >
          Не можем приготовить
        </button>
        {sent ? (
          <p className={kds.units} role="status">
            {isSplit
              ? "Сообщение о проблеме отправлено оператору."
              : "Проблема приготовления сохранена."}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className={kds.dialog} role="group" aria-label="Проблема приготовления">
      <h4 className={kds.dialogTitle}>Что случилось?</h4>
      <fieldset className={kds.reasonList}>
        {PREPARATION_PROBLEM_REASONS.map((r) => (
          <label className={kds.reasonOption} key={r}>
            <input
              type="radio"
              name={`problem-${order.id}`}
              checked={reason === r}
              disabled={pending}
              onChange={() => {
                setReason(r);
                clearError();
              }}
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
            disabled={pending}
            onChange={(event) => {
              setCustomReason(event.target.value);
              clearError();
            }}
            placeholder="Опишите проблему"
          />
        </label>
      ) : null}
      <p className={kds.pickupAdminHint}>
        {isSplit
          ? "Заказ не отменяется: оператор увидит сообщение и решит, что делать."
          : "Заказ не отменяется автоматически. Выберите дальнейшее действие в общем экране."}
      </p>
      {mutationError ? (
        <p className={kds.pickupError} role="alert">
          {mutationError}
        </p>
      ) : null}
      <div className={kds.btnRowEnd}>
        <button
          className={`${kds.btn} ${kds.btnOutline}`}
          type="button"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Отмена
        </button>
        <button
          className={`${kds.btn} ${kds.btnRedOutline}`}
          type="button"
          disabled={!effectiveReason.trim() || pending}
          onClick={doReport}
        >
          {pending
            ? "Отправляем…"
            : isSplit
              ? "Сообщить оператору"
              : "Зафиксировать проблему"}
        </button>
      </div>
    </div>
  );
}

function NewOrderCard({
  order,
  nowMs,
  isSplit,
}: {
  order: Order;
  nowMs: number;
  isSplit: boolean;
}) {
  const { state, acceptOrder, rejectOrder } = usePrototype();
  // Приём и отклонение — взаимоисключающие решения по одному заказу, поэтому у
  // них ОДИН общий guard: его синхронный pending-флаг не даёт запустить второе
  // решение (в том числе «Принять → Отклонить» в одном tick), пока идёт первое.
  const {
    error: decisionError,
    pending: decisionPending,
    run: runDecision,
    clearError: clearDecisionError,
  } = useMutationGuard();
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

  // Исправление 4.3: сериализованный приём (Web Lock + rebase). При гонке
  // показывается русская ошибка, карточка и выбранное время сохраняются,
  // ложный успех не показывается — после успеха карточка уходит из «Новых»
  // через обновлённый общий state.
  const doAccept = async () => {
    await runDecision(async () => {
      const response = await acceptOrder(
        order.id,
        prep,
        "RESTAURANT",
        "KITCHEN",
      );
      return {
        ok: response.ok,
        error: response.error,
        changed: response.ok,
      };
    });
  };

  // Исправление 8: отклонение в COMBINED идёт через тот же guard; форма не
  // закрывается ложно, причина при ошибке сохраняется.
  const doReject = async () => {
    if (!effectiveReason.trim()) return;
    const result = await runDecision(async () => {
      const response = await rejectOrder(
        order.id,
        effectiveReason,
        "RESTAURANT",
      );
      return {
        ok: response.ok,
        error: response.error,
        changed: response.ok,
      };
    });
    if (result.ok) {
      setRejectOpen(false);
    }
  };

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
          <label className={`${kds.field} ${kds.preparationField}`}>
            <span>Время приготовления</span>
            <select
              value={prep}
              disabled={decisionPending}
              onChange={(event) => {
                setPrep(Number(event.target.value));
                clearDecisionError();
              }}
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
              disabled={decisionPending}
              onClick={doAccept}
            >
              {decisionPending ? "Принимаем…" : "Принять"}
            </button>
            {/* Этап 8: в SPLIT кухня не отклоняет заказ (это отмена — зона
                оператора), а сообщает о проблеме приготовления. */}
            {isSplit ? (
              <PreparationProblemPanel order={order} isSplit={isSplit} />
            ) : (
              <button
                className={`${kds.btn} ${kds.btnRedOutline}`}
                type="button"
                disabled={decisionPending}
                onClick={() => {
                  setRejectOpen(true);
                  clearDecisionError();
                }}
              >
                Отклонить
              </button>
            )}
          </div>
          {decisionError ? (
            <p className={kds.pickupError} role="alert">
              {decisionError}
            </p>
          ) : null}
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
                  disabled={decisionPending}
                  onChange={() => {
                    setReason(r);
                    clearDecisionError();
                  }}
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
                disabled={decisionPending}
                onChange={(event) => {
                  setCustomReason(event.target.value);
                  clearDecisionError();
                }}
                placeholder="Опишите причину"
              />
            </label>
          ) : null}
          <div className={kds.btnRowEnd}>
            <button
              className={`${kds.btn} ${kds.btnOutline}`}
              type="button"
              disabled={decisionPending}
              onClick={() => {
                setRejectOpen(false);
                clearDecisionError();
              }}
            >
              Не отклонять
            </button>
            <button
              className={`${kds.btn} ${kds.btnRedOutline}`}
              type="button"
              disabled={!effectiveReason.trim() || decisionPending}
              onClick={doReject}
            >
              {decisionPending ? "Отклоняем…" : "Подтвердить отклонение"}
            </button>
          </div>
          {decisionError ? (
            <p className={kds.pickupError} role="alert">
              {decisionError}
            </p>
          ) : null}
        </div>
      )}
    </article>
  );
}

function PreparingCard({
  order,
  nowMs,
  timeZone,
  isSplit,
}: {
  order: Order;
  nowMs: number;
  timeZone: string;
  isSplit: boolean;
}) {
  const { state, markReady } = usePrototype();
  // Исправление 7: готовность — await с pending и русской ошибкой (гонка двух
  // экранов, устаревший статус, отказ хранилища не проходят молча).
  const {
    error: readyError,
    pending: readyPending,
    run: runReady,
  } = useMutationGuard();
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
      <p className={kds.units}>
        Ожидаемая готовность: к {etaClock(order.expectedReadyAt, timeZone)}
      </p>
      <div className={kds.metaLine}>
        Первоначальная оценка: {order.preparationMinutes ?? "—"} мин
      </div>
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
      <div className={kds.changeTimeRow}>
        <button
          className={`${kds.btn} ${kds.btnOutline} ${kds.changeTimeButton}`}
          type="button"
          onClick={() => {
            setEtaOpen((v) => !v);
            setEtaConfirm(false);
          }}
        >
          Изменить время
        </button>
      </div>
      <div className={kds.btnRow}>
        <button
          className={`${kds.btn} ${kds.btnGreen}`}
          type="button"
          disabled={readyPending}
          onClick={() =>
            void runReady(() => markReady(order.id, "RESTAURANT", "KITCHEN"))
          }
        >
          {readyPending ? "Сохраняем…" : readyLabel}
        </button>
      </div>
      {readyError ? (
        <p className={kds.pickupError} role="alert">
          {readyError}
        </p>
      ) : null}
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
      {/* Этап 6: кухня может сообщить о проблеме и во время приготовления. */}
      <PreparationProblemPanel order={order} isSplit={isSplit} />
    </article>
  );
}

/** §1: типовые причины невыкупа для кухни (последняя — свободный ввод). */
const PICKUP_NO_SHOW_REASONS = [
  "Не удалось связаться с клиентом",
  "Клиент отказался от заказа",
  "Клиент сообщил, что не придёт",
  "Клиент не пришёл в течение времени ожидания",
  "Другая причина",
] as const;
const PICKUP_NO_SHOW_OTHER = "Другая причина";

/** Минут до `targetIso` (0 — если наступило); null — нет данных/часов. */
function minutesUntil(targetIso: string | null, nowMs: number): number | null {
  if (!targetIso || nowMs === 0) return null;
  const diff = Date.parse(targetIso) - nowMs;
  return diff <= 0 ? 0 : Math.ceil(diff / 60_000);
}

/**
 * §1: инлайновая KDS-панель невыкупа. Открывается только с eligibleAt (30 минут
 * после реальной готовности). Причина из списка либо свободный текст (≤300).
 * Никаких prompt/alert/confirm/модалок. Ошибка домена не закрывает панель и не
 * стирает причину; ложный success не показывается.
 */
function KitchenPickupNoShow({
  order,
  nowMs,
  pending,
  isRunning,
  error,
  onConfirmNoShow,
  onClearError,
}: {
  order: Order;
  nowMs: number;
  /** Идёт любая pickup-операция (выдача или невыкуп) — контролы блокируются. */
  pending: boolean;
  /** Идёт именно невыкуп — только тогда кнопка показывает «Закрываем…». */
  isRunning: boolean;
  error: string | null;
  onConfirmNoShow: (reason: string) => Promise<MutationAck>;
  onClearError: () => void;
}) {
  const eligibleAtIso = getPickupNoShowEligibleAtIso(order);
  const nowIso = nowMs > 0 ? new Date(nowMs).toISOString() : null;
  const eligible = nowIso ? isPickupNoShowEligibleAt(order, nowIso) : false;
  const minutesLeft = minutesUntil(eligibleAtIso, nowMs);

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");

  const isOther = reason === PICKUP_NO_SHOW_OTHER;
  const effectiveReason = isOther ? customReason : reason;
  const canConfirm = effectiveReason.trim().length > 0;

  const doConfirm = async () => {
    // Кнопка disabled без причины — защитный ранний выход. Невыкуп запускается
    // общим guard родителя: при ошибке панель остаётся открытой с причиной,
    // при успехе карточка уходит через подтверждённый общий state.
    if (!canConfirm) return;
    await onConfirmNoShow(effectiveReason);
  };

  if (!open) {
    return (
      <button
        className={`${kds.btn} ${kds.btnRedOutline}`}
        type="button"
        disabled={!eligible || pending}
        onClick={() => {
          setOpen(true);
          onClearError();
        }}
      >
        {eligible
          ? "Клиент не пришёл"
          : minutesLeft !== null
            ? `Невыкуп можно отметить через ${minutesLeft} мин`
            : "Невыкуп пока недоступен"}
      </button>
    );
  }

  return (
    <div className={kds.dialog} role="group" aria-label="Невыкуп заказа">
      <h4 className={kds.dialogTitle}>Причина невыкупа</h4>
      <fieldset className={kds.reasonList}>
        {PICKUP_NO_SHOW_REASONS.map((r) => (
          <label className={kds.reasonOption} key={r}>
            <input
              type="radio"
              name={`no-show-${order.id}`}
              checked={reason === r}
              disabled={pending}
              onChange={() => {
                setReason(r);
                onClearError();
              }}
            />
            <span>{r}</span>
          </label>
        ))}
      </fieldset>
      {isOther ? (
        <label className={kds.field}>
          <span>Ваша причина</span>
          <textarea
            maxLength={300}
            value={customReason}
            disabled={pending}
            onChange={(event) => {
              setCustomReason(event.target.value);
              onClearError();
            }}
            placeholder="Опишите причину"
          />
        </label>
      ) : null}
      <p className={kds.pickupInstruction}>
        Заказ будет отменён без фиксации оплаты и без начисления комиссии Direct.
      </p>
      {error ? (
        <p className={kds.pickupError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={kds.btnRowEnd}>
        <button
          className={`${kds.btn} ${kds.btnOutline}`}
          type="button"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            onClearError();
          }}
        >
          Отмена
        </button>
        <button
          className={`${kds.btn} ${kds.btnRedOutline}`}
          type="button"
          disabled={!canConfirm || pending}
          onClick={doConfirm}
        >
          {isRunning ? "Закрываем…" : "Закрыть как невыкуп"}
        </button>
      </div>
    </div>
  );
}

/**
 * §8: инлайновая выдача самовывоза на кухне. Способ оплаты (радио, авто-выбор
 * при одном), ввод названного клиентом четырёхзначного кода (только цифры),
 * подтверждение одним доменным действием. Код клиента здесь НЕ отображается.
 * Ошибка не закрывает панель и не стирает код; успех убирает карточку (статус
 * заказа меняется на PICKED_UP). Рядом — инлайновый невыкуп (§1).
 */
function KitchenPickupHandoff({
  order,
  nowMs,
}: {
  order: Order;
  nowMs: number;
}) {
  const { completePickup, markPickupNoShow } = usePrototype();
  // Выдача и невыкуп — два взаимоисключающих ФИНАЛЬНЫХ решения по одному заказу,
  // поэтому оба идут через ОДИН общий guard: его синхронный pending-флаг не даёт
  // второму действию стартовать (в том числе «Выдать → Невыкуп» в одном tick).
  // pickupActionKind нужен ТОЛЬКО для UI: текст pending и адресация ошибки.
  const {
    error: pickupActionError,
    pending: pickupActionPending,
    run: runPickupAction,
    clearError: clearPickupActionError,
  } = useMutationGuard();
  const [pickupActionKind, setPickupActionKind] = useState<
    "HANDOFF" | "NO_SHOW" | null
  >(null);
  const methods = order.pickupPaymentMethodsSnapshot;
  const single = methods.length === 1 ? methods[0] : null;
  const [paidWith, setPaidWith] = useState<PickupPaymentMethod | null>(single);
  const [code, setCode] = useState("");

  const codeValid = /^\d{4}$/.test(code.trim());
  const canConfirm = codeValid && paidWith !== null;
  // Одна общая ошибка показывается только около того действия, что упало.
  const handoffError =
    pickupActionKind === "HANDOFF" ? pickupActionError : null;
  const noShowError = pickupActionKind === "NO_SHOW" ? pickupActionError : null;

  const doConfirm = async () => {
    // Кнопка disabled при !canConfirm — здесь только сужение типа paidWith.
    if (!paidWith) return;
    // Thunk: операция НЕ стартует до входа в guard, второй клик в том же tick
    // не запускает вторую выдачу. Доменный результат приводится к MutationAck
    // (успешная выдача всегда меняет state). При успехе карточка исчезнет из
    // раздела готовых через подтверждённый общий state — вручную ничего не чистим.
    await runPickupAction(async () => {
      setPickupActionKind("HANDOFF");
      const res = await completePickup(
        order.id,
        code,
        paidWith,
        "RESTAURANT",
        "KITCHEN",
      );
      return { ok: res.ok, error: res.error, changed: res.ok };
    });
  };

  // Невыкуп проходит через ТОТ ЖЕ guard; собственного guard у панели нет.
  const runNoShow = (reason: string) =>
    runPickupAction(async () => {
      setPickupActionKind("NO_SHOW");
      const res = await markPickupNoShow(
        order.id,
        reason,
        "RESTAURANT",
        "KITCHEN",
      );
      return { ok: res.ok, error: res.error, changed: res.ok };
    });

  return (
    <div className={kds.pickupHandoff}>
      <p className={kds.pickupAmount}>
        К оплате: {formatMoney(order.financials.customerTotalCents)}
      </p>
      <fieldset className={kds.pickupMethods}>
        <legend>Способ оплаты на точке</legend>
        {methods.length === 0 ? (
          <span>Способы оплаты не заданы.</span>
        ) : (
          methods.map((method) => (
            <label key={method} className={kds.pickupMethodOption}>
              <input
                type="radio"
                name={`kds-pay-${order.id}`}
                value={method}
                checked={paidWith === method}
                disabled={pickupActionPending}
                onChange={() => {
                  setPaidWith(method);
                  clearPickupActionError();
                }}
              />
              <span>{pickupPaymentMethodLabels[method]}</span>
            </label>
          ))
        )}
      </fieldset>
      <label className={kds.field}>
        <span>Код клиента</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={4}
          value={code}
          placeholder="4 цифры"
          disabled={pickupActionPending}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, "").slice(0, 4));
            clearPickupActionError();
          }}
        />
      </label>
      <p className={kds.pickupInstruction}>
        Попросите клиента назвать четырёхзначный код.
      </p>
      {handoffError ? (
        <p className={kds.pickupError} role="alert">
          {handoffError}
        </p>
      ) : null}
      <button
        className={`${kds.btn} ${kds.btnGreen}`}
        type="button"
        disabled={!canConfirm || pickupActionPending}
        onClick={doConfirm}
      >
        {pickupActionPending && pickupActionKind === "HANDOFF"
          ? "Подтверждаем…"
          : "Подтвердить оплату и выдать"}
      </button>
      <p className={kds.pickupAdminHint}>
        Нет кода клиента? Обратитесь к администратору Direct.
      </p>
      <KitchenPickupNoShow
        order={order}
        nowMs={nowMs}
        pending={pickupActionPending}
        isRunning={pickupActionPending && pickupActionKind === "NO_SHOW"}
        error={noShowError}
        onConfirmNoShow={runNoShow}
        onClearError={clearPickupActionError}
      />
    </div>
  );
}

function ReadyCard({
  order,
  nowMs,
  isSplit,
}: {
  order: Order;
  nowMs: number;
  isSplit: boolean;
}) {
  const { state } = usePrototype();
  const request = getCancellationRequestForOrder(state, order.id);
  const isPickup = order.status === "READY_FOR_PICKUP";
  const waitingFor = isPickup
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
      {/* Этап 8: в SPLIT кухня не видит имя/телефон клиента. */}
      {isPickup && !isSplit ? (
        <div className={kds.metaLine}>
          Клиент: {order.customer.name || "—"}
          {order.customer.phone ? ` · ${order.customer.phone}` : ""}
        </div>
      ) : null}
      <div className={kds.metaLine}>
        Оплата: {paymentStatusLabels[order.paymentStatus]}
      </div>
      <KitchenItems order={order} />
      <p className={kds.units}>Всего единиц: {totalUnits(order)}</p>
      <p className={kds.subtle}>
        Готов {formatElapsed(getOrderReadySince(order), nowMs)} назад
      </p>
      {/* Этап 8: выдачу в SPLIT выполняет оператор — кухня без формы и кода. */}
      {isPickup && isSplit ? (
        <p className={kds.pickupAdminHint}>
          Заказ готов. Выдачу выполняет оператор.
        </p>
      ) : null}
      {isPickup && !isSplit ? (
        <KitchenPickupHandoff order={order} nowMs={nowMs} />
      ) : null}
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
  // Этап 8: в SPLIT кухня не видит приватные данные и не выполняет выдачу.
  const isSplit = restaurant?.orderWorkflowMode === "SPLIT_OPERATOR_KITCHEN";
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
            {/* Выключенный звук — перечёркнутый колокольчик (BellOff), чтобы
                состояние читалось с одного взгляда; включённый — BellRing. */}
            {soundEnabled ? (
              <BellRing size={18} aria-hidden="true" />
            ) : (
              <BellOff size={18} aria-hidden="true" />
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
                  <NewOrderCard order={order} nowMs={nowMs} isSplit={isSplit} key={order.id} />
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
                    isSplit={isSplit}
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
                  <ReadyCard order={order} nowMs={nowMs} isSplit={isSplit} key={order.id} />
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
