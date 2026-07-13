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
  formatMoney,
  getAvailablePlatformDeliveryFeeCents,
  getRestaurantPromotion,
  getValidatedAddressZoneId,
  sortPublishedRestaurants,
  type CatalogSort,
} from "@/prototype/selectors";
import { shouldAutoConfirmAddress } from "@/prototype/pricing-engine";

export default function ClientCatalogPage() {
  const { state, updateAddress, setFulfillmentChoice } = usePrototype();
  const {
    isAddressConfirmed,
    confirmAddress,
    beginAddressEdit,
  } = useClientAddressConfirmation();
  const [sort, setSort] = useState<CatalogSort>("RECOMMENDED");
  const streetFieldRef = useRef<HTMLSelectElement>(null);
  const hasValidAddress =
    getValidatedAddressZoneId(state.cart.address, state) !== null;
  const isDelivery = state.cart.fulfillmentChoice === "DELIVERY";
  const deliveryPricingReady =
    isDelivery && isAddressConfirmed && hasValidAddress;
  const showAddressForm = isDelivery && !isAddressConfirmed;
  const effectiveSort =
    sort === "DELIVERY" && !deliveryPricingReady ? "RECOMMENDED" : sort;
  const restaurants = useMemo(
    () => sortPublishedRestaurants(state, effectiveSort),
    [effectiveSort, state],
  );
  const orderableFees = deliveryPricingReady
    ? restaurants
        .map((restaurant) =>
          getAvailablePlatformDeliveryFeeCents(state, restaurant),
        )
        .filter((fee): fee is number => fee !== null)
    : [];
  const bestFee = orderableFees.length > 0 ? Math.min(...orderableFees) : null;

  const revealAddress = useCallback(() => {
    if (!isDelivery) return;
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
  }, [beginAddressEdit, isDelivery]);

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
        id="fulfillment-method"
        className={`${flowStyles.card} ${flowStyles.catalogFulfillment}`}
        aria-labelledby="fulfillment-title"
      >
        {isDelivery ? (
          <div
            id="delivery-address"
            className={flowStyles.catalogFulfillmentBody}
          >
            {showAddressForm ? (
              <>
                <div className={flowStyles.fulfillmentHeaderRow}>
                  <h2 id="fulfillment-title">Куда доставить заказ?</h2>
                  <button
                    className={flowStyles.fulfillmentSwitchButton}
                    type="button"
                    onClick={() => setFulfillmentChoice("PICKUP")}
                  >
                    Забрать самому
                  </button>
                </div>
                <p>Стоимость доставки зависит от адреса.</p>
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
                  className={`${flowStyles.compactTextButton} ${flowStyles.confirmAddressButton}`}
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
                <strong id="fulfillment-title">
                  {state.cart.address.street}, дом {state.cart.address.house}
                </strong>
                <button type="button" onClick={revealAddress}>
                  Изменить
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className={flowStyles.catalogFulfillmentBody}>
            <div className={flowStyles.fulfillmentHeaderRow}>
              <h2 id="fulfillment-title">Самовывоз</h2>
              <button
                className={flowStyles.fulfillmentSwitchButton}
                type="button"
                onClick={() => setFulfillmentChoice("DELIVERY")}
              >
                Доставка
              </button>
            </div>
            <p>Забрать заказ самостоятельно из выбранного ресторана.</p>
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
            <option value="DELIVERY" disabled={!deliveryPricingReady}>
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
            deliveryPricingReady
              ? getAvailablePlatformDeliveryFeeCents(state, restaurant)
              : null;
          const promotion = getRestaurantPromotion(state, restaurant.id);
          const restaurantDelivery = restaurant.restaurantDeliverySettings;
          return (
            <article className={flowStyles.restaurantCard} key={restaurant.id}>
              <Link
                className={flowStyles.restaurantCardLink}
                href={`/client/restaurants/${restaurant.id}`}
                onClick={() => {
                  if (
                    shouldAutoConfirmAddress({
                      fulfillmentChoice: state.cart.fulfillmentChoice,
                      isAddressConfirmed,
                      hasValidAddress,
                    })
                  ) {
                    confirmAddress();
                  }
                }}
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
                  {promotion ? (
                    <p className={flowStyles.promoBadge}>
                      {promotion.displayText}
                    </p>
                  ) : null}
                  {restaurantDelivery ? (
                    <p className={flowStyles.deliveryConditions}>
                      Минимальный заказ{" "}
                      {formatMoney(restaurantDelivery.minimumOrderCents)}
                      {restaurantDelivery.freeDeliveryThresholdCents !== null
                        ? ` · Бесплатная доставка от ${formatMoney(restaurantDelivery.freeDeliveryThresholdCents)}`
                        : ""}
                    </p>
                  ) : null}
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
