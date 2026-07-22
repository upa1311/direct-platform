"use client";

import Link from "next/link";

import kds from "@/components/kitchen/kitchen.module.css";
import { usePrototype } from "@/prototype/prototype-provider";
import { formatMoney, getDriverActiveOrder } from "@/prototype/selectors";
import type { DeliveryAddress, Order, ZoneId } from "@/prototype/models";
import { useSelectedDriverId } from "@/components/driver/driver-session";
import styles from "../driver.module.css";

/**
 * Read-only текущий заказ водителя. Маршрут доставки в этом микробатче НЕ
 * реализуется: страница только показывает назначенный заказ. Полный адрес и
 * телефон уже можно показать — заказ назначен именно этому водителю.
 */
export default function DriverCurrentOrderPage() {
  const { state, isHydrated } = usePrototype();
  const selectedDriverId = useSelectedDriverId();

  const driver =
    selectedDriverId !== null
      ? state.drivers.find((d) => d.id === selectedDriverId) ?? null
      : null;
  const order = driver ? getDriverActiveOrder(state, driver.id) : null;

  const zoneName = (zoneId: ZoneId | null): string =>
    state.zones.find((z) => z.id === zoneId)?.name ?? "—";

  return (
    <div className={kds.screen}>
      <div className={styles.container}>
        <h2 className={styles.sectionTitle}>Текущий заказ</h2>

        {!isHydrated ? (
          <div className={styles.empty}>Загружаем данные…</div>
        ) : driver === null ? (
          <>
            <div className={styles.notice} role="status">
              Сначала выберите водителя на странице «Обзор».
            </div>
            <Link className={styles.orderLink} href="/driver">
              Перейти к выбору водителя
            </Link>
          </>
        ) : order === null ? (
          <div className={styles.notice} role="status">
            Текущего заказа нет. После принятия предложения заказ появится здесь.
          </div>
        ) : (
          <CurrentOrder order={order} zoneName={zoneName} />
        )}
      </div>
    </div>
  );
}

function CurrentOrder({
  order,
  zoneName,
}: {
  order: Order;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  return (
    <>
      <div className={styles.detailCard}>
        <span className={styles.orderLine}>Заказ {order.publicNumber}</span>
        <span className={styles.detailRowValue}>Заказ принят</span>
      </div>

      <div className={styles.detailCard}>
        <span className={styles.detailRowLabel}>Забрать</span>
        <span className={styles.detailRowValue}>{order.restaurant.name}</span>
        <span className={styles.detailRowValue}>{order.restaurant.address}</span>
        <span className={styles.detailRowValue}>
          {zoneName(order.restaurant.zoneId)}
        </span>
      </div>

      <div className={styles.detailCard}>
        <span className={styles.detailRowLabel}>Доставить</span>
        <span className={styles.detailRowValue}>
          {formatCustomerAddress(order.address)}
        </span>
        <span className={styles.detailRowValue}>
          {zoneName(order.financials.customerZoneId)}
        </span>
        {order.address && addressExtras(order.address) ? (
          <span className={styles.detailRowValue}>
            {addressExtras(order.address)}
          </span>
        ) : null}
      </div>

      <div className={styles.detailCard}>
        <span className={styles.detailRowLabel}>Клиент</span>
        <span className={styles.detailRowValue}>{order.customer.name}</span>
        <a className={styles.phoneLink} href={`tel:${order.customer.phone}`}>
          {order.customer.phone}
        </a>
        {order.address && order.address.comment.trim() !== "" ? (
          <span className={styles.detailRowValue}>
            Комментарий: {order.address.comment}
          </span>
        ) : null}
      </div>

      <div className={styles.detailCard}>
        <span className={styles.detailRowValue}>Оплата онлайн</span>
        <span className={styles.detailRowValue}>
          Ваша выплата:{" "}
          {formatMoney(
            order.financials.driverPayoutCents,
            order.financials.currencyCode,
          )}
        </span>
      </div>
    </>
  );
}

/** Улица и дом клиента (полный адрес разрешён после назначения). */
function formatCustomerAddress(address: DeliveryAddress | null): string {
  if (address === null) return "—";
  const house = address.house.trim();
  return house !== "" ? `${address.street}, ${house}` : address.street;
}

/** Квартира / подъезд / этаж, если указаны. */
function addressExtras(address: DeliveryAddress): string {
  const parts: string[] = [];
  if (address.apartment.trim() !== "") parts.push(`кв. ${address.apartment}`);
  if (address.entrance.trim() !== "") parts.push(`подъезд ${address.entrance}`);
  if (address.floor.trim() !== "") parts.push(`этаж ${address.floor}`);
  return parts.join(" · ");
}
