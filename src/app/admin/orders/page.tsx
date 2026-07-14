"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { OrderHistory } from "@/components/order-flow/order-history";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import { getSafeAdminStatusCorrections } from "@/prototype/actions";
import type { DeliveryMode, Order, OrderStatus } from "@/prototype/models";
import {
  deliveryModeLabels,
  driverStatusLabels,
  formatDateTime,
  formatMoney,
  getAvailableDrivers,
  getDriverById,
  getOrder,
  getPendingCancellationRequests,
  getRestaurant,
  orderStatusLabels,
  paymentMethodLabels,
  paymentStatusLabels,
  shouldShowDriverAssignment,
} from "@/prototype/selectors";
import type { CancellationRequest } from "@/prototype/models";

const PREP_MINUTES = [10, 15, 20, 25, 30, 40];

const ETA_ACTOR_LABELS: Record<string, string> = {
  RESTAURANT: "Ресторан",
  ADMIN: "Администратор Direct",
};

/** §11: сводка последней корректировки ожидаемого времени готовности. */
function EtaAdjustmentSummary({ order }: { order: Order }) {
  const last = order.etaAdjustments[order.etaAdjustments.length - 1];
  const diff = Math.round(
    (Date.parse(last.nextExpectedReadyAt) -
      Date.parse(last.previousExpectedReadyAt)) /
      60_000,
  );
  const diffLabel =
    diff > 0
      ? `+${diff} мин (задержка)`
      : diff < 0
        ? `${diff} мин (раньше)`
        : "без изменений";
  return (
    <div className={flowStyles.zoneNotice}>
      <strong>Последняя корректировка времени</strong>
      <div className={flowStyles.inlineMeta}>
        <span>
          {formatDateTime(last.previousExpectedReadyAt)} →{" "}
          {formatDateTime(last.nextExpectedReadyAt)}
        </span>
        <span>{diffLabel}</span>
        <span>Причина: {last.reason}</span>
        <span>{ETA_ACTOR_LABELS[last.actor] ?? last.actor}</span>
        <span>{formatDateTime(last.occurredAt)}</span>
      </div>
    </div>
  );
}

/** «Проблемный» заказ: ожидает оплаты, отменён, либо водитель Direct не назначен. */
function isProblemOrder(order: Order): boolean {
  if (order.status === "AWAITING_PAYMENT" || order.status === "CANCELED") {
    return true;
  }
  if (
    order.deliveryMode === "PLATFORM_DRIVER" &&
    order.status === "READY" &&
    !order.assignedDriverId
  ) {
    return true;
  }
  return false;
}

function ContactButtons({ order }: { order: Order }) {
  const { state } = usePrototype();
  const restaurant = getRestaurant(state, order.restaurant.id);
  // §9: связь с рестораном по прямому контакту управляющего (contactPhone),
  // иначе по публичному телефону. Срочный контакт — отдельной ссылкой.
  const restaurantPhone = restaurant?.contactPhone || restaurant?.publicPhone;
  return (
    <>
      {restaurantPhone ? (
        <a className={flowStyles.secondaryButton} href={`tel:${restaurantPhone}`}>
          Связаться с рестораном
        </a>
      ) : null}
      {restaurant?.emergencyPhone ? (
        <a
          className={flowStyles.secondaryButton}
          href={`tel:${restaurant.emergencyPhone}`}
        >
          Срочный контакт
        </a>
      ) : null}
      {order.customer.phone ? (
        <a
          className={flowStyles.secondaryButton}
          href={`tel:${order.customer.phone}`}
        >
          Связаться с клиентом
        </a>
      ) : null}
    </>
  );
}

