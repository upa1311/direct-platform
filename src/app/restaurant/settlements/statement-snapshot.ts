/**
 * Snapshot-envelope сформированной выписки: результат жёстко привязан к
 * restaurantId и timeZone, при которых он был построен. Чистая логика видимости
 * не зависит от React и useEffect — гарантирует, что данные одного ресторана не
 * могут «просочиться» под другим рестораном/поясом даже на один render.
 */
export interface StatementSnapshot<R> {
  restaurantId: string;
  timeZone: string;
  asOfIso: string;
  result: R;
}

/**
 * Возвращает snapshot ТОЛЬКО при точном совпадении restaurantId и timeZone с
 * текущим контекстом; иначе null (старый результат немедленно невидим).
 */
export function visibleStatementSnapshot<R>(
  snapshot: StatementSnapshot<R> | null,
  restaurantId: string,
  timeZone: string,
): StatementSnapshot<R> | null {
  if (!snapshot) return null;
  if (
    snapshot.restaurantId !== restaurantId ||
    snapshot.timeZone !== timeZone
  ) {
    return null;
  }
  return snapshot;
}
