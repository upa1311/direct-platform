import { WorkspaceHeader } from "./workspace-header";

/**
 * Навигация кабинета водителя. «Обзор» — рабочее управление доступностью и
 * зоной; «Расчёты» — отдельный раздел, а не карточка на главной.
 *
 * Декоративного переключателя «Онлайн/Офлайн» в шапке больше нет: реальный
 * статус водителя живёт в доменном состоянии и меняется только действиями на
 * экране «Обзор». Два независимых управления доступностью противоречили бы
 * друг другу.
 */
const driverNavigation = [
  { href: "/driver", label: "Обзор" },
  { href: "/driver/offers", label: "Предложения" },
  { href: "/driver/current-order", label: "Текущий заказ" },
  { href: "/driver/settlements", label: "Расчёты" },
] as const;

export function DriverHeader() {
  return (
    <WorkspaceHeader
      applicationName="Кабинет водителя"
      navAriaLabel="Навигация водителя"
      navItems={driverNavigation}
    />
  );
}
