"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import kds from "@/components/kitchen/kitchen.module.css";
import { useRestaurantWorkspace } from "@/components/workspaces/restaurant-workspace";
import { useNowMs } from "@/components/util/use-now";
import { usePrototype } from "@/prototype/prototype-provider";
import type {
  Order,
  PickupPaymentMethod,
  PrototypeState,
} from "@/prototype/models";
import {
  deliveryModeLabels,
  formatMoney,
  formatOrderEtaClock,
  getCancellationRequestForOrder,
  getDriverById,
  getPickupNoShowEligibleAtIso,
  getRestaurant,
  isPickupNoShowEligibleAt,
  paymentMethodLabels,
  paymentStatusLabels,
  pickupPaymentMethodLabels,
} from "@/prototype/selectors";

/**
 * Этап 9: экран оператора заказов (режим «Оператор и кухня отдельно»). Оператор
 * работает с клиентом, оплатой, водителем и выдачей; приготовление и время —
 * зона кухни (кнопок приёма/времени/готовности здесь нет). Один общий Order и
 * state — никакого второго жизненного цикла.
 */

const NO_SHOW_REASONS = [
  "Не удалось связаться с клиентом",
  "Клиент отказался от заказа",
  "Клиент сообщил, что не придёт",
  "Клиент не пришёл в течение времени ожидания",
  "Другая причина",
] as const;

/** Исправление 1: причины отклонения нового заказа оператором. */
const OPERATOR_REJECT_REASONS = [
  "Нет нужных позиций",
  "Ресторан не может выполнить заказ",
  "Заказ невозможно доставить",
  "Ресторан скоро закрывается",
  "Другая причина",
] as const;

/** Минут до targetIso (0 — если наступило); null — нет данных/часов. */
function minutesUntil(targetIso: string | null, nowMs: number): number | null {
  if (!targetIso || nowMs === 0) return null;
  const diff = Date.parse(targetIso) - nowMs;
  return diff <= 0 ? 0 : Math.ceil(diff / 60_000);
}

/** Клиент, телефон, адрес и оплата — данные, доступные оператору (Этап 3). */
function OperatorOrderDetails({ order }: { order: Order }) {
  return (
    <>
      <div className={kds.metaLine}>
        Клиент: {order.customer.name || "—"}
        {order.customer.phone ? ` · ${order.customer.phone}` : ""}
      </div>
      {order.deliveryMode !== "PICKUP" && order.address ? (
        <div className={kds.metaLine}>
          Адрес: {order.address.street}, дом {order.address.house}
          {order.address.apartment ? `, кв. ${order.address.apartment}` : ""}
        </div>
      ) : null}
      <div className={kds.metaLine}>
        {deliveryModeLabels[order.deliveryMode]} ·{" "}
        {paymentMethodLabels[order.paymentMethod]} ·{" "}
        {paymentStatusLabels[order.paymentStatus]}
      </div>
      <div className={kds.metaLine}>
        Сумма: {formatMoney(order.financials.customerTotalCents)}
      </div>
    </>
  );
}

/**
 * Исправление 1: отклонение нового заказа оператором (RESTAURANT_REVIEW).
 * Оператор не принимает заказ и не задаёт время — только штатный отказ через
 * существующий rejectRestaurantOrder с ролью OPERATOR. Кухня в SPLIT кнопку
 * отклонения не получает (у неё «Не можем приготовить»).
 */
