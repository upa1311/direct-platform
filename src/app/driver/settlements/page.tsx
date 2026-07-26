"use client";

import { useState } from "react";
import Link from "next/link";

import kds from "@/components/kitchen/kitchen.module.css";
import { useAuthenticatedDriverId } from "@/components/driver/driver-session";
import { useMutationGuard } from "@/components/util/use-mutation-guard";
import { usePrototype } from "@/prototype/prototype-provider";
import { formatMoney } from "@/prototype/selectors";
import {
  getDriverSettlementPeriodView,
  type DriverEarningEntryView,
  type DriverEarningsPeriod,
} from "@/prototype/driver-earnings";
import {
  getDriverPayoutsView,
  type DriverEarningPayoutState,
  type DriverPayoutBatchView,
} from "@/prototype/driver-payouts";
import styles from "../driver.module.css";
import own from "./settlements.module.css";

const DRIVER_TIME_ZONE = "Europe/Chisinau";

/** Варианты периода сводки — локальное UI-состояние, в state не хранится. */
const PERIODS: { id: DriverEarningsPeriod; label: string }[] = [
  { id: "TODAY", label: "Сегодня" },
  { id: "LAST_7_DAYS", label: "7 дней" },
  { id: "CURRENT_MONTH", label: "Месяц" },
  { id: "ALL_TIME", label: "За весь период" },
];

/** Одна динамическая строка заработка — подпись зависит от периода. */
const EARNED_LABEL: Record<DriverEarningsPeriod, string> = {
  TODAY: "Заработано сегодня",
  LAST_7_DAYS: "Заработано за 7 дней",
  CURRENT_MONTH: "Заработано за месяц",
  ALL_TIME: "Заработано за весь период",
};

/** Пустой период — своё сообщение. */
const EMPTY_PERIOD_TEXT = "За выбранный период завершённых доставок нет.";

/**
 * Раздел «Расчёты» водителя (v27, repair). Доступен только при активной сессии;
 * driverId берётся ТОЛЬКО из сессии (не из URL). Сверху — выбор периода
 * (Сегодня / 7 дней / Месяц / Всё время); вся сводка и история доставок
 * относятся к выбранному периоду по recognizedAt в Europe/Chisinau. Статус каждой
 * доставки берётся из канонического payout read-model, а не из способа оплаты.
 * История выплат Direct остаётся полной. Null-итог показывается как «—».
 */
