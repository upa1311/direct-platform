"use client";

import { Clock } from "lucide-react";

import type { Restaurant } from "@/prototype/models";
import { WEEKDAY_LABELS, WEEKDAY_ORDER } from "@/prototype/models";
import {
  getRestaurantLocalNow,
  getScheduleLabel,
  isRestaurantOpenNow,
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
  const now = ready ? new Date(nowMs) : null;
  const todayId = now
    ? getRestaurantLocalNow(restaurant, now).weekdayId
    : null;
  const todayLabel = todayId ? getScheduleLabel(restaurant, todayId) : "—";
  const open = now ? isRestaurantOpenNow(restaurant, now) : false;

  return (
    <div className={styles.scheduleInfo}>
      <p className={styles.scheduleToday}>
        <Clock aria-hidden="true" className={styles.scheduleIcon} size={15} />
        <span>
          Сегодня: {todayLabel}
          {ready ? (
            <>
              {" · "}
              <span
                className={open ? styles.scheduleOpen : styles.scheduleClosed}
              >
                {open ? "Сейчас открыто" : "Сейчас закрыто"}
              </span>
            </>
          ) : null}
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
                  day === todayId ? styles.scheduleRowToday : ""
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
