"use client";

import { useEffect, useRef } from "react";

import { usePrototype } from "@/prototype/prototype-provider";
import {
  initialReadySoundState,
  readyOrderIds,
  reduceReadySound,
} from "@/components/operator/order-ready-sound";

/** Публичный URL пользовательского аудиофайла «Заказ готов» (лежит в public/). */
export const ORDER_READY_SOUND_FILE_URL = "/sounds/order-ready.mp3";

let orderReadyAudio: HTMLAudioElement | null = null;

/** Один переиспользуемый <audio>-элемент (не создаём новый на каждый tick). */
function getOrderReadyAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof Audio === "undefined") return null;
  if (!orderReadyAudio) {
    orderReadyAudio = new Audio(ORDER_READY_SOUND_FILE_URL);
    orderReadyAudio.preload = "auto";
  }
  return orderReadyAudio;
}

/**
 * Проигрывает пользовательский звук «Заказ готов» один раз. Только сам файл —
 * без fallback-beep. Отклонённый play-Promise (autoplay guard) и синхронные
 * ошибки молча игнорируются: звук не влияет на статус заказа и не роняет UI.
 */
export function playOrderReadySound(): void {
  const audio = getOrderReadyAudio();
  if (!audio) return;
  try {
    audio.currentTime = 0;
    const played = audio.play();
    if (played && typeof played.then === "function") {
      played.catch(() => {
        // autoplay guard / отклонённый Promise — тишина, без ошибки.
      });
    }
  } catch {
    // Воспроизведение никогда не меняет статус заказа.
  }
}

/**
 * Сигнал «Заказ готов» для операторского экрана в SPLIT. Один звук при первом
 * появлении заказа в READY/READY_FOR_PICKUP; повторов на следующих тиках нет.
 * `enabled` должен уже учитывать режим (SPLIT), операторский экран и включённый
 * колокольчик — при enabled=false звук молчит, но baseline обновляется, поэтому
 * после включения старый backlog не звучит. Смена restaurantId создаёт новый
 * baseline без озвучивания. Ничего не мутирует, статус заказа не трогает.
 */
export function useOperatorOrderReadySound({
  restaurantId,
  enabled,
  nowMs,
}: {
  restaurantId: string;
  enabled: boolean;
  nowMs: number;
}): void {
  const { state } = usePrototype();
  const stateRef = useRef(state);
  const restaurantIdRef = useRef(restaurantId);
  const enabledRef = useRef(enabled);
  const soundStateRef = useRef(initialReadySoundState());

  useEffect(() => {
    stateRef.current = state;
    restaurantIdRef.current = restaurantId;
    enabledRef.current = enabled;
  }, [state, restaurantId, enabled]);

  // Тик экрана — тот же nowMs, что и у сигнала нового заказа. На каждом тике
  // сравниваем текущий набор готовых с baseline и, при новом готовом, звучим раз.
  useEffect(() => {
    if (nowMs === 0) return;
    const ids = readyOrderIds(stateRef.current.orders, restaurantIdRef.current);
    const { next, play } = reduceReadySound(soundStateRef.current, {
      restaurantId: restaurantIdRef.current,
      enabled: enabledRef.current,
      readyIds: ids,
    });
    soundStateRef.current = next;
    if (play) {
      playOrderReadySound();
    }
  }, [nowMs]);
}
