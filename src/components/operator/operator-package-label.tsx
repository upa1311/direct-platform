import type { OperatorPackageLabelData } from "./operator-package-label-data";
import styles from "./operator-package-label.module.css";

/**
 * Пакетная наклейка оператора (одна на весь заказ). Компонент презентационный:
 * принимает уже безопасную label-data и не имеет доступа ни к Order, ни к state,
 * поэтому напечатать имя клиента, адрес, телефон, код выдачи, суммы, водителя
 * или cooking comments физически нечем.
 *
 * Порядок макета: DIRECT → НАКЛЕЙКА НА ПАКЕТ → способ получения → номер →
 * ресторан → позиции (без комментариев) → количество → платёжный маркер.
 */
export function OperatorPackageLabel({
  data,
}: {
  data: OperatorPackageLabelData;
}) {
  return (
    <div className={styles.label}>
      <div className={styles.brand}>DIRECT</div>
      <div className={styles.kind}>НАКЛЕЙКА НА ПАКЕТ</div>
      <div className={styles.delivery}>{data.deliveryLabel}</div>
      <div className={styles.number}>{data.publicNumber}</div>
      <div className={styles.line}>{data.restaurantName}</div>

      <ul className={styles.items}>
        {data.items.map((item, index) => (
          <li className={styles.item} key={`${item.name}-${index}`}>
            {item.quantity} × {item.name}
            {item.variantName ? ` · ${item.variantName}` : ""}
          </li>
        ))}
      </ul>

      <div className={styles.counts}>{data.countsLine}</div>

      <div className={styles.payment}>{data.paymentLabel}</div>
    </div>
  );
}
