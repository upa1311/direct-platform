import { redirect } from "next/navigation";

import { RESTAURANT_KITCHEN_PATH } from "@/components/workspaces/restaurant-nav";

/**
 * Режим работы переехал в popover шестерёнки в шапке ресторана, отдельного
 * рабочего экрана настроек больше нет. Старый URL не должен быть 404: прямое
 * открытие ведёт на кухню. Доменная логика режима не тронута — её использует
 * шестерёнка через штатную мутацию setRestaurantWorkflow.
 */
export default function RestaurantSettingsPage(): never {
  redirect(RESTAURANT_KITCHEN_PATH);
}
