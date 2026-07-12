import { PageHeading, RouteCards } from "@/components/workspaces/route-content";

const adminSections = [
  {
    href: "/admin/restaurants",
    title: "Рестораны",
    description: "Список ресторанов платформы",
  },
  {
    href: "/admin/orders",
    title: "Заказы",
    description: "Контроль заказов сервиса",
  },
  {
    href: "/admin/drivers",
    title: "Водители",
    description: "Список водителей и их статусы",
  },
  {
    href: "/admin/zones",
    title: "Зоны и тарифы",
    description: "Настройки географии доставки",
  },
] as const;

export default function AdminPage() {
  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Управление платформой"
        description="Выберите основной раздел в боковой навигации или на этой странице."
      />
      <RouteCards items={adminSections} />
    </>
  );
}
