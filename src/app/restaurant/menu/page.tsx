"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

import kds from "@/components/kitchen/kitchen.module.css";
import { MenuAvailabilitySection } from "@/components/kitchen/kitchen-operations";
import { DishBuilderRoleError } from "@/components/menu/restaurant-dish-builder";
import { RestaurantMenuCatalogActions } from "@/components/menu/restaurant-menu-catalog-actions";
import { resolveMenuPageRole } from "@/components/menu/dish-builder-form";
import {
  readMenuWorkspaceRoleHint,
  rememberMenuWorkspaceRole,
} from "@/components/menu/menu-workspace-context";
import { useRestaurantWorkspace } from "@/components/workspaces/restaurant-workspace";
import { useNowMs } from "@/components/util/use-now";
import { usePrototype } from "@/prototype/prototype-provider";
import { getRestaurant } from "@/prototype/selectors";

/**
 * Этап 10: отдельная страница «Меню и доступность». Использует тот же единый
 * state и компонент доступности меню, что и экран заказов, а сверху — общие
 * действия каталога («Добавить новое блюдо» и «Мои заявки»), видимые сразу,
 * без прокрутки и раскрытия панелей.
 *
 * Роль НЕ угадывается: в SPLIT страницу открывают и оператор, и кухня, поэтому
 * реальный рабочий экран приходит навигационным контекстом (query-параметр или
 * session-подсказка кабинета). Оператор не превращается молча в KITCHEN;
 * повреждённый контекст — fail-closed. Домен дополнительно проверяет право на
 * каждом действии.
 */
function RestaurantMenuPageContent() {
  const { state, isHydrated } = usePrototype();
  const {
    selectedRestaurantId,
    setSelectedRestaurantId,
    workspaceRestaurants,
  } = useRestaurantWorkspace();
  const nowMs = useNowMs();
  const searchParams = useSearchParams();

  const restaurant = getRestaurant(state, selectedRestaurantId);
  const workspaceRole = restaurant
    ? resolveMenuPageRole(
        restaurant.orderWorkflowMode,
        searchParams.get("role"),
        readMenuWorkspaceRoleHint(),
      )
    : null;

  // Разрешённая роль запоминается как контекст: возврат на эту страницу после
  // конструктора или по общей ссылке навигации сохраняет тот же рабочий экран.
  // ТОЛЬКО после hydration: до неё режим ресторана ещё дефолтный (COMBINED), и
  // преждевременная запись затёрла бы настоящий контекст OPERATOR/KITCHEN.
  useEffect(() => {
    if (isHydrated && workspaceRole) {
      rememberMenuWorkspaceRole(workspaceRole);
    }
  }, [isHydrated, workspaceRole]);

  return (
    <div className={kds.screen}>
      <div className={kds.toolbar}>
        <div className={kds.toolbarLeft}>
          <span className={kds.brand}>Меню и доступность</span>
          <span className={kds.restaurantName}>{restaurant?.name ?? "—"}</span>
        </div>
        <div className={kds.toolbarRight}>
          <select
            className={kds.restaurantSelect}
            aria-label="Сменить ресторан"
            value={selectedRestaurantId}
            onChange={(event) => setSelectedRestaurantId(event.target.value)}
          >
            {workspaceRestaurants.map((r) => (
              <option value={r.id} key={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!isHydrated ? (
        <div className={kds.empty}>Загружаем меню…</div>
      ) : !restaurant ? (
        <div className={kds.empty}>Ресторан не найден.</div>
      ) : workspaceRole === null ? (
        <DishBuilderRoleError />
      ) : (
        <>
          {/* Основная точка входа в конструктор — видна сразу под шапкой. */}
          <RestaurantMenuCatalogActions
            workspaceRole={workspaceRole}
            variant="PAGE"
          />
          <MenuAvailabilitySection
            restaurant={restaurant}
            nowMs={nowMs}
            workspaceRole={workspaceRole}
          />
        </>
      )}
    </div>
  );
}

export default function RestaurantMenuPage() {
  return (
    <Suspense>
      <RestaurantMenuPageContent />
    </Suspense>
  );
}
