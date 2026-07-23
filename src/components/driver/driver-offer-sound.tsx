"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BellOff, BellRing } from "lucide-react";

import {
  enableKitchenSound,
  isKitchenSoundReady,
  playKitchenBeep,
} from "@/components/workspaces/kitchen-sound";
import {
  isSoundPreferred,
  resolveSoundState,
} from "@/components/kitchen/sound-preference";
import { usePrototype } from "@/prototype/prototype-provider";
import { getOpenDriverOffersForDriver } from "@/prototype/driver-offers";
import { useNowMs } from "@/components/util/use-now";
import { useAuthenticatedDriverId } from "./driver-session";
import {
  DRIVER_OFFER_SOUND_KEY,
  isDriverOfferBeepDue,
  shouldDriverOfferSoundPlay,
} from "./driver-offer-sound-logic";
import styles from "@/app/driver/driver.module.css";

/**
 * Звуковой сигнал новых предложений водителю.
 *
 * Низкоуровневый Web Audio механизм переиспользуется из кухни (тот же mp3 и
 * fallback), но предпочтение водителя хранится под ОТДЕЛЬНЫМ ключом
 * (DRIVER_OFFER_SOUND_KEY) и никогда не пишет в кухонный: поведение звука кухни
 * не меняется. Повтор — каждые 10 секунд, один общий планировщик (без
 * setInterval на карточку), защита от наложения — в самом playKitchenBeep.
 */
export { DRIVER_OFFER_SOUND_KEY } from "./driver-offer-sound-logic";

// --- Предпочтение звука водителя (внешнее хранилище) ---------------------------

type SoundStatus = "OFF" | "ON" | "ACTIVATION_REQUIRED";

const soundStatusListeners = new Set<() => void>();

function emitSoundStatusChange(): void {
  for (const listener of soundStatusListeners) listener();
}

function subscribeToSoundStatus(onChange: () => void): () => void {
  soundStatusListeners.add(onChange);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === DRIVER_OFFER_SOUND_KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    soundStatusListeners.delete(onChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function getSoundStatus(): SoundStatus {
  const preferred = isSoundPreferred(
    window.localStorage.getItem(DRIVER_OFFER_SOUND_KEY),
  );
  const { soundEnabled, activationRequired } = resolveSoundState(
    preferred,
    isKitchenSoundReady(),
  );
  if (soundEnabled) return "ON";
  return activationRequired ? "ACTIVATION_REQUIRED" : "OFF";
}

function getServerSoundStatus(): SoundStatus {
  return "OFF";
}

/** Состояние и управление звуком предложений (без записи в кухонный ключ). */
export function useDriverOfferSoundPreference(): {
  soundEnabled: boolean;
  soundBlocked: boolean;
  activationRequired: boolean;
  enableSound: () => Promise<void>;
  disableSound: () => void;
} {
  const soundStatus = useSyncExternalStore(
    subscribeToSoundStatus,
    getSoundStatus,
    getServerSoundStatus,
  );
  const soundEnabled = soundStatus === "ON";
  const activationRequired = soundStatus === "ACTIVATION_REQUIRED";
  const [soundBlocked, setSoundBlocked] = useState(false);

  const enableSound = async () => {
    const ok = await enableKitchenSound();
    if (!ok) {
      setSoundBlocked(true);
      return;
    }
    setSoundBlocked(false);
    window.localStorage.setItem(DRIVER_OFFER_SOUND_KEY, "1");
    emitSoundStatusChange();
    // Один тестовый сигнал при включении по жесту пользователя.
    playKitchenBeep();
  };

  const disableSound = () => {
    // Кухонный контекст не трогаем: достаточно убрать предпочтение водителя,
    // планировщик перестанет подавать сигнал. Так поведение кухни не меняется.
    setSoundBlocked(false);
    window.localStorage.setItem(DRIVER_OFFER_SOUND_KEY, "0");
    emitSoundStatusChange();
  };

  return { soundEnabled, soundBlocked, activationRequired, enableSound, disableSound };
}

// --- Планировщик сигнала (один на кабинет) ------------------------------------

/**
 * Единственный планировщик сигнала предложений. Монтируется один раз в layout
 * кабинета. Никакого setInterval на карточку: расписание считается от общего
 * секундного тика, наложение исключено окном в playKitchenBeep.
 */
export function DriverOfferSoundPlayer() {
  const { state, isHydrated } = usePrototype();
  const sessionDriverId = useAuthenticatedDriverId();
  const { soundEnabled } = useDriverOfferSoundPreference();
  const nowMs = useNowMs();

  const lastBeepRef = useRef<number | null>(null);
  const announcedRef = useRef<string[]>([]);

  const driver = sessionDriverId
    ? state.drivers.find((d) => d.id === sessionDriverId) ?? null
    : null;

  useEffect(() => {
    if (!isHydrated || nowMs === 0) return;

    const openOffers = driver
      ? getOpenDriverOffersForDriver(state, driver.id, nowMs)
      : [];
    const shouldPlay = shouldDriverOfferSoundPlay({
      driverSelected: driver !== null,
      driverStatus: driver?.status ?? null,
      openOfferCount: openOffers.length,
      soundEnabled,
    });

    if (!shouldPlay) {
      // Нет условий для сигнала — сбрасываем расписание, чтобы новое
      // предложение прозвучало сразу.
      lastBeepRef.current = null;
      announcedRef.current = [];
      return;
    }

    const openIds = openOffers.map((offer) => offer.id);
    const due = isDriverOfferBeepDue({
      openOfferIds: openIds,
      announcedOfferIds: announcedRef.current,
      lastBeepAtMs: lastBeepRef.current,
      nowMs,
    });
    if (due) {
      playKitchenBeep();
      lastBeepRef.current = nowMs;
      announcedRef.current = openIds;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowMs]);

  return null;
}

// --- Компактная кнопка управления звуком --------------------------------------

/**
 * Компактная кнопка включения/выключения звука предложений. Первое включение —
 * по жесту пользователя (browser autoplay policy). При блокировке браузером
 * показывает подсказку под кнопкой.
 */
export function DriverOfferSoundButton() {
  const { soundEnabled, soundBlocked, enableSound, disableSound } =
    useDriverOfferSoundPreference();
  return (
    <div className={styles.soundControl}>
      <button
        type="button"
        className={styles.soundButton}
        onClick={soundEnabled ? disableSound : () => void enableSound()}
        aria-pressed={soundEnabled}
        title={soundEnabled ? "Выключить звук" : "Включить звук"}
        aria-label={soundEnabled ? "Выключить звук" : "Включить звук"}
      >
        {soundEnabled ? (
          <BellRing size={16} aria-hidden="true" />
        ) : (
          <BellOff size={16} aria-hidden="true" />
        )}
        {soundEnabled ? "Звук включён" : "Включить звук"}
      </button>
      {soundBlocked ? (
        <span className={styles.soundHint} role="alert">
          Браузер не разрешил включить звук. Нажмите ещё раз.
        </span>
      ) : null}
    </div>
  );
}
