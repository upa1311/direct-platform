import { PageHeading, RouteCards } from "@/components/workspaces/route-content";

const restaurantSections = [
  {
    href: "/restaurant/new-orders",
    title: "Новые заказы",
    description: "Заказы, ожидающие решения ресторана",
  },
  {
    href: "/restaurant/active-orders",
    title: "Активные заказы",
    description: "Принятые заказы в работе",
  },
] as const;

export default function RestaurantPage() {
  return (
    <>
      <PageHeading
        eyebrow="Ресторан 1"
        title="Работа с заказами"
        description="Перейдите к новым заказам или откройте список заказов, которые уже готовятся."
      />
      <RouteCards items={restaurantSections} />
    </>
  );
}