function OperatorRejectPanel({ order }: { order: Order }) {
  const { rejectOrder } = usePrototype();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isOther = reason === "Другая причина";
  const effectiveReason = isOther ? customReason : reason;

  const doReject = async () => {
    if (!effectiveReason.trim()) {
      setError("Укажите причину отклонения.");
      return;
    }
    if (pending) return;
    setPending(true);
    try {
      // Исправление 4.4: сериализованная мутация (Web Lock + rebase на свежий
      // state). Кнопка на время запроса заблокирована — повторный клик невозможен.
      const result = await rejectOrder(
        order.id,
        effectiveReason,
        "RESTAURANT",
        "OPERATOR",
      );
      if (!result.ok) {
        // Гонка вкладок (кухня уже приняла и т.п.): форма остаётся открытой,
        // причина сохраняется, показываем ошибку — без ложного успеха.
        setError(result.error ?? "Не удалось отклонить заказ.");
        return;
      }
      setError(null);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <button
        className={`${kds.btn} ${kds.btnRedOutline}`}
        type="button"
        onClick={() => {
          setOpen(true);
          setError(null);
        }}
      >
        Отклонить заказ
      </button>
    );
  }

  return (
    <div className={kds.dialog} role="group" aria-label="Отклонение заказа">
      <h4 className={kds.dialogTitle}>Причина отклонения</h4>
      <fieldset className={kds.reasonList}>
        {OPERATOR_REJECT_REASONS.map((r) => (
          <label className={kds.reasonOption} key={r}>
            <input
              type="radio"
              name={`op-reject-${order.id}`}
              checked={reason === r}
              onChange={() => {
                setReason(r);
                setError(null);
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
            onChange={(event) => {
              setCustomReason(event.target.value);
              setError(null);
            }}
            placeholder="Опишите причину"
          />
        </label>
      ) : null}
      {error ? (
        <p className={kds.pickupError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={kds.btnRowEnd}>
        <button
          className={`${kds.btn} ${kds.btnOutline}`}
          type="button"
          onClick={() => setOpen(false)}
        >
          Не отклонять
        </button>
        <button
          className={`${kds.btn} ${kds.btnRedOutline}`}
          type="button"
          disabled={!effectiveReason.trim() || pending}
          onClick={doReject}
        >
          {pending ? "Отклоняем…" : "Подтвердить отклонение"}
        </button>
      </div>
    </div>
  );
}

/** Последняя проблема кухни (Этап 6) — оператор видит её сразу. */
function PreparationProblemNotice({ order }: { order: Order }) {
  const last = [...order.history]
    .reverse()
    .find((event) => event.type === "PREPARATION_PROBLEM");
  if (!last) return null;
  return (
    <p className={kds.pickupError} role="status">
      {last.message}
    </p>
  );
}

/** Панель выдачи самовывоза оператором: способ оплаты + код + невыкуп. */
function OperatorPickupHandoff({ order, nowMs }: { order: Order; nowMs: number }) {
  const { completePickup, markPickupNoShow } = usePrototype();
  const methods = order.pickupPaymentMethodsSnapshot;
  const single = methods.length === 1 ? methods[0] : null;
  const [paidWith, setPaidWith] = useState<PickupPaymentMethod | null>(single);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [noShowOpen, setNoShowOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [noShowError, setNoShowError] = useState<string | null>(null);

  const eligibleAtIso = getPickupNoShowEligibleAtIso(order);
  const nowIso = nowMs > 0 ? new Date(nowMs).toISOString() : null;
  const noShowEligible = nowIso ? isPickupNoShowEligibleAt(order, nowIso) : false;
  const minutesLeft = minutesUntil(eligibleAtIso, nowMs);

  const codeValid = /^\d{4}$/.test(code.trim());
  const canConfirm = codeValid && paidWith !== null;
  const isOther = reason === "Другая причина";
  const effectiveReason = isOther ? customReason : reason;

  const doConfirm = async () => {
    if (!paidWith) {
      setError("Выберите способ оплаты.");
      return;
    }
    const res = await completePickup(order.id, code, paidWith, "RESTAURANT", "OPERATOR");
    if (!res.ok) {
      setError(res.error ?? "Не удалось подтвердить выдачу.");
      return;
    }
    setError(null);
  };

  const doNoShow = async () => {
    if (!effectiveReason.trim()) {
      setNoShowError("Укажите причину невыкупа.");
      return;
    }
    const res = await markPickupNoShow(order.id, effectiveReason, "RESTAURANT", "OPERATOR");
    if (!res.ok) {
      setNoShowError(res.error ?? "Не удалось закрыть как невыкуп.");
      return;
    }
    setNoShowError(null);
  };

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
                name={`op-pay-${order.id}`}
                value={method}
                checked={paidWith === method}
                onChange={() => {
                  setPaidWith(method);
                  setError(null);
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
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, "").slice(0, 4));
            setError(null);
          }}
        />
      </label>
      <p className={kds.pickupInstruction}>
        Попросите клиента назвать четырёхзначный код.
      </p>
      {error ? (
        <p className={kds.pickupError} role="alert">
          {error}
        </p>
      ) : null}
      <button
        className={`${kds.btn} ${kds.btnGreen}`}
        type="button"
        disabled={!canConfirm}
        onClick={doConfirm}
      >
        Подтвердить оплату и выдать
      </button>

      {!noShowOpen ? (
        <button
          className={`${kds.btn} ${kds.btnRedOutline}`}
          type="button"
          disabled={!noShowEligible}
          onClick={() => setNoShowOpen(true)}
        >
          {noShowEligible
            ? "Клиент не пришёл"
            : minutesLeft !== null
              ? `Невыкуп можно отметить через ${minutesLeft} мин`
              : "Невыкуп пока недоступен"}
        </button>
      ) : (
        <div className={kds.dialog} role="group" aria-label="Невыкуп заказа">
          <h4 className={kds.dialogTitle}>Причина невыкупа</h4>
          <fieldset className={kds.reasonList}>
            {NO_SHOW_REASONS.map((r) => (
              <label className={kds.reasonOption} key={r}>
                <input
                  type="radio"
                  name={`op-no-show-${order.id}`}
                  checked={reason === r}
                  onChange={() => {
                    setReason(r);
                    setNoShowError(null);
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
                onChange={(event) => {
                  setCustomReason(event.target.value);
                  setNoShowError(null);
                }}
                placeholder="Опишите причину"
              />
            </label>
          ) : null}
          <p className={kds.pickupInstruction}>
            Заказ будет отменён без фиксации оплаты и без начисления комиссии
            Direct.
          </p>
          {noShowError ? (
            <p className={kds.pickupError} role="alert">
              {noShowError}
            </p>
          ) : null}
          <div className={kds.btnRowEnd}>
            <button
              className={`${kds.btn} ${kds.btnOutline}`}
              type="button"
              onClick={() => setNoShowOpen(false)}
            >
              Отмена
            </button>
            <button
              className={`${kds.btn} ${kds.btnRedOutline}`}
              type="button"
              disabled={!effectiveReason.trim()}
              onClick={doNoShow}
            >
              Закрыть как невыкуп
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Действия выдачи/доставки в READY и далее — зона оператора. */
function OperatorHandoffActions({ order }: { order: Order }) {
  const { state, markOutForDelivery, markArriving, markDelivered } =
    usePrototype();

  if (order.deliveryMode === "RESTAURANT_DELIVERY") {
    if (order.status === "READY") {
      return (
        <button
          className={`${kds.btn} ${kds.btnGreen}`}
          type="button"
          onClick={() => void markOutForDelivery(order.id, "RESTAURANT", "OPERATOR")}
        >
          Курьер выехал
        </button>
      );
    }
    if (order.status === "OUT_FOR_DELIVERY") {
      return (
        <button
          className={`${kds.btn} ${kds.btnDark}`}
          type="button"
          onClick={() => void markArriving(order.id, "RESTAURANT", "OPERATOR")}
        >
          Курьер скоро будет
        </button>
      );
    }
    if (order.status === "ARRIVING") {
      return (
        <button
          className={`${kds.btn} ${kds.btnGreen}`}
          type="button"
          onClick={() => void markDelivered(order.id, "RESTAURANT", "OPERATOR")}
        >
          Заказ доставлен
        </button>
      );
    }
    return null;
  }

  if (order.deliveryMode === "PLATFORM_DRIVER" && order.status === "READY") {
    const driver = order.assignedDriverId
      ? getDriverById(state, order.assignedDriverId)
      : null;
    return (
      <p className={kds.pickupAdminHint}>
        {driver
          ? `Назначен водитель Direct: ${driver.name}. Передайте заказ при прибытии.`
          : "Водитель Direct ещё не назначен. Назначение выполняет администратор Direct."}
      </p>
    );
  }

  return null;
}

/** Русская строка статуса кухни для оператора (Этап 5/9). */
function operatorKitchenStatus(state: PrototypeState, order: Order): string {
  switch (order.status) {
    case "RESTAURANT_REVIEW":
      return "Ожидает подтверждения кухни";
    case "AWAITING_PAYMENT":
      return "Кухня подтвердила заказ · ожидается оплата";
    case "PREPARING":
      return `Кухня готовит заказ · Ожидаемая готовность: к ${formatOrderEtaClock(state, order)}`;
    case "READY":
      return "Заказ готов";
    case "READY_FOR_PICKUP":
      return "Готов к выдаче клиенту";
    case "OUT_FOR_DELIVERY":
      return "Курьер в пути";
    case "ARRIVING":
      return "Курьер скоро будет";
    default:
      return "";
  }
}

function OperatorOrderCard({ order, nowMs }: { order: Order; nowMs: number }) {
  const { state } = usePrototype();
  const request = getCancellationRequestForOrder(state, order.id);
  return (
    <article className={kds.card}>
      <div className={kds.cardHead}>
        <div>
          <h3 className={kds.orderNumber}>{order.publicNumber}</h3>
          <div className={kds.cardMeta}>
            <span>{operatorKitchenStatus(state, order)}</span>
          </div>
        </div>
      </div>
      {request?.status === "PENDING" ? (
        <p className={kds.pickupError} role="status">
          Клиент запросил отмену. Решение принимает администратор Direct.
        </p>
      ) : null}
      <OperatorOrderDetails order={order} />
      <PreparationProblemNotice order={order} />
      {order.status === "RESTAURANT_REVIEW" ? (
        <OperatorRejectPanel order={order} />
      ) : null}
      {order.status === "READY_FOR_PICKUP" ? (
        <OperatorPickupHandoff order={order} nowMs={nowMs} />
      ) : (
        <OperatorHandoffActions order={order} />
      )}
    </article>
  );
}

const ACTIVE_OPERATOR_STATUSES: readonly Order["status"][] = [
  "RESTAURANT_REVIEW",
  "AWAITING_PAYMENT",
  "PREPARING",
  "READY",
  "READY_FOR_PICKUP",
  "OUT_FOR_DELIVERY",
  "ARRIVING",
];

export default function RestaurantOperatorPage() {
  const router = useRouter();
  const { state, isHydrated } = usePrototype();
  const {
    selectedRestaurantId,
    setSelectedRestaurantId,
    workspaceRestaurants,
  } = useRestaurantWorkspace();
  const nowMs = useNowMs();

  const restaurant = getRestaurant(state, selectedRestaurantId);
  // Исправление 7: в COMBINED существует только один рабочий экран заказов —
  // прямой URL оператора переводится на него. В SPLIT экран остаётся доступен.
  const isCombined =
    isHydrated && restaurant?.orderWorkflowMode !== "SPLIT_OPERATOR_KITCHEN";
  useEffect(() => {
    if (isCombined) {
      router.replace("/restaurant/kitchen");
    }
  }, [isCombined, router]);

  // До гидратации и при redirect не показываем операторский board даже коротко.
  if (!isHydrated || isCombined) {
    return (
      <div className={kds.screen}>
        <div className={kds.empty}>Загружаем заказы…</div>
      </div>
    );
  }

  const orders = state.orders.filter(
    (order) =>
      order.restaurant.id === selectedRestaurantId &&
      ACTIVE_OPERATOR_STATUSES.includes(order.status),
  );

  const waiting = orders.filter(
    (o) => o.status === "RESTAURANT_REVIEW" || o.status === "AWAITING_PAYMENT",
  );
  const preparing = orders.filter((o) => o.status === "PREPARING");
  const handoff = orders.filter(
    (o) =>
      o.status === "READY" ||
      o.status === "READY_FOR_PICKUP" ||
      o.status === "OUT_FOR_DELIVERY" ||
      o.status === "ARRIVING",
  );

  return (
    <div className={kds.screen}>
      <div className={kds.toolbar}>
        <div className={kds.toolbarLeft}>
          <span className={kds.brand}>Оператор заказов</span>
          <span className={kds.restaurantName}>{restaurant?.name ?? "—"}</span>
        </div>
        <div className={kds.toolbarRight}>
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
        </div>
      </div>

      {!isHydrated ? (
        <div className={kds.empty}>Загружаем заказы…</div>
      ) : (
        <div className={kds.board}>
          <section className={kds.column}>
            <h2 className={kds.columnHead}>
              Новые и оплата <span>— {waiting.length}</span>
            </h2>
            {waiting.length === 0 ? (
              <div className={kds.empty}>Новых заказов нет.</div>
            ) : (
              waiting.map((order) => (
                <OperatorOrderCard order={order} nowMs={nowMs} key={order.id} />
              ))
            )}
          </section>

          <section className={kds.column}>
            <h2 className={kds.columnHead}>
              Готовятся <span>— {preparing.length}</span>
            </h2>
            {preparing.length === 0 ? (
              <div className={kds.empty}>Сейчас ничего не готовится.</div>
            ) : (
              preparing.map((order) => (
                <OperatorOrderCard order={order} nowMs={nowMs} key={order.id} />
              ))
            )}
          </section>

          <section className={kds.column}>
            <h2 className={kds.columnHead}>
              Готовы и выдача <span>— {handoff.length}</span>
            </h2>
            {handoff.length === 0 ? (
              <div className={kds.empty}>Заказов на выдачу нет.</div>
            ) : (
              handoff.map((order) => (
                <OperatorOrderCard order={order} nowMs={nowMs} key={order.id} />
              ))
            )}
          </section>
        </div>
      )}
    </div>
  );
}
