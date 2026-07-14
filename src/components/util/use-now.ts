"use client";

import { useEffect, useState } from "react";

/**
 * Тикающая клиентская отметка времени (мс). 0 до гидрации, затем реальное
 * время, обновляемое раз в секунду. Позволяет считать операционную доступность
 * (паузы ресторана/блюд) во время рендера без прямого вызова Date.now().
 */
export function useNowMs(intervalMs = 1000): number {
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    // Инициализация клиентских часов после гидрации (SSR-safe), затем тик.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}
