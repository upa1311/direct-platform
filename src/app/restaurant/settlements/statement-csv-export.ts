import {
  serializeRestaurantStatementCsv,
  type RestaurantStatementCsvFile,
} from "../../../prototype/restaurant-statement-csv";
import type { RestaurantStatementViewResult } from "../../../prototype/restaurant-statement-view";
import { visibleStatementSnapshot, type StatementSnapshot } from "./statement-snapshot";

/**
 * Чистый UI-state helper: даёт CSV-файл ТОЛЬКО из зафиксированного успешного
 * snapshot-envelope, видимого в текущем контексте. Экспорт недоступен (null),
 * если snapshot отсутствует, устарел (сменился restaurantId, timeZone или период
 * startLocalDate/endLocalDate), result не ok или view = null. Не перестраивает
 * выписку и не берёт новый Date.now — использует зафиксированный asOfIso из
 * envelope. Ничего не мутирует.
 */
export function buildStatementCsvExport(
  snapshot: StatementSnapshot<RestaurantStatementViewResult> | null,
  restaurantId: string,
  timeZone: string,
  startLocalDate: string,
  endLocalDate: string,
): RestaurantStatementCsvFile | null {
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
  return serializeRestaurantStatementCsv(result.view, asOfIso, timeZone);
}
