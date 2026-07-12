"use client";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";

export default function AdminRestaurantsPage() {
  const { state } = usePrototype();

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Рестораны"
        description="Все рестораны из общего состояния прототипа."
      />
      <section className={flowStyles.card}>
        <h2>Рестораны · {state.restaurants.length}</h2>
        <div className={flowStyles.orderList}>
          {state.restaurants.map((restaurant) => (
            <div className={flowStyles.cartLine} key={restaurant.id}>
              <strong>{restaurant.name}</strong>
              <div className={flowStyles.inlineMeta}>
                <span>{restaurant.status}</span>
                <span>{restaurant.zoneId}</span>
                <span>{restaurant.address}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
