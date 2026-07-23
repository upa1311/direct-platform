"use client";

import { useSyncExternalStore } from "react";

/**
 * UI-сессия авторизованного водителя. После входа по имени и телефону в
 * localStorage хранится ТОЛЬКО driverId — имя и телефон повторно не сохраняются.
 * Это не доменное состояние: выход из аккаунта не меняет статус водителя.
 *
 * SSR-снимок — null (без расхождения гидратации). Изменения видны в текущей
 * вкладке (локальный emitter) и между вкладками (событие storage). Ошибки
 * localStorage не ломают страницу.
 */
export const DRIVER_SESSION_KEY = "direct-driver-session-id";

/** Старый ключ выбора демо-водителя. Больше НЕ авторизует и не мигрируется. */
const LEGACY_SELECTED_DRIVER_KEY = "direct-selected-driver-id";

export function readAuthenticatedDriverId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DRIVER_SESSION_KEY);
  } catch {
    return null;
  }
}

export function writeAuthenticatedDriverId(driverId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DRIVER_SESSION_KEY, driverId);
  } catch {
    // Отсутствие localStorage не должно ломать вход.
  }
  emitSessionChange();
}

export function clearAuthenticatedDriverId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DRIVER_SESSION_KEY);
  } catch {
    // Игнорируем — сессия и так считается отсутствующей.
  }
  emitSessionChange();
}

/**
 * Безопасно удаляет legacy-ключ выбора демо-водителя. Старый выбор Петра не
 * должен превращаться в автоматический вход, поэтому ключ просто стирается.
 */
export function clearLegacySelectedDriverId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_SELECTED_DRIVER_KEY);
  } catch {
    // Ничего не делаем.
  }
}

/** Подписчики текущей вкладки: событие storage в своей вкладке не срабатывает. */
const listeners = new Set<() => void>();

function emitSessionChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === DRIVER_SESSION_KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", handleStorage);
  };
}

/**
 * driverId текущей сессии как внешнее хранилище: переживает SPA-переходы без
 * setState в эффекте и отдаёт null на сервере.
 */
export function useAuthenticatedDriverId(): string | null {
  return useSyncExternalStore(subscribe, readAuthenticatedDriverId, () => null);
}
