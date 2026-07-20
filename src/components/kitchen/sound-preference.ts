/**
 * Чистая логика настройки звука ресторанного кабинета.
 *
 * Разделяются два разных понятия:
 *  - ПРЕДПОЧТЕНИЕ пользователя (`soundPreferred`) — переживает SPA-переходы и
 *    перезагрузки, хранится в localStorage под KITCHEN_SOUND_KEY;
 *  - ФАКТИЧЕСКАЯ готовность документа (`ready`) — работает ли прямо сейчас
 *    AudioContext в этой вкладке. Браузер может запретить его запуск без нового
 *    пользовательского жеста, поэтому предпочтение само по себе звук не включает.
 *
 * Колокольчик показывается включённым только когда выполнено И то, И другое:
 * интерфейс не должен врать, что звук работает, если контекст не запущен.
 */

/** Сообщение, когда предпочтение сохранено, но вкладке нужен один жест. */
export const SOUND_ACTIVATION_MESSAGE =
  "Звук сохранён. Нажмите колокольчик один раз для этой вкладки.";

/** Значение предпочтения в localStorage: «1» — да, всё остальное — нет. */
export function isSoundPreferred(raw: string | null): boolean {
  return raw === "1";
}

export interface SoundState {
  /** Звук реально работает в этой вкладке. */
  soundEnabled: boolean;
  /** Предпочтение сохранено, но нужен один жест именно в этой вкладке. */
  activationRequired: boolean;
}

/**
 * Итоговое состояние по предпочтению и фактической готовности контекста.
 * Автоматически AudioContext не создаётся: обход autoplay policy не делаем.
 */
export function resolveSoundState(
  preferred: boolean,
  ready: boolean,
): SoundState {
  if (!preferred) {
    return { soundEnabled: false, activationRequired: false };
  }
  return preferred && ready
    ? { soundEnabled: true, activationRequired: false }
    : { soundEnabled: false, activationRequired: true };
}
