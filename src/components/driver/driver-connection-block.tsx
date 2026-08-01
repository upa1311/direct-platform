"use client";

import type { DriverConnectionView } from "@/prototype/driver-connection";
import styles from "@/app/driver/driver.module.css";

/** Local HH:MM rendering of the confirmed state's updatedAt (not server time). */
function formatSyncClock(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time));
}

/**
 * One compact connection block for the driver workspace. States are distinguished
 * by TEXT (not colour alone); recovering/degraded are announced; the retry button
 * has a clear accessible name. It never claims a working backend — only the
 * browser signal + last confirmed local state.
 */
export function DriverConnectionBlock({
  view,
  onRetry,
}: {
  view: DriverConnectionView;
  onRetry: () => void;
}) {
  if (view.status === "ONLINE") {
    const clock = formatSyncClock(view.lastStateUpdatedAt);
    return (
      <div className={styles.connectionOnline} role="status">
        <span className={styles.connectionTitle}>На связи</span>
        {clock !== null ? (
          <span className={styles.connectionDetail}>Данные актуальны: {clock}</span>
        ) : null}
      </div>
    );
  }

  if (view.status === "RECOVERING" || view.status === "INITIALIZING") {
    return (
      <div className={styles.connectionRecovering} role="status" aria-busy="true">
        <span className={styles.connectionTitle}>
          {view.status === "INITIALIZING"
            ? "Проверяем соединение"
            : "Восстанавливаем связь"}
        </span>
        <span className={styles.connectionDetail}>
          Обновляем предложения и активный заказ…
        </span>
      </div>
    );
  }

  if (view.status === "OFFLINE") {
    return (
      <div className={styles.connectionOffline} role="alert">
        <span className={styles.connectionTitle}>Нет соединения</span>
        <span className={styles.connectionDetail}>
          Показаны последние доступные данные. Действия временно недоступны.
        </span>
      </div>
    );
  }

  // DEGRADED
  return (
    <div className={styles.connectionDegraded} role="alert">
      <span className={styles.connectionTitle}>Не удалось обновить данные</span>
      <span className={styles.connectionDetail}>
        Действия временно недоступны.
      </span>
      <button
        type="button"
        className={styles.connectionRetryButton}
        onClick={onRetry}
        aria-label="Повторить обновление данных"
      >
        Повторить
      </button>
    </div>
  );
}
