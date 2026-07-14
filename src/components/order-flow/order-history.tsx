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
        // §2: у клиента для ETA-событий скрываем и причину, и actor.
        const neutralizedEta = neutralizeEtaReason && event.type === "ETA";
        const message = neutralizedEta
          ? "Ресторан обновил ожидаемое время готовности заказа."
          : event.message;
        return (
          <li key={event.id}>
            <span className={styles.historyMarker} aria-hidden="true" />
            <div>
              <strong>{message}</strong>
              <span>
                {formatDateTime(event.occurredAt)}
                {neutralizedEta ? "" : ` · ${orderActorLabels[event.actor]}`}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
