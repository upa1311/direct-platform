"use client";

import { usePathname } from "next/navigation";

import { usePrototype } from "@/prototype/prototype-provider";
import { restaurantNavItemsForPath } from "./restaurant-nav";
import { RestaurantSettingsMenu } from "./restaurant-settings-menu";
import { useRestaurantWorkspace } from "./restaurant-workspace";
import { WorkspaceHeader } from "./workspace-header";

/**
 * Этап 11: навигация ресторана зависит от режима работы выбранного ресторана.
 * COMBINED — «Заказы» и «Меню и доступность»; SPLIT — «Оператор заказов» первым.
 * Сам режим переключается шестерёнкой справа, а не рабочим разделом. Ссылка
 * «Меню и доступность» несёт явный контекст роли текущего экрана (см.
 * menuNavHref): оператор остаётся оператором и после reload.
 */
export function RestaurantHeader() {
  const { state } = usePrototype();
  const { selectedRestaurantId } = useRestaurantWorkspace();
  const pathname = usePathname();
  const mode =
    state.restaurants.find((r) => r.id === selectedRestaurantId)
      ?.orderWorkflowMode ?? "COMBINED";

  return (
    <WorkspaceHeader
      applicationName="Кабинет ресторана"
      navAriaLabel="Навигация ресторана"
      navItems={restaurantNavItemsForPath(mode, pathname)}
      navRightSlot={<RestaurantSettingsMenu />}
    />
  );
}
