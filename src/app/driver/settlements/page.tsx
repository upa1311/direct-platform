import { PageHeading, SectionPanel } from "@/components/workspaces/route-content";

/**
 * Раздел «Расчёты» водителя. Пока это честная заглушка: финансовой модели
 * водителя не существует, поэтому ни сумм, ни истории здесь не показывается —
 * выдуманные цифры хуже их отсутствия.
 */
export default function DriverSettlementsPage() {
  return (
    <>
      <PageHeading
        eyebrow="Водитель"
        title="Расчёты"
        description="Здесь будут показаны выполненные доставки, заработок и история расчётов."
      />
      <SectionPanel
        title="Данных пока нет"
        description="Раздел появится вместе с учётом выполненных доставок."
      />
    </>
  );
}
