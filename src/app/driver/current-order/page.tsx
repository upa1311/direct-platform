import { PageHeading, SectionPanel } from "@/components/workspaces/route-content";

export default function DriverCurrentOrderPage() {
  return (
    <>
      <PageHeading
        eyebrow="Водитель"
        title="Текущий заказ"
        description="Здесь отображается доставка, которую водитель выполняет сейчас."
      />
      <SectionPanel
        title="Текущего заказа нет"
        description="После принятия предложения информация о заказе появится здесь."
        action={{ href: "/driver/offers", label: "Посмотреть предложения" }}
      />
    </>
  );
}