function DriverAssignment({ order }: { order: Order }) {
  const { state, assignDriver, reassignDriver, unassignDriver } =
    usePrototype();
  const available = getAvailableDrivers(state);
  const [selected, setSelected] = useState(available[0]?.id ?? "");
  const assignedDriver = getDriverById(state, order.assignedDriverId);

  const doAssign = () => {
    if (!selected) return;
    const res = assignDriver(order.id, selected);
    if (!res.ok) window.alert(res.error ?? "Не удалось назначить водителя.");
  };
  const doReassign = () => {
    if (!selected) return;
    const reason = window.prompt("Причина переназначения водителя:");
    if (reason === null) return;
    const res = reassignDriver(order.id, selected, reason);
    if (!res.ok) window.alert(res.error ?? "Не удалось переназначить.");
  };
  const doUnassign = () => {
    const reason = window.prompt("Причина снятия назначения:");
    if (reason === null) return;
    const res = unassignDriver(order.id, reason);
    if (!res.ok) window.alert(res.error ?? "Не удалось снять назначение.");
  };

  return (
    <div className={flowStyles.orderActionBlock}>
      <h4 className={flowStyles.sectionTitle}>Водитель Direct</h4>
      {assignedDriver ? (
        <p>
          Назначен: <strong>{assignedDriver.name}</strong>
          {assignedDriver.phone ? (
            <>
              {" · "}
              <a href={`tel:${assignedDriver.phone}`}>Позвонить водителю</a>
            </>
          ) : null}
        </p>
      ) : (
        <p>Водитель не назначен.</p>
      )}
      <div className={flowStyles.buttonRow}>
        <label className={flowStyles.field}>
          <span>Найти водителя (свободные)</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {available.length === 0 ? (
              <option value="">Нет свободных водителей</option>
            ) : (
              available.map((driver) => (
                <option value={driver.id} key={driver.id}>
                  {driver.name} · {driverStatusLabels[driver.status]}
                </option>
              ))
            )}
          </select>
        </label>
        {assignedDriver ? (
          <>
            <button
              className={flowStyles.secondaryButton}
              type="button"
              onClick={doReassign}
            >
              Переназначить водителя
            </button>
            <button
              className={flowStyles.secondaryButton}
              type="button"
              onClick={doUnassign}
            >
              Снять назначение
            </button>
          </>
        ) : (
          <button
            className={flowStyles.primaryButton}
            type="button"
            disabled={available.length === 0}
            onClick={doAssign}
          >
            Назначить водителя
          </button>
        )}
      </div>
    </div>
  );
}

function StatusCorrection({ order }: { order: Order }) {
  const { correctStatus } = usePrototype();
  // §2: допустимые статусы зависят от типа заказа (проверка и в UI, и в домене).
  const safeStatuses = getSafeAdminStatusCorrections(order);
  const [target, setTarget] = useState<OrderStatus>(
    safeStatuses[0] ?? "PREPARING",
  );
  const [reason, setReason] = useState("");

  const apply = () => {
    const res = correctStatus(order.id, target, reason);
    if (!res.ok) {
      window.alert(res.error ?? "Не удалось исправить статус.");
      return;
    }
    setReason("");
  };

  return (
    <details className={flowStyles.orderActionBlock}>
      <summary>Исправить статус (безопасно)</summary>
      <div className={flowStyles.fieldGrid}>
        <label className={flowStyles.field}>
          <span>Новый статус</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value as OrderStatus)}
          >
            {safeStatuses.map((status) => (
              <option value={status} key={status}>
                {orderStatusLabels[status]}
              </option>
            ))}
          </select>
        </label>
        <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
          <span>Причина</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Обязательная причина"
          />
        </label>
      </div>
      <button
        className={flowStyles.secondaryButton}
        type="button"
        disabled={!reason.trim()}
        onClick={apply}
      >
        Применить исправление
      </button>
    </details>
  );
}

