import type { DriverStatus } from "@/prototype/models";

/**
 * Чистая логика звукового сигнала предложений водителю. Вынесена из React-
 * компонента, чтобы её можно было проверить доменным тестом без DOM.
 *
 * Ключ предпочтения ОТЛИЧАЕТСЯ от кухонного: настройка водителя никогда не
 * пишется в `direct-kitchen-sound-enabled`, поэтому поведение звука кухни не
 * меняется.
 */
export const DRIVER_OFFER_SOUND_KEY = "direct-driver-offer-sound-enabled";

/** Интервал повтора сигнала предложения. */
export const DRIVER_OFFER_BEEP_INTERVAL_MS = 10_000;

/**
 * Должен ли вообще звучать сигнал: только у выбранного AVAILABLE-водителя с хотя
 * бы одним открытым предложением и включённым звуком.
 */
export function shouldDriverOfferSoundPlay(params: {
  driverSelected: boolean;
  driverStatus: DriverStatus | null;
  openOfferCount: number;
  soundEnabled: boolean;
}): boolean {
  return (
    params.driverSelected &&
    params.driverStatus === "AVAILABLE" &&
    params.openOfferCount > 0 &&
    params.soundEnabled
  );
}

/**
 * Пора ли подать сигнал: сразу при новом (необъявленном) предложении, иначе не
 * чаще одного раза в интервал. Одна логика на все карточки — наложенных сигналов
 * не возникает.
 */
export function isDriverOfferBeepDue(params: {
  openOfferIds: readonly string[];
  announcedOfferIds: readonly string[];
  lastBeepAtMs: number | null;
  nowMs: number;
  intervalMs?: number;
}): boolean {
  const interval = params.intervalMs ?? DRIVER_OFFER_BEEP_INTERVAL_MS;
  if (params.openOfferIds.length === 0) return false;
  const hasUnannounced = params.openOfferIds.some(
    (id) => !params.announcedOfferIds.includes(id),
  );
  if (hasUnannounced) return true;
  if (params.lastBeepAtMs === null) return true;
  return params.nowMs - params.lastBeepAtMs >= interval;
}
