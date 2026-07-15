"use client";

import { Clock } from "lucide-react";

import type { Restaurant } from "@/prototype/models";
import { WEEKDAY_LABELS, WEEKDAY_ORDER } from "@/prototype/models";
import {
  getClientRestaurantScheduleSummary,
  getScheduleLabel,
} from "@/prototype/selectors";
import { RestaurantAvailabilityBadge } from "./restaurant-availability-badge";
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
  // Активный день подсвечивается в полном графике: при ночном интервале это
  // может быть вчерашний день (тот, чей интервал сейчас продолжается).
  const activeDayId = summary?.activeScheduleWeekdayId ?? null;

  // §0.2: ночной интервал предыдущего дня, продолжающийся после полуночи. Тогда
  // «Сегодня: Закрыто» рядом с бейджем «Открыто» противоречиво — показываем
  // объясняющий текст «Сейчас открыто до 02:00 · Сегодня: Закрыто».
  const isCarriedOverNight =
    summary?.isOpen === true &&
    summary.activeScheduleWeekdayId !== summary.currentWeekdayId;

  // §2: в обычном случае строка графика показывает ТОЛЬКО рабочие часы.
  // Фактическую возможность заказа (открыто/пауза/закрыто) + вторичную подсказку
  // показывает единый RestaurantAvailabilityBadge — статус не дублируется.
  const hoursText = summary
    ? isCarriedOverNight
      ? summary.statusText
      : `Сегодня: ${summary.todayScheduleLabel}`
    : "Сегодня: —";

  return (
    <div className={styles.scheduleInfo}>
      <p className={styles.scheduleToday}>
        <Clock aria-hidden="true" className={styles.scheduleIcon} size={15} />
        <span>{hoursText}</span>
      </p>
      {ready ? (
        <RestaurantAvailabilityBadge restaurant={restaurant} nowMs={nowMs} />
      ) : null}
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
