import type { KitchenOrderLabelData } from "./kitchen-order-label-data";
import styles from "./kitchen-order-label.module.css";

/**
 * Термонаклейка заказа (одна на весь заказ). Компонент презентационный: он
 * принимает уже безопасную label-data и не имеет доступа ни к Order, ни к
 * state, поэтому напечатать клиента, код выдачи или финансы физически нечем.
 */
export function KitchenOrderLabel({ data }: { data: KitchenOrderLabelData }) {
  return (
    <div className={styles.label}>
      <div className={styles.brand}>{data.brand}</div>
      <div className={styles.number}>{data.publicNumber}</div>

      <div className={styles.delivery}>{data.deliveryLabel}</div>
      <div className={styles.ready}>{data.readyLine}</div>

      <hr className={styles.rule} />

      <ul className={styles.items}>
        {data.items.map((item, index) => (
          <li className={styles.item} key={`${item.name}-${index}`}>
            <div className={styles.itemLine}>
              {item.quantity} × {item.name}
              {item.variantName ? ` · ${item.variantName}` : ""}
            </div>
            {item.comment ? (
              <div className={styles.comment}>ВАЖНО: {item.comment}</div>
            ) : null}
          </li>
        ))}
      </ul>

      <div className={styles.counts}>{data.countsLine}</div>

      <div className={styles.payment}>{data.paymentLabel}</div>

      <div className={styles.footer}>
        {data.restaurantName}
        {data.acceptedLine ? ` · ${data.acceptedLine}` : ""}
      </div>
    </div>
  );
}
