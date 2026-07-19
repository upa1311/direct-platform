"use client";

import { useEffect, useRef } from "react";

import { playKitchenBeep } from "@/components/workspaces/kitchen-sound";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  initialPreparingSoundState,
  preparingOrderIds,
  reducePreparingSound,
} from "@/components/kitchen/split-kitchen-preparing-sound";

/**
 * Кухонный сигнал о начале приготовления — только для кухонного экрана в SPLIT.
 * Один существующий beep (playKitchenBeep) при первом появлении заказа в PREPARING;
 * повторов во время приготовления нет. `enabled` должен уже учитывать режим
 * (SPLIT), кухонный экран и включённый колокольчик — при enabled=false звук
 * молчит, но baseline обновляется, поэтому после включения старый backlog не
 * звучит. Смена restaurantId создаёт новый baseline без озвучивания. Отдельный
 * аудиофайл не используется: тот же beep, что и у сигнала нового заказа. Ничего
 * не мутирует, статус заказа не трогает.
 */
export function useSplitKitchenPreparingSound({
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
  const soundStateRef = useRef(initialPreparingSoundState());

  useEffect(() => {
    stateRef.current = state;
    restaurantIdRef.current = restaurantId;
    enabledRef.current = enabled;
  }, [state, restaurantId, enabled]);

  // Тот же тик nowMs, что у сигнала нового заказа. На каждом тике сравниваем
  // текущий набор PREPARING с baseline и, при новом PREPARING, звучим один раз.
  useEffect(() => {
    if (nowMs === 0) return;
    const ids = preparingOrderIds(
      stateRef.current.orders,
      restaurantIdRef.current,
    );
    const { next, play } = reducePreparingSound(soundStateRef.current, {
      restaurantId: restaurantIdRef.current,
      enabled: enabledRef.current,
      preparingIds: ids,
    });
    soundStateRef.current = next;
    if (play) {
      playKitchenBeep();
    }
  }, [nowMs]);
}
