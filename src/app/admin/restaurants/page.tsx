"use client";

import Link from "next/link";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import type { Restaurant } from "@/prototype/models";
import {
  formatMoney,
  getPickupPaymentSummary,
  getRestaurantActiveOrderCount,
  getRestaurantLocalNow,
  getRestaurantTotalDebtCents,
  getScheduleLabel,
  getZoneName,
  isRestaurantOpenNow,
  publicationStatusLabels,
} from "@/prototype/selectors";

function RestaurantOperationalCard({
  restaurant,
}: {
  restaurant: Restaurant;
}) {
  const { state, isHydrated, setRestaurantAccepting } = usePrototype();
  const isRestaurantCourier = restaurant.deliveryProvider === "RESTAURANT";
  // §8: deliveryProvider — источник истины. Собственные настройки доставки
  // действуют только у ресторана со своим курьером.
  const settings = isRestaurantCourier
    ? restaurant.restaurantDeliverySettings
    : null;
  const activeOrders = getRestaurantActiveOrderCount(state, restaurant.id);
  const debt = getRestaurantTotalDebtCents(state, restaurant.id);
  const pickupSummary = getPickupPaymentSummary(restaurant);

  // §5: «открыт сейчас» и «сегодня» — в часовом поясе ресторана (после гидратации).
  const now = isHydrated ? new Date() : null;
  const localWeekday = now
    ? getRestaurantLocalNow(restaurant, now).weekdayId
    : null;
  const todayHours = localWeekday
    ? getScheduleLabel(restaurant, localWeekday)
    : "—";
  const openNow = now ? isRestaurantOpenNow(restaurant, now) : null;

  const servedZones = settings
    ? settings.servedZoneIds
        .map((zone) => getZoneName(state, zone))
        .join(", ")
    : "Матрица Direct (все зоны)";

  const handlePause = () => {
    if (
      window.confirm(
        `Приостановить приём новых заказов рестораном «${restaurant.name}»? Существующие заказы продолжат обрабатываться.`,
      )
    ) {
      setRestaurantAccepting(restaurant.id, false);
    }
  };

  return (
    <article className={flowStyles.card}>
      <div className={flowStyles.orderHeader}>
        <div>
          <h3 className={flowStyles.sectionTitle}>{restaurant.name}</h3>
          <p>{restaurant.address}</p>
        </div>
        <span className={flowStyles.statusBadge}>
          {publicationStatusLabels[restaurant.status]}
        </span>
      </div>

      <div className={flowStyles.adminOrderGrid}>
        <section>
          <h4 className={flowStyles.sectionTitle}>Основная информация</h4>
          <dl className={flowStyles.definitionList}>
            <div className={flowStyles.definitionRow}>
              <dt>Приём заказов</dt>
              <dd>
                {restaurant.isAcceptingOrders
                  ? "Принимает"
                  : "Приостановлен"}
              </dd>
            </div>
            <div className={flowStyles.definitionRow}>
              <dt>Открыт сейчас</dt>
              <dd>
                {openNow === null ? "—" : openNow ? "Да" : "Нет (по графику)"}
              </dd>
            </div>
            <div className={flowStyles.definitionRow}>
              <dt>Часы работы сегодня</dt>
              <dd>{isHydrated ? todayHours : "—"}</dd>
            </div>
            <div className={flowStyles.definitionRow}>
              <dt>Часовой пояс</dt>
              <dd>{restaurant.timeZone}</dd>
            </div>
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
              <dt>Тип доставки</dt>
              <dd>
                {isRestaurantCourier ? "Курьер ресторана" : "Водители Direct"}
              </dd>
            </div>
            <div className={flowStyles.definitionRow}>
              <dt>Самовывоз</dt>
              <dd>{restaurant.pickupEnabled ? "Доступен" : "Недоступен"}</dd>
            </div>
            <div className={flowStyles.definitionRow}>
              <dt>Оплата доставки</dt>
              <dd>
                {isRestaurantCourier
                  ? "Наличные курьеру ресторана"
                  : "Онлайн"}
              </dd>
            </div>
            <div className={flowStyles.definitionRow}>
              <dt>Оплата самовывоза</dt>
              <dd>{pickupSummary ?? "—"}</dd>
            </div>
            <div className={flowStyles.definitionRow}>
              <dt>Активных заказов</dt>
              <dd>{activeOrders}</dd>
            </div>
            <div className={flowStyles.definitionRow}>
              <dt>Задолженность перед Direct</dt>
              <dd>{formatMoney(debt)}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h4 className={flowStyles.sectionTitle}>Контактная информация</h4>
          <dl className={flowStyles.definitionList}>
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
              <dt>Прямой телефон</dt>
              <dd>
                {restaurant.contactPhone ? (
                  <a href={`tel:${restaurant.contactPhone}`}>
                    {restaurant.contactPhone}
                  </a>
                ) : (
                  "—"
                )}
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
            {restaurant.contactMessenger ? (
              <div className={flowStyles.definitionRow}>
                <dt>Мессенджер</dt>
                <dd>{restaurant.contactMessenger}</dd>
              </div>
            ) : null}
            {restaurant.emergencyPhone ? (
              <div className={flowStyles.definitionRow}>
                <dt>Срочный телефон</dt>
                <dd>
                  <a href={`tel:${restaurant.emergencyPhone}`}>
                    {restaurant.emergencyPhone}
                  </a>
                </dd>
              </div>
            ) : null}
            {restaurant.internalAdminNote ? (
              <div className={flowStyles.definitionRow}>
                <dt>Заметка Direct</dt>
                <dd>{restaurant.internalAdminNote}</dd>
              </div>
            ) : null}
          </dl>
        </section>

        <section>
          <h4 className={flowStyles.sectionTitle}>Условия сотрудничества</h4>
          <dl className={flowStyles.definitionList}>
            <div className={flowStyles.definitionRow}>
              <dt>Комиссия Direct за доставку</dt>
              <dd>{(restaurant.commissionRateBps / 100).toFixed(0)}%</dd>
            </div>
            <div className={flowStyles.definitionRow}>
              <dt>Комиссия Direct за самовывоз</dt>
              <dd>{(restaurant.pickupCommissionRateBps / 100).toFixed(0)}%</dd>
            </div>
            <div className={flowStyles.definitionRow}>
              <dt>Доставку выполняет</dt>
              <dd>
                {isRestaurantCourier
                  ? "Курьер ресторана"
                  : "Водитель Direct"}
              </dd>
            </div>
            {isRestaurantCourier && settings ? (
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
              </>
            ) : (
              <div className={flowStyles.definitionRow}>
                <dt>Тарифы доставки</dt>
                <dd>Матрица Direct</dd>
              </div>
            )}
            <div className={flowStyles.definitionRow}>
              <dt>Обслуживаемые зоны</dt>
              <dd>{servedZones}</dd>
            </div>
          </dl>
        </section>
      </div>

      <div className={flowStyles.buttonRow}>
        {restaurant.publicPhone ? (
          <a
            className={flowStyles.secondaryButton}
            href={`tel:${restaurant.publicPhone}`}
          >
            Позвонить
          </a>
        ) : null}
        <Link
          className={flowStyles.secondaryButton}
          href={`/admin/orders?restaurantId=${restaurant.id}`}
        >
          Открыть заказы
        </Link>
        <Link
          className={flowStyles.secondaryButton}
          href={`/admin/settlements?restaurantId=${restaurant.id}`}
        >
          Открыть расчёты
        </Link>
        {restaurant.isAcceptingOrders ? (
          <button
            className={flowStyles.dangerButton}
            type="button"
            onClick={handlePause}
          >
            Приостановить приём заказов
          </button>
        ) : (
          <button
            className={flowStyles.secondaryButton}
            type="button"
            onClick={() => setRestaurantAccepting(restaurant.id, true)}
          >
            Возобновить приём заказов
          </button>
        )}
        <Link
          className={flowStyles.secondaryButton}
          href={`/admin/restaurant-builder/${restaurant.id}`}
        >
          Открыть в конструкторе
        </Link>
        <Link
          className={flowStyles.backLink}
          href={`/admin/restaurants/${restaurant.id}`}
        >
          Подробнее →
        </Link>
      </div>
    </article>
  );
}

export default function AdminRestaurantsPage() {
  const { state } = usePrototype();

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Рестораны"
        description="Оперативный справочник: контакты, график, условия сотрудничества и быстрые действия. Полная настройка — в «Конструкторе ресторанов»."
      />
      <div className={flowStyles.orderList}>
        {state.restaurants.map((restaurant) => (
          <RestaurantOperationalCard
            key={restaurant.id}
            restaurant={restaurant}
          />
        ))}
      </div>
    </>
  );
}
