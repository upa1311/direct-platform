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
import styles from "./settlements.module.css";

/** Вид раздела: по заказам, по дням или журнал обязательств. */
type SettlementView = "ORDERS" | "DAILY" | "OBLIGATIONS";

/** Локальная дата ресторана YYYY-MM-DD → «16.07.2026» без пересчёта пояса. */
function formatLocalDateRu(localDate: string): string {
  const [y, m, d] = localDate.split("-");
  if (!y || !m || !d) return localDate;
  return `${d}.${m}.${y}`;
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
    <div className={kds.screen}>
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
        <div className={styles.container}>
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
              Расчёты построены по финансовым снимкам заказов. Статус начисления
              относится только к существующему журналу комиссий. Выплаты Direct
              ресторану пока не отслеживаются в отдельном журнале.
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
