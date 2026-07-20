"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BellOff, BellRing } from "lucide-react";

import {
  disableKitchenSound,
  enableKitchenSound,
  isKitchenSoundReady,
  KITCHEN_SOUND_KEY,
  playKitchenBeep,
} from "@/components/workspaces/kitchen-sound";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  getAudibleKitchenReviewOrders,
  isKitchenBeepDue,
} from "@/prototype/selectors";
import { isSoundPreferred, resolveSoundState } from "./sound-preference";
import kds from "./kitchen.module.css";

/**
 * Состояние звука — внешнее по отношению к React: оно живёт в localStorage
 * (предпочтение) и в модульном AudioContext (фактическая готовность). Поэтому
 * читаем его через useSyncExternalStore: это переживает SPA-переходы без
 * setState в эффекте и корректно отдаёт «выключено» при серверном рендере,
 * то есть без расхождения гидратации.
 */
type SoundStatus = "OFF" | "ON" | "ACTIVATION_REQUIRED";

/** Подписчики этой вкладки: storage-событие в своей вкладке не срабатывает. */
const soundStatusListeners = new Set<() => void>();

/** Сообщить своей вкладке, что предпочтение изменилось. */
function emitSoundStatusChange(): void {
  for (const listener of soundStatusListeners) listener();
}

