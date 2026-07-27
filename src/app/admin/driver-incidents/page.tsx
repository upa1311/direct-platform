"use client";

import { useMemo, useRef, useState } from "react";

import { formatAnalyticsDuration } from "@/components/analytics/analytics-presentation";
import { useNowMs } from "@/components/util/use-now";
import { PageHeading } from "@/components/workspaces/route-content";
import {
  DRIVER_ORDER_INCIDENT_REASON_LABELS,
  DRIVER_ORDER_INCIDENT_RESOLUTION_LABELS,
  getAdminDriverOrderIncidentViews,
  type AdminDriverOrderIncidentView,
} from "@/prototype/driver-order-incidents";
import { getRestaurantDelayAlerts } from "@/prototype/restaurant-waiting-analytics";
import type { DriverOrderIncidentResolutionOutcome } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatDateTime,
  getAvailableDrivers,
  orderStatusLabels,
  paymentMethodLabels,
} from "@/prototype/selectors";

import styles from "./driver-incidents.module.css";

type IncidentFilter = "OPEN" | "RESOLVED" | "ALL";

const FILTERS: readonly { value: IncidentFilter; label: string }[] = [
  { value: "OPEN", label: "Открытые" },
  { value: "RESOLVED", label: "Закрытые" },
  { value: "ALL", label: "Все" },
];

const STATUS_LABELS = {
  OPEN: "Открыта",
  RESOLVED: "Закрыта",
  REVIEW_REQUIRED: "Требует проверки",
} as const;

function checkedIncrement(value: number): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Incident count is not safe");
  return next;
}

