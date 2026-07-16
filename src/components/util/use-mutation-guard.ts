"use client";

import { useCallback, useState } from "react";

import type { MutationAck } from "@/prototype/prototype-store";
import { MUTATION_FALLBACK_ERROR } from "./mutation-feedback";

/**
 * Исправление 7: общий guard пользовательских мутаций. Ожидает Promise-ack,
 * ведёт pending и показывает русскую ошибку вместо молчаливого fire-and-forget.
 * Подтверждённый общий state остаётся источником истины — компонент ничего не
 * рисует «успешным» заранее, а при ошибке отображает баннер.
 */
export function useMutationGuard(): {
  error: string | null;
  pending: boolean;
  run: (ack: Promise<MutationAck>) => Promise<MutationAck>;
  clearError: () => void;
} {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (ack: Promise<MutationAck>): Promise<MutationAck> => {
      setPending(true);
      try {
        const result = await ack;
        setError(result.ok ? null : (result.error ?? MUTATION_FALLBACK_ERROR));
        return result;
      } finally {
        setPending(false);
      }
    },
    [],
  );

  const clearError = useCallback(() => setError(null), []);

  return { error, pending, run, clearError };
}
