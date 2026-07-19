import type { Order } from "@/prototype/models";
import { isHighValueCashOrder } from "@/prototype/selectors";
import kds from "./kitchen.module.css";

/**
 * Информационное предупреждение о крупном заказе с оплатой при получении.
 *
 * Только подсказка: ничего не подтверждает и не требует подтверждения в системе,
 * не блокирует «Принять» и «Принять и распечатать», не добавляет статусов и не
 * трогает lifecycle, оплату, ETA и финансовый снимок. Показывается в карточке
 * нового заказа там, где решение принимает человек с доступом к клиенту: общий
 * экран в COMBINED и операторский экран в SPLIT. Кухонный экран в SPLIT
 * предупреждение не получает, поэтому телефон клиента туда не попадает; в
 * кухонные данные и производственную распечатку он тоже не добавляется.
 *
 * Исчезает вместе с карточкой нового заказа: рендерится только там, где карточка
 * живёт, а после принятия/отмены карточка уходит вместе с предупреждением.
 */
export function HighValueCashOrderWarning({ order }: { order: Order }) {
  if (!isHighValueCashOrder(order)) return null;
  const phone = order.customer.phone.trim();
  return (
    <div className={kds.cashWarning} role="status">
      <p className={kds.cashWarningTitle}>ВНИМАНИЕ: БОЛЬШАЯ СУММА ЗАКАЗА</p>
      <p>
        Заказ с оплатой при получении на сумму от $50 рекомендуется подтвердить у
        клиента по телефону перед началом приготовления.
      </p>
      {/* Телефон — тем же компактным способом, что и на операторском экране. */}
      {phone ? (
        <p className={kds.cashWarningPhone}>
          Телефон клиента:{" "}
          <a className={kds.subtleLink} href={`tel:${phone}`}>
            {phone}
          </a>
        </p>
      ) : null}
    </div>
  );
}
