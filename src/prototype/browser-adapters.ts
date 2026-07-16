/**
 * Этап 4 (восстановление): безопасные адаптеры необязательных browser API.
 * Корневой PrototypeProvider монтируется на каждом маршруте, поэтому ни один
 * из этих API не имеет права уронить приложение: в небезопасном контексте
 * (например, страница открыта по LAN-адресу http://192.168.x.x:3000, а не с
 * localhost) `crypto.randomUUID` и `navigator.locks` отсутствуют, а конструктор
 * `BroadcastChannel` в отдельных окружениях может бросить. Все функции чистые
 * и проверяются в node:test без браузера.
 */

/**
 * Локальный идентификатор вкладки. `crypto.randomUUID` используется, когда
 * доступен; fallback — НЕ криптографический (это метка источника broadcast-
 * сообщений между своими вкладками, не security token).
 */
export function createPrototypeSourceId(): string {
  try {
    if (
      typeof globalThis.crypto !== "undefined" &&
      typeof globalThis.crypto.randomUUID === "function"
    ) {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Используем fallback ниже.
  }
  return `direct-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Безопасное открытие BroadcastChannel: отсутствие API или бросающий
 * конструктор → null. Синхронизация через событие `storage` при этом
 * сохраняется; страница продолжает открываться.
 */
export function openPrototypeChannel(
  channelName: string,
): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel !== "function") {
      return null;
    }
    return new BroadcastChannel(channelName);
  } catch {
    return null;
  }
}

/** Безопасное закрытие канала: закрытый/битый канал ничего не роняет. */
export function closePrototypeChannel(
  channel: BroadcastChannel | null,
): void {
  try {
    channel?.close();
  } catch {
    // Ничего не роняем.
  }
}

/**
 * Безопасный доступ к Web Locks. Недоступный или бросающий LockManager → null:
 * чтение каталога и навигация работают, а критические мутации возвращают
 * fail-closed ошибку «Безопасная синхронизация вкладок недоступна…».
 */
export function getPrototypeLockManager(): LockManager | null {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.locks &&
      typeof navigator.locks.request === "function"
    ) {
      return navigator.locks;
    }
  } catch {
    return null;
  }
  return null;
}
