"use client";

import { useEffect, useRef, useState } from "react";
import { BellOff, BellRing } from "lucide-react";

import {
  disableKitchenSound,
  enableKitchenSound,
  KITCHEN_SOUND_KEY,
  playKitchenBeep,
} from "@/components/workspaces/kitchen-sound";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  getAudibleKitchenReviewOrders,
  isKitchenBeepDue,
} from "@/prototype/selectors";
import kds from "./kitchen.module.css";

/**
 * Сигнал о новом заказе. Звучит там, где принимается решение: в COMBINED — на
 * общем экране, в SPLIT — у оператора. Экран, который решение не принимает,
 * передаёт enabled=false и молчит, поэтому дубля сигнала быть не может.
 *
 * Реализация звука не своя: используется существующий Web Audio контроллер
 * (mp3 + fallback-осциллятор, повтор, browser guards). Здесь — только
 * расписание и включение после реального жеста пользователя.
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
  enableSound: () => Promise<void>;
  disableSound: () => void;
} {
  const { state } = usePrototype();
  const [soundEnabled, setSoundEnabled] = useState(false);
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
      setSoundBlocked(true);
      return;
    }
    setSoundBlocked(false);
    setSoundEnabled(true);
    window.localStorage.setItem(KITCHEN_SOUND_KEY, "1");
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
    setSoundEnabled(false);
    window.localStorage.setItem(KITCHEN_SOUND_KEY, "0");
  };

  return { soundEnabled, soundBlocked, enableSound, disableSound };
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
