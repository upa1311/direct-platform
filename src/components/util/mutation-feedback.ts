import type { AddCartItemResult } from "@/prototype/actions";
import type { MutationAck } from "@/prototype/prototype-store";

/** Запасная русская ошибка, если мутация не вернула собственный текст. */
export const MUTATION_FALLBACK_ERROR =
  "Не удалось сохранить изменение. Обновите страницу и повторите.";

export interface MutationFeedback {
  kind: "success" | "error";
  text: string;
}

/**
 * Исправление 5: единственный способ построить пользовательский feedback по
 * результату мутации. Success-текст возможен ТОЛЬКО при ack.ok === true —
 * «Сохранено» до фактического commit построить нельзя.
 */
export function feedbackFromAck(
  ack: MutationAck,
  successText: string,
): MutationFeedback {
  return ack.ok
    ? { kind: "success", text: successText }
    : { kind: "error", text: ack.error ?? MUTATION_FALLBACK_ERROR };
}

/**
 * Исправление 6: русские сообщения по статусу добавления блюда в корзину.
 * Инфраструктурные статусы не маскируются под недоступное блюдо, и клиенту не
 * предлагается очистить корзину. RESTAURANT_CONFLICT обрабатывается отдельным
 * confirm-диалогом и собственного сообщения не имеет (null).
 */
export function addItemFeedbackMessage(
  result: AddCartItemResult,
): string | null {
  switch (result) {
    case "ADDED":
      return "Блюдо добавлено в корзину.";
    case "NOT_AVAILABLE":
      return "Блюдо сейчас недоступно.";
    case "RESTAURANT_UNAVAILABLE":
      return "Ресторан сейчас не принимает заказы. Выберите другой ресторан или повторите позже.";
    case "SYNC_UNAVAILABLE":
      return "Безопасная синхронизация вкладок недоступна в этом браузере.";
    case "SAVE_FAILED":
      return "Не удалось сохранить изменение. Обновите страницу и повторите.";
    case "RESTAURANT_CONFLICT":
      return null;
  }
}