export default function DriverSettlementsPage() {
  const sessionDriverId = useAuthenticatedDriverId();
  const { state } = usePrototype();
  const [period, setPeriod] = useState<DriverEarningsPeriod>("TODAY");

  if (sessionDriverId === null) {
    return (
      <div className={kds.screen}>
        <div className={styles.container}>
          <div className={styles.notice} role="status">
            Войдите в систему под своим именем и номером телефона, чтобы открыть
            кабинет водителя.
          </div>
          <Link className={styles.orderLink} href="/driver">
            Перейти ко входу
          </Link>
        </div>
      </div>
    );
  }

  const nowIso = new Date().toISOString();
  const view = getDriverSettlementPeriodView(
    state,
    sessionDriverId,
    period,
    nowIso,
    DRIVER_TIME_ZONE,
  );
  const payouts = getDriverPayoutsView(state, sessionDriverId);
  const stateById = new Map<string, DriverEarningPayoutState>();
  for (const s of payouts.earningStates) stateById.set(s.earningEntryId, s.state);
  const hasEntries = view.entries.length > 0;

  return (
    <>
      {/* Локальный компактный заголовок (не общий shell-heading): плотные
          отступы только для этой страницы, eyebrow скрыт на мобильном. */}
      <header className={own.header}>
        <p className={own.eyebrow}>Водитель</p>
        <h1 className={own.title}>Расчёты</h1>
        <p className={own.headerDescription}>
          Заработок, наличные и выплаты Direct.
        </p>
      </header>

      <div className={own.wrap}>
        <div
          className={own.periodControl}
          role="group"
          aria-label="Период расчётов"
        >
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={
                p.id === period
                  ? `${own.periodButton} ${own.periodButtonActive}`
                  : own.periodButton
              }
              aria-pressed={p.id === period}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {view.reviewRequired ? (
          <p className={own.reviewNotice} role="alert">
            Некоторые данные расчётов требуют проверки Direct. История доставок
            сохранена.
          </p>
        ) : null}

        <section className={own.summary} aria-label="Сводка расчётов">
          <div className={own.summaryRow}>
            <span className={own.summaryLabel}>Завершённых доставок</span>
            <span className={own.summaryValue}>{view.completedDeliveryCount}</span>
          </div>
          <SummaryRow label={EARNED_LABEL[period]} cents={view.earnedCents} />
          <SummaryRow
            label="Получено из наличных заказов"
            cents={view.cashReceivedCents}
          />
          <SummaryRow label="Direct должен вам" cents={view.dueFromDirectCents} />
          <SummaryRow
            label="Direct отправил — ждёт подтверждения"
            cents={view.sentByDirectCents}
          />
          <SummaryRow label="Получено от Direct" cents={view.receivedFromDirectCents} />
        </section>

        {payouts.batches.length > 0 ? (
          <section aria-label="Выплаты Direct">
            <h2 className={own.sectionTitle}>Выплаты Direct</h2>
            <ul className={own.historyList}>
              {payouts.batches.map((batch) => (
                <li key={batch.id}>
                  <PayoutCard driverId={sessionDriverId} batch={batch} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {hasEntries ? (
          <section aria-label="История доставок">
            <h2 className={own.sectionTitle}>История доставок</h2>
            <ul className={own.historyList}>
              {view.entries.map((row) => (
                <li key={row.entry.id}>
                  <HistoryRow row={row} payoutState={stateById.get(row.entry.id)} />
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className={own.emptyCard} aria-label="История доставок">
            <span className={own.emptyTitle}>
              {view.reviewRequired
                ? "Данные завершённых доставок требуют проверки Direct."
                : EMPTY_PERIOD_TEXT}
            </span>
            <p className={own.emptyText}>
              {view.reviewRequired
                ? "История сохранена, но суммы пока не подтверждены."
                : "Выберите другой период или дождитесь завершённой доставки."}
            </p>
          </section>
        )}
      </div>
    </>
  );
}

/** Строка компактной сводки: label слева, сумма справа; null → «—». */
function SummaryRow({ label, cents }: { label: string; cents: number | null }) {
  return (
    <div className={own.summaryRow}>
      <span className={own.summaryLabel}>{label}</span>
      {cents === null ? (
        <span
          className={own.summaryValue}
          aria-label="Итог недоступен и требует проверки Direct"
        >
          —
        </span>
      ) : (
        <span className={own.summaryValue}>{formatMoney(cents)}</span>
      )}
    </div>
  );
}

const METHOD_LABEL: Record<DriverPayoutBatchView["method"], string> = {
  BANK_TRANSFER: "На карту",
  CASH: "Наличными",
};

/** Карточка одной выплаты Direct с подтверждением фактического получения. */
function PayoutCard({
  driverId,
  batch,
}: {
  driverId: string;
  batch: DriverPayoutBatchView;
}) {
  const { confirmDriverPayoutReceipt } = usePrototype();
  const guard = useMutationGuard();
  const isBank = batch.method === "BANK_TRANSFER";
  const confirmed = batch.status === "CONFIRMED_RECEIVED";

  const onConfirm = () => {
    if (guard.pending) return;
    void guard.run(async () => {
      const r = await confirmDriverPayoutReceipt(driverId, batch.id);
      return { ok: r.ok, error: r.error, changed: r.ok };
    });
  };

  return (
    <article className={own.payoutCard}>
      <div className={own.historyHead}>
        <span className={own.orderNumber}>{formatMoney(batch.amountCents)}</span>
        <span className={own.historyDate}>{formatDate(batch.sentAt)}</span>
      </div>
      <div className={own.amountRow}>
        <span>{METHOD_LABEL[batch.method]}</span>
        <span className={confirmed ? own.statusConfirmed : own.statusLabel}>
          {confirmed ? "Расчёт подтверждён" : "Ожидает вашего подтверждения"}
        </span>
      </div>
      <span className={own.payoutMeta}>
        Доставок: {batch.earningCount} · заработок{" "}
        {formatDate(batch.firstEarningAt)} — {formatDate(batch.lastEarningAt)}
      </span>
      {batch.externalReference !== null ? (
        <span className={own.payoutMeta}>Операция: {batch.externalReference}</span>
      ) : null}
      {batch.note !== null ? (
        <span className={own.payoutMeta}>Комментарий: {batch.note}</span>
      ) : null}

      {confirmed ? (
        <p className={own.payoutConfirmedText} role="status">
          Вы подтвердили получение {formatMoney(batch.amountCents)} (
          {METHOD_LABEL[batch.method]})
          {batch.confirmedAt ? ` — ${formatDate(batch.confirmedAt)}` : ""}.
        </p>
      ) : (
        <>
          <p className={own.payoutHint}>
            {isBank
              ? "Direct отправил деньги на ваш счёт."
              : "Direct отметил передачу наличных."}{" "}
            Подтвердите только после фактического получения денег.
          </p>
          {guard.error ? (
            <p className={own.payoutError} role="alert">
              {guard.error}
            </p>
          ) : null}
          <button
            type="button"
            className={own.payoutConfirmButton}
            onClick={onConfirm}
            disabled={guard.pending}
          >
            {isBank ? "Да, деньги получил" : "Да, наличные получил"}
          </button>
        </>
      )}
    </article>
  );
}

/**
 * Подпись статуса одной доставки из КАНОНИЧЕСКОГО payout read-model (единый
 * источник). React не определяет статус ONLINE по способу оплаты — иначе один
 * экран мог бы показать подтверждённую выплату и «ожидает выплаты» для одной
 * earning одновременно.
 */
function statusLabelFor(state: DriverEarningPayoutState | undefined): string {
  switch (state) {
    case "NOT_APPLICABLE_CASH_RETAINED":
      return "Получено наличными";
    case "DUE_FROM_DIRECT":
      return "Ожидает выплаты Direct";
    case "SENT_AWAITING_CONFIRMATION":
      return "Direct отправил — ждёт подтверждения";
    case "CONFIRMED_RECEIVED":
      return "Получено от Direct";
    default:
      return "Требует проверки Direct";
  }
}

/** Строка истории доставок. Для наличного заказа показаны две физические суммы. */
function HistoryRow({
  row,
  payoutState,
}: {
  row: DriverEarningEntryView;
  payoutState: DriverEarningPayoutState | undefined;
}) {
  const { entry } = row;
  const isCash = row.paymentMethod === "CASH";
  const confirmed = payoutState === "CONFIRMED_RECEIVED";
  return (
    <article className={own.historyCard}>
      <div className={own.historyHead}>
        <span className={own.orderNumber}>Заказ №{row.publicNumber}</span>
        <span className={own.historyDate}>{formatDate(entry.recognizedAt)}</span>
      </div>
      <span className={own.restaurantName}>{row.restaurantName}</span>
      <div className={own.amountRow}>
        <span>Заработок: {formatMoney(entry.amountCents, entry.currencyCode)}</span>
        <span className={confirmed ? own.statusConfirmed : own.statusLabel}>
          {statusLabelFor(payoutState)}
        </span>
      </div>
      {isCash &&
      row.customerCollectionCents !== null &&
      row.restaurantHandoffCents !== null ? (
        <div className={own.secondaryRow}>
          <span>
            Получено от клиента:{" "}
            {formatMoney(row.customerCollectionCents, entry.currencyCode)}
          </span>
          <span>
            Передано ресторану:{" "}
            {formatMoney(row.restaurantHandoffCents, entry.currencyCode)}
          </span>
        </div>
      ) : null}
    </article>
  );
}

/** Момент в понятном локальном формате Europe/Chisinau; при сбое — исходная строка. */
function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: DRIVER_TIME_ZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
