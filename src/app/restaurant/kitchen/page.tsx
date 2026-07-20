"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import kds from "@/components/kitchen/kitchen.module.css";
import { getVisibleCookingComment } from "@/components/kitchen/cooking-comment";
import { formatMenuPortion } from "@/prototype/menu-catalog";
import { HighValueCashOrderWarning } from "@/components/kitchen/high-value-cash-order-warning";
import { useKitchenProductionTicketPrint } from "@/components/kitchen/kitchen-production-ticket-print";
import { OperatorPackageLabelPrintButton } from "@/components/operator/operator-package-label-print";
import {
  defaultPrep,
  formatAutoClose,
  PREP_OPTIONS,
} from "@/components/kitchen/new-order-decision";
import {
  COMBINED_ORDERS_LABEL,
  SPLIT_KITCHEN_LABEL,
} from "@/components/workspaces/restaurant-nav";
import {
  NewOrderSoundButton,
  useNewOrderSound,
} from "@/components/kitchen/new-order-sound";
import { SOUND_ACTIVATION_MESSAGE } from "@/components/kitchen/sound-preference";
import { useSplitKitchenPreparingSound } from "@/components/kitchen/use-split-kitchen-preparing-sound";
import { PreparationProblemResolveBlock } from "@/components/kitchen/preparation-problem-resolve";
import {
  EtaAdjustPanel,
  RestaurantPauseControl,
} from "@/components/kitchen/kitchen-operations";
import { RestaurantMenuAvailabilityPanel } from "@/components/kitchen/restaurant-menu-availability-panel";
import { useMutationGuard } from "@/components/util/use-mutation-guard";
import { useRestaurantWorkspace } from "@/components/workspaces/restaurant-workspace";
import { usePrototype } from "@/prototype/prototype-provider";
import type { MutationAck } from "@/prototype/prototype-store";
import { PREPARATION_PROBLEM_REASONS } from "@/prototype/actions";
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
  getCancellationRequester,
  getCancellationRequestForOrder,
  getKitchenAwaitingPaymentOrders,
  getKitchenNewOrders,
  getKitchenPendingStartOrders,
  getKitchenPreparingOrders,
  getKitchenReadyOrders,
  getLatestResolvedPreparationProblem,
  getOpenPreparationProblem,
  getRestaurantCancellationUiState,
  getOrderReadySince,
  getOrderStatusSince,
  getPickupNoShowEligibleAtIso,
  getPickupPaymentChoices,
  getRestaurant,
  isPickupNoShowEligibleAt,
  paymentStatusLabels,
  pickupPaymentMethodLabels,
} from "@/prototype/selectors";

