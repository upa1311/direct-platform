"use client";

import { useEffect, useRef } from "react";

import { usePrototype } from "@/prototype/prototype-provider";

/**
 * Невидимый runtime актуализации предложений водителей. Смонтирован в layout
 * кабинета, поэтому работает на всех маршрутах `/driver/*`.
 *
 * Обязанности: после гидратации и при каждом изменении состояния выполнить
 * доменный reconciliation (создать/истечь/отменить предложения) и держать ОДИН
 * таймер на ближайшее истечение, чтобы вовремя закрыть просроченное. Секундного
 * сохранения состояния здесь нет: countdown обновляется на странице локально, а
 * PrototypeState меняется только когда есть что менять (reconciliation
 * идемпотентен и не наращивает revision вхолостую, поэтому бесконечного цикла
 * ревизий не возникает).
 */
export function DriverOfferRuntime() {
  const { state, isHydrated, refreshDriverOffers } = usePrototype();
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isHydrated) return;

    // Актуализируем сразу: создаём новые предложения, закрываем невалидные.
    void refreshDriverOffers();

    // Ближайшее истечение среди открытых предложений — единственный таймер.
    const now = Date.now();
    let nearest = Infinity;
    for (const offer of state.driverOffers) {
      if (offer.status !== "OPEN") continue;
      const expiry = Date.parse(offer.expiresAt);
      if (expiry > now && expiry < nearest) nearest = expiry;
    }

    if (nearest !== Infinity) {
      // +50 мс, чтобы к моменту reconciliation срок уже точно истёк.
      const delay = Math.max(0, nearest - now + 50);
      timerRef.current = window.setTimeout(() => {
        void refreshDriverOffers();
      }, delay);
    }

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // Перезапуск при каждом изменении состояния: reconciliation-no-op не меняет
    // revision, поэтому цикла нет.
  }, [isHydrated, state.revision, state.driverOffers, refreshDriverOffers]);

  return null;
}