function subscribeToSoundStatus(onChange: () => void): () => void {
  soundStatusListeners.add(onChange);
  // Чужие вкладки приходят через storage; свои — через локальный emitter.
  const handleStorage = (event: StorageEvent) => {
    if (event.key === KITCHEN_SOUND_KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    soundStatusListeners.delete(onChange);
    window.removeEventListener("storage", handleStorage);
  };
}

/**
 * Текущее состояние: предпочтение из localStorage + фактическая готовность
 * контекста. Возвращается примитив, поэтому снимок стабилен по значению.
 */
function getSoundStatus(): SoundStatus {
  const preferred = isSoundPreferred(
    window.localStorage.getItem(KITCHEN_SOUND_KEY),
  );
  const { soundEnabled, activationRequired } = resolveSoundState(
    preferred,
    isKitchenSoundReady(),
  );
  if (soundEnabled) return "ON";
  return activationRequired ? "ACTIVATION_REQUIRED" : "OFF";
}

/** На сервере звука нет: гидратация начинается с выключенного состояния. */
function getServerSoundStatus(): SoundStatus {
  return "OFF";
}

/**
 * Сигнал о новом заказе. Звучит там, где принимается решение: в COMBINED — на
 * общем экране, в SPLIT — у оператора. Экран, который решение не принимает,
 * передаёт enabled=false и молчит, поэтому дубля сигнала быть не может.
 *
 * Реализация звука не своя: используется существующий Web Audio контроллер
 * (mp3 + fallback-осциллятор, повтор, browser guards). Здесь — только
 * расписание, восстановление сохранённого предпочтения и включение после
 * реального жеста пользователя.
 *
 * Предпочтение звука принадлежит браузеру, а не экрану и не ресторану: переход
 * кухня ↔ оператор ↔ меню ↔ расчёты его не сбрасывает. Выключением считается
 * только явное нажатие колокольчика, поэтому в cleanup звук не выключается и
 * «0» при размонтировании не записывается.
 */
export function useNewOrderSound({
  restaurantId,
  enabled,
  nowMs,
}: {
  restaurantId: string;
  /** Должен ли этот экран озвучивать новые заказы в текущем режиме. */
  enabled: boolean;
  /** Общий тик экрана — расписание сигнала считается от него. */
  nowMs: number;
}): {
  soundEnabled: boolean;
  soundBlocked: boolean;
  /** Предпочтение сохранено, но этой вкладке нужен один жест пользователя. */
  activationRequired: boolean;
  enableSound: () => Promise<void>;
  disableSound: () => void;
} {
  const { state } = usePrototype();
  // Восстановление после SPA-навигации: снимок считается из сохранённого
  // предпочтения и реальной готовности контекста. Если контекст всё ещё запущен
  // (обычный переход между разделами), звук возвращается сам — без повторного
  // клика, нового AudioContext и тестового сигнала.
  const soundStatus = useSyncExternalStore(
    subscribeToSoundStatus,
    getSoundStatus,
    getServerSoundStatus,
  );
  const soundEnabled = soundStatus === "ON";
  const activationRequired = soundStatus === "ACTIVATION_REQUIRED";
  const [soundBlocked, setSoundBlocked] = useState(false);

  const stateRef = useRef(state);
  const restaurantIdRef = useRef(restaurantId);
  const soundEnabledRef = useRef(false);
  const routedRef = useRef(enabled);
  const lastBeepRef = useRef<number | null>(null);
  const announcedRef = useRef<string[]>([]);

  useEffect(() => {
    stateRef.current = state;
    restaurantIdRef.current = restaurantId;
    soundEnabledRef.current = soundEnabled;
    routedRef.current = enabled;
  }, [state, restaurantId, soundEnabled, enabled]);

  // Если звук выключили в ДРУГОЙ вкладке, здесь освобождаем AudioContext.
  // Обработчик ничего не записывает в localStorage, поэтому storage-петли нет.
  useEffect(() => {
    if (soundStatus === "OFF" && isKitchenSoundReady()) {
      disableKitchenSound();
    }
  }, [soundStatus]);

  // Централизованное расписание сигнала: без setInterval на карточку.
  useEffect(() => {
    if (nowMs === 0) return;
    if (!routedRef.current) {
      // Экран не отвечает за решение — расписание сброшено, сигнала нет.
      lastBeepRef.current = null;
      announcedRef.current = [];
      return;
    }
    const audibleIds = getAudibleKitchenReviewOrders(
      stateRef.current,
      restaurantIdRef.current,
      nowMs,
    ).map((order) => order.id);
    if (audibleIds.length === 0) {
      // Нет звучащих заказов — сбрасываем расписание для мгновенного сигнала.
      lastBeepRef.current = null;
      announcedRef.current = [];
      return;
    }
    if (!soundEnabledRef.current) return;
    const due = isKitchenBeepDue({
      reviewOrderIds: audibleIds,
      announcedOrderIds: announcedRef.current,
      lastBeepAtMs: lastBeepRef.current,
      nowMs,
    });
    if (due) {
      playKitchenBeep();
      lastBeepRef.current = nowMs;
      announcedRef.current = [...audibleIds];
    }
  }, [nowMs]);

  const enableSound = async () => {
    const ok = await enableKitchenSound();
    if (!ok) {
      // Браузер не дал запустить контекст — ложного включения не показываем.
      setSoundBlocked(true);
      return;
    }
    setSoundBlocked(false);
    // Предпочтение переживает переходы; снимок пересчитается из него и из уже
    // запущенного контекста.
    window.localStorage.setItem(KITCHEN_SOUND_KEY, "1");
    emitSoundStatusChange();
    // Если уже есть звучащие новые заказы — один рабочий сигнал сразу.
    const audibleIds = getAudibleKitchenReviewOrders(
      state,
      restaurantId,
      Date.now(),
    ).map((order) => order.id);
    playKitchenBeep();
    lastBeepRef.current = Date.now();
    announcedRef.current = audibleIds;
  };

  const disableSound = () => {
    disableKitchenSound();
    setSoundBlocked(false);
    window.localStorage.setItem(KITCHEN_SOUND_KEY, "0");
    emitSoundStatusChange();
  };

  return {
    soundEnabled,
    soundBlocked,
    activationRequired,
    enableSound,
    disableSound,
  };
}

/** Компактная нейтральная кнопка-колокольчик — та же, что была на кухне. */
export function NewOrderSoundButton({
  soundEnabled,
  onEnable,
  onDisable,
}: {
  soundEnabled: boolean;
  onEnable: () => void;
  onDisable: () => void;
}) {
  return (
    <button
      className={`${kds.soundBtn} ${soundEnabled ? kds.soundBtnOn : ""}`}
      type="button"
      onClick={soundEnabled ? onDisable : onEnable}
      aria-label={soundEnabled ? "Выключить звук" : "Включить звук"}
      title={
        soundEnabled ? "Звук включён. Нажмите, чтобы выключить" : "Включить звук"
      }
    >
      {/* Выключенный звук — перечёркнутый колокольчик (BellOff), чтобы
          состояние читалось с одного взгляда; включённый — BellRing. */}
      {soundEnabled ? (
        <BellRing size={18} aria-hidden="true" />
      ) : (
        <BellOff size={18} aria-hidden="true" />
      )}
      {soundEnabled ? <span className={kds.soundDot} aria-hidden="true" /> : null}
    </button>
  );
}
