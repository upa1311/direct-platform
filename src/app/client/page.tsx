"use client";

import { ClientOrderCard } from "@/components/order-flow/client-order-card";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading, RouteCards } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import { getLatestCustomerOrder } from "@/prototype/selectors";

const clientSections = [
  {
    href: "/client/catalog",
    title: "Каталог",
    description: "Посмотреть доступные рестораны",
  },
  {
    href: "/client/cart",
    title: "Корзина",
    description: "Проверить выбранные позиции",
  },
  {
    href: "/client/orders",
    title: "Мои заказы",
    description: "Открыть текущие и прошлые заказы",
  },
] as const;

export default function ClientPage() {
  const { state, isHydrated } = usePrototype();
  const latestOrder = getLatestCustomerOrder(state);

  return (
    <>
      <PageHeading
        eyebrow="Клиент"
        title="Заказ еды"
        description="Выберите ресторан в каталоге или вернитесь к уже созданному заказу."
      />
      {isHydrated && latestOrder ? (
        <section className={flowStyles.latestOrderSection}>
          <h2>Последний заказ</h2>
          <ClientOrderCard order={latestOrder} linkLabel="Продолжить" />
        </section>
      ) : null}
      <RouteCards items={clientSections} />
    </>
  );
}