export default function DriverIncidentsPage() {
  const { state } = usePrototype();
  const nowMs = useNowMs(60_000);
  const [filter, setFilter] = useState<IncidentFilter>("OPEN");
  const rows = useMemo(() => getAdminDriverOrderIncidentViews(state), [state]);
  const delayAlerts = useMemo(
    () =>
      nowMs > 0
        ? getRestaurantDelayAlerts(state, new Date(nowMs).toISOString())
        : [],
    [nowMs, state],
  );
  const summary = rows.reduce(
    (acc, row) => {
      if (row.status === "OPEN") acc.open = checkedIncrement(acc.open);
      if (row.status === "REVIEW_REQUIRED") acc.review = checkedIncrement(acc.review);
      if (row.status === "RESOLVED") acc.resolved = checkedIncrement(acc.resolved);
      return acc;
    },
    { open: 0, review: 0, resolved: 0 },
  );
  const visibleRows = rows.filter((row) =>
    filter === "ALL"
      ? true
      : filter === "OPEN"
        ? row.status !== "RESOLVED"
        : row.status === "RESOLVED",
  );

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Проблемы водителей"
        description="Ситуации в активных доставках, требующие решения Direct."
      />

      <section className={styles.summary} aria-label="Сводка проблем водителей">
        <SummaryItem label="Открыто" value={summary.open} />
        <SummaryItem label="Требует проверки" value={summary.review} />
        <SummaryItem label="Закрыто" value={summary.resolved} />
      </section>

      {delayAlerts.length > 0 ? (
        <section className={styles.delayAlerts} aria-labelledby="restaurant-delay-title">
          <div className={styles.delayAlertsHeading}>
            <h2 id="restaurant-delay-title">Автоматические задержки ресторанов</h2>
            <span>{delayAlerts.length}</span>
          </div>
          <p className={styles.delayAlertsHint}>
            Выведены по факту прибытия водителя и просроченной ETA; сообщение водителя не требуется.
          </p>
          <div className={styles.delayAlertCards}>
            {delayAlerts.map((alert) => (
              <article className={styles.delayAlertCard} key={alert.orderId}>
                <h3>Заказ №{alert.publicNumber}</h3>
                <dl className={styles.details}>
                  <Detail label="Ресторан" value={alert.restaurantName} />
                  <Detail label="Водитель" value={alert.driverName} />
                  <Detail label="ETA" value={formatDateTime(alert.expectedReadyAt)} />
                  <Detail label="Фактическое ожидание" value={formatAnalyticsDuration(alert.waitingDurationMs)} />
                  <Detail label="Опоздание" value={formatAnalyticsDuration(alert.restaurantDelayMs)} />
                  <Detail label="Incident водителя" value={alert.driverIncidentExists ? "Есть" : "Нет"} />
                </dl>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <div className={styles.filters} role="group" aria-label="Фильтр проблем">
        {FILTERS.map((item) => (
          <button
            type="button"
            key={item.value}
            className={filter === item.value ? styles.filterActive : styles.filter}
            aria-pressed={filter === item.value}
            onClick={() => setFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {visibleRows.length === 0 ? (
        <p className={styles.empty}>В этом разделе проблем нет.</p>
      ) : (
        <div className={styles.cards}>
          {visibleRows.map((row) => <IncidentCard key={row.key} row={row} />)}
        </div>
      )}
    </>
  );
}

function SummaryItem({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.summaryItem}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function IncidentCard({ row }: { row: AdminDriverOrderIncidentView }) {
  const {
    state,
    adminResolveDriverOrderIncident,
    cancelOrderByAdmin,
    reassignDriver,
  } = usePrototype();
  const [note, setNote] = useState("");
  const [selectedDriverId, setSelectedDriverId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const incident = row.incident;
  const order = row.order;
  const candidates = getAvailableDrivers(state).filter(
    (driver) =>
      driver.id !== incident?.driverId && driver.id !== order?.assignedDriverId,
  );
  const isActive =
    order !== null && ["READY", "OUT_FOR_DELIVERY", "ARRIVING"].includes(order.status);
  const sameDriver =
    incident !== null && order?.assignedDriverId === incident.driverId;

  const runGuarded = async (action: () => Promise<void>) => {
    if (pendingRef.current) return;
    if (note.trim().length < 3) {
      setError("Укажите решение администратора.");
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const resolve = async (outcome: DriverOrderIncidentResolutionOutcome) => {
    if (incident === null) return;
    const result = await adminResolveDriverOrderIncident(incident.id, outcome, note);
    if (!result.ok) setError(result.error ?? "Не удалось закрыть проблему.");
  };

  const cancelAndResolve = async () => {
    if (incident === null || order === null) return;
    const canceled = await cancelOrderByAdmin(order.id, note);
    if (!canceled.ok) {
      setError(canceled.error ?? "Не удалось отменить заказ.");
      return;
    }
    const resolved = await adminResolveDriverOrderIncident(
      incident.id,
      "ORDER_CANCELED",
      note,
    );
    if (!resolved.ok) {
      setError("Заказ отменён, но проблема осталась открытой. Повторите закрытие.");
    }
  };

  const reassignAndResolve = async () => {
    if (incident === null || order === null) return;
    if (selectedDriverId === "") {
      setError("Выберите свободного водителя.");
      return;
    }
    const reassigned = await reassignDriver(order.id, selectedDriverId, note);
    if (!reassigned.ok) {
      setError(reassigned.error ?? "Не удалось переназначить водителя.");
      return;
    }
    const resolved = await adminResolveDriverOrderIncident(
      incident.id,
      "DRIVER_REASSIGNED",
      note,
    );
    if (!resolved.ok) {
      setError("Водитель переназначен, но проблема осталась открытой. Повторите закрытие.");
    }
  };

  const restaurantPhone = row.restaurant?.contactPhone.trim() || row.restaurant?.publicPhone || null;

  return (
    <article
      className={`${styles.card} ${
        row.status === "REVIEW_REQUIRED" ? styles.cardReview : row.status === "OPEN" ? styles.cardOpen : ""
      }`}
      aria-busy={pending}
    >
      <div className={styles.cardHeader}>
        <h2>Заказ №{order?.publicNumber ?? row.orderId}</h2>
        <span className={styles.status}>{STATUS_LABELS[row.status]}</span>
      </div>

      {row.status === "REVIEW_REQUIRED" ? (
        <p className={styles.reviewText}>Данные проблемы требуют проверки Direct. Автоматические действия отключены.</p>
      ) : incident !== null ? (
        <dl className={styles.details}>
          <Detail label="Причина" value={DRIVER_ORDER_INCIDENT_REASON_LABELS[incident.reason]} />
          {incident.details !== null ? <Detail label="Комментарий" value={incident.details} /> : null}
          <Detail label="Сообщил" value={row.driver?.name ?? incident.driverId} />
          <Detail label="Текущий водитель" value={row.currentAssignedDriver?.name ?? "Не назначен"} />
          <Detail label="Ресторан" value={row.restaurant?.name ?? order?.restaurant.name ?? "—"} />
          <Detail label="Статус заказа" value={order ? orderStatusLabels[order.status] : "Заказ не найден"} />
          <Detail label="Оплата" value={order ? paymentMethodLabels[order.paymentMethod] : "—"} />
          <Detail label="Сообщено" value={formatDateTime(incident.reportedAt)} />
          {row.resolution ? (
            <>
              <Detail label="Решение" value={DRIVER_ORDER_INCIDENT_RESOLUTION_LABELS[row.resolution.outcome]} />
              <Detail label="Комментарий решения" value={row.resolution.note} />
              <Detail label="Закрыто" value={formatDateTime(row.resolution.resolvedAt)} />
              <Detail label="Статус при закрытии" value={orderStatusLabels[row.resolution.orderStatusAtResolution]} />
              <Detail label="Водитель при закрытии" value={row.resolution.assignedDriverIdAtResolution ?? "Не назначен"} />
            </>
          ) : null}
        </dl>
      ) : null}

      {incident !== null ? (
        <div className={styles.contacts}>
          {row.driver ? <a href={`tel:${row.driver.phone}`}>Позвонить водителю</a> : null}
          {restaurantPhone ? <a href={`tel:${restaurantPhone}`}>Позвонить ресторану</a> : null}
          {order ? <a href={`tel:${order.customer.phone}`}>Позвонить клиенту</a> : null}
        </div>
      ) : null}

      {row.status === "OPEN" && incident !== null && order !== null ? (
        <div className={styles.actions}>
          <label htmlFor={`incident-note-${incident.id}`}>Комментарий решения</label>
          <textarea
            id={`incident-note-${incident.id}`}
            rows={3}
            maxLength={300}
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />

          {order.status === "CANCELED" ? (
            <ActionButton pending={pending} onClick={() => void runGuarded(() => resolve("ORDER_CANCELED"))}>
              Закрыть как отменённый
            </ActionButton>
          ) : order.status === "DELIVERED" ? (
            <ActionButton pending={pending} onClick={() => void runGuarded(() => resolve("ORDER_COMPLETED"))}>
              Закрыть как завершённый
            </ActionButton>
          ) : !sameDriver ? (
            <ActionButton pending={pending} onClick={() => void runGuarded(() => resolve("DRIVER_REASSIGNED"))}>
              Закрыть как переназначенный
            </ActionButton>
          ) : isActive ? (
            <>
              <ActionButton pending={pending} onClick={() => void runGuarded(() => resolve("CONTINUE_ORDER"))}>
                Разрешить продолжить заказ
              </ActionButton>
              <button
                type="button"
                className={styles.cancelButton}
                disabled={pending}
                onClick={() => void runGuarded(cancelAndResolve)}
              >
                Отменить заказ и закрыть проблему
              </button>
              <div className={styles.reassignBlock}>
                <label htmlFor={`incident-driver-${incident.id}`}>Свободный водитель</label>
                <select
                  id={`incident-driver-${incident.id}`}
                  value={selectedDriverId}
                  disabled={pending}
                  onChange={(event) => setSelectedDriverId(event.target.value)}
                >
                  <option value="">Выберите водителя</option>
                  {candidates.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
                </select>
                <ActionButton pending={pending} onClick={() => void runGuarded(reassignAndResolve)}>
                  Переназначить и закрыть проблему
                </ActionButton>
              </div>
            </>
          ) : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </div>
      ) : null}
    </article>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function ActionButton({
  pending,
  onClick,
  children,
}: {
  pending: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return <button type="button" disabled={pending} onClick={onClick}>{children}</button>;
}
