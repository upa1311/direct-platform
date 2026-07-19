import type { Order } from "@/prototype/models";
import {
  formatMoney,
  HIGH_VALUE_CASH_ORDER_WARNING_TEXT,
  HIGH_VALUE_CASH_ORDER_WARNING_TITLE,
  highValueCashOrderFulfillmentLabel,
  isHighValueCashOrder,
} from "@/prototype/selectors";
import kds from "./kitchen.module.css";

/**
 * Предупреждение о крупном заказе с оплатой при получении.
 *
 * Текст — обязательная операционная инструкция сотруднику: заказ ТРЕБУЕТ
 * подтверждения клиента по телефону перед началом приготовления. При этом
 * система остаётся нетехнической: отдельной кнопки подтверждения нет, новых
 * статусов и полей заказа нет, приём и печать не блокируются, автоотмены нет.
 *
 * Показывается только в карточке НОВОГО заказа (RESTAURANT_REVIEW — часть
 * правила в isHighValueCashOrder) там, где решение принимает человек с доступом
 * к клиенту: общий экран в COMBINED и операторский экран в SPLIT. Кухонный экран
 * в SPLIT предупреждение не получает, поэтому телефон клиента туда не попадает;
 * в кухонные данные и производственную распечатку он тоже не добавляется.
 */
export function HighValueCashOrderWarning({ order }: { order: Order }) {
  if (!isHighValueCashOrder(order)) return null;
  const phone = order.customer.phone.trim();
  const fulfillmentLabel = highValueCashOrderFulfillmentLabel(order);
  return (
    <div className={kds.cashWarning} role="status">
      <p className={kds.cashWarningTitle}>
        {HIGH_VALUE_CASH_ORDER_WARNING_TITLE}
      </p>
      <p>{HIGH_VALUE_CASH_ORDER_WARNING_TEXT}</p>
      {/* Фактический итог заказа — существующим formatMoney, без пересчётов. */}
      <p className={kds.cashWarningTotal}>
        Сумма заказа: {formatMoney(order.financials.customerTotalCents)}
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
      {fulfillmentLabel ? (
        <p className={kds.cashWarningFulfillment}>{fulfillmentLabel}</p>
      ) : null}
    </div>
  );
}
