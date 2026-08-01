import type { CashTenderIntent } from "./models";

/**
 * Отпечаток наличного намерения клиента (v31). Единственный источник fingerprint
 * для compare-and-set сохранения, сверки вкладок и подтверждения записи. Живёт в
 * pure prototype-ядре (без зависимости от `src/components`), чтобы domain/provider
 * могли выполнять CAS без UI-слоя. UI/editor импортируют helper отсюда.
 *
 *   NULL | EXACT | CHANGE_FROM:<cents>
 *
 * Разные суммы CHANGE_FROM различимы; null и оба режима не пересекаются.
 */
export function cashTenderIntentKey(intent: CashTenderIntent): string {
  if (intent === null) return "NULL";
  return intent.mode === "EXACT" ? "EXACT" : `CHANGE_FROM:${intent.tenderCents}`;
}
