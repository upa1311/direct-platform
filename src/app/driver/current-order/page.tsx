"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import kds from "@/components/kitchen/kitchen.module.css";
import { usePrototype } from "@/prototype/prototype-provider";
import { formatMoney, getDriverActiveOrder } from "@/prototype/selectors";
import {
  resolveDriverDeliveryStage,
  type DriverDeliveryStage,
} from "@/prototype/driver-delivery";
import type { DeliveryAddress, Order, ZoneId } from "@/prototype/models";
import { useSelectedDriverId } from "@/components/driver/driver-session";
import styles from "../driver.module.css";

/**
 * Рабочий экран текущего заказа водителя. Этап определяется доменным
 * resolveDriverDeliveryStage по статусу заказа и append-only журналу, а не
 * состоянием React. Полные данные заказа показываются только водителю, которому
 * заказ назначен. Одна главная кнопка на этап; после доставки — редирект на
 * /driver для ручного подтверждения зоны.
 */
export default function DriverCurrentOrderPage() {
  const { state, isHydrated } = usePrototype();
  const selectedDriverId = useSelectedDriverId();

  const driver =
    selectedDriverId !== null
      ? state.drivers.find((d) => d.id === selectedDriverId) ?? null
      : null;
  // Приватность: показываем заказ только если он назначен ИМЕННО этому водителю.
  const activeOrder = driver ? getDriverActiveOrder(state, driver.id) : null;
  const order =
    activeOrder && activeOrder.assignedDriverId === selectedDriverId
      ? activeOrder
      : null;

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
          <CurrentOrder
            driverId={driver.id}
            order={order}
            stage={resolveDriverDeliveryStage(state, driver.id, order.id)}
            zoneName={zoneName}
          />
        )}
      </div>
    </div>
  );
}

/** Опорные точки маршрута для компактного прогресса. */
const PROGRESS_STEPS = ["Ресторан", "Получение", "Клиент", "Доставка"] as const;

/** Индекс активного шага прогресса по этапу (для подсветки). */
function activeStepIndex(stage: DriverDeliveryStage): number {
  switch (stage) {
    case "GO_TO_RESTAURANT":
    case "WAITING_AT_RESTAURANT":
      return 0;
    case "READY_TO_PICK_UP":
      return 1;
    case "GO_TO_CUSTOMER":
      return 2;
    case "ARRIVING_TO_CUSTOMER":
      return 3;
    default:
      return -1;
  }
}

function CurrentOrder({
  driverId,
  order,
  stage,
  zoneName,
}: {
  driverId: string;
  order: Order;
  stage: DriverDeliveryStage;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  const {
    driverArriveAtRestaurant,
    driverPickUpOrder,
    driverMarkArriving,
    driverCompleteDelivery,
  } = usePrototype();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Блокировка повторного клика; без optimistic update — ждём serialized мутацию
  // и переключаем этап только по подтверждённому успеху.
  const run = async (
    action: () => Promise<{ ok: boolean; error: string | null }>,
    redirectToOverview = false,
  ) => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (redirectToOverview) {
      router.push("/driver");
    }
  };

  const activeIndex = activeStepIndex(stage);

  return (
    <>
      {/* Компактный прогресс: без крупного stepper и enum-значений. */}
      <ol className={styles.progress} aria-label="Этапы доставки">
        {PROGRESS_STEPS.map((label, index) => (
          <li
            key={label}
            className={
              index === activeIndex
                ? `${styles.progressStep} ${styles.progressStepActive}`
                : styles.progressStep
            }
            aria-current={index === activeIndex ? "step" : undefined}
          >
            {label}
          </li>
        ))}
      </ol>

      <StagePanel
        stage={stage}
        pending={pending}
        onArrive={() =>
          run(() => driverArriveAtRestaurant(driverId, order.id))
        }
        onPickUp={() => run(() => driverPickUpOrder(driverId, order.id))}
        onArriving={() => run(() => driverMarkArriving(driverId, order.id))}
        onDeliver={() =>
          run(() => driverCompleteDelivery(driverId, order.id), true)
        }
      />

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <OrderDetails order={order} zoneName={zoneName} />
    </>
  );
}

function StagePanel({
  stage,
  pending,
  onArrive,
  onPickUp,
  onArriving,
  onDeliver,
}: {
  stage: DriverDeliveryStage;
  pending: boolean;
  onArrive: () => void;
  onPickUp: () => void;
  onArriving: () => void;
  onDeliver: () => void;
}) {
  switch (stage) {
    case "GO_TO_RESTAURANT":
      return (
        <StageCard title="Следующий шаг" hint="Доберитесь до ресторана и подтвердите прибытие.">
          <MainButton label="Я в ресторане" pending={pending} onClick={onArrive} />
        </StageCard>
      );
    case "WAITING_AT_RESTAURANT":
      return (
        <StageCard title="Вы в ресторане" hint="Заказ ещё готовится. Ожидаем готовность заказа.">
          {null}
        </StageCard>
      );
    case "READY_TO_PICK_UP":
      return (
        <StageCard title="Заказ готов" hint="Проверьте заказ и заберите его у ресторана.">
          <MainButton label="Заказ получен" pending={pending} onClick={onPickUp} />
        </StageCard>
      );
    case "GO_TO_CUSTOMER":
      return (
        <StageCard title="Доставьте заказ клиенту">
          <MainButton label="Я подъезжаю" pending={pending} onClick={onArriving} />
        </StageCard>
      );
    case "ARRIVING_TO_CUSTOMER":
      return (
        <StageCard
          title="Вы подъезжаете к клиенту"
          hint="Свяжитесь с клиентом при необходимости."
        >
          <MainButton label="Заказ доставлен" pending={pending} onClick={onDeliver} />
        </StageCard>
      );
    default:
      return (
        <div className={styles.notice} role="status">
          Этап заказа требует проверки Direct. Не выполняйте следующий переход,
          пока данные не будут проверены.
        </div>
      );
  }
}

function StageCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.stageCard}>
      <span className={styles.stageTitle}>{title}</span>
      {hint ? <span className={styles.stageHint}>{hint}</span> : null}
      {children}
    </div>
  );
}

function MainButton({
  label,
  pending,
  onClick,
}: {
  label: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.primaryButton}
      disabled={pending}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function OrderDetails({
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
