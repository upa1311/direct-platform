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
  SETTLEMENT_ROW_DATA_STATUS_LABELS,
  type RestaurantDailySettlementRow,
  type RestaurantSettlementOverview,
  type RestaurantSettlementPeriod,
  type RestaurantSettlementRow,
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
import {
  buildRestaurantFinanceReadModel,
  type RestaurantFinanceReadModelResult,
} from "@/prototype/restaurant-finance-read-model";
import {
  describeFinanceNet,
  FINANCE_CHANNEL_LABELS,
  FINANCE_DATA_STATUS_LABELS,
  FINANCE_DELIVERY_LABELS,
  FINANCE_DIRECTION_LABELS,
} from "./overview-presentation";
import { describeOpenPosition } from "./open-position";
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

import { getLatestFullRestaurantSettlement } from "@/prototype/restaurant-settlement-records";
import { RESTAURANT_SETTLEMENT_METHOD_LABELS } from "@/app/admin/settlements/settlement-selection";

import type {
  PrototypeState,
  RestaurantSettlementRecord,
} from "@/prototype/models";

/** Вид раздела: главный обзор, по заказам, по дням, журнал или выписка. */
type SettlementView = "OVERVIEW" | "ORDERS" | "DAILY" | "OBLIGATIONS" | "STATEMENT";

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
  const [view, setView] = useState<SettlementView>("OVERVIEW");

  // Presentation-only флаги контекста представления (без пересчёта данных).
  // Период и сводка заказов имеют смысл только в отчётах по заказам/дням;
  // «Взаимные обязательства · за всё время» относятся только к «Обязательствам».
  const isPeriodReport = view === "ORDERS" || view === "DAILY";
  const isObligations = view === "OBLIGATIONS";

  const restaurant = getRestaurant(state, selectedRestaurantId);
  const timeZone = restaurant?.timeZone ?? "Europe/Chisinau";

  // Канонический финансовый read-model — единственный источник главного
  // экрана OVERVIEW. Не зависит от nowMs и старых report-builders.
  const financeResult = useMemo<RestaurantFinanceReadModelResult | null>(() => {
    if (!isHydrated || !restaurant) return null;
    return buildRestaurantFinanceReadModel(state, selectedRestaurantId);
  }, [isHydrated, restaurant, state, selectedRestaurantId]);

  // Старый отчёт по заказам/дням — только для подробных режимов ORDERS/DAILY;
  // канонический OVERVIEW от него (и от nowMs) не зависит.
  const overviewResult = useMemo(() => {
    if (
      (view !== "ORDERS" && view !== "DAILY") ||
      !isHydrated ||
      nowMs === 0 ||
      !restaurant
    ) {
      return null;
    }
    return buildRestaurantSettlementOverview(
      state,
      selectedRestaurantId,
      period,
      new Date(nowMs).toISOString(),
      timeZone,
    );
  }, [view, isHydrated, nowMs, restaurant, state, selectedRestaurantId, period, timeZone]);

  const dailyResult = useMemo(() => {
    if (view !== "DAILY" || !isHydrated || nowMs === 0 || !restaurant) return null;
    return buildRestaurantDailySettlement(
      state,
      selectedRestaurantId,
      period,
      new Date(nowMs).toISOString(),
      timeZone,
    );
  }, [view, isHydrated, nowMs, restaurant, state, selectedRestaurantId, period, timeZone]);

  // Fail-closed контракт билдеров: при денежном переполнении отчёт не
  // возвращает частичные суммы. UI обязан показать предупреждение вместо цифр,
  // иначе пустой отчёт выглядел бы как настоящий нулевой баланс.
  const overview =
    overviewResult && overviewResult.ok ? overviewResult.overview : null;
  const daily = dailyResult && dailyResult.ok ? dailyResult.days : null;
  const reportError =
    overviewResult && !overviewResult.ok
      ? overviewResult.error
      : dailyResult && !dailyResult.ok
        ? dailyResult.error
        : null;

  // Открытая позиция двустороннего журнала — только для старого режима
  // «Обязательства»; канонический OVERVIEW эти helpers не использует.
  const position = useMemo(() => {
    if (view !== "OBLIGATIONS" || !isHydrated || !restaurant) return null;
    return {
      receivable: getRestaurantOpenReceivableCents(state, selectedRestaurantId),
      payable: getRestaurantOpenPayableCents(state, selectedRestaurantId),
      net: getRestaurantNetPositionCents(state, selectedRestaurantId),
    };
  }, [view, isHydrated, restaurant, state, selectedRestaurantId]);

  // Журнал обязательств — вся история, независимо от периода отчёта.
  const journal = useMemo(() => {
    if (view !== "OBLIGATIONS" || !isHydrated || !restaurant) return null;
    return buildRestaurantAccountingJournal(state, selectedRestaurantId);
  }, [view, isHydrated, restaurant, state, selectedRestaurantId]);

  // Последний ПОЛНЫЙ расчёт — read-only справка на главном экране.
  const lastFullSettlement = useMemo(() => {
    if (!isHydrated || !restaurant) return null;
    return getLatestFullRestaurantSettlement(state, selectedRestaurantId);
  }, [isHydrated, restaurant, state, selectedRestaurantId]);

  const money = (cents: number) =>
    formatMoney(cents, overview?.currencyCode ?? "USD");

  // Однозначный результат открытой позиции (интерпретация готового net).
  const positionMain = position ? describeOpenPosition(position, money) : null;

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

      {!isHydrated ? (
        <div className={kds.empty}>Загружаем расчёты…</div>
      ) : !restaurant ? (
        <div className={kds.empty}>Ресторан не найден.</div>
      ) : view === "OVERVIEW" ? (
        <div className={`${styles.container} direct-print-screen`}>
          <FinanceOverview
            result={financeResult}
            money={money}
            timeZone={timeZone}
            lastFull={lastFullSettlement}
            onShowOrders={() => setView("ORDERS")}
            onShowStatement={() => setView("STATEMENT")}
          />
        </div>
      ) : (
        <div className={`${styles.container} direct-print-screen`}>
          {/* Возврат на главный экран: спокойная текстовая кнопка, а не вкладка
              и не фильтр — пользователь уже внутри раздела «Расчёты», поэтому
              подпись называет цель («Общий баланс»), а не текущий раздел. */}
          <button
            type="button"
            className={styles.backLink}
            onClick={() => setView("OVERVIEW")}
          >
            ← Общий баланс
          </button>

          {/* Переключатель представления: единая панель вкладок. */}
          <div className={styles.viewTabs} role="group" aria-label="Представление">
            {(
              [
                ["ORDERS", "По заказам"],
                ["DAILY", "По дням"],
                ["OBLIGATIONS", "Обязательства"],
                ["STATEMENT", "Выписка"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={styles.viewTab}
                aria-pressed={view === value}
                onClick={() => setView(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Период и сводка заказов — только в отчётах по заказам/дням. */}
          {reportError ? (
            <div className={styles.info} role="alert">
              <p>Не удалось безопасно сформировать финансовый отчёт.</p>
              <p>{reportError}</p>
            </div>
          ) : null}

          {isPeriodReport && !reportError && overview ? (
            <>
              {/* Фильтр периода: легче вкладок и с подписью — виден только в
                  отчётах по заказам и по дням, где период реально применяется. */}
              <div className={styles.periodFilter}>
                <span className={styles.periodFilterLabel} id="period-filter-label">
                  Период
                </span>
                <div
                  className={styles.periodChips}
                  role="group"
                  aria-labelledby="period-filter-label"
                >
                  {RESTAURANT_SETTLEMENT_PERIOD_ORDER.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={styles.periodChip}
                      aria-pressed={period === p}
                      onClick={() => setPeriod(p)}
                    >
                      {RESTAURANT_SETTLEMENT_PERIOD_LABELS[p]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Основная сводка: четыре главных показателя, всегда видимы. */}
              <div className={styles.summaryGrid}>
                <SummaryCard label="Заказов за период" value={String(overview.summary.completedOrderCount)} />
                <SummaryCard label="Продажи блюд" value={money(overview.summary.foodSubtotalCents)} />
                <SummaryCard
                  label="Ресторану после комиссий"
                  value={money(overview.summary.restaurantNetCents)}
                  hint="Учтены комиссия Direct и доля банковской комиссии ресторана."
                />
                <SummaryCard label="Комиссия Direct" value={money(overview.summary.platformCommissionReceivableCents)} />
              </div>

              {/* Технические показатели скрыты по умолчанию (нативный details). */}
              <details className={styles.reconDetails}>
                <summary className={styles.reconSummary}>Подробности сверки</summary>
                <div className={styles.reconDetailsBody}>
                  <div className={styles.summaryGrid}>
                    <SummaryCard label="Стоимость заказов" value={money(overview.summary.customerTotalCents)} />
                    <SummaryCard label="Собрано рестораном с клиентов" value={money(overview.summary.restaurantCollectedFromCustomerCents)} />
                    <SummaryCard
                      label="Собрано Direct с клиентов"
                      value={money(overview.summary.platformCollectedFromCustomerCents)}
                      hint="Информационный показатель снимка, не подтверждённая выплата."
                    />
                    <SummaryCard
                      label="Ожидает расчёта по журналу комиссий"
                      value={money(overview.summary.pendingLedgerCents)}
                      hint="Только начисления со статусом „Ожидает расчёта“ в журнале комиссий."
                    />
                    {/* Банк — отдельная сторона: его комиссия уменьшает чистый
                        результат стороны, принявшей платёж, и не является
                        обязательством между рестораном и Direct. */}
                    <SummaryCard
                      label="Комиссия банка"
                      value={money(overview.summary.totalBankFeeCents)}
                      hint={`За счёт ресторана: ${money(
                        overview.summary.restaurantBankFeeCents,
                      )} · За счёт Direct: ${money(
                        overview.summary.directBankFeeCents,
                      )}`}
                    />
                  </div>

                  {/* Объяснение финансовых снимков */}
                  <div className={styles.info}>
                    <p>
                      Расчёты построены по финансовым снимкам заказов. Открытые
                      обязательства между Direct и рестораном фиксируются в
                      отдельном двустороннем журнале. Исполнение или допустимое
                      списание фиксирует администратор Direct. Система не выполняет
                      автоматический взаимозачёт или банковский перевод.
                    </p>
                    <p>
                      Показатель «Ожидает расчёта по журналу комиссий» относится
                      только к старому журналу комиссий, который сохранён для
                      совместимости.
                    </p>
                    <p className={styles.footnote}>
                      Раздел предназначен для операционной сверки, а не заменяет
                      бухгалтерский учёт.
                    </p>
                  </div>
                </div>
              </details>
            </>
          ) : null}

          {/* Взаимные обязательства — открытая позиция за всё время (не зависит
              от переключателя периода). Показывается только в представлении
              «Обязательства»; отчёты по заказам/дням и выписка её не показывают. */}
          {isObligations && position && positionMain ? (
            <>
              <h2 className={styles.sectionTitle}>
                Взаимные обязательства · за всё время
              </h2>
              {/* Один крупный однозначный результат вместо трёх карточек и знака
                  «Чистой позиции». Значение всегда положительное (или 0). */}
              <div className={styles.positionMain}>
                <span className={styles.positionMainLabel}>
                  {positionMain.label}
                </span>
                <span className={styles.positionMainValue}>
                  {positionMain.value}
                </span>
              </div>
              <div className={styles.info}>
                <p>
                  Это разница открытых обязательств. Автоматический взаимозачёт и
                  банковская выплата не выполняются.
                </p>
              </div>

              {/* Исходные суммы за всё время скрыты по умолчанию (нативный details). */}
              <details className={styles.reconDetails}>
                <summary className={styles.reconSummary}>Показать расчёт</summary>
                <div className={styles.reconDetailsBody}>
                  <div className={styles.summaryGrid}>
                    <SummaryCard
                      label="Ресторан должен Direct"
                      value={money(position.receivable)}
                    />
                    <SummaryCard
                      label="Direct должен ресторану"
                      value={money(position.payable)}
                    />
                  </div>
                  <div className={styles.info}>
                    <p>
                      Эти суммы показывают все открытые обязательства за всё время
                      и не зависят от выбранного периода отчёта.
                    </p>
                    <p>
                      Автоматический взаимозачёт и фактическая выплата не
                      выполняются.
                    </p>
                  </div>
                </div>
              </details>
            </>
          ) : null}

          {view === "DAILY" && reportError ? null : view === "DAILY" ? (
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
          ) : overview ? (
            <OrdersView overview={overview} money={money} timeZone={timeZone} />
          ) : (
            <div className={styles.empty}>Загружаем расчёты…</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Главный канонический обзор «Расчёты с Direct». ЕДИНСТВЕННЫЙ источник всех
 * финансовых значений — buildRestaurantFinanceReadModel: React только выбирает
 * тексты по enum и форматирует готовые суммы/даты. Ошибка read-model — честный
 * fail-closed блок без fallback на старые helpers и без правдоподобного
 * баланса.
 */
/** Способ последнего полного расчёта русской подписью (enum не показывается). */
function lastFullMethodSuffix(record: RestaurantSettlementRecord): string {
  return record.execution.dataStatus === "COMPLETE"
    ? ` (${RESTAURANT_SETTLEMENT_METHOD_LABELS[record.execution.method].toLowerCase()})`
    : "";
}

function FinanceOverview({
  result,
  money,
  timeZone,
  lastFull,
  onShowOrders,
  onShowStatement,
}: {
  result: RestaurantFinanceReadModelResult | null;
  money: (cents: number) => string;
  timeZone: string;
  /** Последний ПОЛНЫЙ расчёт ресторана либо null (read-only). */
  lastFull: RestaurantSettlementRecord | null;
  onShowOrders: () => void;
  onShowStatement: () => void;
}) {
  if (result === null) {
    return <div className={styles.empty}>Загружаем расчёты…</div>;
  }
  if (!result.ok) {
    return (
      <div className={styles.failCard} role="alert">
        <strong className={styles.failTitle}>Данные требуют проверки</strong>
        <p className={styles.failText}>
          Сейчас невозможно безопасно рассчитать баланс ресторана.
        </p>
        <p className={styles.failReason}>{result.error}</p>
      </div>
    );
  }
  const model = result.model;
  // Готовое направление и сумма после взаимозачёта — из model, без арифметики.
  const net = describeFinanceNet(model);
  // Момент отсечки и платёж последнего полного расчёта — как они сохранены.
  const lastFullCutoffAt =
    lastFull && lastFull.selection.scope === "FULL_OPEN_POSITION"
      ? lastFull.selection.cutoffAt
      : null;
  const lastFullPayment = !lastFull
    ? ""
    : lastFull.netDirection === "BALANCED"
      ? "Взаимозачёт без передачи денег."
      : lastFull.netDirection === "DIRECT_OWES_RESTAURANT"
        ? `Direct передал вам ${money(lastFull.netAmountCents)}${lastFullMethodSuffix(lastFull)}.`
        : `Вы передали Direct ${money(lastFull.netAmountCents)}${lastFullMethodSuffix(lastFull)}.`;

  return (
    <>
      <h2 className={styles.sectionTitle}>Расчёты с Direct</h2>

      {/* Главная карточка баланса. */}
      <section
        className={styles.overviewCard}
        aria-label="Итог взаиморасчётов"
      >
        <span className={styles.overviewTitle}>{net.title}</span>
        <span className={styles.overviewAmount}>{money(net.amountCents)}</span>
        <span className={styles.overviewNote}>{net.note}</span>

        {/* Информационная gross-разбивка исходных сторон. */}
        <dl className={styles.overviewGross}>
          <div className={styles.grossRow}>
            <dt>Direct должен вам</dt>
            <dd>{money(model.directOwesRestaurantCents)}</dd>
          </div>
          <div className={styles.grossRow}>
            <dt>Вы должны Direct</dt>
            <dd>{money(model.restaurantOwesDirectCents)}</dd>
          </div>
        </dl>
      </section>

      {/* Последний ПОЛНЫЙ расчёт: read-only, ресторан здесь ничего не
          подтверждает. Выборочный расчёт полным не считается. */}
      <section className={styles.noticeCard} aria-label="Последний полный расчёт">
        {lastFull === null ? (
          <span>Полных расчётов пока не было.</span>
        ) : (
          <>
            <div>
              <strong>
                Последний полный расчёт:{" "}
                {formatInZone(lastFullCutoffAt as string, timeZone)}
              </strong>
            </div>
            <div>На этот момент баланс был закрыт полностью.</div>
            <div>{lastFullPayment}</div>
            {lastFull.externalReference ? (
              <div>Документ: {lastFull.externalReference}</div>
            ) : null}
            {model.openAccountingEntryCount > 0 ? (
              <div>
                Текущий баланс сформирован после последнего полного расчёта.
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* Компактная сводная метаинформация. */}
      <dl className={styles.overviewMeta}>
        <div className={styles.metaItem}>
          <dt>Открытых заказов</dt>
          <dd>{model.openOrderCount}</dd>
        </div>
        <div className={styles.metaItem}>
          <dt>Открытых обязательств</dt>
          <dd>{model.openAccountingEntryCount}</dd>
        </div>
        <div className={styles.metaItem}>
          <dt>Самый старый открытый заказ</dt>
          <dd>
            {model.oldestOpenRecognizedAt
              ? formatInZone(model.oldestOpenRecognizedAt, timeZone)
              : "—"}
          </dd>
        </div>
      </dl>

      {/* Данные, требующие внимания (в баланс не входят). */}
      {model.reviewRequiredOrderCount > 0 ? (
        <div className={styles.noticeCard} role="status">
          Есть заказы, требующие проверки данных —{" "}
          {model.reviewRequiredOrderCount}
        </div>
      ) : null}
      {model.pendingPaymentChannelOrderCount > 0 ? (
        <div className={styles.noticeCard} role="status">
          Есть самовывозы, ожидающие подтверждения способа оплаты —{" "}
          {model.pendingPaymentChannelOrderCount}
        </div>
      ) : null}

      {/* Открытые заказы, из которых состоит баланс. */}
      <h3 className={styles.sectionSubTitle}>Открытые заказы</h3>
      {model.openOrders.length === 0 ? (
        <div className={styles.empty}>Открытых заказов для расчёта нет</div>
      ) : (
        <ul className={styles.financeList}>
          {model.openOrders.map((row) => (
            <li className={styles.financeRow} key={row.orderId}>
              <div className={styles.financeRowHead}>
                <span className={styles.orderNumber}>{row.publicNumber}</span>
                <span className={styles.financeRowDate}>
                  {formatInZone(row.recognizedAt, timeZone)}
                </span>
              </div>
              <div className={styles.financeRowTags}>
                <span>{FINANCE_DELIVERY_LABELS[row.deliveryMode]}</span>
                <span>{FINANCE_CHANNEL_LABELS[row.paymentChannel]}</span>
                {/* Банковская доля ресторана видна сразу: она уменьшает его
                    чистый результат и не является долгом перед Direct.
                    Полная разбивка — в подробностях заказа и сверке. */}
                {row.restaurantBankFeeCents !== null &&
                row.restaurantBankFeeCents > 0 ? (
                  <span>
                    Банк: −{money(row.restaurantBankFeeCents)} с ресторана
                  </span>
                ) : null}
                {row.dataStatus !== "COMPLETE" ? (
                  <span className={styles.financeRowStatus}>
                    {FINANCE_DATA_STATUS_LABELS[row.dataStatus]}
                  </span>
                ) : null}
              </div>
              <div className={styles.financeRowAmount}>
                <span>{FINANCE_DIRECTION_LABELS[row.direction]}</span>
                <strong>{money(row.amountCents)}</strong>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Переходы к подробным отчётам (внутреннее переключение страницы). */}
      <div className={styles.overviewActions}>
        <button
          type="button"
          className={styles.periodButton}
          onClick={onShowOrders}
        >
          Все заказы
        </button>
        <button
          type="button"
          className={styles.periodButton}
          onClick={onShowStatement}
        >
          История расчётов
        </button>
      </div>
    </>
  );
}

/** Представление «По заказам» — существующая таблица и «Требуют внимания». */
function OrdersView({
  overview,
  money,
  timeZone,
}: {
  // Только успешный обзор: ошибку страница показывает предупреждением выше.
  overview: RestaurantSettlementOverview;
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
              {/* 7 основных колонок; остальные прежние поля — в «Детали» (details).
                  На ≤720px ordersTable превращает каждую строку в карточку
                  (data-label подписывает значения). Значения и порядок не меняются. */}
              <table className={`${styles.table} ${styles.ordersTable}`}>
                <thead>
                  <tr>
                    <th>Завершён</th>
                    <th>Заказ</th>
                    <th>Способ</th>
                    <th className={styles.num}>Продажи блюд</th>
                    <th className={styles.num}>Ресторану после комиссии</th>
                    <th className={styles.num}>Комиссия Direct</th>
                    <th>Детали</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.rows.map((row) => (
                    <tr key={row.orderId}>
                      <td data-label="Завершён">
                        {formatInZone(row.completedAt, timeZone)}
                      </td>
                      <td className={styles.orderNumber} data-label="Заказ">
                        {row.publicNumber}
                      </td>
                      <td data-label="Способ">{deliveryModeLabels[row.deliveryMode]}</td>
                      <td className={styles.money} data-label="Продажи блюд">
                        {money(row.foodSubtotalCents)}
                      </td>
                      <td className={styles.money} data-label="Ресторану после комиссии">
                        {money(row.restaurantNetAfterPlatformCommissionCents)}
                      </td>
                      <td className={styles.money} data-label="Комиссия Direct">
                        {money(row.platformCommissionReceivableCents)}
                      </td>
                      <td className={styles.ordersDetailCell} data-label="Детали">
                        <OrderDetails row={row} money={money} />
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

/**
 * «Детали» заказа: нативный закрытый по умолчанию details с остальными прежними
 * полями строки (статус, полная стоимость, кто собрал, собрано рестораном/Direct,
 * комиссионное начисление). Значения не пересчитываются — только показ.
 */
function OrderDetails({
  row,
  money,
}: {
  row: RestaurantSettlementRow;
  money: (cents: number) => string;
}) {
  const ledgerText = row.ledger
    ? `${settlementTypeLabels[row.ledger.type]} · ${money(row.ledger.amountCents)} · ${settlementStatusLabels[row.ledger.status]}`
    : "Начисления нет";
  return (
    <details>
      <summary
        className={styles.reconSummary}
        aria-label={`Открыть детали заказа ${row.publicNumber}`}
      >
        Открыть
      </summary>
      <dl className={styles.orderDetailsList}>
        <OrderDetailRow
          label="Статус"
          value={row.completionStatus === "DELIVERED" ? "Доставлен" : "Получен"}
        />
        <OrderDetailRow label="Полная стоимость" value={money(row.customerTotalCents)} />
        <OrderDetailRow label="Собрал" value={SETTLEMENT_COLLECTOR_LABELS[row.collector]} />
        <OrderDetailRow
          label="Собрано рестораном с клиента"
          value={money(row.restaurantCollectedFromCustomerCents)}
        />
        <OrderDetailRow
          label="Собрано Direct с клиента"
          value={money(row.platformCollectedFromCustomerCents)}
        />
        <OrderDetailRow
          label="Комиссия Direct"
          value={money(row.restaurantCommissionCents)}
        />
        {/* Полное обязательство ресторана — это перечисление, а не комиссия:
            в него могут входить доставка и доплата за небольшой заказ. */}
        {row.restaurantOwesDirectCents !== null &&
        row.restaurantOwesDirectCents > 0 ? (
          <OrderDetailRow
            label="Перечисление рестораном"
            value={money(row.restaurantOwesDirectCents)}
          />
        ) : null}
        {row.directOwesRestaurantCents !== null &&
        row.directOwesRestaurantCents > 0 ? (
          <OrderDetailRow
            label="Direct должен ресторану"
            value={money(row.directOwesRestaurantCents)}
          />
        ) : null}
        {/* Банковская комиссия заказа: три сохранённые суммы движения. Для
            наличного заказа три нуля бессмысленны — одна спокойная строка. */}
        {row.totalBankFeeCents !== null &&
        row.restaurantBankFeeCents !== null &&
        row.directBankFeeCents !== null ? (
          row.totalBankFeeCents === 0 ? (
            <OrderDetailRow label="Банковская комиссия" value="нет" />
          ) : (
            <>
              <OrderDetailRow
                label="Комиссия банка всего"
                value={money(row.totalBankFeeCents)}
              />
              <OrderDetailRow
                label="Доля ресторана"
                value={money(row.restaurantBankFeeCents)}
              />
              <OrderDetailRow
                label="Доля Direct"
                value={money(row.directBankFeeCents)}
              />
            </>
          )
        ) : null}
        <OrderDetailRow
          label="Источник данных"
          value={SETTLEMENT_ROW_DATA_STATUS_LABELS[row.dataStatus]}
        />
        <OrderDetailRow label="Комиссионное начисление" value={ledgerText} />
      </dl>
    </details>
  );
}

function OrderDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.orderDetailsRow}>
      <dt className={styles.orderDetailsRowLabel}>{label}</dt>
      <dd className={styles.orderDetailsRowValue}>{value}</dd>
    </div>
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
        {hasOrders ? (
          <span className={styles.dayChevron} aria-hidden="true">
            {open ? "▲" : "▼"}
          </span>
        ) : null}
      </button>

      {/* Тело дня с внутренними отступами; таблица заказов — вне него, чтобы
          сохранить её border-top. */}
      <div className={styles.dayBody}>
        {/* Основные показатели дня: четыре главных значения, всегда видимы. */}
        <div className={styles.summaryGrid}>
          <SummaryCard label="Заказов" value={String(day.completedOrderCount)} />
          <SummaryCard label="Продажи блюд" value={money(day.foodSubtotalCents)} />
          <SummaryCard
            label="Ресторану после комиссий"
            value={money(day.restaurantNetCents)}
            hint="Учтены комиссия Direct и доля банковской комиссии ресторана."
          />
          <SummaryCard label="Комиссия Direct" value={money(day.platformCommissionReceivableCents)} />
        </div>

        {/* Остальные показатели дня скрыты по умолчанию (нативный details). */}
        <details className={styles.reconDetails}>
          <summary className={styles.reconSummary}>Подробности дня</summary>
          <div className={styles.reconDetailsBody}>
            <div className={styles.summaryGrid}>
              <SummaryCard label="Стоимость заказов" value={money(day.customerTotalCents)} />
              <SummaryCard label="Собрано рестораном с клиентов" value={money(day.restaurantCollectedFromCustomerCents)} />
              <SummaryCard label="Собрано Direct с клиентов" value={money(day.platformCollectedFromCustomerCents)} />
              <SummaryCard
                label="Ожидает расчёта по журналу комиссий"
                value={money(day.pendingLedgerCents)}
              />
              <SummaryCard label="Требуют внимания" value={String(day.paidCanceledCount)} />
            </div>
          </div>
        </details>
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
