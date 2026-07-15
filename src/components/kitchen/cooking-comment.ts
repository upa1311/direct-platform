/**
 * Чистый помощник для отображения комментария клиента к позиции на кухне.
 * Возвращает обрезанный по краям текст, если после trim он непустой, иначе null
 * (блок не показывается). Внутреннее содержимое пользователя не изменяется —
 * только убираются ведущие/замыкающие пробелы для показа. Не мутирует вход.
 */
export function getVisibleCookingComment(
  comment: string | null | undefined,
): string | null {
  if (typeof comment !== "string") return null;
  const trimmed = comment.trim();
  return trimmed.length > 0 ? trimmed : null;
}
