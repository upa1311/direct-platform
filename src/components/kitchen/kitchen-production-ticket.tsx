import type { KitchenProductionTicketData } from "./kitchen-production-ticket-data";
import styles from "./kitchen-production-ticket.module.css";

/**
 * Производственный кухонный тикет (один на весь заказ). Компонент
 * презентационный: принимает уже безопасную ticket-data и не имеет доступа ни к
 * Order, ни к state, поэтому напечатать имя клиента, адрес, телефон, код выдачи
 * или финансы физически нечем.
 *
 * Порядок макета сверху вниз: заголовок → способ получения → номер заказа →
 * позиции (с комментариями) → количество → первоначальная оценка → и строго в
 * самом низу крупный блок с рамкой «ОЖИДАЕМАЯ ГОТОВНОСТЬ» (последний элемент).
 */
export function KitchenProductionTicket({
  data,
}: {
  data: KitchenProductionTicketData;
}) {
  return (
    <div className={styles.ticket}>
      <div className={styles.header}>ПРОИЗВОДСТВЕННЫЙ ЗАКАЗ</div>
      <div className={styles.delivery}>{data.deliveryLabel}</div>
      {/* Одна строка (точная строка «Номер заказа: DIR-1003»). */}
      <div className={styles.number}>Номер заказа: {data.publicNumber}</div>

      <ul className={styles.items}>
        {data.items.map((item, index) => (
          <li className={styles.item} key={`${item.name}-${index}`}>
            <div className={styles.itemLine}>
              {item.quantity} × {item.name}
              {item.variantName ? ` · ${item.variantName}` : ""}
            </div>
            {item.cookingComment ? (
              <div className={styles.comment}>ВАЖНО: {item.cookingComment}</div>
            ) : null}
          </li>
        ))}
      </ul>

      <div className={styles.counts}>{data.countsLine}</div>
      {/* Пустую оценку не печатаем, чтобы не оставлять пустую строку. */}
      {data.preparationMinutes != null ? (
        <div className={styles.estimate}>
          Первоначальная оценка: {data.preparationMinutes} мин
        </div>
      ) : null}

      {/* Последний элемент тикета: крупная рамка с временем готовности. */}
      <div className={styles.readyFrame}>{data.readyLine}</div>
    </div>
  );
}
