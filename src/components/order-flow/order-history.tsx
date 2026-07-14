import type { OrderHistoryEvent } from "@/prototype/models";
import { formatDateTime, orderActorLabels } from "@/prototype/selectors";
import styles from "./order-flow.module.css";

export function OrderHistory({
  events,
  neutralizeEtaReason = false,
}: {
  events: OrderHistoryEvent[];
  /** Клиентский режим (§10): у ETA-событий скрываем внутреннюю причину. */
  neutralizeEtaReason?: boolean;
}) {
  return (
    <ol className={styles.historyList}>
      {[...events].reverse().map((event) => {
        const message =
          neutralizeEtaReason && event.type === "ETA"
            ? "Ресторан обновил ожидаемое время готовности заказа."
            : event.message;
        return (
          <li key={event.id}>
            <span className={styles.historyMarker} aria-hidden="true" />
            <div>
              <strong>{message}</strong>
              <span>
                {formatDateTime(event.occurredAt)} ·{" "}
                {orderActorLabels[event.actor]}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
