"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  getDeliveryFeeCents,
  getValidatedAddressZoneId,
  sortPublishedRestaurants,
  type CatalogSort,
} from "@/prototype/selectors";

export default function ClientCatalogPage() {
  const { state, updateAddress } = usePrototype();
  const [sort, setSort] = useState<CatalogSort>("RECOMMENDED");
  const hasValidAddress =
    getValidatedAddressZoneId(state.cart.address, state) !== null;
  const effectiveSort = sort === "DELIVERY" && !hasValidAddress
    ? "RECOMMENDED"
    : sort;
  const restaurants = useMemo(
    () => sortPublishedRestaurants(state, effectiveSort),
    [effectiveSort, state],
  );
  const availableFees = hasValidAddress
    ? restaurants
        .map((restaurant) => getDeliveryFeeCents(state, restaurant))
        .filter((fee): fee is number => fee !== null)
    : [];
  const bestFee = availableFees.length > 0 ? Math.min(...availableFees) : null;

  return (
    <>
      <PageHeading
        eyebrow="Клиент"
        title="Рестораны"
        description="Выберите адрес и откройте меню подходящего ресторана."
      />
      <section
        className={`${flowStyles.card} ${flowStyles.catalogAddress}`}
        aria-labelledby="catalog-address-title"
      >
        <div>
          <h2 id="catalog-address-title">Куда доставить?</h2>
          <p>Стоимость доставки может меняться в зависимости от района.</p>
        </div>
        <div className={flowStyles.catalogAddressFields}>
          <label className={flowStyles.field}>
            <span>Улица</span>
            <select
              value={state.cart.address.street}
              onChange={(event) => updateAddress({ street: event.target.value })}
            >
              <option value="">Выберите улицу</option>
              {state.zones.flatMap((zone) =>
                zone.streets.map((street) => (
                  <option value={street} key={street}>
                    {street}
                  </option>
                )),
              )}
            </select>
          </label>
          <label className={flowStyles.field}>
            <span>Дом</span>
            <input
              required
              value={state.cart.address.house}
              onChange={(event) => updateAddress({ house: event.target.value })}
              placeholder="Номер дома"
            />
          </label>
        </div>
        {hasValidAddress ? (
          <p className={flowStyles.zoneNotice}>
            Доставка будет рассчитана для выбранного адреса: {state.cart.address.street}, дом {state.cart.address.house}.
          </p>
        ) : (
          <p className={flowStyles.feedback}>
            Выберите улицу и укажите номер дома.
          </p>
        )}
        <small>
          Определение адреса по геолокации появится после подключения карт.
        </small>
      </section>

      <div className={flowStyles.catalogToolbar}>
        <label className={flowStyles.field}>
          <span>Сортировка</span>
          <select
            value={effectiveSort}
            onChange={(event) => setSort(event.target.value as CatalogSort)}
          >
            <option value="RECOMMENDED">Рекомендуемые</option>
            <option value="DELIVERY" disabled={!hasValidAddress}>
              Выгодная доставка
            </option>
            <option value="PREPARATION">Быстрее приготовят</option>
            <option value="OPEN">Открыты сейчас</option>
          </select>
        </label>
      </div>

      <div className={flowStyles.catalogGrid}>
        {restaurants.map((restaurant) => {
          const deliveryFee = hasValidAddress
            ? getDeliveryFeeCents(state, restaurant)
            : null;
          return (
            <article className={flowStyles.restaurantCard} key={restaurant.id}>
              <Link
                className={flowStyles.restaurantCardLink}
                href={`/client/restaurants/${restaurant.id}`}
              >
                <div>
                  <div className={flowStyles.restaurantTitleRow}>
                    <h2>{restaurant.name}</h2>
                    {bestFee !== null && deliveryFee === bestFee ? (
                      <span className={flowStyles.bestDeliveryBadge}>
                        Выгодная доставка для вашего адреса
                      </span>
                    ) : null}
                  </div>
                  <p>{restaurant.description}</p>
                  <span className={flowStyles.statusBadge}>
                    {restaurant.isAcceptingOrders
                      ? "Принимает заказы"
                      : "Меню для просмотра"}
                  </span>
                  <p className={flowStyles.preparationTime}>
                    Обычно готовят за {restaurant.defaultPreparationMinutes} минут
                  </p>
                </div>
                <div className={flowStyles.cardMeta}>
                  <span>{restaurant.address}</span>
                  <span>Открыть меню →</span>
                </div>
              </Link>
            </article>
          );
        })}
      </div>
    </>
  );
}
