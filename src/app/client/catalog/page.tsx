"use client";

import Link from "next/link";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import { getPublishedRestaurants } from "@/prototype/selectors";

export default function ClientCatalogPage() {
  const { state } = usePrototype();
  const restaurants = getPublishedRestaurants(state);

  return (
    <>
      <PageHeading
        eyebrow="Клиент"
        title="Каталог"
        description="Выберите ресторан, откройте меню и добавьте блюда в корзину."
      />
      <div className={flowStyles.catalogGrid}>
        {restaurants.map((restaurant) => (
          <article className={flowStyles.restaurantCard} key={restaurant.id}>
            <Link
              className={flowStyles.restaurantCardLink}
              href={`/client/restaurants/${restaurant.id}`}
            >
              <div>
                <h2>{restaurant.name}</h2>
                <p>{restaurant.description}</p>
                <span className={flowStyles.statusBadge}>
                  {restaurant.isAcceptingOrders
                    ? "Принимает заказы"
                    : "Демонстрационный ресторан — заказы пока недоступны"}
                </span>
              </div>
              <div className={flowStyles.cardMeta}>
                <span>{restaurant.address}</span>
                <span>Открыть меню →</span>
              </div>
            </Link>
          </article>
        ))}
      </div>
    </>
  );
}
