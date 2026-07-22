"use client";

import { useSyncExternalStore } from "react";

/**
 * Общий выбор демо-водителя для всех экранов кабинета (`/driver`,
 * `/driver/offers`, `/driver/current-order`, `/driver/settlements`).
 *
 * Это исключительно UI-предпочтение браузера, не доменное состояние: оно решает,
 * «под каким водителем» открыт кабинет. Пётр автоматически не выбирается; при
 * серверном рендере снимок — null (без расхождения гидратации). Изменения видны
 * и в текущей вкладке (локальный emitter), и из других вкладок (событие storage).
 */
export const SELECTED_DRIVER_KEY = "direct-selected-driver-id";

export function readSelectedDriverId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SELECTED_DRIVER_KEY);
  } catch {
    return null;
  }
}

export function writeSelectedDriverId(driverId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (driverId === null) {
      window.localStorage.removeItem(SELECTED_DRIVER_KEY);
    } else {
      window.localStorage.setItem(SELECTED_DRIVER_KEY, driverId);
    }
  } catch {
    // Отсутствие localStorage не должно ломать рабочий экран.
  }
  emitSelectedDriverChange();
}

/** Подписчики текущей вкладки: событие storage в своей вкладке не срабатывает. */
const listeners = new Set<() => void>();

function emitSelectedDriverChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === SELECTED_DRIVER_KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", handleStorage);
  };
}

/**
 * Текущий выбранный id как внешнее хранилище: переживает SPA-переходы без
 * setState в эффекте и отдаёт null на сервере.
 */
export function useSelectedDriverId(): string | null {
  return useSyncExternalStore(subscribe, readSelectedDriverId, () => null);
}
