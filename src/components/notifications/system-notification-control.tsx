"use client";

import type { DirectNotificationCapability } from "@/prototype/direct-notifications";
import styles from "./notifications.module.css";

/** Honest, non-marketing note: this V1 works only while a Direct client is open. */
export const DIRECT_NOTIFICATION_APP_OPEN_NOTE =
  "Работают, пока Direct открыт в браузере.";

/**
 * Shared presentation for the Direct system-notification control. It is a
 * SEPARATE channel from the sound bell (own accessible label), and never claims
 * background/remote push. Capability drives which honest state is shown.
 */
export function SystemNotificationControl({
  capability,
  onEnable,
  onDisable,
  title = "Системные уведомления",
}: {
  capability: DirectNotificationCapability;
  onEnable: () => void;
  onDisable: () => void;
  title?: string;
}) {
  const status = capability.status;

  if (status === "UNSUPPORTED") {
    return (
      <section className={styles.card} aria-label={title} role="group">
        <span className={styles.title}>{title}</span>
        <p className={styles.hint}>
          Этот браузер не поддерживает системные уведомления.
        </p>
      </section>
    );
  }

  if (status === "DENIED") {
    return (
      <section className={styles.card} aria-label={title} role="group">
        <span className={styles.title}>Уведомления заблокированы браузером</span>
        <p className={styles.hint}>
          Разрешите уведомления для этого сайта в настройках браузера.
        </p>
      </section>
    );
  }

  if (status === "DEGRADED") {
    return (
      <section className={styles.card} aria-label={title} role="status">
        <span className={styles.title}>{title}</span>
        <p className={styles.hint}>Системные уведомления временно недоступны.</p>
      </section>
    );
  }

  if (status === "ENABLED") {
    return (
      <section className={styles.card} aria-label={title} role="group">
        <span className={styles.title}>
          <span className={styles.enabledDot} aria-hidden="true" />
          Системные уведомления включены
        </span>
        <p className={styles.hint}>{DIRECT_NOTIFICATION_APP_OPEN_NOTE}</p>
        <button
          type="button"
          className={styles.button}
          onClick={onDisable}
          aria-label="Выключить системные уведомления"
        >
          Выключить
        </button>
      </section>
    );
  }

  // PERMISSION_REQUIRED or DISABLED — both invite the user to enable.
  return (
    <section className={styles.card} aria-label={title} role="group">
      <span className={styles.title}>Системные уведомления выключены</span>
      <p className={styles.hint}>
        Получайте уведомления о новых заказах, пока Direct открыт.
      </p>
      <button
        type="button"
        className={`${styles.button} ${styles.buttonPrimary}`}
        onClick={onEnable}
        aria-label="Включить системные уведомления"
      >
        Включить
      </button>
    </section>
  );
}
