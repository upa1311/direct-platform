import type { OrderHistoryEvent } from "@/prototype/models";
import { formatDateTime, orderActorLabels } from "@/prototype/selectors";
import styles from "./order-flow.module.css";

export function OrderHistory({ events }: { events: OrderHistoryEvent[] }) {
  return (
    <ol className={styles.historyList}>
      {[...events].reverse().map((event) => (
        <li key={event.id}>
          <span className={styles.historyMarker} aria-hidden="true" />
          <div>
            <strong>{event.message}</strong>
            <span>
              {formatDateTime(event.occurredAt)} · {orderActorLabels[event.actor]}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
