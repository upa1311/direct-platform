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
  buildRestaurantSettlementOverview,
  RESTAURANT_SETTLEMENT_PERIOD_LABELS,
  RESTAURANT_SETTLEMENT_PERIOD_ORDER,
  SETTLEMENT_COLLECTOR_LABELS,
  type RestaurantSettlementPeriod,
} from "@/prototype/restaurant-settlements";
import styles from "./settlements.module.css";

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
        </div>
      )}
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
