"use client";

import { Clock } from "lucide-react";

import type { Restaurant } from "@/prototype/models";
import { WEEKDAY_LABELS, WEEKDAY_ORDER } from "@/prototype/models";
import {
  getClientRestaurantAvailabilityAt,
  getClientRestaurantScheduleSummary,
  getScheduleLabel,
} from "@/prototype/selectors";
import styles from "./order-flow.module.css";

/**
 * Клиентский график работы ресторана (§5). День и статус «открыто/закрыто»
 * считаются в часовом поясе РЕСТОРАНА (getRestaurantLocalNow / isRestaurantOpenNow),
 * не по времени компьютера клиента. IANA-таймзона клиенту не показывается.
 *
 * SSR-безопасно: до гидратации nowMs === 0 → «Сегодня: —» без «Сейчас
 * открыто/закрыто», чтобы не было mismatch. После гидратации используется
 * new Date(nowMs). Это только отображение — бизнес-логика не меняется.
 */
export function ClientRestaurantSchedule({
  restaurant,
  nowMs,
  showFullSchedule = false,
}: {
  restaurant: Restaurant;
  nowMs: number;
  showFullSchedule?: boolean;
}) {
  const ready = nowMs > 0;
  const summary = ready
    ? getClientRestaurantScheduleSummary(restaurant, new Date(nowMs))
    : null;
  const availability = ready
    ? getClientRestaurantAvailabilityAt(restaurant, nowMs)
    : null;
  // Активный день подсвечивается в полном графике: при ночном интервале это
  // может быть вчерашний день (тот, чей интервал сейчас продолжается).
  const activeDayId = summary?.activeScheduleWeekdayId ?? null;

  // §5: статус берётся из ЕДИНОГО availability — «Сейчас открыто» показывается
  // только когда заказ реально можно отправить. Пауза/админ-отключение
  // переопределяют график; ночной интервал использует спец-текст summary.
  let statusText = "Сегодня: —";
  if (summary && availability) {
    if (
      availability.state === "ACCEPTING" ||
      availability.state === "CLOSED_SCHEDULE"
    ) {
      statusText = summary.statusText;
    } else if (availability.state === "OPERATIONAL_PAUSE") {
      statusText = `Сегодня: ${summary.todayScheduleLabel} · Временно не принимает заказы`;
    } else if (availability.state === "ADMIN_DISABLED") {
      statusText = `Сегодня: ${summary.todayScheduleLabel} · Сейчас не принимает заказы`;
    } else {
      statusText = "Заказы недоступны";
    }
  }
  const openTone = availability?.state === "ACCEPTING";

  return (
    <div className={styles.scheduleInfo}>
      <p className={styles.scheduleToday}>
        <Clock aria-hidden="true" className={styles.scheduleIcon} size={15} />
        <span>
          <span
            className={openTone ? styles.scheduleOpen : styles.scheduleClosed}
          >
            {statusText}
          </span>
        </span>
      </p>
      {showFullSchedule ? (
        <details className={styles.scheduleDetails}>
          <summary>График работы</summary>
          <dl className={styles.scheduleWeek}>
            {WEEKDAY_ORDER.map((day) => (
              <div
                key={day}
                className={`${styles.scheduleRow} ${
                  day === activeDayId ? styles.scheduleRowToday : ""
                }`}
              >
                <dt>{WEEKDAY_LABELS[day]}</dt>
                <dd>{getScheduleLabel(restaurant, day)}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}
