"use client";

import { useEffect, useRef } from "react";

import { playKitchenBeep } from "@/components/workspaces/kitchen-sound";
import { usePrototype } from "@/prototype/prototype-provider";
import { isKitchenBeepDue } from "@/prototype/selectors";
import {
  KITCHEN_START_REPEAT_INTERVAL_MS,
  preparingAwaitingKitchenStartIds,
} from "@/components/kitchen/split-kitchen-preparing-sound";

/**
 * Кухонный сигнал ожидания подтверждения начала приготовления — только для
 * кухонного экрана в SPLIT. Пока заказ находится в PREPARING и кухня не нажала
 * «Начать готовить» (kitchenStartedAt === null), тот же существующий
 * playKitchenBeep повторяется каждые KITCHEN_START_REPEAT_INTERVAL_MS: первый
 * сигнал звучит сразу, затем каждые 20 секунд, пока не подтверждено начало.
 *
 * Расписание — единое централизованное через nowMs-тик и общий isKitchenBeepDue
 * (тот же планировщик, что у сигнала нового заказа), без setInterval на карточку.
 * `enabled` уже учитывает режим (SPLIT), кухонный экран и включённый колокольчик:
 * при enabled=false сигнала нет; когда ожидающих заказов не остаётся, расписание
 * сбрасывается, поэтому следующий кандидат снова звучит сразу, а повторное
 * включение колокольчика не создаёт второго таймера. Ничего не мутирует, статус
 * заказа не трогает.
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
  const lastBeepRef = useRef<number | null>(null);
  const announcedRef = useRef<string[]>([]);

  useEffect(() => {
    stateRef.current = state;
    restaurantIdRef.current = restaurantId;
    enabledRef.current = enabled;
  }, [state, restaurantId, enabled]);

  // Единый тик nowMs. На каждом тике считаем набор ожидающих подтверждения кухни
  // заказов и через общий планировщик решаем, нужен ли сигнал.
  useEffect(() => {
    if (nowMs === 0) return;
    const waitingIds = preparingAwaitingKitchenStartIds(
      stateRef.current.orders,
      restaurantIdRef.current,
    );
    if (waitingIds.length === 0) {
      // Нет ожидающих — сбрасываем расписание для мгновенного сигнала следующего.
      lastBeepRef.current = null;
      announcedRef.current = [];
      return;
    }
    if (!enabledRef.current) return;
    const due = isKitchenBeepDue({
      reviewOrderIds: waitingIds,
      announcedOrderIds: announcedRef.current,
      lastBeepAtMs: lastBeepRef.current,
      nowMs,
      intervalMs: KITCHEN_START_REPEAT_INTERVAL_MS,
    });
    if (due) {
      playKitchenBeep();
      lastBeepRef.current = nowMs;
      announcedRef.current = [...waitingIds];
    }
  }, [nowMs]);
}
