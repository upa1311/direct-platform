"use client";

import Link from "next/link";

import kds from "@/components/kitchen/kitchen.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { useAuthenticatedDriverId } from "@/components/driver/driver-session";
import { usePrototype } from "@/prototype/prototype-provider";
import { formatMoney } from "@/prototype/selectors";
import {
  getDriverEarningsView,
  type DriverEarningEntryView,
} from "@/prototype/driver-earnings";
import styles from "../driver.module.css";
import own from "./settlements.module.css";

/**
 * Раздел «Расчёты» водителя (финализирован v25). Доступен только при активной
 * сессии; driverId берётся ТОЛЬКО из сессии (не из URL), поэтому водитель видит
 * лишь свои записи.
 *
 * Три РАЗНЫХ итога не складываются и не взаимозачитываются: весь заработок, уже
 * полученная наличными часть и сумма, которую Direct ещё должен выплатить.
 * Водитель никогда не должен Direct. При переполнении итог показывается как «—» и
 * требует проверки, но история доставок сохраняется.
 */
export default function DriverSettlementsPage() {
  const sessionDriverId = useAuthenticatedDriverId();
  const { state } = usePrototype();

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

  const view = getDriverEarningsView(state, sessionDriverId);
  const hasEntries = view.entries.length > 0;

  return (
    <>
      <PageHeading
        eyebrow="Водитель"
        title="Расчёты"
        description="Заработок по доставкам, наличные выплаты и сумма, которую должен выплатить Direct."
      />

      <div className={own.wrap}>
        {view.reviewRequired ? (
          <p className={own.reviewNotice} role="status">
            Некоторые данные расчётов требуют проверки Direct. История доставок
            сохранена.
          </p>
        ) : null}

        <section className={own.summaryGrid} aria-label="Сводка расчётов">
          <SummaryCard
            title="Всего заработано"
            cents={view.totalEarningsCents}
            hint="Стоимость всех завершённых доставок в журнале."
          />
          <SummaryCard
            title="Получено наличными"
            cents={view.cashReceivedCents}
            hint="Эту сумму вы уже оставили себе из наличных заказов."
          />
          <SummaryCard
            title="К выплате Direct"
            cents={view.dueFromDirectCents}
            hint="Оплата безналичных доставок, которую Direct ещё должен вам."
          />
          <article className={own.summaryCard}>
            <span className={own.summaryTitle}>Доставок</span>
            <span className={own.summaryValue}>{view.deliveryCount}</span>
            <span className={own.summaryHint}>
              Завершённые доставки в журнале заработка.
            </span>
          </article>
        </section>

        {hasEntries ? (
          <section aria-label="История доставок">
            <h2 className={own.sectionTitle}>История доставок</h2>
            <ul className={own.historyList}>
              {view.entries.map((row) => (
                <li key={row.entry.id}>
                  <HistoryRow row={row} />
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className={own.emptyCard} aria-label="История доставок">
            <span className={own.emptyTitle}>
              {view.reviewRequired
                ? "Данные завершённых доставок требуют проверки Direct."
                : "Завершённых доставок пока нет."}
            </span>
            <p className={own.emptyText}>
              {view.reviewRequired
                ? "История сохранена, но суммы пока не подтверждены."
                : "После завершённой доставки здесь появится ваш заработок."}
            </p>
          </section>
        )}
      </div>
    </>
  );
}

/** Карточка сводки: null-итог показывается как «—» (не как подтверждённый ноль). */
function SummaryCard({
  title,
  cents,
  hint,
}: {
  title: string;
  cents: number | null;
  hint: string;
}) {
  return (
    <article className={own.summaryCard}>
      <span className={own.summaryTitle}>{title}</span>
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
      <span className={own.summaryHint}>{hint}</span>
    </article>
  );
}

/** Строка истории. Для наличного заказа показаны две физические суммы из
 * неизменяемого cash snapshot; для онлайн — только статус ожидания выплаты. */
function HistoryRow({ row }: { row: DriverEarningEntryView }) {
  const { entry } = row;
  const isCash = row.paymentMethod === "CASH";
  return (
    <article className={own.historyCard}>
      <div className={own.historyHead}>
        <span className={own.orderNumber}>Заказ №{row.publicNumber}</span>
        <span className={own.historyDate}>
          {formatRecognizedAt(entry.recognizedAt)}
        </span>
      </div>
      <span className={own.restaurantName}>{row.restaurantName}</span>
      <div className={own.amountRow}>
        <span>Заработок: {formatMoney(entry.amountCents, entry.currencyCode)}</span>
        <span className={own.statusLabel}>
          {isCash ? "Получено наличными" : "Ожидает выплаты Direct"}
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

/** Момент признания в понятном локальном формате; при сбое — исходная строка. */
function formatRecognizedAt(iso: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
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
