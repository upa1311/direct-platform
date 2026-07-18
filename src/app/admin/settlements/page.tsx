"use client";

import { useMemo, useState } from "react";

import { PageHeading } from "@/components/workspaces/route-content";
import { useMutationGuard } from "@/components/util/use-mutation-guard";
import { usePrototype } from "@/prototype/prototype-provider";
import { formatDateTime, formatMoney, getPickupStats } from "@/prototype/selectors";
import {
  ACCOUNTING_DIRECTION_LABELS,
  ACCOUNTING_RESOLUTION_NOTE_MAX,
  ACCOUNTING_RESOLUTION_REFERENCE_MAX,
  ACCOUNTING_SOURCE_LABELS,
  ACCOUNTING_STATUS_LABELS,
  ACCOUNTING_TYPE_LABELS,
  buildAdminAccountingView,
  formatAccountingResolutionMessage,
  type AccountingResolutionConfirmation,
  type AdminAccountingRow,
} from "@/prototype/restaurant-accounting";
import styles from "./admin-settlements.module.css";

type StatusFilter = "OPEN" | "CLOSED" | "ALL";
type DirectionFilter =
  | "ALL"
  | "RESTAURANT_OWES_DIRECT"
  | "DIRECT_OWES_RESTAURANT";

export default function AdminSettlementsPage() {
  const { state } = usePrototype();
  // Все известные рестораны (в т.ч. архивные/остановленные), чтобы история
  // сверки не исчезала вместе с публикацией.
  const restaurants = state.restaurants;
  const [selectedRestaurantId, setSelectedRestaurantId] = useState(
    restaurants[0]?.id ?? "",
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("OPEN");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("ALL");
  // Спокойное подтверждение остаётся видимым, даже когда закрытая строка уходит
  // из фильтра «Открытые». Живёт в родителе, не внутри строки.
  const [confirmation, setConfirmation] =
    useState<AccountingResolutionConfirmation | null>(null);

  const activeRestaurantId = restaurants.some((r) => r.id === selectedRestaurantId)
    ? selectedRestaurantId
    : (restaurants[0]?.id ?? "");

  const selectRestaurant = (id: string) => {
    setSelectedRestaurantId(id);
    // Подтверждение одного ресторана не должно показываться под другим.
    setConfirmation(null);
  };

  const view = useMemo(
    () =>
      activeRestaurantId
        ? buildAdminAccountingView(state, activeRestaurantId)
        : null,
    [state, activeRestaurantId],
  );
  const stats = activeRestaurantId
    ? getPickupStats(state, activeRestaurantId)
    : null;

  const visibleRows = (view?.rows ?? []).filter((row) => {
    const statusOk =
      statusFilter === "ALL"
        ? true
        : statusFilter === "OPEN"
          ? row.status === "OPEN"
          : row.status !== "OPEN";
    const directionOk =
      directionFilter === "ALL" ? true : row.direction === directionFilter;
    return statusOk && directionOk;
  });

  const netHint = view
    ? view.netPositionCents > 0
      ? "Direct должен ресторану."
      : view.netPositionCents < 0
        ? "Ресторан должен Direct."
        : "Открытые обязательства взаимно равны."
    : "";

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Расчёты с ресторанами"
        description="Открытые обязательства Direct и ресторанов, история решений и административная фиксация внешних расчётов."
      />

      <div className={styles.container}>
        <div className={styles.toolbar}>
          <label className={styles.field} style={{ maxWidth: "100%" }}>
            <span>Ресторан</span>
            <select
              className={styles.select}
              aria-label="Выбрать ресторан"
              value={activeRestaurantId}
              onChange={(e) => selectRestaurant(e.target.value)}
            >
              {restaurants.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!view ? (
          <div className={styles.empty}>Рестораны не найдены.</div>
        ) : (
          <>
            {/* Позиция за всё время */}
            <div className={styles.cards}>
              <PositionCard label="Ресторан должен Direct" value={formatMoney(view.openReceivableCents)} />
              <PositionCard label="Direct должен ресторану" value={formatMoney(view.openPayableCents)} />
              <PositionCard label="Чистая позиция" value={formatMoney(view.netPositionCents)} hint={netHint} />
              <PositionCard label="Открытых обязательств" value={String(view.openCount)} />
              <PositionCard label="Закрытых обязательств" value={String(view.closedCount)} />
            </div>

            <div className={styles.info}>
              <p>
                Это информационная позиция открытых обязательств. Система не
                выполняет автоматический взаимозачёт, списание со счёта или
                банковскую выплату.
              </p>
            </div>

            {/* Спокойное подтверждение результата — остаётся видимым, когда
                закрытая строка уходит из фильтра «Открытые». */}
            {confirmation ? (
              <div
                className={styles.confirmBanner}
                role="status"
                aria-live="polite"
              >
                <span>{formatAccountingResolutionMessage(confirmation)}</span>
                <button
                  type="button"
                  className={styles.confirmClose}
                  onClick={() => setConfirmation(null)}
                >
                  Закрыть сообщение
                </button>
              </div>
            ) : null}

            {/* Фильтры журнала */}
            <h2 className={styles.sectionTitle}>Обязательства</h2>
            <div className={styles.filters} role="group" aria-label="Статус">
              {(
                [
                  ["OPEN", "Открытые"],
                  ["CLOSED", "Закрытые"],
                  ["ALL", "Все"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={styles.filterButton}
                  aria-pressed={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={styles.filters} role="group" aria-label="Направление">
              {(
                [
                  ["ALL", "Все направления"],
                  ["RESTAURANT_OWES_DIRECT", "Ресторан должен Direct"],
                  ["DIRECT_OWES_RESTAURANT", "Direct должен ресторану"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={styles.filterButton}
                  aria-pressed={directionFilter === value}
                  onClick={() => setDirectionFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            {visibleRows.length === 0 ? (
              <div className={styles.empty}>
                Обязательств по выбранным фильтрам нет.
              </div>
            ) : (
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Дата признания</th>
                      <th>Заказ</th>
                      <th>Ресторан</th>
                      <th>Кто кому должен</th>
                      <th>Основание</th>
                      <th className={styles.num}>Сумма</th>
                      <th>Статус</th>
                      <th>Источник</th>
                      <th>Дата закрытия</th>
                      <th>Решение</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <AccountingRow
                        key={row.entryId}
                        row={row}
                        onResolved={setConfirmation}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Второстепенная статистика самовывоза (не бухгалтерский баланс). */}
            {stats ? (
              <>
                <h2 className={styles.sectionTitle}>Статистика самовывоза</h2>
                <div className={styles.statsGrid}>
                  <Stat label="Выдано самовывозом" value={String(stats.issued)} />
                  <Stat label="Невыкуплено" value={String(stats.noShow)} />
                  <Stat label="Процент неявок" value={`${stats.noShowPercent}%`} />
                  <Stat
                    label="Подозрительные отмены после готовности"
                    value={String(stats.suspiciousAfterReady)}
                  />
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function PositionCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className={styles.card}>
      <span className={styles.cardLabel}>{label}</span>
      <span className={styles.cardValue}>{value}</span>
      {hint ? <span className={styles.cardHint}>{hint}</span> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.statCell}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

function AccountingRow({
  row,
  onResolved,
}: {
  row: AdminAccountingRow;
  onResolved: (confirmation: AccountingResolutionConfirmation) => void;
}) {
  const { resolveAccountingEntry } = usePrototype();
  const { error, pending, run, clearError } = useMutationGuard();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");

  const canSubmit = note.trim().length > 0 && !pending;

  const submit = async (outcome: "SETTLED" | "WAIVED") => {
    if (!canSubmit) return;
    const res = await run(async () => {
      const r = await resolveAccountingEntry(
        row.entryId,
        outcome,
        note,
        reference.trim() ? reference : null,
      );
      return { ok: r.ok, error: r.error, changed: r.ok };
    });
    // Подтверждение — только при реальном успехе; при domain/infra error нет.
    if (res.ok) {
      setOpen(false);
      setNote("");
      setReference("");
      onResolved({
        outcome,
        publicNumber: row.publicNumber,
        amountText: formatMoney(row.amountCents),
      });
    }
  };

  return (
    <>
      <tr>
        <td>{formatDateTime(row.recognizedAt)}</td>
        <td className={styles.orderNumber}>
          {row.publicNumber ?? "Старое начисление"}
        </td>
        <td>{row.restaurantName}</td>
        <td>{ACCOUNTING_DIRECTION_LABELS[row.direction]}</td>
        <td>{ACCOUNTING_TYPE_LABELS[row.type]}</td>
        <td className={styles.num}>{formatMoney(row.amountCents)}</td>
        <td>{ACCOUNTING_STATUS_LABELS[row.status]}</td>
        <td>{ACCOUNTING_SOURCE_LABELS[row.source]}</td>
        <td>{row.settledAt ? formatDateTime(row.settledAt) : "—"}</td>
        <td>
          {row.status === "OPEN" ? (
            !open ? (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => {
                  setOpen(true);
                  clearError();
                }}
              >
                Зафиксировать расчёт
              </button>
            ) : null
          ) : row.resolution ? (
            <div className={styles.audit}>
              <span className={styles.auditDecision}>
                {row.resolution.outcome === "SETTLED"
                  ? "Расчёт подтверждён"
                  : "Комиссия списана"}
              </span>
              <span className={styles.subtle}>
                {formatDateTime(row.resolution.occurredAt)}
              </span>
              <span>{row.resolution.note}</span>
              {row.resolution.externalReference ? (
                <span className={styles.subtle}>
                  Ссылка: {row.resolution.externalReference}
                </span>
              ) : null}
            </div>
          ) : (
            <span className={styles.subtle}>—</span>
          )}
        </td>
      </tr>

      {row.status === "OPEN" && open ? (
        <tr>
          <td colSpan={10}>
            <div className={styles.form}>
              <label className={styles.field}>
                <span>Основание решения</span>
                <textarea
                  value={note}
                  maxLength={ACCOUNTING_RESOLUTION_NOTE_MAX}
                  disabled={pending}
                  onChange={(e) => {
                    setNote(e.target.value);
                    clearError();
                  }}
                  placeholder="Опишите основание решения"
                />
              </label>
              <label className={styles.field}>
                <span>Внешняя ссылка (необязательно)</span>
                <input
                  value={reference}
                  maxLength={ACCOUNTING_RESOLUTION_REFERENCE_MAX}
                  disabled={pending}
                  onChange={(e) => {
                    setReference(e.target.value);
                    clearError();
                  }}
                  placeholder="Номер операции / документа"
                />
                <span className={styles.hint}>
                  Например, номер банковской операции, кассового документа или
                  сверки.
                </span>
              </label>

              <p className={styles.confirmNote}>
                Будет зафиксировано, что внешний расчёт исполнен. Денежный перевод
                системой не выполняется.
              </p>
              {row.canWaive ? (
                <p className={styles.confirmNote}>
                  Списание: комиссионное требование Direct будет списано. Это
                  действие не является возвратом или выплатой ресторану.
                </p>
              ) : null}

              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}

              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={!canSubmit}
                  onClick={() => void submit("SETTLED")}
                >
                  {pending ? "Сохраняем…" : "Подтвердить исполнение"}
                </button>
                {row.canWaive ? (
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={!canSubmit}
                    onClick={() => void submit("WAIVED")}
                  >
                    Списать комиссию Direct
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.btn}
                  disabled={pending}
                  onClick={() => {
                    setOpen(false);
                    clearError();
                  }}
                >
                  Отмена
                </button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
