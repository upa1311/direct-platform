"use client";

import {
  BREAKDOWN_CODE_LABELS,
  type RestaurantBalanceBreakdown,
  type RestaurantBalanceBreakdownLine,
} from "@/prototype/restaurant-balance-breakdown";
import styles from "./restaurant-balance-breakdown.module.css";

/**
 * Общая презентация расшифровки баланса: администратор Direct и ресторан
 * видят ОДНИ И ТЕ ЖЕ категории, суммы, количества заказов и детали доплат.
 *
 * Компонент получает уже готовую расшифровку и ничего не считает: финансовой
 * арифметики в React нет, подписи берутся из общего словаря.
 */

/** Строка категории: сумма, число заказов и раскрываемый список заказов. */
function BreakdownLine({
  line,
  money,
  showSign,
}: {
  line: RestaurantBalanceBreakdownLine;
  money: (cents: number) => string;
  /** Для формулы выплаты знак делает направление очевидным. */
  showSign: boolean;
}) {
  const label = BREAKDOWN_CODE_LABELS[line.code];
  const sign = !showSign ? "" : line.effect === "SUBTRACT" ? "−" : "+";
  return (
    <div className={styles.line}>
      <div className={styles.lineHead}>
        <span className={styles.lineLabel}>{label}</span>
        <span className={styles.lineAmount}>
          {sign}
          {money(line.amountCents)}
          {line.orderCount > 1 ? (
            <span className={styles.lineCount}> · {line.orderCount}</span>
          ) : null}
        </span>
      </div>
      <details className={styles.lineDetails}>
        <summary className={styles.lineSummary}>Заказы</summary>
        <ul className={styles.orderList}>
          {line.orders.map((order) => (
            <li className={styles.orderRow} key={order.orderId}>
              <span>{order.publicNumber}</span>
              <span>{money(order.amountCents)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function RestaurantBalanceBreakdownView({
  breakdown,
  money,
  restaurantSideTitle,
  directSideTitle,
}: {
  breakdown: RestaurantBalanceBreakdown;
  money: (cents: number) => string;
  /** Подпись стороны ресторана (в кабинете — «Вы должны Direct»). */
  restaurantSideTitle: string;
  /** Подпись стороны Direct (в кабинете — «Direct должен вам»). */
  directSideTitle: string;
}) {
  const hasRestaurantSide = breakdown.restaurantOwesDirect.lines.length > 0;
  const hasDirectSide = breakdown.directOwesRestaurant.lines.length > 0;
  const hasInfo = breakdown.informationalLines.length > 0;

  return (
    <section
      className={styles.breakdown}
      aria-label="Из чего сложился текущий баланс"
    >
      <h3 className={styles.title}>Из чего сложился текущий баланс</h3>

      {!hasRestaurantSide && !hasDirectSide ? (
        <p className={styles.note}>Открытых обязательств сейчас нет.</p>
      ) : null}

      {hasRestaurantSide ? (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{restaurantSideTitle}</span>
            <span className={styles.sectionTotal}>
              {money(breakdown.restaurantOwesDirect.totalCents)}
            </span>
          </div>
          {breakdown.restaurantOwesDirect.lines.map((line) => (
            <BreakdownLine
              key={line.code}
              line={line}
              money={money}
              showSign={false}
            />
          ))}
        </div>
      ) : null}

      {hasDirectSide ? (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{directSideTitle}</span>
            <span className={styles.sectionTotal}>
              {money(breakdown.directOwesRestaurant.totalCents)}
            </span>
          </div>
          {breakdown.directOwesRestaurant.lines.map((line) => (
            <BreakdownLine
              key={line.code}
              line={line}
              money={money}
              showSign
            />
          ))}
        </div>
      ) : null}

      {hasInfo ? (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>
              Не входит во взаиморасчёт
            </span>
          </div>
          {breakdown.informationalLines.map((line) => (
            <BreakdownLine
              key={line.code}
              line={line}
              money={money}
              showSign={false}
            />
          ))}
        </div>
      ) : null}

      {breakdown.reviewRequiredOrderCount > 0 ? (
        <p className={styles.warning} role="status">
          Есть заказы, которые не входят в расшифровку и требуют проверки
          финансовых данных. Полный расчёт будет недоступен до завершения
          проверки.
        </p>
      ) : null}
      {breakdown.pendingPaymentChannelOrderCount > 0 ? (
        <p className={styles.note} role="status">
          Есть самовывозы, по которым способ оплаты ещё не подтверждён. Они пока
          не входят в баланс.
        </p>
      ) : null}
    </section>
  );
}
