import { PageHeading, RouteCards } from "@/components/workspaces/route-content";

const driverSections = [
  {
    href: "/driver/offers",
    title: "Предложения",
    description: "Доступные предложения на доставку",
  },
  {
    href: "/driver/current-order",
    title: "Текущий заказ",
    description: "Заказ, который водитель выполняет сейчас",
  },
] as const;

export default function DriverPage() {
  return (
    <>
      <PageHeading
        eyebrow="Водитель"
        title="Рабочая смена"
        description="Включите статус онлайн, чтобы обозначить готовность принимать предложения."
      />
      <RouteCards items={driverSections} />
    </>
  );
}
