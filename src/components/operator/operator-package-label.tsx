import {
  formatPackageLabelItemLine,
  PACKAGE_LABEL_LOGO_SRC,
  type OperatorPackageLabelData,
} from "./operator-package-label-data";
import styles from "./operator-package-label.module.css";

/**
 * Пакетная наклейка (одна на весь заказ). Компонент презентационный: принимает
 * уже безопасную label-data и не имеет доступа ни к Order, ни к state, поэтому
 * напечатать телефон, код выдачи, комментарии кухни, комментарий к адресу,
 * водителя или внутренние финансы физически нечем.
 *
 * Строгий порядок сверху вниз: фирменный логотип → способ получения → ресторан →
 * публичный номер → позиции → клиент → адрес (только доставка) → платёжный блок
 * строго последним. После платёжного блока элементов нет.
 */
export function OperatorPackageLabel({
  data,
}: {
  data: OperatorPackageLabelData;
}) {
  const { paymentBlock } = data;
  return (
    <div className={styles.label}>
      {/* Логотип — обычный <img> из public/: печать ждёт его загрузки. */}
      <div className={styles.logoBox}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={styles.logo}
          data-package-label-logo=""
          src={PACKAGE_LABEL_LOGO_SRC}
          alt="Direct"
        />
      </div>

      {/* Текстовая часть слегка сдвинута вправо: фирменный рисунок визуально
          тяжелее справа, и прижатый к левому краю текст выглядел смещённым.
          Платёжный блок в этот контейнер НЕ входит — он остаётся на всей
          доступной ширине наклейки. */}
      <div className={styles.textBlock}>
        <div className={styles.delivery}>{data.deliveryLabel}</div>
        <div className={styles.line}>Ресторан: {data.restaurantName}</div>

        {/* Подпись перед крупным номером, чтобы он не сливался с рестораном. */}
        <div className={styles.numberCaption}>Номер заказа</div>
        <div className={styles.number}>{data.publicNumber}</div>

        <ul className={styles.items}>
          {data.items.map((item, index) => (
            <li className={styles.item} key={`${item.name}-${index}`}>
              {formatPackageLabelItemLine(item)}
            </li>
          ))}
        </ul>

        <div className={styles.customer}>Клиент: {data.customerName}</div>
        {/* Адрес только для доставки: для самовывоза строки нет совсем. */}
        {data.addressMain ? (
          <div className={styles.address}>Адрес: {data.addressMain}</div>
        ) : null}
        {data.addressAccess ? (
          <div className={styles.addressAccess}>{data.addressAccess}</div>
        ) : null}
      </div>

      {/* Платёжный блок — строго последний элемент наклейки. */}
      <div className={styles.payment}>
        <div className={styles.paymentTitle}>{paymentBlock.title}</div>
        {paymentBlock.kind === "PAID" ? null : (
          <div className={styles.paymentAmount}>{paymentBlock.amount}</div>
        )}
        {paymentBlock.kind === "PICKUP_DUE" && paymentBlock.methodsLine ? (
          <div className={styles.paymentMethods}>
            {paymentBlock.methodsLine}
          </div>
        ) : null}
      </div>
    </div>
  );
}
