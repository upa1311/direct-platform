"use client";

import type { Restaurant } from "@/prototype/models";
import {
  getClientRestaurantAvailabilityAt,
  type RestaurantAvailabilityTone,
} from "@/prototype/selectors";
import styles from "./order-flow.module.css";

const TONE_CLASS: Record<RestaurantAvailabilityTone, string> = {
  accepting: styles.restaurantAvailabilityAccepting,
  paused: styles.restaurantAvailabilityPaused,
  closed: styles.restaurantAvailabilityClosed,
  unavailable: styles.restaurantAvailabilityUnavailable,
};

/**
 * §9/§10: единый клиентский статус доступности ресторана — точка + подпись без
 * серой капсулы. Опирается на getClientRestaurantAvailabilityAt, поэтому текст
 * никогда не противоречит фактической возможности заказа и графику. Вторичная
 * подсказка (возобновление паузы / ближайшее открытие) — под бейджем.
 */
export function RestaurantAvailabilityBadge({
  restaurant,
  nowMs,
  showDetail = true,
}: {
  restaurant: Restaurant;
  nowMs: number;
  showDetail?: boolean;
}) {
  const availability = getClientRestaurantAvailabilityAt(restaurant, nowMs);
  return (
    <>
      <span
        className={`${styles.restaurantAvailability} ${
          TONE_CLASS[availability.tone]
        }`}
      >
        <span className={styles.restaurantAvailabilityDot} aria-hidden="true" />
        <span>{availability.shortLabel}</span>
      </span>
      {showDetail && availability.detailLabel ? (
        <span className={styles.restaurantAvailabilityNote}>
          {availability.detailLabel}
        </span>
      ) : null}
    </>
  );
}
