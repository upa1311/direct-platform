"use client";

import { useMemo, useState } from "react";

import kds from "@/components/kitchen/kitchen.module.css";
import { useRestaurantWorkspace } from "@/components/workspaces/restaurant-workspace";
import { useNowMs } from "@/components/util/use-now";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  deliveryModeLabels,
  formatMoney,
  getRestaurant,
  getRestaurantTimeZoneLabel,
  paymentStatusLabels,
  settlementStatusLabels,
  settlementTypeLabels,
} from "@/prototype/selectors";
import {
  buildRestaurantDailySettlement,
  buildRestaurantSettlementOverview,
  RESTAURANT_SETTLEMENT_PERIOD_LABELS,
  RESTAURANT_SETTLEMENT_PERIOD_ORDER,
  SETTLEMENT_COLLECTOR_LABELS,
  type RestaurantDailySettlementRow,
  type RestaurantSettlementPeriod,
} from "@/prototype/restaurant-settlements";
import {
  ACCOUNTING_DIRECTION_LABELS,
  ACCOUNTING_SOURCE_LABELS,
  ACCOUNTING_STATUS_LABELS,
  ACCOUNTING_TYPE_LABELS,
  buildRestaurantAccountingJournal,
  getRestaurantNetPositionCents,
  getRestaurantOpenPayableCents,
  getRestaurantOpenReceivableCents,
  type RestaurantAccountingJournalRow,
} from "@/prototype/restaurant-accounting";
import {
  buildRestaurantStatementView,
  type RestaurantStatementCurrencySection,
  type RestaurantStatementRecognitionViewRow,
  type RestaurantStatementResolutionViewRow,
  type RestaurantStatementViewResult,
} from "@/prototype/restaurant-statement-view";
import { defaultStatementRange } from "./statement-range";
import {
  visibleStatementSnapshot,
  type StatementSnapshot,
} from "./statement-snapshot";
import { buildStatementCsvExport } from "./statement-csv-export";
import type { RestaurantStatementCsvFile } from "@/prototype/restaurant-statement-csv";
import { buildStatementPrintModel, type StatementPrintModel } from "./statement-print";
import styles from "./settlements.module.css";
import "./statement-print.css";

import type { PrototypeState } from "@/prototype/models";

/** Вид раздела: по заказам, по дням, журнал обязательств или выписка. */
type SettlementView = "ORDERS" | "DAILY" | "OBLIGATIONS" | "STATEMENT";

/** Локальная дата ресторана YYYY-MM-DD → «16.07.2026» без пересчёта пояса. */
function formatLocalDateRu(localDate: string): string {
  const [y, m, d] = localDate.split("-");
  if (!y || !m || !d) return localDate;
  return `${d}.${m}.${y}`;
}

/**
 * Клиентское скачивание CSV: один клик → один файл. Blob + object URL, после
 * запуска скачивания object URL немедленно отзывается (revokeObjectURL). Без
 * внешних библиотек и серверного endpoint.
 */
function triggerCsvDownload(file: RestaurantStatementCsvFile): void {
  const blob = new Blob([file.content], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = file.fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Дата-время завершения/отмены в часовом поясе ресторана, ru-RU. */
function formatInZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timeZone || "Europe/Chisinau",
    }).format(new Date(iso));
  } catch {
    return "—";
  }
}

/**
 * Первый read-only раздел ресторанной бухгалтерии «Расчёты». Все цифры — из
 * неизменяемых order.financials; статус начисления — из существующего commission
 * ledger. Мутаций и пересчёта старых заказов нет. Одна и та же страница в
 * COMBINED и SPLIT; роль не влияет на финансовые данные.
 */
