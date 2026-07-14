"use client";

import Link from "next/link";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { CreateRestaurantForm } from "@/components/admin/restaurant-form";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import { publicationStatusLabels } from "@/prototype/selectors";

export default function RestaurantBuilderPage() {
  const { state } = usePrototype();

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Конструктор ресторанов"
        description="Полная настройка ресторанов, меню, размеров, доставки, оплаты и акций. Изменения не переписывают существующие заказы."
      />

      <CreateRestaurantForm />

      <section className={flowStyles.card}>
        <h2>Все рестораны</h2>
        <div className={flowStyles.orderList}>
          {state.restaurants.map((restaurant) => (
            <div className={flowStyles.cartLine} key={restaurant.id}>
              <div className={flowStyles.cartLineTop}>
                <div>
                  <strong>{restaurant.name}</strong>
                  <p>
                    {publicationStatusLabels[restaurant.status]} ·{" "}
                    {restaurant.deliveryProvider === "RESTAURANT"
                      ? "Курьер ресторана"
                      : "Водители Direct"}
                  </p>
                </div>
                <Link
                  className={flowStyles.primaryButton}
                  href={`/admin/restaurant-builder/${restaurant.id}`}
                >
                  Открыть в конструкторе
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
