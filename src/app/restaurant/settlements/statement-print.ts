import type {
  RestaurantStatementView,
  RestaurantStatementViewResult,
} from "../../../prototype/restaurant-statement-view";
import { visibleStatementSnapshot, type StatementSnapshot } from "./statement-snapshot";

/**
 * Чистый UI-state helper печати. Разрешает печать/PDF ТОЛЬКО из зафиксированного
 * успешного snapshot-envelope, видимого в текущем контексте, и возвращает уже
 * готовую печатную модель: presentation-model выписки, зафиксированный момент
 * формирования и часовой пояс snapshot. Печать недоступна (null), если snapshot
 * отсутствует, устарел (сменился restaurantId, timeZone или период
 * startLocalDate/endLocalDate), result не ok или view = null. Не перестраивает
 * выписку, не вызывает statement core / accounting / pricing / Date.now —
 * использует зафиксированный asOfIso из envelope. Та же привязка к snapshot, что
 * и у CSV-экспорта. Ничего не мутирует.
 */
export interface StatementPrintModel {
  view: RestaurantStatementView;
  asOfIso: string;
  timeZone: string;
}

export function buildStatementPrintModel(
  snapshot: StatementSnapshot<RestaurantStatementViewResult> | null,
  restaurantId: string,
  timeZone: string,
  startLocalDate: string,
  endLocalDate: string,
): StatementPrintModel | null {
  const visible = visibleStatementSnapshot(
    snapshot,
    restaurantId,
    timeZone,
    startLocalDate,
    endLocalDate,
  );
  if (!visible) return null;
  const { result, asOfIso } = visible;
  if (!result.ok || !result.view) return null;
  return { view: result.view, asOfIso, timeZone };
}
