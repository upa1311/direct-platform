"use client";

import kds from "@/components/kitchen/kitchen.module.css";
import { MenuAvailabilitySection } from "@/components/kitchen/kitchen-operations";
import { useRestaurantWorkspace } from "@/components/workspaces/restaurant-workspace";
import { useNowMs } from "@/components/util/use-now";
import { usePrototype } from "@/prototype/prototype-provider";
import { getRestaurant } from "@/prototype/selectors";

/**
 * Этап 10: отдельная страница «Меню и доступность». Использует тот же единый
 * state и компонент доступности меню, что и экран заказов, — временное
 * отключение блюда, восстановление и массовые действия категории.
 */
export default function RestaurantMenuPage() {
  const { state, isHydrated } = usePrototype();
  const {
    selectedRestaurantId,
    setSelectedRestaurantId,
    workspaceRestaurants,
  } = useRestaurantWorkspace();
  const nowMs = useNowMs();

  const restaurant = getRestaurant(state, selectedRestaurantId);

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
      ) : restaurant ? (
        <MenuAvailabilitySection restaurant={restaurant} nowMs={nowMs} />
      ) : (
        <div className={kds.empty}>Ресторан не найден.</div>
      )}
    </div>
  );
}
