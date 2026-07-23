"use client";

import { formatMoney } from "@/prototype/selectors";
import type { Order, PrototypeState, ZoneId } from "@/prototype/models";
import styles from "@/app/driver/driver.module.css";

/**
 * Карточка нового предложения (до принятия). Приватность: показывается только
 * улица и зона клиента; дом, квартира, подъезд, этаж, имя, телефон и комментарий
 * скрыты. Выплата берётся строго из неизменяемого снимка заказа.
 */
export function DriverOfferCard({
  order,
  remainingMs,
  zoneName,
  restaurantTimeZone,
  disabled,
  onAccept,
  onDecline,
}: {
  order: Order;
  remainingMs: number;
  zoneName: (zoneId: ZoneId | null) => string;
  restaurantTimeZone: string;
  disabled: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const readiness =
    order.status === "READY"
      ? "Готовность: Готов"
      : order.expectedReadyAt !== null
        ? `Ожидаемая готовность: ${formatTime(order.expectedReadyAt, restaurantTimeZone)}`
        : "Готовится";

  return (
    <div className={styles.offerCard}>
      <div className={styles.offerHead}>
        <span className={styles.offerNumber}>Заказ {order.publicNumber}</span>
        <span className={styles.offerPayout}>
          Ваша выплата:{" "}
          {formatMoney(
            order.financials.driverPayoutCents,
            order.financials.currencyCode,
          )}
        </span>
      </div>

      <div className={styles.offerSection}>
        <span className={styles.offerSectionLabel}>Забрать</span>
        <span className={styles.offerSectionValue}>{order.restaurant.name}</span>
        <span className={styles.offerSectionValue}>
          {order.restaurant.address}
        </span>
        <span className={styles.offerSectionValue}>
          {zoneName(order.restaurant.zoneId)}
        </span>
      </div>

      <div className={styles.offerSection}>
        <span className={styles.offerSectionLabel}>Доставить</span>
        {/* До принятия — только улица и зона клиента, без точного адреса. */}
        <span className={styles.offerSectionValue}>
          {order.address?.street ?? "—"}
        </span>
        <span className={styles.offerSectionValue}>
          {zoneName(order.financials.customerZoneId)}
        </span>
      </div>

      <div className={styles.offerSection}>
        <span className={styles.offerSectionValue}>{readiness}</span>
        <span className={styles.offerSectionValue}>Оплата онлайн</span>
      </div>

      <div className={styles.offerMetaRow}>
        <span>Осталось:</span>
        <span className={styles.offerCountdown}>
          {formatCountdown(remainingMs)}
        </span>
      </div>

      <div className={styles.offerActions}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={disabled}
          onClick={onAccept}
        >
          Принять заказ
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={disabled}
          onClick={onDecline}
        >
          Отказаться
        </button>
      </div>
    </div>
  );
}

/** Таймзона ресторана заказа (для форматирования готовности), с fallback. */
export function restaurantTimeZoneOf(
  state: PrototypeState,
  order: Order,
): string {
  return (
    state.restaurants.find((r) => r.id === order.restaurant.id)?.timeZone ??
    "Europe/Chisinau"
  );
}

/** Оставшееся время как MM:SS (не меньше 00:00). */
function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Время готовности HH:MM в поясе ресторана. */
function formatTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timeZone || "Europe/Chisinau",
    }).format(new Date(iso));
  } catch {
    return "—";
  }
}
