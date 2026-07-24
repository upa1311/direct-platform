"use client";

import Link from "next/link";

import kds from "@/components/kitchen/kitchen.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { useAuthenticatedDriverId } from "@/components/driver/driver-session";
import { usePrototype } from "@/prototype/prototype-provider";
import { formatMoney } from "@/prototype/selectors";
import { getDriverCashLedgerView } from "@/prototype/driver-cash-ledger";
import styles from "../driver.module.css";
import own from "./settlements.module.css";

/**
 * Раздел «Расчёты» водителя. Доступен только при активной сессии; driverId
 * берётся ТОЛЬКО из сессии (не из URL), поэтому водитель видит лишь свои записи.
 *
 * Показываются две РАЗНЫЕ экономические величины, которые нельзя складывать или
 * вычитать друг из друга: заработок, уже удержанный водителем из полученных
 * наличных, и деньги Direct, которые пока физически находятся у водителя.
 * Netting здесь не выполняется. Онлайн-выплаты в этот раздел пока не входят.
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

  const view = getDriverCashLedgerView(state, sessionDriverId);

  return (
    <>
      <PageHeading
        eyebrow="Водитель"
        title="Расчёты"
        description="Заработок с наличных доставок и сумма, которую нужно передать Direct."
      />

      <div className={own.wrap}>
        {view.reviewRequired ? (
          <p className={own.reviewNotice} role="status">
            Некоторые расчёты требуют проверки Direct.
          </p>
        ) : null}

        <section className={own.summaryGrid} aria-label="Сводка наличных расчётов">
          <article className={own.summaryCard}>
            <span className={own.summaryTitle}>Заработок с наличных заказов</span>
            <span className={own.summaryValue}>
              {formatMoney(view.cashEarningsCents)}
            </span>
            <span className={own.summaryHint}>
              Эта сумма уже осталась у вас после наличных доставок.
            </span>
          </article>

          <article className={own.summaryCard}>
            <span className={own.summaryTitle}>Передать Direct</span>
            <span className={own.summaryValue}>
              {formatMoney(view.dueToDirectCents)}
            </span>
            <span className={own.summaryHint}>
              Деньги Direct, которые остались у вас после наличных заказов.
            </span>
          </article>

          <article className={own.summaryCard}>
            <span className={own.summaryTitle}>Наличных доставок</span>
            <span className={own.summaryValue}>{view.cashDeliveryCount}</span>
            <span className={own.summaryHint}>
              Завершённые наличные заказы в журнале.
            </span>
          </article>
        </section>

        {view.entries.length === 0 ? (
          <section className={own.emptyCard} aria-label="Наличных расчётов пока нет">
            <span className={own.emptyTitle}>Наличных расчётов пока нет</span>
            <p className={own.emptyText}>
              После завершённой наличной доставки здесь появятся ваш заработок и
              сумма к передаче Direct.
            </p>
          </section>
        ) : (
          <section aria-label="История наличных доставок">
            <h2 className={own.sectionTitle}>История наличных доставок</h2>
            <ul className={own.historyList}>
              {view.entries.map(({ entry, order }) => (
                <li key={entry.id}>
                  <article className={own.historyCard}>
                    <div className={own.historyHead}>
                      <span className={own.orderNumber}>
                        Заказ №{order.publicNumber}
                      </span>
                      <span className={own.historyDate}>
                        {formatRecognizedAt(entry.recognizedAt)}
                      </span>
                    </div>
                    <span className={own.restaurantName}>
                      {order.restaurant.name}
                    </span>
                    <div className={own.amountRow}>
                      <span>
                        Заработок:{" "}
                        {formatMoney(entry.driverEarningCents, entry.currencyCode)}
                      </span>
                      <span>
                        Передать Direct:{" "}
                        {formatMoney(
                          entry.directReceivableFromDriverCents,
                          entry.currencyCode,
                        )}
                      </span>
                    </div>
                    <div className={own.secondaryRow}>
                      <span>
                        Получено от клиента:{" "}
                        {formatMoney(
                          entry.customerCollectionCents,
                          entry.currencyCode,
                        )}
                      </span>
                      <span>
                        Передано ресторану:{" "}
                        {formatMoney(
                          entry.restaurantHandoffCents,
                          entry.currencyCode,
                        )}
                      </span>
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className={own.note}>Онлайн-выплаты пока не входят в этот раздел.</p>
      </div>
    </>
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