export default function RestaurantSettlementsPage() {
  const { state, isHydrated } = usePrototype();
  const { selectedRestaurantId, setSelectedRestaurantId, workspaceRestaurants } =
    useRestaurantWorkspace();
  const nowMs = useNowMs();
  const [period, setPeriod] = useState<RestaurantSettlementPeriod>("TODAY");
  const [view, setView] = useState<SettlementView>("ORDERS");

  const restaurant = getRestaurant(state, selectedRestaurantId);
  const timeZone = restaurant?.timeZone ?? "Europe/Chisinau";

  const overview = useMemo(() => {
    if (!isHydrated || nowMs === 0 || !restaurant) return null;
    return buildRestaurantSettlementOverview(
      state,
      selectedRestaurantId,
      period,
      new Date(nowMs).toISOString(),
      timeZone,
    );
  }, [isHydrated, nowMs, restaurant, state, selectedRestaurantId, period, timeZone]);

  const daily = useMemo(() => {
    if (view !== "DAILY" || !isHydrated || nowMs === 0 || !restaurant) return null;
    return buildRestaurantDailySettlement(
      state,
      selectedRestaurantId,
      period,
      new Date(nowMs).toISOString(),
      timeZone,
    );
  }, [view, isHydrated, nowMs, restaurant, state, selectedRestaurantId, period, timeZone]);

  // Открытая позиция двустороннего журнала — не зависит от выбранного периода.
  const position = useMemo(() => {
    if (!isHydrated || !restaurant) return null;
    return {
      receivable: getRestaurantOpenReceivableCents(state, selectedRestaurantId),
      payable: getRestaurantOpenPayableCents(state, selectedRestaurantId),
      net: getRestaurantNetPositionCents(state, selectedRestaurantId),
    };
  }, [isHydrated, restaurant, state, selectedRestaurantId]);

  // Журнал обязательств — вся история, независимо от периода отчёта.
  const journal = useMemo(() => {
    if (view !== "OBLIGATIONS" || !isHydrated || !restaurant) return null;
    return buildRestaurantAccountingJournal(state, selectedRestaurantId);
  }, [view, isHydrated, restaurant, state, selectedRestaurantId]);

  const money = (cents: number) =>
    formatMoney(cents, overview?.currencyCode ?? "USD");

  return (
    <div className={`${kds.screen} direct-print-root`}>
      <div className={kds.toolbar}>
        <div className={kds.toolbarLeft}>
          <span className={kds.brand}>Расчёты</span>
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

      {!isHydrated || !overview ? (
        <div className={kds.empty}>Загружаем расчёты…</div>
      ) : !restaurant ? (
        <div className={kds.empty}>Ресторан не найден.</div>
      ) : (
        <div className={`${styles.container} direct-print-screen`}>
          {/* Переключатель периода */}
          <div className={styles.periods} role="group" aria-label="Период">
            {RESTAURANT_SETTLEMENT_PERIOD_ORDER.map((p) => (
              <button
                key={p}
                type="button"
                className={styles.periodButton}
                aria-pressed={period === p}
                onClick={() => setPeriod(p)}
              >
                {RESTAURANT_SETTLEMENT_PERIOD_LABELS[p]}
              </button>
            ))}
          </div>

          {/* Внутренний переключатель представления (не пункт навигации). */}
          <div className={styles.periods} role="group" aria-label="Представление">
            <button
              type="button"
              className={styles.periodButton}
              aria-pressed={view === "ORDERS"}
              onClick={() => setView("ORDERS")}
            >
              По заказам
            </button>
            <button
              type="button"
              className={styles.periodButton}
              aria-pressed={view === "DAILY"}
              onClick={() => setView("DAILY")}
            >
              По дням
            </button>
            <button
              type="button"
              className={styles.periodButton}
              aria-pressed={view === "OBLIGATIONS"}
              onClick={() => setView("OBLIGATIONS")}
            >
              Обязательства
            </button>
            <button
              type="button"
              className={styles.periodButton}
              aria-pressed={view === "STATEMENT"}
              onClick={() => setView("STATEMENT")}
            >
              Выписка
            </button>
          </div>

          {/* Сводные показатели */}
          <div className={styles.summaryGrid}>
            <SummaryCard label="Завершённые заказы" value={String(overview.summary.completedOrderCount)} />
            <SummaryCard label="Стоимость заказов" value={money(overview.summary.customerTotalCents)} />
            <SummaryCard label="Продажи блюд" value={money(overview.summary.foodSubtotalCents)} />
            <SummaryCard label="Чисто ресторану" value={money(overview.summary.restaurantNetCents)} />
            <SummaryCard label="Собрано рестораном с клиентов" value={money(overview.summary.restaurantCollectedFromCustomerCents)} />
            <SummaryCard
              label="Собрано Direct с клиентов"
              value={money(overview.summary.platformCollectedFromCustomerCents)}
              hint="Информационный показатель снимка, не подтверждённая выплата."
            />
            <SummaryCard
              label="Комиссия Direct по финансовым снимкам"
              value={money(overview.summary.platformCommissionReceivableCents)}
              hint="По финансовым снимкам заказов."
            />
            <SummaryCard
              label="Ожидает расчёта по журналу комиссий"
              value={money(overview.summary.pendingLedgerCents)}
              hint="Только начисления со статусом „Ожидает расчёта“ в журнале комиссий."
            />
          </div>

          {/* Объяснение */}
          <div className={styles.info}>
            <p>
              Расчёты построены по финансовым снимкам заказов. Открытые
              обязательства между Direct и рестораном фиксируются в отдельном
              двустороннем журнале. Исполнение или допустимое списание фиксирует
              администратор Direct. Система не выполняет автоматический
              взаимозачёт или банковский перевод.
            </p>
            <p>
              Показатель «Ожидает расчёта по журналу комиссий» относится только к
              старому журналу комиссий, который сохранён для совместимости.
            </p>
            <p className={styles.footnote}>
              Раздел предназначен для операционной сверки, а не заменяет
              бухгалтерский учёт.
            </p>
          </div>

          {/* Взаимные обязательства — открытая позиция за всё время (не зависит
              от переключателя периода). */}
          {position ? (
            <>
              <h2 className={styles.sectionTitle}>
                Взаимные обязательства · за всё время
              </h2>
              <div className={styles.summaryGrid}>
                <SummaryCard
                  label="Ресторан должен Direct"
                  value={money(position.receivable)}
                />
                <SummaryCard
                  label="Direct должен ресторану"
                  value={money(position.payable)}
                />
                <SummaryCard
                  label="Чистая позиция"
                  value={money(position.net)}
                  hint={
                    position.net > 0
                      ? "Direct должен ресторану."
                      : position.net < 0
                        ? "Ресторан должен Direct."
                        : "Открытые обязательства взаимно равны."
                  }
                />
              </div>
              <div className={styles.info}>
                <p>
                  Эти суммы показывают все открытые обязательства и не зависят от
                  выбранного периода отчёта.
                </p>
                <p>
                  Чистая позиция — информационная разница открытых обязательств.
                  Автоматический взаимозачёт и фактическая выплата не выполняются.
                </p>
              </div>
            </>
          ) : null}

          {view === "DAILY" ? (
            <DailyView days={daily ?? []} money={money} />
          ) : view === "OBLIGATIONS" ? (
            <ObligationsView rows={journal ?? []} money={money} timeZone={timeZone} />
          ) : view === "STATEMENT" ? (
            // key по restaurantId:timeZone принудительно перемонтирует секцию при
            // смене контекста — синхронная изоляция без stale-render на первый кадр.
            <RestaurantStatementSection
              key={`${selectedRestaurantId}:${timeZone}`}
              state={state}
              restaurantId={selectedRestaurantId}
              timeZone={timeZone}
              nowMs={nowMs}
            />
          ) : (
            <OrdersView overview={overview} money={money} timeZone={timeZone} />
          )}
        </div>
      )}
    </div>
  );
}

