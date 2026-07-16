"use client";

import { useCallback, useRef, useState } from "react";

import type { MutationAck } from "@/prototype/prototype-store";
import {
  createMutationGuardCore,
  type MutationGuardCore,
} from "./mutation-guard-core";

/**
 * Этап 6 (восстановление): общий guard пользовательских мутаций с thunk-API.
 * Guard принимает НЕ запущенный Promise, а операцию `() => Promise<MutationAck>`
 * — иначе мутация стартует до проверки pending и защита начала операции не
 * работает. Синхронный pending-флаг живёт в ядре (см. mutation-guard-core):
 * React state не защищает от двух кликов в одном tick. Rejected Promise
 * превращается в русский ack, а не в unhandled rejection.
 */
export function useMutationGuard(): {
  error: string | null;
  pending: boolean;
  run: (operation: () => Promise<MutationAck>) => Promise<MutationAck>;
  clearError: () => void;
} {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const coreRef = useRef<MutationGuardCore | null>(null);
  if (coreRef.current === null) {
    coreRef.current = createMutationGuardCore({
      onPending: setPending,
      onError: setError,
    });
  }
  const core = coreRef.current;

  const run = useCallback(
    (operation: () => Promise<MutationAck>) => core.run(operation),
    [core],
  );

  const clearError = useCallback(() => setError(null), []);

  return { error, pending, run, clearError };
}