/** Заметный блок уведомления кухни о запросе клиента на отмену (§11). */
function CancellationRequestNotice({
  request,
}: {
  request: CancellationRequest;
}) {
  // Только клиентский/legacy запрос: статус ресторанного запроса уже выводится в
  // PreparationProblemPanel, второй одинаковый блок кухне не показываем.
  if (getCancellationRequester(request) !== "CLIENT") {
    return null;
  }
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
            {item.selectedVariantName ? ` · ${item.selectedVariantName}` : ""}
            {formatMenuPortion(item.portionSnapshot ?? null)
              ? ` · ${formatMenuPortion(item.portionSnapshot ?? null)}`
              : ""}{" "}
            × {item.quantity}
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
  const { state, reportPreparationProblem } = usePrototype();
  // Pending и защита от двойного нажатия — через общий thunk-guard; локального
  // error-state больше нет, единственный источник ошибки — mutationError.
  const { error: mutationError, pending, run, clearError } = useMutationGuard();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");

  // Источник истины — общий state, а не локальный флаг: OPEN/RESOLVED видны и в
  // другой вкладке без reload.
  const openProblem = getOpenPreparationProblem(order);
  const latestResolved = getLatestResolvedPreparationProblem(order);

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
    // При успехе форма закрывается; активный OPEN-статус ниже показывается уже
    // из общего state. При ошибке форма остаётся с сохранённой причиной.
    if (res.ok) setOpen(false);
  };

  // Пока проблема открыта, повторной кнопки нет: вторую проблему поверх
  // нерешённой отправить нельзя. В SPLIT решение — зона оператора, кухня видит
  // компактный статус. В COMBINED тот же общий экран «Заказы» решает проблему
  // сам — показываем форму подтверждения.
  if (openProblem) {
    if (isSplit) {
      // Кухня видит только статус без приватных данных и без причины решения
      // администратора: различаем «ждём оператора» / «оператор запросил отмену» /
      // «Direct отклонил отмену». Источник — общий state.
      const request = getCancellationRequestForOrder(state, order.id);
      const cancelState = getRestaurantCancellationUiState(
        request,
        openProblem.problemId,
      );
      let statusText = "Проблема передана оператору. Ожидается решение.";
      if (cancelState === "PENDING") {
        statusText =
          "Оператор запросил отмену у Direct. Ожидается решение администратора.";
      } else if (cancelState === "REJECTED") {
        statusText = "Direct отклонил отмену. Оператор решает, как продолжить заказ.";
      }
      return (
        <p className={kds.units} role="status">
          {statusText}
        </p>
      );
    }
    return (
      <PreparationProblemResolveBlock order={order} workspaceRole="COMBINED" />
    );
  }

  if (!open) {
    return (
      <>
        <button
          className={`${kds.btn} ${kds.btnRedOutline}`}
          type="button"
          onClick={() => setOpen(true)}
        >
          Не можем приготовить
        </button>
        {/* После решения оператором — спокойное подтверждение продолжения. */}
        {latestResolved ? (
          <p className={kds.units} role="status">
            Оператор подтвердил: проблема решена, заказ продолжается.
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
  onRequestPrint,
}: {
  order: Order;
  nowMs: number;
  isSplit: boolean;
  onRequestPrint: (orderId: string) => void;
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

  // «Принять и распечатать»: тот же приём и guard; печать открывается ТОЛЬКО
  // после подтверждённого успеха и по каноническим данным принятого заказа. При
  // ошибке приёма ничего не печатается.
  const doAcceptAndPrint = async () => {
    const result = await runDecision(async () => {
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
    if (result.ok) {
      onRequestPrint(order.id);
    }
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
      {/* Крупный заказ с оплатой при получении: подсказка позвонить клиенту.
          Только общий экран (COMBINED) — эта карточка в SPLIT не рендерится,
          но признак оставлен явно, чтобы кухня не получила предупреждение и
          телефон клиента ни при каких изменениях разметки. */}
      {isSplit ? null : <HighValueCashOrderWarning order={order} />}
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
            <button
              className={`${kds.btn} ${kds.btnOutline}`}
              type="button"
              disabled={decisionPending}
              onClick={doAcceptAndPrint}
            >
              Принять и распечатать
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

/**
 * SPLIT: карточка заказа, который оператор уже принял (и клиент оплатил, если
 * оплата онлайн), но кухня ещё не начала готовить. Приготовление не идёт,
 * поэтому здесь нет ни обратного отсчёта, ни задержки, ни ожидаемого времени,
 * ни готовности, ни корректировки ETA — только состав, оценка и старт.
 */
function KitchenPendingStartCard({ order }: { order: Order }) {
  const { startKitchenPreparation } = usePrototype();
  const {
    error: startError,
    pending: startPending,
    run: runStart,
  } = useMutationGuard();

  return (
    <article className={`${kds.card} ${kds.cardAttention}`}>
      <div className={kds.cardHead}>
        <div>
          <h3 className={kds.orderNumber}>{order.publicNumber}</h3>
          <div className={kds.cardMeta}>
            <span>{kitchenDeliveryLabel(order.deliveryMode)}</span>
          </div>
        </div>
        <span className={kds.attentionBadge}>Новый</span>
      </div>
      <p className={kds.units}>Заказ принят оператором и передан на кухню.</p>
      <KitchenItems order={order} />
      <p className={kds.units}>Всего единиц: {totalUnits(order)}</p>
      {/* Только первоначальная оценка: фактический отсчёт начнётся с клика. */}
      <div className={kds.metaLine}>
        Первоначальная оценка: {order.preparationMinutes ?? "—"} мин
      </div>
      <div className={kds.btnRow}>
        <button
          className={`${kds.btn} ${kds.btnDark}`}
          type="button"
          disabled={startPending}
          onClick={() =>
            void runStart(() =>
              startKitchenPreparation(order.id, "RESTAURANT", "KITCHEN"),
            )
          }
        >
          {startPending ? "Подтверждаем…" : "Начать готовить"}
        </button>
      </div>
      {startError ? (
        <p className={kds.pickupError} role="alert">
          {startError}
        </p>
      ) : null}
      {/* Сообщить о проблеме кухня может и до начала приготовления. */}
      <PreparationProblemPanel order={order} isSplit />
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
  const openProblem = getOpenPreparationProblem(order);
  const countdown = formatKitchenCountdown(order.expectedReadyAt, nowMs);
  const request = getCancellationRequestForOrder(state, order.id);
  const [etaOpen, setEtaOpen] = useState(false);
  const [etaConfirm, setEtaConfirm] = useState(false);
  const lastEta = order.etaAdjustments.at(-1) ?? null;
  const startedClock = order.kitchenStartedAt
    ? formatClock24(order.kitchenStartedAt, timeZone || "Europe/Chisinau")
    : null;
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
      {/* В SPLIT сюда попадают только уже начатые заказы: ожидающие старта живут
          в колонке «Новые». Спокойная строка фиксирует момент начала. */}
      {isSplit && startedClock ? (
        <p className={kds.startedLine}>Начато в {startedClock}</p>
      ) : null}
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
      {openProblem ? (
        <p className={kds.units} role="status">
          Сначала дождитесь решения проблемы приготовления.
        </p>
      ) : null}
      {/* Готовность доступна только у начатого заказа: ожидающие старта сюда не
          попадают, а доменный markReady дополнительно fail-closed это запрещает. */}
      <div className={kds.btnRow}>
        <button
          className={`${kds.btn} ${kds.btnGreen}`}
          type="button"
          disabled={readyPending || openProblem !== null}
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
 * Инлайновая выдача неоплаченного самовывоза на общем экране. Заказ не оплачен
 * заранее: сотрудник отмечает фактический способ полученной оплаты (радио,
 * авто-выбор при единственном варианте) и выдаёт заказ одним доменным
 * действием. Никакого кода клиента здесь нет и не требуется.
 *
 * Ошибка не закрывает панель и не сбрасывает выбор; успех убирает карточку
 * (статус заказа меняется на PICKED_UP). Рядом — инлайновый невыкуп (§1).
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
  // Способы оплаты берутся из исторического снимка; пустой снимок не блокирует
  // выдачу — сотрудник фиксирует фактическую оплату из безопасного набора.
  const methods = getPickupPaymentChoices(order);
  const single = methods.length === 1 ? methods[0] : null;
  const [paidWith, setPaidWith] = useState<PickupPaymentMethod | null>(single);

  // Код клиента больше не требуется: заказ не оплачен заранее, подтверждением
  // служит сама оплата сотруднику.
  const canConfirm = paidWith !== null;
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
        <legend>Чем клиент оплатил</legend>
        {methods.map((method) => (
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
        ))}
      </fieldset>
      <p className={kds.pickupInstruction}>
        Отметьте фактический способ оплаты и выдайте заказ.
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
          : "Оплата получена — выдать заказ"}
      </button>
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
      <div className={kds.btnRow}>
        {/* Пакетная наклейка — документ ГОТОВОГО пакета. Доступна и на общем
            экране (COMBINED), и на кухне в SPLIT (роль KITCHEN). Производственного
            листа здесь уже нет: он печатается при принятии нового заказа. */}
        <OperatorPackageLabelPrintButton
          order={order}
          workspaceRole={isSplit ? "KITCHEN" : "COMBINED"}
        />
      </div>
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

  const restaurant = getRestaurant(state, selectedRestaurantId);
  // Этап 8: в SPLIT кухня не видит приватные данные и не выполняет выдачу.
  const isSplit = restaurant?.orderWorkflowMode === "SPLIT_OPERATOR_KITCHEN";
  // В SPLIT селектор возвращает пусто: решение по новому заказу — у оператора,
  // непринятый заказ до кухни не доходит ни карточкой, ни звуком, ни таймером.
  const newOrders = getKitchenNewOrders(state, selectedRestaurantId);
  const awaitingOrders = getKitchenAwaitingPaymentOrders(
    state,
    selectedRestaurantId,
  );
  // SPLIT: принятые и оплаченные заказы, которые кухня ещё не начала готовить.
  // В COMBINED список пуст — там подэтапа ожидания не существует.
  const pendingStartOrders = getKitchenPendingStartOrders(
    state,
    selectedRestaurantId,
  );
  const preparingOrders = getKitchenPreparingOrders(state, selectedRestaurantId);
  const readyOrders = getKitchenReadyOrders(state, selectedRestaurantId);

  // Единый тик экрана: часы для отсчётов и расписания сигнала.
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  // Звук нового заказа — общий контроллер. В SPLIT новых заказов у кухни нет,
  // поэтому она их и не озвучивает: сигнал уходит оператору, дубля не будет.
  const {
    soundEnabled,
    soundBlocked,
    activationRequired,
    enableSound: handleEnableSound,
    disableSound: handleDisableSound,
  } = useNewOrderSound({
    restaurantId: selectedRestaurantId,
    enabled: !isSplit,
    nowMs,
  });

  // SPLIT: пока заказ в PREPARING и кухня не подтвердила «Начать готовить»
  // (kitchenStartedAt === null), кухня получает существующий playKitchenBeep сразу
  // и затем каждые 20 секунд до подтверждения. Тот же колокольчик кухни —
  // разрешение звука. В COMBINED сигнал отключён (начало ставится автоматически).
  useSplitKitchenPreparingSound({
    restaurantId: selectedRestaurantId,
    enabled: isSplit && soundEnabled,
    nowMs,
  });

  // Печать производственного листа при принятии нового заказа (COMBINED). Хук на
  // уровне страницы: печатает канонический принятый заказ, даже когда карточка
  // «Нового» уже ушла из колонки.
  const kitchenTimeZone = restaurant?.timeZone ?? "Europe/Chisinau";
  const { requestPrint, printPortal } = useKitchenProductionTicketPrint(
    state.orders,
    kitchenTimeZone,
  );

  return (
    <div className={kds.screen}>
      {printPortal}
      <div className={kds.toolbar}>
        <div className={kds.toolbarLeft}>
          {/* В COMBINED экран ведёт заказ целиком, а не только готовит. */}
          <span className={kds.brand}>
            {isSplit ? SPLIT_KITCHEN_LABEL : COMBINED_ORDERS_LABEL}
          </span>
          <span className={kds.restaurantName}>{restaurant?.name ?? "—"}</span>
        </div>
        <div className={kds.toolbarRight}>
          {/* Единый источник статуса приёма — RestaurantPauseControl ниже.
              Дублирующий toolbar-chip убран, чтобы состояние показывалось один раз. */}
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
          {/* Один колокольчик на экране: в COMBINED управляет сигналом нового
              заказа, в SPLIT — кухонным сигналом начала приготовления. */}
          <NewOrderSoundButton
            soundEnabled={soundEnabled}
            onEnable={() => void handleEnableSound()}
            onDisable={handleDisableSound}
          />
        </div>
      </div>
      {soundBlocked ? (
        <p className={kds.soundError} role="alert">
          Браузер заблокировал звук. Нажмите значок звука ещё раз.
        </p>
      ) : null}
      {/* Предпочтение сохранено, но новой вкладке нужен один жест пользователя:
          обходить autoplay policy браузера мы не пытаемся. */}
      {activationRequired && !soundBlocked ? (
        <p className={kds.soundError} role="status">
          {SOUND_ACTIVATION_MESSAGE}
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

          {/* В COMBINED «Новые» — это заказы на решение (принять/отклонить).
              В SPLIT решение принимает оператор, поэтому «Новые» для кухни —
              это уже принятые и оплаченные заказы, которые она ещё не начала
              готовить: доска остаётся из трёх колонок. */}
          <div className={kds.board}>
            <section className={kds.column}>
              <h2 className={kds.columnHead}>
                Новые{" "}
                <span>
                  — {isSplit ? pendingStartOrders.length : newOrders.length}
                </span>
              </h2>
              {isSplit ? (
                pendingStartOrders.length === 0 ? (
                  <div className={kds.empty}>Новых заказов нет.</div>
                ) : (
                  pendingStartOrders.map((order) => (
                    <KitchenPendingStartCard order={order} key={order.id} />
                  ))
                )
              ) : newOrders.length === 0 ? (
                <div className={kds.empty}>Новых заказов нет.</div>
              ) : (
                newOrders.map((order) => (
                  <NewOrderCard
                    order={order}
                    nowMs={nowMs}
                    isSplit={isSplit}
                    onRequestPrint={requestPrint}
                    key={order.id}
                  />
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
          {/* Компактная строка «Меню · статус» внизу экрана заказов. Закрыта по
              умолчанию; раскрывается в существующий MenuAvailabilitySection —
              вторая реализация управления меню не создаётся. Отдельная страница
              /restaurant/menu остаётся и работает как прежде. */}
          {restaurant ? (
            <RestaurantMenuAvailabilityPanel
              restaurant={restaurant}
              nowMs={nowMs}
              workspaceRole={isSplit ? "KITCHEN" : "COMBINED"}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
