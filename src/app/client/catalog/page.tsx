"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapPin } from "lucide-react";

import {
  ADDRESS_REQUEST_EVENT,
  useClientAddressConfirmation,
} from "@/components/order-flow/client-address-confirmation";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  canPlacePrototypeOrder,
  getDeliveryFeeCents,
  getValidatedAddressZoneId,
  sortPublishedRestaurants,
  type CatalogSort,
} from "@/prototype/selectors";

export default function ClientCatalogPage() {
  const { state, updateAddress } = usePrototype();
  const {
    isAddressConfirmed,
    confirmAddress,
    beginAddressEdit,
  } = useClientAddressConfirmation();
  const [sort, setSort] = useState<CatalogSort>("RECOMMENDED");
  const streetFieldRef = useRef<HTMLSelectElement>(null);
  const hasValidAddress =
    getValidatedAddressZoneId(state.cart.address, state) !== null;
  const showAddressForm = !isAddressConfirmed;
  const effectiveSort =
    sort === "DELIVERY" && !hasValidAddress ? "RECOMMENDED" : sort;
  const restaurants = useMemo(
    () => sortPublishedRestaurants(state, effectiveSort),
    [effectiveSort, state],
  );
  const orderableFees = hasValidAddress
    ? restaurants
        .filter(canPlacePrototypeOrder)
        .map((restaurant) => getDeliveryFeeCents(state, restaurant))
        .filter((fee): fee is number => fee !== null)
    : [];
  const bestFee = orderableFees.length > 0 ? Math.min(...orderableFees) : null;

  const revealAddress = useCallback(() => {
    beginAddressEdit();
    window.requestAnimationFrame(() => {
      document.getElementById("delivery-address")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
      streetFieldRef.current?.focus({ preventScroll: true });
    });
  }, [beginAddressEdit]);

  useEffect(() => {
    const handleHash = () => {
      if (window.location.hash === "#delivery-address") revealAddress();
    };
    const initialFrame = window.requestAnimationFrame(handleHash);
    window.addEventListener("hashchange", handleHash);
    window.addEventListener(ADDRESS_REQUEST_EVENT, revealAddress);
    return () => {
      window.cancelAnimationFrame(initialFrame);
      window.removeEventListener("hashchange", handleHash);
      window.removeEventListener(ADDRESS_REQUEST_EVENT, revealAddress);
    };
  }, [revealAddress]);

  return (
    <>
      <section
        id="delivery-address"
        className={`${flowStyles.card} ${flowStyles.catalogAddress} ${showAddressForm ? "" : flowStyles.catalogAddressCollapsed}`}
        aria-labelledby="catalog-address-title"
      >
        {showAddressForm ? (
          <>
            <div>
              <h2 id="catalog-address-title">Куда доставить?</h2>
              <p>От адреса зависит стоимость доставки.</p>
            </div>
            <div className={flowStyles.catalogAddressFields}>
              <label className={flowStyles.field}>
                <span>Улица</span>
                <select
                  ref={streetFieldRef}
                  value={state.cart.address.street}
                  onChange={(event) =>
                    updateAddress({ street: event.target.value })
                  }
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
                  onChange={(event) =>
                    updateAddress({ house: event.target.value })
                  }
                  placeholder="Номер дома"
                />
              </label>
            </div>
            <button
              className={flowStyles.compactTextButton}
              type="button"
              disabled={!hasValidAddress}
              onClick={confirmAddress}
            >
              Готово
            </button>
          </>
        ) : (
          <div className={flowStyles.compactAddressLine}>
            <MapPin aria-hidden="true" />
            <strong id="catalog-address-title">
              {state.cart.address.street}, дом {state.cart.address.house}
            </strong>
            <button type="button" onClick={revealAddress}>
              Изменить
            </button>
          </div>
        )}
      </section>

      <div className={flowStyles.catalogHeadingRow} id="restaurant-list">
        <h1>Рестораны</h1>
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
          const deliveryFee =
            hasValidAddress && canPlacePrototypeOrder(restaurant)
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