/** Представление «По заказам» — существующая таблица и «Требуют внимания». */
function OrdersView({
  overview,
  money,
  timeZone,
}: {
  overview: NonNullable<ReturnType<typeof buildRestaurantSettlementOverview>>;
  money: (cents: number) => string;
  timeZone: string;
}) {
  return (
    <>
      {/* Завершённые заказы */}
      <h2 className={styles.sectionTitle}>Завершённые заказы</h2>
      {overview.rows.length === 0 ? (
            <div className={styles.empty}>
              За выбранный период завершённых заказов нет.
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Завершён</th>
                    <th>Заказ</th>
                    <th>Способ</th>
                    <th>Статус</th>
                    <th className={styles.num}>Стоимость</th>
                    <th className={styles.num}>Блюда</th>
                    <th>Собрал</th>
                    <th className={styles.num}>Собрал ресторан</th>
                    <th className={styles.num}>Собрал Direct</th>
                    <th className={styles.num}>Комиссия Direct</th>
                    <th className={styles.num}>Чисто ресторану</th>
                    <th>Комиссионное начисление</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.rows.map((row) => (
                    <tr key={row.orderId}>
                      <td>{formatInZone(row.completedAt, timeZone)}</td>
                      <td className={styles.orderNumber}>{row.publicNumber}</td>
                      <td>{deliveryModeLabels[row.deliveryMode]}</td>
                      <td>
                        {row.completionStatus === "DELIVERED"
                          ? "Доставлен"
                          : "Получен"}
                      </td>
                      <td className={styles.money}>{money(row.customerTotalCents)}</td>
                      <td className={styles.money}>{money(row.foodSubtotalCents)}</td>
                      <td>{SETTLEMENT_COLLECTOR_LABELS[row.collector]}</td>
                      <td className={styles.money}>
                        {money(row.restaurantCollectedFromCustomerCents)}
                      </td>
                      <td className={styles.money}>
                        {money(row.platformCollectedFromCustomerCents)}
                      </td>
                      <td className={styles.money}>
                        {money(row.platformCommissionReceivableCents)}
                      </td>
                      <td className={styles.money}>
                        {money(row.restaurantNetAfterPlatformCommissionCents)}
                      </td>
                      <td>
                        {row.ledger
                          ? `${settlementTypeLabels[row.ledger.type]} · ${money(row.ledger.amountCents)} · ${settlementStatusLabels[row.ledger.status]}`
                          : "Начисления нет"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Требуют внимания — оплаченные отменённые */}
          {overview.paidCanceled.length > 0 ? (
            <>
              <h2 className={styles.sectionTitle}>Требуют внимания</h2>
              {overview.paidCanceled.map((row) => (
                <div className={styles.attentionCard} key={row.orderId}>
                  <div className={styles.attentionRow}>
                    <strong className={styles.orderNumber}>{row.publicNumber}</strong>
                    <span>{formatInZone(row.canceledAt, timeZone)}</span>
                    <span>{deliveryModeLabels[row.deliveryMode]}</span>
                    <span>{paymentStatusLabels[row.paymentStatus]}</span>
                    <span className={styles.money}>{money(row.customerTotalCents)}</span>
                  </div>
                  <div className={styles.attentionNote}>
                    Возврат не выполняется автоматически. Проверьте решение по
                    оплате.
                  </div>
                </div>
              ))}
            </>
          ) : null}
    </>
  );
}

/** Представление «По дням» — карточки дней с раскрытием заказов. */
function DailyView({
  days,
  money,
}: {
  days: RestaurantDailySettlementRow[];
  money: (cents: number) => string;
}) {
  if (days.length === 0) {
    return (
      <>
        <h2 className={styles.sectionTitle}>Сверка по дням</h2>
        <div className={styles.empty}>
          За выбранный период завершённых заказов нет.
        </div>
      </>
    );
  }
  return (
    <>
      <h2 className={styles.sectionTitle}>Сверка по дням</h2>
      <div className={styles.days}>
        {days.map((day) => (
          <DayCard key={day.localDate} day={day} money={money} />
        ))}
      </div>
    </>
  );
}

function DayCard({
  day,
  money,
}: {
  day: RestaurantDailySettlementRow;
  money: (cents: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const hasOrders = day.orders.length > 0;
  return (
    <div className={styles.dayCard}>
      <button
        type="button"
        className={styles.dayHeader}
        aria-expanded={open}
        disabled={!hasOrders}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.dayDate}>{formatLocalDateRu(day.localDate)}</span>
        <span className={styles.dayHeaderMeta}>
          Завершённых заказов: {day.completedOrderCount} · Стоимость:{" "}
          {money(day.customerTotalCents)}
        </span>
        {hasOrders ? (
          <span className={styles.dayChevron} aria-hidden="true">
            {open ? "▲" : "▼"}
          </span>
        ) : null}
      </button>

      <div className={styles.dayMetrics}>
        <DayMetric label="Завершённые заказы" value={String(day.completedOrderCount)} />
        <DayMetric label="Стоимость заказов" value={money(day.customerTotalCents)} />
        <DayMetric label="Продажи блюд" value={money(day.foodSubtotalCents)} />
        <DayMetric label="Чисто ресторану" value={money(day.restaurantNetCents)} />
        <DayMetric label="Собрано рестораном" value={money(day.restaurantCollectedFromCustomerCents)} />
        <DayMetric label="Собрано Direct" value={money(day.platformCollectedFromCustomerCents)} />
        <DayMetric label="Комиссия Direct" value={money(day.platformCommissionReceivableCents)} />
        <DayMetric
          label="Ожидает расчёта по журналу комиссий"
          value={money(day.pendingLedgerCents)}
        />
        <DayMetric label="Требуют внимания" value={String(day.paidCanceledCount)} />
      </div>

      {open && hasOrders ? (
        <div className={`${styles.tableScroll} ${styles.dayOrders}`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Заказ</th>
                <th>Способ</th>
                <th className={styles.num}>Стоимость</th>
                <th className={styles.num}>Чисто ресторану</th>
                <th>Комиссионное начисление</th>
              </tr>
            </thead>
            <tbody>
              {day.orders.map((row) => (
                <tr key={row.orderId}>
                  <td className={styles.orderNumber}>{row.publicNumber}</td>
                  <td>{deliveryModeLabels[row.deliveryMode]}</td>
                  <td className={styles.money}>{money(row.customerTotalCents)}</td>
                  <td className={styles.money}>
                    {money(row.restaurantNetAfterPlatformCommissionCents)}
                  </td>
                  <td>
                    {row.ledger
                      ? `${settlementTypeLabels[row.ledger.type]} · ${money(row.ledger.amountCents)} · ${settlementStatusLabels[row.ledger.status]}`
                      : "Начисления нет"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function DayMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.dayMetric}>
      <span className={styles.dayMetricLabel}>{label}</span>
      <span className={styles.dayMetricValue}>{value}</span>
    </div>
  );
}

type ObligationStatusFilter = "OPEN" | "CLOSED" | "ALL";
type ObligationDirectionFilter =
  | "ALL"
  | "RESTAURANT_OWES_DIRECT"
  | "DIRECT_OWES_RESTAURANT";

/** Представление «Обязательства» — read-only журнал двусторонних обязательств. */
function ObligationsView({
  rows,
  money,
  timeZone,
}: {
  rows: RestaurantAccountingJournalRow[];
  money: (cents: number) => string;
  timeZone: string;
}) {
  const [statusFilter, setStatusFilter] = useState<ObligationStatusFilter>("OPEN");
  const [directionFilter, setDirectionFilter] =
    useState<ObligationDirectionFilter>("ALL");

  // Фильтры presentation-only: сами записи не меняются.
  const visible = rows.filter((row) => {
    const statusOk =
      statusFilter === "ALL"
        ? true
        : statusFilter === "OPEN"
          ? row.status === "OPEN"
          : row.status === "SETTLED" || row.status === "WAIVED";
    const directionOk =
      directionFilter === "ALL" ? true : row.direction === directionFilter;
    return statusOk && directionOk;
  });

  return (
    <>
      <h2 className={styles.sectionTitle}>Обязательства · за всё время</h2>

      <div className={styles.periods} role="group" aria-label="Статус">
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
            className={styles.periodButton}
            aria-pressed={statusFilter === value}
            onClick={() => setStatusFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className={styles.periods} role="group" aria-label="Направление">
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
            className={styles.periodButton}
            aria-pressed={directionFilter === value}
            onClick={() => setDirectionFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className={styles.empty}>Обязательств по выбранным фильтрам нет.</div>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Дата признания</th>
                <th>Заказ</th>
                <th>Кто кому должен</th>
                <th>Основание</th>
                <th className={styles.num}>Сумма</th>
                <th>Статус</th>
                <th>Источник</th>
                <th>Дата закрытия</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.entryId}>
                  <td>{formatInZone(row.recognizedAt, timeZone)}</td>
                  <td className={styles.orderNumber}>
                    {row.publicNumber ?? "Старое начисление"}
                  </td>
                  <td>{ACCOUNTING_DIRECTION_LABELS[row.direction]}</td>
                  <td>{ACCOUNTING_TYPE_LABELS[row.type]}</td>
                  <td className={styles.money}>{money(row.amountCents)}</td>
                  <td>{ACCOUNTING_STATUS_LABELS[row.status]}</td>
                  <td>{ACCOUNTING_SOURCE_LABELS[row.source]}</td>
                  <td>
                    {row.settledAt ? formatInZone(row.settledAt, timeZone) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Изолированный контейнер состояния выписки. Монтируется с key
 * `restaurantId:timeZone`, поэтому при смене ресторана или пояса перемонтируется
 * с чистым состоянием и свежим default range. Сформированная выписка хранится
 * envelope'ом с restaurantId/timeZone и показывается только при их точном
 * совпадении с текущим контекстом — старые данные не появляются под новым
 * рестораном ни на один render (двойная защита: key-remount + envelope-gate).
 */
function RestaurantStatementSection({
  state,
  restaurantId,
  timeZone,
  nowMs,
}: {
  state: PrototypeState;
  restaurantId: string;
  timeZone: string;
  nowMs: number;
}) {
  // Lazy init: default range из текущего пояса один раз при монтировании.
  const [range, setRange] = useState(() => defaultStatementRange(nowMs, timeZone));
  const [snapshot, setSnapshot] = useState<StatementSnapshot<
    RestaurantStatementViewResult
  > | null>(null);

  const generate = () => {
    if (nowMs === 0) return;
    // Фиксируем контекст и момент формирования; результат к ним жёстко привязан.
    const rid = restaurantId;
    const tz = timeZone;
    const asOf = new Date(nowMs).toISOString();
    const result = buildRestaurantStatementView(state, rid, {
      startLocalDate: range.startLocalDate,
      endLocalDate: range.endLocalDate,
      timeZone: tz,
      asOfIso: asOf,
    });
    setSnapshot({
      restaurantId: rid,
      timeZone: tz,
      startLocalDate: range.startLocalDate,
      endLocalDate: range.endLocalDate,
      asOfIso: asOf,
      result,
    });
  };

  // Envelope виден только при точном совпадении контекста И периода (без опоры на
  // useEffect и без автоперестроения). Изменение любой даты немедленно скрывает
  // старый результат.
  const visible = visibleStatementSnapshot(
    snapshot,
    restaurantId,
    timeZone,
    range.startLocalDate,
    range.endLocalDate,
  );
  // Stale: выписка была сформирована, но текущий период формы уже не совпадает с
  // зафиксированным. Структурное сравнение, не по тексту/DOM/времени.
  const isStale = snapshot !== null && visible === null;

  // CSV и печать доступны ТОЛЬКО из одного и того же зафиксированного успешного
  // snapshot текущего контекста И периода; при ошибке/отсутствии/смене
  // restaurantId, timeZone или дат оба helper'а вернут null. asOfIso берётся из
  // envelope — новый Date.now() не запрашивается, выписка не перестраивается.
  const csvFile = useMemo(
    () =>
      buildStatementCsvExport(
        snapshot,
        restaurantId,
        timeZone,
        range.startLocalDate,
        range.endLocalDate,
      ),
    [snapshot, restaurantId, timeZone, range.startLocalDate, range.endLocalDate],
  );
  const printModel = useMemo(
    () =>
      buildStatementPrintModel(
        snapshot,
        restaurantId,
        timeZone,
        range.startLocalDate,
        range.endLocalDate,
      ),
    [snapshot, restaurantId, timeZone, range.startLocalDate, range.endLocalDate],
  );

  return (
    <StatementView
      timeZone={timeZone}
      startLocalDate={range.startLocalDate}
      endLocalDate={range.endLocalDate}
      onStartChange={(value) => setRange((r) => ({ ...r, startLocalDate: value }))}
      onEndChange={(value) => setRange((r) => ({ ...r, endLocalDate: value }))}
      onGenerate={generate}
      result={visible?.result ?? null}
      asOfIso={visible?.asOfIso ?? null}
      csvFile={csvFile}
      printModel={printModel}
      isStale={isStale}
    />
  );
}

/** Представление «Выписка» — read-only, полностью из presentation-model. */
function StatementView({
  timeZone,
  startLocalDate,
  endLocalDate,
  onStartChange,
  onEndChange,
  onGenerate,
  result,
  asOfIso,
  csvFile,
  printModel,
  isStale,
}: {
  timeZone: string;
  startLocalDate: string;
  endLocalDate: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onGenerate: () => void;
  result: RestaurantStatementViewResult | null;
  asOfIso: string | null;
  csvFile: RestaurantStatementCsvFile | null;
  printModel: StatementPrintModel | null;
  isStale: boolean;
}) {
  const view = result?.ok ? result.view : null;
  const noMovements =
    view !== null &&
    view.currencySections.length === 0 &&
    view.recognitionRows.length === 0 &&
    view.resolutionRows.length === 0;

  return (
    <>
      <h2 className={styles.sectionTitle}>Выписка по взаимным обязательствам</h2>
      <div className={styles.info}>
        <p>
          Выписка показывает историческую позицию и движения между Direct и
          рестораном за выбранный период. Она предназначена для сверки и не
          подтверждает банковский перевод, списание со счёта или автоматический
          взаимозачёт.
        </p>
      </div>

      {/* Форма периода */}
      <div className={styles.statementForm}>
        <label className={styles.field}>
          <span>Дата начала</span>
          <input
            type="date"
            value={startLocalDate}
            onChange={(e) => onStartChange(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>Дата окончания</span>
          <input
            type="date"
            value={endLocalDate}
            onChange={(e) => onEndChange(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={styles.generateButton}
          onClick={onGenerate}
        >
          Сформировать выписку
        </button>
      </div>

      {result === null ? (
        isStale ? (
          // Период изменён после формирования: старый результат скрыт, экспорт
          // недоступен (helpers вернули null), выписку нужно сформировать заново.
          <div className={styles.attentionCard} role="status">
            <div className={styles.attentionRow}>
              Период изменён. Сформируйте выписку заново.
            </div>
          </div>
        ) : (
          <div className={styles.empty}>
            Задайте период и сформируйте выписку.
          </div>
        )
      ) : !result.ok || !view ? (
        <div className={styles.attentionCard} role="alert">
          <div className={styles.attentionRow}>{result.error}</div>
        </div>
      ) : (
        <>
          {/* Мета: имя ресторана берём из самой presentation-model view, чтобы
              не смешать старый result с текущим restaurant prop. */}
          <div className={styles.info}>
            <p>
              Ресторан: <strong>{view.restaurantName}</strong>. Период:{" "}
              {formatLocalDateRu(view.startLocalDate)} —{" "}
              {formatLocalDateRu(view.endLocalDate)}. Часовой пояс:{" "}
              {getRestaurantTimeZoneLabel(timeZone)}.
            </p>
            {asOfIso ? (
              <p className={styles.footnote}>
                Сформирована: {formatInZone(asOfIso, timeZone)}.
              </p>
            ) : null}
          </div>

          {/* Действия по зафиксированной успешной выписке текущего контекста. Обе
              кнопки относятся к одному snapshot; экспорт/печать не перестраивают
              выписку и не запрашивают новый момент. Кнопки переносятся на узких
              экранах без горизонтального скролла страницы (statementActions). */}
          {csvFile || printModel ? (
            <div className={styles.statementActions}>
              {csvFile ? (
                <button
                  type="button"
                  className={styles.generateButton}
                  onClick={() => triggerCsvDownload(csvFile)}
                >
                  Скачать CSV
                </button>
              ) : null}
              {printModel ? (
                <button
                  type="button"
                  className={styles.generateButton}
                  title="Открыть печать или сохранить выписку в PDF"
                  aria-label="Открыть печать или сохранить выписку в PDF"
                  onClick={() => window.print()}
                >
                  Печать / PDF
                </button>
              ) : null}
            </div>
          ) : null}

          {noMovements ? (
            <div className={styles.empty}>
              За выбранный период финансовых движений не найдено.
            </div>
          ) : null}

          {/* Секции по валютам */}
          {view.currencySections.map((section) => (
            <StatementCurrencySection
              key={section.currencyCode}
              section={section}
            />
          ))}

          {/* Признанные обязательства */}
          <h3 className={styles.sectionSubTitle}>Признанные обязательства</h3>
          {view.recognitionRows.length === 0 ? (
            <div className={styles.empty}>Новых обязательств за период нет.</div>
          ) : (
            <StatementRecognitionTable rows={view.recognitionRows} timeZone={timeZone} />
          )}

          {/* Решения по обязательствам */}
          <h3 className={styles.sectionSubTitle}>Решения по обязательствам</h3>
          {view.resolutionRows.length === 0 ? (
            <div className={styles.empty}>
              Решений по обязательствам за период нет.
            </div>
          ) : (
            <StatementResolutionTable rows={view.resolutionRows} timeZone={timeZone} />
          )}

          {/* Предупреждения о данных */}
          {view.hasIntegrityWarnings ? (
            <>
              <h3 className={styles.sectionSubTitle}>Требуется проверка данных</h3>
              <div className={styles.attentionCard} role="status">
                {view.integritySummary.map((g, index) => (
                  <div className={styles.attentionRow} key={index}>
                    {g.message} — {g.count}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {/* Печатный документ: скрыт на экране, показывается только в @media
              print. Данные — из зафиксированной печатной модели (тот же snapshot,
              что и CSV), без пересчёта. */}
          {printModel ? (
            <StatementPrintDocument model={printModel} timeZone={timeZone} />
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * Печатная версия выписки. На экране скрыта (display:none), в @media print —
 * единственный видимый блок (правила в settlements.module.css скрывают остальной
 * интерфейс только во время печати). Рендерит ровно данные RestaurantStatementView:
 * заголовок, метаданные, секции по валютам (opening/движения/closing + сходимость),
 * таблицы признанных обязательств и решений, integrity-предупреждения (message +
 * count). Внутренних ID, PII и сырых enum здесь нет — модель их не содержит.
 */
function StatementPrintDocument({
  model,
  timeZone,
}: {
  model: StatementPrintModel;
  timeZone: string;
}) {
  const { view, asOfIso } = model;
  return (
    <section className="direct-print-doc" aria-hidden="true">
      <h1 className="direct-print-title">Выписка по взаимным обязательствам</h1>

      <div className="direct-print-meta">
        <div>
          <span className="direct-print-meta-label">Оператор:</span> Direct
        </div>
        <div>
          <span className="direct-print-meta-label">Ресторан:</span>{" "}
          {view.restaurantName}
        </div>
        <div>
          <span className="direct-print-meta-label">Период:</span>{" "}
          {formatLocalDateRu(view.startLocalDate)} —{" "}
          {formatLocalDateRu(view.endLocalDate)}
        </div>
        <div>
          <span className="direct-print-meta-label">Часовой пояс:</span>{" "}
          {getRestaurantTimeZoneLabel(timeZone)}
        </div>
        <div>
          <span className="direct-print-meta-label">Сформирована:</span>{" "}
          {formatInZone(asOfIso, timeZone)}
        </div>
        <p className="direct-print-note">
          Документ предназначен для сверки и не подтверждает банковский перевод,
          списание со счёта или автоматический взаимозачёт.
        </p>
      </div>

      {view.currencySections.map((section) => (
        <div key={section.currencyCode} className="direct-print-currency">
          <h2 className="direct-print-currency-head">Валюта: {section.currencyCode}</h2>
          <table className="direct-print-table">
            <tbody>
              <tr>
                <th colSpan={2} className="direct-print-block-head">
                  Позиция на начало
                </th>
              </tr>
              <tr>
                <td>Ресторан должен Direct</td>
                <td className="direct-print-money">
                  {formatMoney(section.openingRestaurantOwesDirectCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <td>Direct должен ресторану</td>
                <td className="direct-print-money">
                  {formatMoney(section.openingDirectOwesRestaurantCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <td>Чистая позиция</td>
                <td className="direct-print-money">
                  {formatMoney(section.openingNetCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <th colSpan={2} className="direct-print-block-head">
                  Движения за период
                </th>
              </tr>
              <tr>
                <td>Признано: ресторан должен Direct</td>
                <td className="direct-print-money">
                  {formatMoney(section.recognizedRestaurantOwesDirectCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <td>Признано: Direct должен ресторану</td>
                <td className="direct-print-money">
                  {formatMoney(section.recognizedDirectOwesRestaurantCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <td>Подтверждено: ресторан должен Direct</td>
                <td className="direct-print-money">
                  {formatMoney(section.settledRestaurantOwesDirectCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <td>Подтверждено: Direct должен ресторану</td>
                <td className="direct-print-money">
                  {formatMoney(section.settledDirectOwesRestaurantCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <td>Комиссия Direct списана</td>
                <td className="direct-print-money">
                  {formatMoney(section.waivedRestaurantOwesDirectCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <th colSpan={2} className="direct-print-block-head">
                  Позиция на конец
                </th>
              </tr>
              <tr>
                <td>Ресторан должен Direct</td>
                <td className="direct-print-money">
                  {formatMoney(section.closingRestaurantOwesDirectCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <td>Direct должен ресторану</td>
                <td className="direct-print-money">
                  {formatMoney(section.closingDirectOwesRestaurantCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <td>Чистая позиция</td>
                <td className="direct-print-money">
                  {formatMoney(section.closingNetCents, section.currencyCode)}
                </td>
              </tr>
              <tr>
                <td>Сходимость</td>
                <td className="direct-print-money">
                  {section.isReconciled ? "Сходится" : "Не сходится"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}

      <h2 className="direct-print-section-head">Признанные обязательства</h2>
      {view.recognitionRows.length === 0 ? (
        <p>Новых обязательств за период нет.</p>
      ) : (
        <table className="direct-print-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Заказ</th>
              <th>Кто кому должен</th>
              <th>Основание</th>
              <th className="direct-print-money">Сумма</th>
              <th>Валюта</th>
              <th>Источник</th>
            </tr>
          </thead>
          <tbody>
            {view.recognitionRows.map((r, index) => (
              <tr key={index}>
                <td>{formatInZone(r.recognizedAt, timeZone)}</td>
                <td>{r.orderLabel}</td>
                <td>{r.directionLabel}</td>
                <td>{r.typeLabel}</td>
                <td className="direct-print-money">
                  {formatMoney(r.amountCents, r.currencyCode)}
                </td>
                <td>{r.currencyCode}</td>
                <td>{r.sourceLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="direct-print-section-head">Решения по обязательствам</h2>
      {view.resolutionRows.length === 0 ? (
        <p>Решений по обязательствам за период нет.</p>
      ) : (
        <table className="direct-print-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Заказ</th>
              <th>Решение</th>
              <th>Кто кому должен</th>
              <th>Основание</th>
              <th className="direct-print-money">Сумма</th>
              <th>Валюта</th>
              <th>Комментарий</th>
              <th>Внешняя ссылка</th>
            </tr>
          </thead>
          <tbody>
            {view.resolutionRows.map((r, index) => (
              <tr key={index}>
                <td>{formatInZone(r.occurredAt, timeZone)}</td>
                <td>{r.orderLabel}</td>
                <td>{r.decisionLabel}</td>
                <td>{r.directionLabel}</td>
                <td>{r.typeLabel}</td>
                <td className="direct-print-money">
                  {formatMoney(r.amountCents, r.currencyCode)}
                </td>
                <td>{r.currencyCode}</td>
                <td className="direct-print-wrap">{r.note}</td>
                <td className="direct-print-wrap">{r.externalReference ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view.hasIntegrityWarnings ? (
        <>
          <h2 className="direct-print-section-head">Требуется проверка данных</h2>
          <table className="direct-print-table">
            <thead>
              <tr>
                <th>Предупреждение</th>
                <th>Количество</th>
              </tr>
            </thead>
            <tbody>
              {view.integritySummary.map((g, index) => (
                <tr key={index}>
                  <td className="direct-print-wrap">{g.message}</td>
                  <td>{g.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

function StatementCurrencySection({
  section,
}: {
  section: RestaurantStatementCurrencySection;
}) {
  const m = (cents: number) => formatMoney(cents, section.currencyCode);
  return (
    <div className={styles.currencySection}>
      <div className={styles.currencyHead}>Валюта: {section.currencyCode}</div>

      <div className={styles.statementBlock}>
        <span className={styles.blockTitle}>Позиция на начало</span>
        <div className={styles.summaryGrid}>
          <SummaryCard label="Ресторан должен Direct" value={m(section.openingRestaurantOwesDirectCents)} />
          <SummaryCard label="Direct должен ресторану" value={m(section.openingDirectOwesRestaurantCents)} />
          <SummaryCard label="Чистая позиция" value={m(section.openingNetCents)} />
        </div>
      </div>

      <div className={styles.statementBlock}>
        <span className={styles.blockTitle}>Движения за период</span>
        <div className={styles.summaryGrid}>
          <SummaryCard label="Признано: ресторан должен Direct" value={m(section.recognizedRestaurantOwesDirectCents)} />
          <SummaryCard label="Признано: Direct должен ресторану" value={m(section.recognizedDirectOwesRestaurantCents)} />
          <SummaryCard label="Подтверждено: ресторан должен Direct" value={m(section.settledRestaurantOwesDirectCents)} />
          <SummaryCard label="Подтверждено: Direct должен ресторану" value={m(section.settledDirectOwesRestaurantCents)} />
          <SummaryCard label="Комиссия Direct списана" value={m(section.waivedRestaurantOwesDirectCents)} />
        </div>
      </div>

      <div className={styles.statementBlock}>
        <span className={styles.blockTitle}>Позиция на конец</span>
        <div className={styles.summaryGrid}>
          <SummaryCard label="Ресторан должен Direct" value={m(section.closingRestaurantOwesDirectCents)} />
          <SummaryCard label="Direct должен ресторану" value={m(section.closingDirectOwesRestaurantCents)} />
          <SummaryCard label="Чистая позиция" value={m(section.closingNetCents)} />
        </div>
      </div>

      {section.isReconciled ? (
        <p className={styles.footnote}>Позиции сходятся с движениями периода.</p>
      ) : (
        <div className={styles.attentionCard} role="status">
          <div className={styles.attentionRow}>
            Позиции не сходятся с движениями периода. Требуется проверка
            администратором.
          </div>
        </div>
      )}
    </div>
  );
}

function StatementRecognitionTable({
  rows,
  timeZone,
}: {
  rows: RestaurantStatementRecognitionViewRow[];
  timeZone: string;
}) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Дата</th>
            <th>Заказ</th>
            <th>Кто кому должен</th>
            <th>Основание</th>
            <th className={styles.num}>Сумма</th>
            <th>Источник</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td>{formatInZone(row.recognizedAt, timeZone)}</td>
              <td className={styles.orderNumber}>{row.orderLabel}</td>
              <td>{row.directionLabel}</td>
              <td>{row.typeLabel}</td>
              <td className={styles.money}>
                {formatMoney(row.amountCents, row.currencyCode)}
              </td>
              <td>{row.sourceLabel}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatementResolutionTable({
  rows,
  timeZone,
}: {
  rows: RestaurantStatementResolutionViewRow[];
  timeZone: string;
}) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Дата</th>
            <th>Заказ</th>
            <th>Решение</th>
            <th>Кто кому должен</th>
            <th>Основание</th>
            <th className={styles.num}>Сумма</th>
            <th>Комментарий</th>
            <th>Внешняя ссылка</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td>{formatInZone(row.occurredAt, timeZone)}</td>
              <td className={styles.orderNumber}>{row.orderLabel}</td>
              <td>{row.decisionLabel}</td>
              <td>{row.directionLabel}</td>
              <td>{row.typeLabel}</td>
              <td className={styles.money}>
                {formatMoney(row.amountCents, row.currencyCode)}
              </td>
              <td>{row.note}</td>
              <td>{row.externalReference ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryCard({
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
