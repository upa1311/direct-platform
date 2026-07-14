"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { RestaurantBuilderEditor } from "@/components/admin/restaurant-form";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import { getRestaurant } from "@/prototype/selectors";

export default function RestaurantBuilderDetailPage() {
  const params = useParams<{ restaurantId: string }>();
  const { state } = usePrototype();
  const restaurant = getRestaurant(state, params.restaurantId);

  if (!restaurant) {
    return (
      <>
        <PageHeading
          eyebrow="Администратор"
          title="Конструктор ресторанов"
          description="Ресторан не найден."
        />
        <div className={flowStyles.emptyState}>
          Ресторан не найден.{" "}
          <Link href="/admin/restaurant-builder">
            Вернуться к списку ресторанов
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeading
        eyebrow="Конструктор ресторанов"
        title={restaurant.name}
        description="Основное, контакты и график, доставка и оплата, меню, размеры, акции, публикация и предпросмотр."
      />
      <RestaurantBuilderEditor restaurant={restaurant} />
    </>
  );
}
