"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatMoney,
  getDeliveryFeeCents,
  getPublishedRestaurants,
  getValidatedAddressZoneId,
} from "@/prototype/selectors";

type CatalogSort = "RECOMMENDED" | "DELIVERY";

export default function ClientCatalogPage() {
  const { state, updateAddress } = usePrototype();
  const [sort, setSort] = useState<CatalogSort>("RECOMMENDED");
  const customerZoneId = getValidatedAddressZoneId(state.cart.address, state);
  const restaurants = useMemo(() => {
    const published = getPublishedRestaurants(state);
    if (sort !== "DELIVERY" || !customerZoneId) return published;
    return [...published].sort((left, right) =>
      (getDeliveryFeeCents(state, left) ?? Number.MAX_SAFE_INTEGER) -
      (getDeliveryFeeCents(state, right) ?? Number.MAX_SAFE_INTEGER));
  }, [customerZoneId, sort, state]);
  const availableFees = restaurants
    .map((restaurant) => getDeliveryFeeCents(state, restaurant))
    .filter((fee): fee is number => fee !== null);
  const bestFee = availableFees.length ? Math.min(...availableFees) : null;

  return (
    <>
      <PageHeading eyebrow="Клиент" title="Рестораны" description="Выберите адрес, сравните доставку и откройте меню." />
      <section className={`${flowStyles.card} ${flowStyles.catalogAddress}`} aria-labelledby="catalog-address-title">
        <div>
          <h2 id="catalog-address-title">Куда доставить?</h2>
          <p>Стоимость доставки рассчитается отдельно для каждого ресторана.</p>
        </div>
        <div className={flowStyles.catalogAddressFields}>
          <label className={flowStyles.field}>
            <span>Улица</span>
            <select value={state.cart.address.street} onChange={(event) => updateAddress({ street: event.target.value })}>
              <option value="">Выберите улицу</option>
              {state.zones.flatMap((zone) => zone.streets.map((street) => <option value={street} key={street}>{street}</option>))}
            </select>
          </label>
          <label className={flowStyles.field}>
            <span>Дом</span>
            <input required value={state.cart.address.house} onChange={(event) => updateAddress({ house: event.target.value })} placeholder="Номер дома" />
          </label>
        </div>
        {customerZoneId ? (
          <p className={flowStyles.zoneNotice}>Доставить: {state.cart.address.street}, дом {state.cart.address.house}. Адрес относится к {customerZoneId.replace("zone-", "Зоне ")}.</p>
        ) : (
          <p className={flowStyles.feedback}>Выберите улицу из списка и укажите номер дома.</p>
        )}
        <small>Определение адреса по геолокации появится после подключения карт.</small>
      </section>

      <div className={flowStyles.catalogToolbar}>
        <label className={flowStyles.field}><span>Сортировка</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as CatalogSort)}>
            <option value="RECOMMENDED">Рекомендуемые</option>
            <option value="DELIVERY" disabled={!customerZoneId}>Доставка дешевле</option>
          </select>
        </label>
      </div>

      <div className={flowStyles.catalogGrid}>
        {restaurants.map((restaurant) => {
          const deliveryFee = getDeliveryFeeCents(state, restaurant);
          return (
            <article className={flowStyles.restaurantCard} key={restaurant.id}>
              <Link className={flowStyles.restaurantCardLink} href={`/client/restaurants/${restaurant.id}`}>
                <div>
                  <div className={flowStyles.restaurantTitleRow}>
                    <h2>{restaurant.name}</h2>
                    {bestFee !== null && deliveryFee === bestFee ? <span className={flowStyles.bestDeliveryBadge}>Самая выгодная доставка для вашего адреса</span> : null}
                  </div>
                  <p>{restaurant.description}</p>
                  <span className={flowStyles.statusBadge}>{restaurant.isAcceptingOrders ? "Принимает заказы" : "Меню для просмотра"}</span>
                </div>
                <div className={flowStyles.cardMeta}><span>{restaurant.address}</span><span>Открыть меню →</span></div>
              </Link>
              <div className={flowStyles.deliveryQuote}>
                <strong>{deliveryFee === null ? (state.cart.address.street || state.cart.address.house ? "Стоимость временно недоступна" : "Укажите адрес, чтобы увидеть точную стоимость доставки") : `Доставка ${formatMoney(deliveryFee)}`}</strong>
                {deliveryFee !== null && customerZoneId ? (
                  <details><summary>Почему такая цена?</summary><p>Ресторан: {restaurant.zoneId.replace("zone-", "Зона ")}<br />Ваш адрес: {customerZoneId.replace("zone-", "Зона ")}<br />Тариф {restaurant.zoneId.replace("zone-", "Зона ")} → {customerZoneId.replace("zone-", "Зона ")}: {formatMoney(deliveryFee)}.</p></details>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
