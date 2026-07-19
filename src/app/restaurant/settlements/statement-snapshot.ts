/**
 * Snapshot-envelope сформированной выписки: результат жёстко привязан к
 * restaurantId, timeZone И периоду (startLocalDate/endLocalDate), при которых он
 * был построен. Чистая логика видимости не зависит от React и useEffect — данные
 * одного ресторана/пояса/периода не могут «просочиться» под другим контекстом
 * даже на один render. Изменение любой границы периода делает старый snapshot
 * невидимым (stale) до повторного формирования.
 */
export interface StatementSnapshot<R> {
  restaurantId: string;
  timeZone: string;
  /** Локальная дата начала периода, за который построен snapshot. */
  startLocalDate: string;
  /** Локальная дата окончания периода, за который построен snapshot. */
  endLocalDate: string;
  asOfIso: string;
  result: R;
}

/**
 * Возвращает snapshot ТОЛЬКО при точном структурном совпадении restaurantId,
 * timeZone и обеих границ периода с текущим контекстом формы; иначе null (старый
 * результат немедленно невидим). Актуальность определяется строгим сравнением
 * значений, а не текстом, DOM или временем последнего клика.
 */
export function visibleStatementSnapshot<R>(
  snapshot: StatementSnapshot<R> | null,
  restaurantId: string,
  timeZone: string,
  startLocalDate: string,
  endLocalDate: string,
): StatementSnapshot<R> | null {
  if (!snapshot) return null;
  if (
    snapshot.restaurantId !== restaurantId ||
    snapshot.timeZone !== timeZone ||
    snapshot.startLocalDate !== startLocalDate ||
    snapshot.endLocalDate !== endLocalDate
  ) {
    return null;
  }
  return snapshot;
}
