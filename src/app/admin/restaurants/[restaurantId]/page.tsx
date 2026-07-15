"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  type Restaurant,
} from "@/prototype/models";
import {
  ACTIVE_ORDER_STATUSES,
  formatMoney,
  getRestaurant,
  getRestaurantLocalNow,
  getRestaurantTotalDebtCents,
  getScheduleLabel,
  getZoneName,
  orderStatusLabels,
  publicationStatusLabels,
} from "@/prototype/selectors";

function DetailContent({ restaurant }: { restaurant: Restaurant }) {
  const { state, isHydrated, setRestaurantAccepting } = usePrototype();
  // §8: собственные настройки доставки действуют только у своего курьера.
  const settings =
    restaurant.deliveryProvider === "RESTAURANT"
      ? restaurant.restaurantDeliverySettings
      : null;
  const activeOrders = state.orders.filter(
    (order) =>
      order.restaurant.id === restaurant.id &&
      ACTIVE_ORDER_STATUSES.includes(order.status),
  );
  const debt = getRestaurantTotalDebtCents(state, restaurant.id);
  // §5: сегодняшний день — в часовом поясе ресторана.
  const today = isHydrated
    ? getRestaurantLocalNow(restaurant, new Date()).weekdayId
    : null;

  const handlePause = () => {
    if (
      window.confirm(
        `Приостановить приём заказов рестораном «${restaurant.name}»?`,
      )
    ) {
      void setRestaurantAccepting(restaurant.id, false);
    }
  };

  return (
    <>
      <div className={flowStyles.buttonRow}>
        {restaurant.publicPhone ? (
          <a
            className={flowStyles.secondaryButton}
            href={`tel:${restaurant.publicPhone}`}
          >
            Позвонить ресторану
          </a>
        ) : null}
        {restaurant.contactPhone ? (
          <a
            className={flowStyles.secondaryButton}
            href={`tel:${restaurant.contactPhone}`}
          >
            Позвонить контактному лицу
          </a>
        ) : null}
        <Link
          className={flowStyles.secondaryButton}
          href={`/admin/orders?restaurantId=${restaurant.id}`}
        >
          Открыть все заказы
        </Link>
        {restaurant.isAcceptingOrders ? (
          <button
            className={flowStyles.dangerButton}
            type="button"
            onClick={handlePause}
          >
            Приостановить заказы
          </button>
        ) : (
          <button
            className={flowStyles.secondaryButton}
            type="button"
            onClick={() => void setRestaurantAccepting(restaurant.id, true)}
          >
            Возобновить заказы
          </button>
        )}
        <Link
          className={flowStyles.secondaryButton}
          href={`/admin/restaurant-builder/${restaurant.id}`}
        >
          Редактировать в конструкторе
        </Link>
      </div>

      <section className={flowStyles.card}>
        <h2>Сводка</h2>
        <dl className={flowStyles.definitionList}>
          <div className={flowStyles.definitionRow}>
            <dt>Статус публикации</dt>
            <dd>{publicationStatusLabels[restaurant.status]}</dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Приём заказов</dt>
            <dd>
              {restaurant.isAcceptingOrders ? "Принимает" : "Приостановлен"}
            </dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Адрес</dt>
            <dd>{restaurant.address}</dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Тип доставки</dt>
            <dd>
              {restaurant.deliveryProvider === "RESTAURANT"
                ? "Курьер ресторана"
                : "Водители Direct"}
            </dd>
          </div>
        </dl>
      </section>

      <section className={flowStyles.card}>
        <h2>Контакты и график</h2>
        <dl className={flowStyles.definitionList}>
          <div className={flowStyles.definitionRow}>
            <dt>Публичный телефон</dt>
            <dd>
              {restaurant.publicPhone ? (
                <a href={`tel:${restaurant.publicPhone}`}>
                  {restaurant.publicPhone}
                </a>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Контактное лицо</dt>
            <dd>
              {restaurant.contactPersonName || "—"}
              {restaurant.contactPersonRole
                ? ` · ${restaurant.contactPersonRole}`
                : ""}
            </dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Электронная почта</dt>
            <dd>
              {restaurant.contactEmail ? (
                <a href={`mailto:${restaurant.contactEmail}`}>
                  {restaurant.contactEmail}
                </a>
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>
        <h3 className={flowStyles.sectionTitle}>График работы</h3>
        <dl className={flowStyles.definitionList}>
          {WEEKDAY_ORDER.map((day) => (
            <div
              className={flowStyles.definitionRow}
              key={day}
              style={
                today === day ? { fontWeight: 700 } : undefined
              }
            >
              <dt>{WEEKDAY_LABELS[day]}</dt>
              <dd>{getScheduleLabel(restaurant, day)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={flowStyles.card}>
        <h2>Условия сотрудничества</h2>
        <dl className={flowStyles.definitionList}>
          <div className={flowStyles.definitionRow}>
            <dt>Комиссия Direct за доставку</dt>
            <dd>{(restaurant.commissionRateBps / 100).toFixed(0)}%</dd>
          </div>
          <div className={flowStyles.definitionRow}>
            <dt>Комиссия Direct за самовывоз</dt>
            <dd>{(restaurant.pickupCommissionRateBps / 100).toFixed(0)}%</dd>
          </div>
          {settings ? (
            <>
              <div className={flowStyles.definitionRow}>
                <dt>Минимальный заказ</dt>
                <dd>{formatMoney(settings.minimumOrderCents)}</dd>
              </div>
              <div className={flowStyles.definitionRow}>
                <dt>Бесплатная доставка от</dt>
                <dd>
                  {settings.freeDeliveryThresholdCents !== null
                    ? formatMoney(settings.freeDeliveryThresholdCents)
                    : "—"}
                </dd>
              </div>
              <div className={flowStyles.definitionRow}>
                <dt>Обслуживаемые зоны</dt>
                <dd>
                  {settings.servedZoneIds
                    .map((zone) => getZoneName(state, zone))
                    .join(", ")}
                </dd>
              </div>
            </>
          ) : (
            <div className={flowStyles.definitionRow}>
              <dt>Тарифы доставки</dt>
              <dd>Матрица Direct</dd>
            </div>
          )}
        </dl>
      </section>

      <section className={flowStyles.card}>
        <h2>Активные заказы</h2>
        {activeOrders.length === 0 ? (
          <div className={flowStyles.emptyState}>Активных заказов нет.</div>
        ) : (
          <dl className={flowStyles.definitionList}>
            {activeOrders.map((order) => (
              <div className={flowStyles.definitionRow} key={order.id}>
                <dt>
                  <Link href={`/admin/orders?restaurantId=${restaurant.id}`}>
                    Заказ {order.publicNumber}
                  </Link>
                </dt>
                <dd>{orderStatusLabels[order.status]}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className={flowStyles.card}>
        <h2>Расчёты</h2>
        <dl className={flowStyles.definitionList}>
          <div className={flowStyles.definitionRow}>
            <dt>Задолженность перед Direct</dt>
            <dd>{formatMoney(debt)}</dd>
          </div>
        </dl>
        <Link
          className={flowStyles.backLink}
          href={`/admin/settlements?restaurantId=${restaurant.id}`}
        >
          Открыть расчёты →
        </Link>
      </section>

      <section className={flowStyles.card}>
        <h2>Внутренние заметки</h2>
        <p>
          {restaurant.internalAdminNote || "Заметок нет."}
        </p>
      </section>
    </>
  );
}

export default function AdminRestaurantDetailPage() {
  const params = useParams<{ restaurantId: string }>();
  const { state } = usePrototype();
  const restaurant = getRestaurant(state, params.restaurantId);

  if (!restaurant) {
    return (
      <>
        <PageHeading
          eyebrow="Администратор"
          title="Ресторан"
          description="Ресторан не найден."
        />
        <div className={flowStyles.emptyState}>
          Ресторан не найден.{" "}
          <Link href="/admin/restaurants">Вернуться к списку</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeading
        eyebrow="Ресторан"
        title={restaurant.name}
        description="Оперативная карточка: сводка, контакты, условия, активные заказы и расчёты."
      />
      <Link className={flowStyles.backLink} href="/admin/restaurants">
        ← К списку ресторанов
      </Link>
      <DetailContent restaurant={restaurant} />
    </>
  );
}
