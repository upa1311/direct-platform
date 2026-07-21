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
import {
  buildRestaurantSettlementPreview,
  getRestaurantSettlementRecords,
} from "@/prototype/restaurant-settlement-records";
import {
  canConfirmSettlement,
  describeSettlementNet,
  formatSettlementSuccess,
  openEntryIds,
  pluralObligations,
  reconcileSelection,
  selectionCheckboxLabel,
  settlementConfirmLabel,
  settlementHistoryLabel,
  toSettlementHistoryRows,
  type SettlementSuccess,
} from "./settlement-selection";
import styles from "./admin-settlements.module.css";

type StatusFilter = "OPEN" | "CLOSED" | "ALL";
type DirectionFilter =
  | "ALL"
  | "RESTAURANT_OWES_DIRECT"
  | "DIRECT_OWES_RESTAURANT";

export default function AdminSettlementsPage() {
  const { state, isHydrated, confirmSettlement } = usePrototype();
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

  // Групповой расчёт: выбор обязательств и форма подтверждения.
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [settlementNote, setSettlementNote] = useState("");
  const [settlementReference, setSettlementReference] = useState("");
  const [settlementSuccess, setSettlementSuccess] =
    useState<SettlementSuccess | null>(null);
  const {
    error: settlementError,
    pending: settlementPending,
    run: runSettlement,
    clearError: clearSettlementError,
  } = useMutationGuard();

  const activeRestaurantId = restaurants.some((r) => r.id === selectedRestaurantId)
    ? selectedRestaurantId
    : (restaurants[0]?.id ?? "");

  const selectRestaurant = (id: string) => {
    setSelectedRestaurantId(id);
    // Подтверждение одного ресторана не должно показываться под другим.
    setConfirmation(null);
    // Выбор, форма и результат относятся к конкретному ресторану.
    setSelectedEntryIds([]);
    setSettlementNote("");
    setSettlementReference("");
    setSettlementSuccess(null);
    clearSettlementError();
  };

  const changeStatusFilter = (next: StatusFilter) => {
    setStatusFilter(next);
    // Уходя с «Открытых», снимаем выбор: администратор не должен подтверждать
    // строки, которых сейчас не видит.
    if (next !== "OPEN") {
      setSelectedEntryIds([]);
    }
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

  const allRows = useMemo(() => view?.rows ?? [], [view]);

  // Согласование выбора со свежим состоянием — производно, без setState в
  // эффекте: другая вкладка могла закрыть обязательство между preview и
  // подтверждением, и такие id просто перестают участвовать в расчёте.
  const effectiveSelectedIds = useMemo(
    () => reconcileSelection(selectedEntryIds, allRows),
    [selectedEntryIds, allRows],
  );

  // Канонический preview: единственный источник gross и net для формы.
  const settlementPreview = useMemo(() => {
    if (effectiveSelectedIds.length === 0 || !activeRestaurantId) return null;
    return buildRestaurantSettlementPreview(
      state,
      activeRestaurantId,
      effectiveSelectedIds,
    );
  }, [state, activeRestaurantId, effectiveSelectedIds]);

  const previewOk = settlementPreview?.ok ? settlementPreview.preview : null;
  const previewNet = previewOk
    ? describeSettlementNet(previewOk.netDirection)
    : null;

  const settlementRecords = useMemo(
    () =>
      activeRestaurantId
        ? toSettlementHistoryRows(
            getRestaurantSettlementRecords(state, activeRestaurantId),
          )
        : [],
    [state, activeRestaurantId],
  );

  const openIds = openEntryIds(allRows);
  const canSubmitSettlement = canConfirmSettlement({
    hasSelection: effectiveSelectedIds.length > 0,
    previewOk: previewOk !== null,
    netAmountCents: previewOk?.netAmountCents ?? null,
    note: settlementNote,
    reference: settlementReference,
    pending: settlementPending,
  });

  const toggleEntry = (entryId: string) => {
    setSettlementSuccess(null);
    clearSettlementError();
    setSelectedEntryIds((current) =>
      current.includes(entryId)
        ? current.filter((id) => id !== entryId)
        : [...current, entryId],
    );
  };

  const submitSettlement = async () => {
    if (!canSubmitSettlement || !previewOk) return;
    const confirmed = previewOk;
    const res = await runSettlement(async () => {
      const r = await confirmSettlement(
        activeRestaurantId,
        effectiveSelectedIds,
        settlementNote,
        settlementReference.trim() ? settlementReference : null,
      );
      return { ok: r.ok, error: r.error, changed: r.ok };
    });
    // Успех показывается только после реального ok доменного действия.
    if (res.ok) {
      setSettlementSuccess({
        netDirection: confirmed.netDirection,
        netAmountCents: confirmed.netAmountCents,
        entryCount: confirmed.entryCount,
      });
      setSelectedEntryIds([]);
      setSettlementNote("");
      setSettlementReference("");
    }
  };

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

        {!isHydrated ? (
          <div className={styles.empty}>Загружаем расчёты…</div>
        ) : !view ? (
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

            {/* Новый групповой расчёт: выбор обязательств → канонический
                preview → одно доменное подтверждение. */}
            <h2 className={styles.sectionTitle}>Новый расчёт</h2>
            <section className={styles.settlementPanel} aria-label="Новый расчёт">
              <div className={styles.settlementSelectionRow}>
                <span className={styles.settlementSelected}>
                  Выбрано: {effectiveSelectedIds.length}{" "}
                  {pluralObligations(effectiveSelectedIds.length)}
                </span>
                <div className={styles.settlementSelectionActions}>
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={openIds.length === 0 || settlementPending}
                    onClick={() => {
                      setSettlementSuccess(null);
                      clearSettlementError();
                      setSelectedEntryIds(openIds);
                    }}
                  >
                    Выбрать все открытые
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={
                      effectiveSelectedIds.length === 0 || settlementPending
                    }
                    onClick={() => {
                      setSettlementSuccess(null);
                      clearSettlementError();
                      setSelectedEntryIds([]);
                    }}
                  >
                    Снять выбор
                  </button>
                </div>
              </div>

              {effectiveSelectedIds.length === 0 ? (
                <p className={styles.settlementHint}>
                  Отметьте открытые обязательства в таблице ниже, чтобы
                  зафиксировать расчёт.
                </p>
              ) : settlementPreview && !settlementPreview.ok ? (
                <p className={styles.error} role="alert">
                  {settlementPreview.error}
                </p>
              ) : previewOk && previewNet ? (
                <>
                  <div className={styles.settlementPreview}>
                    <PositionCard
                      label="Выбрано обязательств"
                      value={String(previewOk.entryCount)}
                    />
                    <PositionCard
                      label="Ресторан должен Direct"
                      value={formatMoney(previewOk.restaurantOwesDirectCents)}
                    />
                    <PositionCard
                      label="Direct должен ресторану"
                      value={formatMoney(previewOk.directOwesRestaurantCents)}
                    />
                  </div>
                  <div className={styles.settlementNet}>
                    <span className={styles.settlementNetLabel}>
                      {previewNet.title}
                    </span>
                    <span className={styles.settlementNetValue}>
                      {formatMoney(previewOk.netAmountCents)}
                    </span>
                  </div>
                  <p className={styles.confirmNote}>{previewNet.warning}</p>

                  <div className={styles.settlementForm}>
                    <label className={styles.field}>
                      <span>Основание расчёта</span>
                      <textarea
                        value={settlementNote}
                        maxLength={ACCOUNTING_RESOLUTION_NOTE_MAX}
                        disabled={settlementPending}
                        onChange={(e) => {
                          setSettlementNote(e.target.value);
                          clearSettlementError();
                        }}
                        placeholder="Опишите основание расчёта"
                      />
                    </label>
                    <label className={styles.field}>
                      <span>
                        Номер платежа или документа
                        {previewOk.netAmountCents > 0 ? "" : " (необязательно)"}
                      </span>
                      <input
                        value={settlementReference}
                        maxLength={ACCOUNTING_RESOLUTION_REFERENCE_MAX}
                        disabled={settlementPending}
                        onChange={(e) => {
                          setSettlementReference(e.target.value);
                          clearSettlementError();
                        }}
                        placeholder="Номер операции / документа"
                      />
                      <span className={styles.hint}>
                        Например: номер банковской операции, кассового документа
                        или акта сверки.
                      </span>
                    </label>
                  </div>

                  {settlementError ? (
                    <p className={styles.error} role="alert">
                      {settlementError}
                    </p>
                  ) : null}

                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={!canSubmitSettlement}
                      onClick={() => void submitSettlement()}
                    >
                      {settlementPending
                        ? "Сохраняем расчёт…"
                        : settlementConfirmLabel(previewOk.netDirection)}
                    </button>
                  </div>
                </>
              ) : null}

              {settlementSuccess ? (
                <div
                  className={styles.confirmBanner}
                  role="status"
                  aria-live="polite"
                >
                  <span>
                    Расчёт подтверждён.{" "}
                    {formatSettlementSuccess(
                      settlementSuccess,
                      formatMoney(settlementSuccess.netAmountCents),
                    )}
                  </span>
                  <button
                    type="button"
                    className={styles.confirmClose}
                    onClick={() => setSettlementSuccess(null)}
                  >
                    Закрыть сообщение
                  </button>
                </div>
              ) : null}
            </section>

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
                  onClick={() => changeStatusFilter(value)}
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
                      <th>Выбрать</th>
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
                        selected={effectiveSelectedIds.includes(row.entryId)}
                        onToggleSelect={toggleEntry}
                        selectionDisabled={settlementPending}
                        onResolved={setConfirmation}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* История групповых расчётов — только из канонических записей. */}
            <h2 className={styles.sectionTitle}>История расчётов</h2>
            {settlementRecords.length === 0 ? (
              <div className={styles.empty}>
                Подтверждённых групповых расчётов пока нет.
              </div>
            ) : (
              <div className={styles.historyList}>
                {settlementRecords.map((record) => (
                  <article className={styles.historyCard} key={record.id}>
                    <div className={styles.historyHead}>
                      <span className={styles.historyDate}>
                        {formatDateTime(record.settledAt)}
                      </span>
                      <span className={styles.historyDirection}>
                        {settlementHistoryLabel(record.netDirection)}
                      </span>
                      <span className={styles.historyAmount}>
                        {formatMoney(record.netAmountCents)}
                      </span>
                    </div>
                    <dl className={styles.historyGross}>
                      <div className={styles.historyGrossRow}>
                        <dt>Ресторан должен Direct</dt>
                        <dd>{formatMoney(record.restaurantOwesDirectCents)}</dd>
                      </div>
                      <div className={styles.historyGrossRow}>
                        <dt>Direct должен ресторану</dt>
                        <dd>{formatMoney(record.directOwesRestaurantCents)}</dd>
                      </div>
                    </dl>
                    <p className={styles.historyNote}>{record.note}</p>
                    {record.externalReference ? (
                      <p className={styles.subtle}>
                        Ссылка: {record.externalReference}
                      </p>
                    ) : null}
                    <details className={styles.historyDetails}>
                      <summary>Подробности</summary>
                      <p className={styles.subtle}>
                        Количество обязательств: {record.entryCount}
                      </p>
                    </details>
                  </article>
                ))}
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

/**
 * Строка журнала обязательств. Расчёт (SETTLED) выполняется ТОЛЬКО групповым
 * workflow с записью RestaurantSettlementRecord, поэтому одиночного закрытия
 * обязательства из строки здесь больше нет. Осталось отдельное списание
 * комиссионного требования Direct (WAIVED): оно не создаёт запись расчёта и
 * доступно только там, где домен это разрешает (row.canWaive) — выплату
 * ресторану списать нельзя.
 */
function AccountingRow({
  row,
  selected,
  onToggleSelect,
  selectionDisabled,
  onResolved,
}: {
  row: AdminAccountingRow;
  selected: boolean;
  onToggleSelect: (entryId: string) => void;
  selectionDisabled: boolean;
  onResolved: (confirmation: AccountingResolutionConfirmation) => void;
}) {
  const { resolveAccountingEntry } = usePrototype();
  const { error, pending, run, clearError } = useMutationGuard();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");

  const canSubmit = note.trim().length > 0 && !pending;
  const amountText = formatMoney(row.amountCents);

  const submitWaive = async () => {
    if (!canSubmit) return;
    const res = await run(async () => {
      const r = await resolveAccountingEntry(
        row.entryId,
        "WAIVED",
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
        outcome: "WAIVED",
        publicNumber: row.publicNumber,
        amountText,
      });
    }
  };

  return (
    <>
      <tr>
        <td>
          {row.status === "OPEN" ? (
            <input
              type="checkbox"
              checked={selected}
              disabled={selectionDisabled}
              aria-label={selectionCheckboxLabel(row, amountText)}
              onChange={() => onToggleSelect(row.entryId)}
            />
          ) : (
            <span className={styles.subtle} aria-hidden="true">
              —
            </span>
          )}
        </td>
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
            // Расчёт выполняется только групповым workflow выше; здесь
            // осталось лишь списание комиссионного требования Direct.
            row.canWaive && !open ? (
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  setOpen(true);
                  clearError();
                }}
              >
                Списать комиссию
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

      {row.status === "OPEN" && row.canWaive && open ? (
        <tr>
          <td colSpan={11}>
            <div className={styles.form}>
              <label className={styles.field}>
                <span>Основание списания</span>
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
                Комиссионное требование Direct будет списано. Это не возврат, не
                выплата ресторану и не групповой расчёт: запись расчёта не
                создаётся.
              </p>

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
                  onClick={() => void submitWaive()}
                >
                  {pending ? "Сохраняем…" : "Списать комиссию Direct"}
                </button>
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
