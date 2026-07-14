"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { usePrototype } from "@/prototype/prototype-provider";
import { WORKING_RESTAURANT_IDS } from "@/prototype/selectors";
import type { Restaurant } from "@/prototype/models";

/**
 * Временный для прототипа выбор активного ресторана кухни (только рабочие
 * рестораны 1–3). Хранится в отдельном localStorage-ключе, НЕ попадает в
 * заказы и финансовые snapshots. Позже будет определяться аккаунтом/ролью.
 */
const WORKSPACE_RESTAURANT_KEY = "direct-restaurant-workspace-id";
const DEFAULT_RESTAURANT_ID = "restaurant-1";

interface RestaurantWorkspaceValue {
  selectedRestaurantId: string;
  setSelectedRestaurantId: (restaurantId: string) => void;
  /** Рабочие рестораны (1–3), существующие в состоянии. */
  workspaceRestaurants: Restaurant[];
}

const RestaurantWorkspaceContext =
  createContext<RestaurantWorkspaceValue | null>(null);

export function RestaurantWorkspaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { state } = usePrototype();
  const workspaceRestaurants = useMemo(
    () =>
      state.restaurants.filter((restaurant) =>
        (WORKING_RESTAURANT_IDS as readonly string[]).includes(restaurant.id),
      ),
    [state.restaurants],
  );

  const [selectedRestaurantId, setSelected] = useState(DEFAULT_RESTAURANT_ID);

  // Восстанавливаем выбор из localStorage после монтирования (SSR-safe).
  useEffect(() => {
    const stored = window.localStorage.getItem(WORKSPACE_RESTAURANT_KEY);
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- одноразовое чтение browser-only storage после гидрации
      setSelected(stored);
    }
  }, []);

  // Если выбранный ресторан больше не существует — берём первый доступный.
  const availableIds = workspaceRestaurants.map((restaurant) => restaurant.id);
  const resolvedId =
    availableIds.includes(selectedRestaurantId)
      ? selectedRestaurantId
      : (availableIds[0] ?? DEFAULT_RESTAURANT_ID);

  // §7: если сохранённый ресторан пропал — фиксируем исправленный fallback
  // обратно в localStorage, чтобы выбор оставался согласованным.
  useEffect(() => {
    if (resolvedId !== selectedRestaurantId) {
      window.localStorage.setItem(WORKSPACE_RESTAURANT_KEY, resolvedId);
    }
  }, [resolvedId, selectedRestaurantId]);

  const setSelectedRestaurantId = useCallback((restaurantId: string) => {
    setSelected(restaurantId);
    window.localStorage.setItem(WORKSPACE_RESTAURANT_KEY, restaurantId);
  }, []);

  const value = useMemo<RestaurantWorkspaceValue>(
    () => ({
      selectedRestaurantId: resolvedId,
      setSelectedRestaurantId,
      workspaceRestaurants,
    }),
    [resolvedId, setSelectedRestaurantId, workspaceRestaurants],
  );

  return (
    <RestaurantWorkspaceContext.Provider value={value}>
      {children}
    </RestaurantWorkspaceContext.Provider>
  );
}

export function useRestaurantWorkspace(): RestaurantWorkspaceValue {
  const context = useContext(RestaurantWorkspaceContext);
  if (!context) {
    throw new Error(
      "useRestaurantWorkspace must be used inside RestaurantWorkspaceProvider",
    );
  }
  return context;
}
