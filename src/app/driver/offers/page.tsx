import { PageHeading, SectionPanel } from "@/components/workspaces/route-content";

export default function DriverOffersPage() {
  return (
    <>
      <PageHeading
        eyebrow="Водитель"
        title="Предложения"
        description="Новые предложения на доставку будут появляться в этом разделе."
      />
      <SectionPanel
        title="Предложений пока нет"
        description="Проверьте статус в шапке: для рабочей смены водитель должен быть онлайн."
        action={{
          href: "/driver/current-order",
          label: "Открыть текущий заказ",
        }}
      />
    </>
  );
}
