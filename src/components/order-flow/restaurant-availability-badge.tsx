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
 * Компактные подписи для страницы оформления: один актуальный статус без
 * вторичных подсказок. Тексты закреплены только для однозначных состояний;
 * прочие честные статусы (`unavailable`) показываются как есть — такой
 * ресторан не называется открытым.
 */
const CHECKOUT_LABEL: Partial<Record<RestaurantAvailabilityTone, string>> = {
  accepting: "Открыто · принимает заказы",
  closed: "Ресторан сейчас закрыт",
  paused: "Ресторан временно не принимает заказы",
};

/**
 * §9/§10: единый клиентский статус доступности ресторана — точка + подпись без
 * серой капсулы. Опирается на getClientRestaurantAvailabilityAt, поэтому текст
 * никогда не противоречит фактической возможности заказа и графику. Вторичная
 * подсказка (возобновление паузы / ближайшее открытие) — под бейджем.
 *
 * `compactCheckout` — режим страницы оформления: без detailLabel и с
 * checkout-текстами статусов; остальные места использования не меняются.
 */
export function RestaurantAvailabilityBadge({
  restaurant,
  nowMs,
  showDetail = true,
  compactCheckout = false,
}: {
  restaurant: Restaurant;
  nowMs: number;
  showDetail?: boolean;
  compactCheckout?: boolean;
}) {
  const availability = getClientRestaurantAvailabilityAt(restaurant, nowMs);
  const label = compactCheckout
    ? (CHECKOUT_LABEL[availability.tone] ?? availability.shortLabel)
    : availability.shortLabel;
  const detailVisible = showDetail && !compactCheckout;
  return (
    <>
      <span
        className={`${styles.restaurantAvailability} ${
          TONE_CLASS[availability.tone]
        }`}
      >
        <span className={styles.restaurantAvailabilityDot} aria-hidden="true" />
        <span>{label}</span>
      </span>
      {detailVisible && availability.detailLabel ? (
        <span className={styles.restaurantAvailabilityNote}>
          {availability.detailLabel}
        </span>
      ) : null}
    </>
  );
}
