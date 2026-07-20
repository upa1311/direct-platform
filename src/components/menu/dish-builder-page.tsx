"use client";

import { useSearchParams } from "next/navigation";

import kds from "@/components/kitchen/kitchen.module.css";
import {
  DishBuilderRoleError,
  DishBuilderScreen,
} from "@/components/menu/restaurant-dish-builder";
import { useRestaurantWorkspace } from "@/components/workspaces/restaurant-workspace";
import { resolveDishBuilderRole } from "@/components/menu/dish-builder-form";
import type { Restaurant, RestaurantWorkspaceRole } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import { getRestaurant } from "@/prototype/selectors";

/**
 * Общий каркас страниц конструктора блюда. Ресторан берётся из workspace
 * context (как на всех ресторанных экранах), реальная рабочая роль — из
 * валидируемого query-параметра `role`: это только навигационный контекст,
 * право на каждое действие повторно проверяет домен. Неизвестная или
 * повреждённая роль в SPLIT — fail-closed заглушка без сохранений.
 */
export function DishBuilderPageShell({
  screenTitle,
  children,
}: {
  screenTitle: string;
  children: (context: {
    restaurant: Restaurant;
    workspaceRole: RestaurantWorkspaceRole;
  }) => React.ReactNode;
}) {
  const { state, isHydrated } = usePrototype();
  const { selectedRestaurantId } = useRestaurantWorkspace();
  const searchParams = useSearchParams();

  const restaurant = getRestaurant(state, selectedRestaurantId);
  const workspaceRole = restaurant
    ? resolveDishBuilderRole(
        restaurant.orderWorkflowMode,
        searchParams.get("role"),
      )
    : null;

  return (
    <DishBuilderScreen>
      <div className={kds.toolbar}>
        <div className={kds.toolbarLeft}>
          <span className={kds.brand}>{screenTitle}</span>
          <span className={kds.restaurantName}>{restaurant?.name ?? "—"}</span>
        </div>
      </div>
      {!isHydrated ? (
        <div className={kds.empty}>Загружаем…</div>
      ) : !restaurant ? (
        <div className={kds.empty}>Ресторан не найден.</div>
      ) : workspaceRole === null ? (
        <DishBuilderRoleError />
      ) : (
        children({ restaurant, workspaceRole })
      )}
    </DishBuilderScreen>
  );
}
