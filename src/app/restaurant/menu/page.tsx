"use client";

import { useSearchParams } from "next/navigation";
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
 * Этап 10: отдельная страница «Меню и доступность». Раздел показывается ВСЕГДА,
 * когда ресторан найден: список блюд, категории, поиск, статусы и журнал не
 * зависят от рабочей роли. Роль (валидируемый query `role`, затем резервная
 * session-подсказка кабинета) управляет только правами: с ролью доступны
 * «Добавить новое блюдо», «Мои заявки» и изменение доступности; без роли раздел
 * работает read-only с компактной подсказкой — fail-closed относится к
 * мутациям и конструктору, а не к просмотру. Оператор не превращается молча в
 * KITCHEN; домен дополнительно проверяет право на каждом действии.
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

  // Session-подсказка — резервный внешний источник: на сервере snapshot null,
  // поэтому SSR и первый клиентский рендер совпадают, а sessionStorage не
  // становится источником расхождения (query остаётся первичным контекстом).
  const sessionHint = useSyncExternalStore(
    subscribeToNothing,
    readMenuWorkspaceRoleHint,
    () => null,
  );

  const restaurant = getRestaurant(state, selectedRestaurantId);
  const workspaceRole =
    isHydrated && restaurant
      ? resolveMenuPageRole(
          restaurant.orderWorkflowMode,
          searchParams.get("role"),
          sessionHint,
        )
      : null;

  // Разрешённая роль запоминается как контекст: возврат на эту страницу после
  // конструктора или по общей ссылке навигации сохраняет тот же рабочий экран.
  // Только после hydration — до неё режим ресторана ещё дефолтный.
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
      ) : (
        <>
          {workspaceRole ? (
            // Основная точка входа в конструктор — видна сразу под шапкой.
            <RestaurantMenuCatalogActions
              workspaceRole={workspaceRole}
              variant="PAGE"
            />
          ) : (
            <p className={kds.menuReadOnlyNotice} role="status">
              Откройте раздел из кабинета оператора или кухни, чтобы изменять
              меню.
            </p>
          )}
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
