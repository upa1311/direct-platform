import type { Order, OrderHistoryEvent } from "@/prototype/models";
import {
  clientHistoryEvent,
  formatDateTime,
  orderActorLabels,
} from "@/prototype/selectors";
import styles from "./order-flow.module.css";

export function OrderHistory({
  events,
  order,
  clientSafe = false,
  neutralizeEtaReason = false,
}: {
  events: OrderHistoryEvent[];
  /** Заказ — источник структурных фактов для клиентски-безопасного режима (§4). */
  order?: Order;
  /** Клиентский режим (§4): нейтрализует внутренние PICKUP-тексты и actor. */
  clientSafe?: boolean;
  /** Клиентский режим (§10): у ETA-событий скрываем внутреннюю причину. */
  neutralizeEtaReason?: boolean;
}) {
  const safe = clientSafe || neutralizeEtaReason;
  // Внутреннее подтверждение кухни «Начать готовить» — только для оператора и
  // аудита (админ). Клиенту отдельным событием не показываем.
  const visibleEvents = clientSafe
    ? events.filter((event) => event.type !== "KITCHEN_START")
    : events;
  return (
    <ol className={styles.historyList}>
      {[...visibleEvents].reverse().map((event) => {
        const { message, hideActor } = safe
          ? clientHistoryEvent(event, order, clientSafe)
          : { message: event.message, hideActor: false };
        return (
          <li key={event.id}>
            <span className={styles.historyMarker} aria-hidden="true" />
            <div>
              <strong>{message}</strong>
              <span>
                {formatDateTime(event.occurredAt)}
                {hideActor ? "" : ` · ${orderActorLabels[event.actor]}`}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
