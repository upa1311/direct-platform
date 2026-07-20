"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useSyncExternalStore } from "react";

import kds from "@/components/kitchen/kitchen.module.css";
import { MenuAvailabilitySection } from "@/components/kitchen/kitchen-operations";
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

/** sessionStorage не эмитит событий — подписка пустая, snapshot читается сам. */
function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * Этап 10: отдельная страница «Меню и доступность». Ресторанный кабинет
 * НИКОГДА не read-only: создание блюда, «Мои заявки», «Отключить»/«Вернуть» и
 * массовые действия доступны всегда. Роль каноническая (query → сохранённый
 * workspace-контекст → канонический экран режима, см. resolveMenuPageRole);
 * если query отсутствует или повреждён, корректный URL восстанавливается через
 * router.replace — роль переживает reload, смену ресторана, возврат из
 * конструктора и browser Back. Права всё равно повторно проверяет домен
 * (MANAGE_MENU_CATALOG / CHANGE_MENU_AVAILABILITY) — UI не источник
 * авторизации.
 */
function RestaurantMenuPageContent() {
  const { state, isHydrated } = usePrototype();
  const {
    selectedRestaurantId,
    setSelectedRestaurantId,
    workspaceRestaurants,
  } = useRestaurantWorkspace();
  const nowMs = useNowMs();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Session-подсказка — резервный внешний источник: на сервере snapshot null,
  // поэтому SSR и первый клиентский рендер совпадают.
  const sessionHint = useSyncExternalStore(
    subscribeToNothing,
    readMenuWorkspaceRoleHint,
    () => null,
  );

  const queryRole = searchParams.get("role");
  const restaurant = getRestaurant(state, selectedRestaurantId);
  // До hydration роль не резолвится: режим ресторана ещё дефолтный.
  const workspaceRole =
    isHydrated && restaurant
      ? resolveMenuPageRole(restaurant.orderWorkflowMode, queryRole, sessionHint)
      : null;

  // Канонизация контекста: роль запоминается, а отсутствующий/повреждённый
  // query восстанавливается корректным URL — вместо молчаливого исчезновения
  // рабочих кнопок.
  useEffect(() => {
    if (!workspaceRole) return;
    rememberMenuWorkspaceRole(workspaceRole);
    if (queryRole !== workspaceRole) {
      router.replace(`/restaurant/menu?role=${workspaceRole}`);
    }
  }, [workspaceRole, queryRole, router]);

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

      {!isHydrated || !workspaceRole ? (
        <div className={kds.empty}>Загружаем меню…</div>
      ) : !restaurant ? (
        <div className={kds.empty}>Ресторан не найден.</div>
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