function OrderActions({ order }: { order: Order }) {
  const {
    acceptOrder,
    rejectOrder,
    markReady,
    markOutForDelivery,
    markArriving,
    markDelivered,
    markDeliveredByDriver,
    completePickup,
    markPickupNoShow,
    issuePickupNoCode,
    cancelOrderByAdmin,
    setPreparationMinutes,
  } = usePrototype();
  const [prep, setPrep] = useState(20);
  const [code, setCode] = useState("");

  const doReject = () => {
    const reason = window.prompt("Причина отклонения заказа:");
    if (reason === null) return;
    if (!reason.trim()) {
      window.alert("Причина обязательна.");
      return;
    }
    rejectOrder(order.id, reason, "ADMIN");
  };
  const doCancel = () => {
    const reason = window.prompt("Причина отмены заказа:");
    if (reason === null) return;
    const res = cancelOrderByAdmin(order.id, reason);
    if (!res.ok) window.alert(res.error ?? "Не удалось отменить заказ.");
  };
  const doPickupNoShow = () => {
    const reason = window.prompt("Причина: клиент не пришёл");
    if (reason === null) return;
    markPickupNoShow(order.id, reason, "ADMIN");
  };
  const doEmergencyPickup = () => {
    const reason = window.prompt("Причина аварийной выдачи без кода:");
    if (reason === null) return;
    if (!reason.trim()) {
      window.alert("Причина обязательна.");
      return;
    }
    if (
      !window.confirm(
        "Подтвердите аварийную выдачу без кода клиента. Действие будет записано в историю заказа.",
      )
    ) {
      return;
    }
    const res = issuePickupNoCode(order.id, reason);
    if (!res.ok) window.alert(res.error ?? "Не удалось выдать заказ.");
  };
  const doCompletePickup = () => {
    const res = completePickup(order.id, code, "ADMIN");
    if (!res.ok) window.alert(res.error ?? "Неверный код.");
    else setCode("");
  };

  const isRestaurantDelivery = order.deliveryMode === "RESTAURANT_DELIVERY";
  const isPlatform = order.deliveryMode === "PLATFORM_DRIVER";
  const isTerminal =
    order.status === "DELIVERED" ||
    order.status === "PICKED_UP" ||
    order.status === "CANCELED";

  return (
    <div className={flowStyles.orderActions}>
      {order.status === "RESTAURANT_REVIEW" ? (
        <div className={flowStyles.buttonRow}>
          <label className={flowStyles.field}>
            <span>Время приготовления, мин</span>
            <select
              value={prep}
              onChange={(e) => setPrep(Number(e.target.value))}
            >
              {PREP_MINUTES.map((m) => (
                <option value={m} key={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button
            className={flowStyles.primaryButton}
            type="button"
            onClick={() => acceptOrder(order.id, prep, "ADMIN")}
          >
            Принять от имени ресторана
          </button>
          <button
            className={flowStyles.secondaryButton}
            type="button"
            onClick={doReject}
          >
            Отклонить заказ
          </button>
        </div>
      ) : null}

      {order.status === "PREPARING" ? (
        <div className={flowStyles.buttonRow}>
          <label className={flowStyles.field}>
            <span>Изменить время, мин</span>
            <select
              value={prep}
              onChange={(e) => {
                const m = Number(e.target.value);
                setPrep(m);
                setPreparationMinutes(order.id, m);
              }}
            >
              {PREP_MINUTES.map((m) => (
                <option value={m} key={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button
            className={flowStyles.primaryButton}
            type="button"
            onClick={() => markReady(order.id, "ADMIN")}
          >
            Отметить готовым
          </button>
        </div>
      ) : null}

      {order.status === "READY_FOR_PICKUP" ? (
        <div className={flowStyles.buttonRow}>
          <label className={flowStyles.field}>
            <span>Код клиента</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button
            className={flowStyles.primaryButton}
            type="button"
            onClick={doCompletePickup}
          >
            Подтвердить выдачу по коду
          </button>
          <button
            className={flowStyles.secondaryButton}
            type="button"
            onClick={doPickupNoShow}
          >
            Клиент не пришёл
          </button>
          <button
            className={flowStyles.dangerButton}
            type="button"
            onClick={doEmergencyPickup}
          >
            Выдать без кода
          </button>
        </div>
      ) : null}

      {/* Курьер ресторана (RESTAURANT_DELIVERY): READY → OUT → ARRIVING → DELIVERED */}
      {isRestaurantDelivery && order.status === "READY" ? (
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={() => markOutForDelivery(order.id, "ADMIN")}
        >
          Курьер выехал
        </button>
      ) : null}
      {isRestaurantDelivery && order.status === "OUT_FOR_DELIVERY" ? (
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={() => markArriving(order.id, "ADMIN")}
        >
          Курьер скоро будет
        </button>
      ) : null}
      {isRestaurantDelivery && order.status === "ARRIVING" ? (
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={() => markDelivered(order.id, "ADMIN")}
        >
          Заказ доставлен, наличные получены
        </button>
      ) : null}

      {/* Водитель Direct (PLATFORM_DRIVER): блок назначения виден только когда
          заказ оплачен и готов к передаче водителю либо уже в пути (§3). */}
      {shouldShowDriverAssignment(order) ? (
        <DriverAssignment order={order} />
      ) : null}
      {isPlatform && order.assignedDriverId && order.status === "READY" ? (
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={() => markOutForDelivery(order.id, "ADMIN")}
        >
          Водитель выехал
        </button>
      ) : null}
      {isPlatform && order.status === "OUT_FOR_DELIVERY" ? (
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={() => markArriving(order.id, "ADMIN")}
        >
          Водитель скоро будет
        </button>
      ) : null}
      {isPlatform &&
      (order.status === "OUT_FOR_DELIVERY" || order.status === "ARRIVING") ? (
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={() => markDeliveredByDriver(order.id)}
        >
          Отметить доставленным
        </button>
      ) : null}

      <div className={flowStyles.buttonRow}>
        <ContactButtons order={order} />
        {!isTerminal ? (
          <button
            className={flowStyles.dangerButton}
            type="button"
            onClick={doCancel}
          >
            Отменить заказ
          </button>
        ) : null}
      </div>

      {!isTerminal ? <StatusCorrection order={order} /> : null}
    </div>
  );
}

/** Карточка одного PENDING-запроса на отмену с действиями администратора (§12). */
function CancellationRequestCard({
  request,
  onOpenOrder,
}: {
  request: CancellationRequest;
  onOpenOrder: (publicNumber: string) => void;
}) {
  const { state, approveCancellation, rejectCancellation } = usePrototype();
  const order = getOrder(state, request.orderId);
  const restaurant = getRestaurant(state, request.restaurantId);
  const [mode, setMode] = useState<"none" | "approve" | "reject">("none");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!order) return null;
  const paidOnline =
    order.paymentMethod === "ONLINE" && order.paymentStatus === "PAID";

  const submit = () => {
    const result =
      mode === "approve"
        ? approveCancellation(request.id, note)
        : rejectCancellation(request.id, note);
    if (!result.ok) {
      setError(result.error ?? "Не удалось выполнить действие.");
      return;
    }
    setMode("none");
    setNote("");
    setError(null);
  };

  return (
    <article className={flowStyles.orderCard}>
      <div className={flowStyles.orderHeader}>
        <div>
          <h3 className={flowStyles.orderNumber}>Заказ {order.publicNumber}</h3>
          <p>
            {restaurant?.name ?? order.restaurant.name} · {order.customer.name}
          </p>
        </div>
        <span className={flowStyles.statusBadge}>
          {orderStatusLabels[order.status]}
        </span>
      </div>
      <dl className={flowStyles.definitionList}>
        <div className={flowStyles.definitionRow}>
          <dt>Оплата</dt>
          <dd>{paymentMethodLabels[order.paymentMethod]}</dd>
        </div>
        <div className={flowStyles.definitionRow}>
          <dt>Оплачено онлайн</dt>
          <dd>{paidOnline ? "Да" : "Нет"}</dd>
        </div>
        <div className={flowStyles.definitionRow}>
          <dt>Причина клиента</dt>
          <dd>{request.reason}</dd>
        </div>
        <div className={flowStyles.definitionRow}>
          <dt>Запрос создан</dt>
          <dd>{formatDateTime(request.requestedAt)}</dd>
        </div>
      </dl>
      {paidOnline ? (
        <p className={flowStyles.summaryHint}>
          Возврат оплаты не выполняется автоматически. Требуется отдельное решение
          по возврату.
        </p>
      ) : null}

      {mode === "none" ? (
        <div className={flowStyles.buttonRow}>
          <button
            className={flowStyles.dangerButton}
            type="button"
            onClick={() => {
              setMode("approve");
              setError(null);
            }}
          >
            Одобрить отмену
          </button>
          <button
            className={flowStyles.secondaryButton}
            type="button"
            onClick={() => {
              setMode("reject");
              setError(null);
            }}
          >
            Отклонить запрос
          </button>
          <button
            className={flowStyles.secondaryButton}
            type="button"
            onClick={() => onOpenOrder(order.publicNumber)}
          >
            Открыть заказ
          </button>
        </div>
      ) : (
        <div className={flowStyles.orderActions}>
          <label className={flowStyles.field}>
            <span>
              {mode === "approve" ? "Решение по отмене" : "Причина отклонения"}
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Обязательный комментарий администратора"
            />
          </label>
          {error ? (
            <div className={flowStyles.warningNotice} role="alert">
              {error}
            </div>
          ) : null}
          <div className={flowStyles.buttonRow}>
            <button
              className={
                mode === "approve"
                  ? flowStyles.dangerButton
                  : flowStyles.primaryButton
              }
              type="button"
              disabled={!note.trim()}
              onClick={submit}
            >
              {mode === "approve" ? "Подтвердить отмену" : "Подтвердить отклонение"}
            </button>
            <button
              className={flowStyles.secondaryButton}
              type="button"
              onClick={() => {
                setMode("none");
                setError(null);
              }}
            >
              Назад
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function CancellationRequestsSection({
  onOpenOrder,
}: {
  onOpenOrder: (publicNumber: string) => void;
}) {
  const { state } = usePrototype();
  const pending = getPendingCancellationRequests(state);
  if (pending.length === 0) return null;
  return (
    <section className={flowStyles.card}>
      <h2>Запросы на отмену — {pending.length}</h2>
      <div className={flowStyles.orderList}>
        {pending.map((request) => (
          <CancellationRequestCard
            request={request}
            onOpenOrder={onOpenOrder}
            key={request.id}
          />
        ))}
      </div>
    </section>
  );
}

function OrdersConsole() {
  const { state } = usePrototype();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [restaurantId, setRestaurantId] = useState(
    searchParams.get("restaurantId") ?? "",
  );
  const [status, setStatus] = useState<OrderStatus | "">("");
  const [mode, setMode] = useState<DeliveryMode | "">("");
  const [payment, setPayment] = useState("");
  const [driverId, setDriverId] = useState("");
  const [problemOnly, setProblemOnly] = useState(false);

  const filtered = useMemo(() => {
    return [...state.orders]
      .reverse()
      .filter((order) => {
        if (
          search.trim() &&
          !order.publicNumber
            .toLowerCase()
            .includes(search.trim().toLowerCase())
        ) {
          return false;
        }
        if (restaurantId && order.restaurant.id !== restaurantId) return false;
        if (status && order.status !== status) return false;
        if (mode && order.deliveryMode !== mode) return false;
        if (payment && order.paymentMethod !== payment) return false;
        if (driverId && order.assignedDriverId !== driverId) return false;
        if (problemOnly && !isProblemOrder(order)) return false;
        return true;
      });
  }, [state.orders, search, restaurantId, status, mode, payment, driverId, problemOnly]);

  return (
    <>
      <CancellationRequestsSection onOpenOrder={setSearch} />
      <section className={flowStyles.card}>
        <h2>Фильтры</h2>
        <div className={flowStyles.fieldGrid}>
          <label className={flowStyles.field}>
            <span>Поиск по номеру заказа</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Например: DIR-1002"
            />
          </label>
          <label className={flowStyles.field}>
            <span>Ресторан</span>
            <select
              value={restaurantId}
              onChange={(e) => setRestaurantId(e.target.value)}
            >
              <option value="">Все рестораны</option>
              {state.restaurants.map((restaurant) => (
                <option value={restaurant.id} key={restaurant.id}>
                  {restaurant.name}
                </option>
              ))}
            </select>
          </label>
          <label className={flowStyles.field}>
            <span>Статус</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as OrderStatus | "")}
            >
              <option value="">Любой</option>
              {(Object.keys(orderStatusLabels) as OrderStatus[]).map((s) => (
                <option value={s} key={s}>
                  {orderStatusLabels[s]}
                </option>
              ))}
            </select>
          </label>
          <label className={flowStyles.field}>
            <span>Способ получения</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as DeliveryMode | "")}
            >
              <option value="">Любой</option>
              <option value="PLATFORM_DRIVER">Доставка водителем Direct</option>
              <option value="RESTAURANT_DELIVERY">Доставка ресторана</option>
              <option value="PICKUP">Самовывоз</option>
            </select>
          </label>
          <label className={flowStyles.field}>
            <span>Способ оплаты</span>
            <select
              value={payment}
              onChange={(e) => setPayment(e.target.value)}
            >
              <option value="">Любой</option>
              <option value="ONLINE">Оплата онлайн</option>
              <option value="PAY_AT_RESTAURANT">
                Оплата в ресторане при получении
              </option>
              <option value="CASH_TO_RESTAURANT_COURIER">
                Наличные курьеру ресторана
              </option>
            </select>
          </label>
          <label className={flowStyles.field}>
            <span>Назначенный водитель</span>
            <select
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
            >
              <option value="">Любой</option>
              {state.drivers.map((driver) => (
                <option value={driver.id} key={driver.id}>
                  {driver.name}
                </option>
              ))}
            </select>
          </label>
          <label className={flowStyles.sizeOption}>
            <input
              type="checkbox"
              checked={problemOnly}
              onChange={(e) => setProblemOnly(e.target.checked)}
            />
            <span>Только проблемные заказы</span>
          </label>
        </div>
      </section>

      {filtered.length === 0 ? (
        <div className={flowStyles.emptyState}>
          Заказы по выбранным фильтрам не найдены.
        </div>
      ) : (
        <div className={flowStyles.orderList}>
          {filtered.map((order) => {
            const driver = getDriverById(state, order.assignedDriverId);
            return (
              <article className={flowStyles.orderCard} key={order.id}>
                <div className={flowStyles.orderHeader}>
                  <div>
                    <h2 className={flowStyles.orderNumber}>
                      {order.publicNumber}
                    </h2>
                    <p>
                      {order.restaurant.name} · {order.customer.name}
                    </p>
                  </div>
                  <span className={flowStyles.statusBadge}>
                    {orderStatusLabels[order.status]}
                  </span>
                </div>
                <dl className={flowStyles.summaryList}>
                  <div className={flowStyles.summaryRow}>
                    <dt>Телефон клиента</dt>
                    <dd>{order.customer.phone || "—"}</dd>
                  </div>
                  <div className={flowStyles.summaryRow}>
                    <dt>Способ получения</dt>
                    <dd>{deliveryModeLabels[order.deliveryMode]}</dd>
                  </div>
                  <div className={flowStyles.summaryRow}>
                    <dt>Оплата</dt>
                    <dd>
                      {paymentMethodLabels[order.paymentMethod]} ·{" "}
                      {paymentStatusLabels[order.paymentStatus]}
                    </dd>
                  </div>
                  {order.deliveryMode === "PLATFORM_DRIVER" ? (
                    <div className={flowStyles.summaryRow}>
                      <dt>Водитель Direct</dt>
                      <dd>{driver ? driver.name : "—"}</dd>
                    </div>
                  ) : null}
                  <div className={flowStyles.summaryRow}>
                    <dt>Создан</dt>
                    <dd>{formatDateTime(order.createdAt)}</dd>
                  </div>
                  <div className={flowStyles.summaryRow}>
                    <dt>Текущая готовность</dt>
                    <dd>
                      {order.expectedReadyAt
                        ? formatDateTime(order.expectedReadyAt)
                        : "—"}
                    </dd>
                  </div>
                  <div className={flowStyles.summaryRow}>
                    <dt>Первоначальная оценка</dt>
                    <dd>{order.preparationMinutes ?? "—"} мин</dd>
                  </div>
                  {order.etaAdjustments.length > 0 ? (
                    <div className={flowStyles.summaryRow}>
                      <dt>Корректировок времени</dt>
                      <dd>{order.etaAdjustments.length}</dd>
                    </div>
                  ) : null}
                  <div className={flowStyles.summaryRow}>
                    <dt>Итог клиента</dt>
                    <dd>{formatMoney(order.financials.customerTotalCents)}</dd>
                  </div>
                </dl>

                {order.etaAdjustments.length > 0 ? (
                  <EtaAdjustmentSummary order={order} />
                ) : null}

                <OrderActions order={order} />

                <h3 className={flowStyles.sectionTitle}>История статусов</h3>
                <OrderHistory events={order.history} />
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

export default function AdminOrdersPage() {
  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Заказы"
        description="Оперативный центр управления заказами: фильтры и действия по каждому заказу."
      />
      <Suspense fallback={<div className={flowStyles.emptyState}>Загрузка…</div>}>
        <OrdersConsole />
      </Suspense>
    </>
  );
}
