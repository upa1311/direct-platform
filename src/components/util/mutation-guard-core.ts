import type { MutationAck } from "@/prototype/prototype-store";
import { MUTATION_FALLBACK_ERROR } from "./mutation-feedback";

/** Русский отказ второй операции, запущенной во время pending. */
export const MUTATION_ALREADY_RUNNING_ERROR = "Действие уже выполняется.";

export interface MutationGuardCore {
  run: (operation: () => Promise<MutationAck>) => Promise<MutationAck>;
  isPending: () => boolean;
}

/**
 * Этап 6 (восстановление): чистое ядро mutation guard — то же, что использует
 * hook useMutationGuard, но без React (проверяется node:test). Семантика:
 * 1) операция передаётся thunk'ом и НЕ вызывается, пока guard занят —
 *    защищено синхронным флагом (два клика одного tick запускают одну операцию);
 * 2) rejected Promise превращается в русский MutationAck, не в unhandled
 *    rejection;
 * 3) pending/error сообщаются через callbacks (в hook — setState).
 */
export function createMutationGuardCore({
  onPending,
  onError,
}: {
  onPending: (pending: boolean) => void;
  onError: (error: string | null) => void;
}): MutationGuardCore {
  let pending = false;

  const run = async (
    operation: () => Promise<MutationAck>,
  ): Promise<MutationAck> => {
    if (pending) {
      // Thunk НЕ вызывается: вторая операция даже не стартует.
      return {
        ok: false,
        error: MUTATION_ALREADY_RUNNING_ERROR,
        changed: false,
      };
    }
    pending = true;
    onPending(true);
    try {
      const result = await operation();
      onError(result.ok ? null : (result.error ?? MUTATION_FALLBACK_ERROR));
      return result;
    } catch {
      const result: MutationAck = {
        ok: false,
        error: MUTATION_FALLBACK_ERROR,
        changed: false,
      };
      onError(result.error);
      return result;
    } finally {
      pending = false;
      onPending(false);
    }
  };

  return { run, isPending: () => pending };
}
