// Чистая логика корректировки ожидаемого времени готовности заказа (Кухня 3).
//
// Вынесено из pricing-engine, чтобы там осталась только pricing/finance/
// delivery-quote логика. Без зависимостей от React и состояния прототипа.

/** Минимум будущего ETA: не раньше чем через минуту от текущего момента. */
export const ETA_MIN_AHEAD_MS = 60_000;
/** Максимум будущего ETA: не дальше 180 минут от текущего момента. */
export const ETA_MAX_AHEAD_MS = 180 * 60_000;
/** Максимальная длина причины после trim. */
export const ETA_REASON_MAX_LENGTH = 300;

/**
 * Типизированное намерение изменения ETA (§1). UI хранит именно намерение, а не
 * готовый ISO — конкретное время вычисляется один раз при submit из общего
 * nowIso, чтобы preview и domain-validation использовали одну временную точку.
 */
export type EtaAdjustmentIntent =
  | { kind: "DELAY"; minutes: number }
  | { kind: "EARLIER"; minutes: number }
  | { kind: "FROM_NOW"; minutes: number };

/**
 * Новое ETA при задержке: прибавляет минуты к БАЗЕ, где база — максимум из
 * текущего expectedReadyAt и now (если ETA уже в прошлом). Чистая функция.
 */
export function computeDelayedEtaIso(
  currentExpectedReadyAt: string,
  addMinutes: number,
  nowIso: string,
): string {
  const base = Math.max(
    Date.parse(currentExpectedReadyAt),
    Date.parse(nowIso),
  );
  return new Date(base + addMinutes * 60_000).toISOString();
}

/** Новое ETA при более ранней готовности: вычитает минуты из текущего ETA. */
export function computeEarlierEtaIso(
  currentExpectedReadyAt: string,
  subtractMinutes: number,
): string {
  return new Date(
    Date.parse(currentExpectedReadyAt) - subtractMinutes * 60_000,
  ).toISOString();
}

/** ETA «через N минут от текущего момента». */
export function computeEtaFromNowIso(
  nowIso: string,
  minutesFromNow: number,
): string {
  return new Date(Date.parse(nowIso) + minutesFromNow * 60_000).toISOString();
}

/**
 * Вычисляет конкретное ETA из намерения на общей временной точке nowIso (§1).
 * Один вызов — один nowIso и для расчёта, и (в domain) для валидации.
 */
export function computeEtaFromIntent(
  intent: EtaAdjustmentIntent,
  currentExpectedReadyAt: string,
  nowIso: string,
): string {
  switch (intent.kind) {
    case "DELAY":
      return computeDelayedEtaIso(currentExpectedReadyAt, intent.minutes, nowIso);
    case "EARLIER":
      return computeEarlierEtaIso(currentExpectedReadyAt, intent.minutes);
    case "FROM_NOW":
      return computeEtaFromNowIso(nowIso, intent.minutes);
  }
}

/** Разница в минутах между новым и старым ETA (>0 задержка, <0 раньше). */
export function computeEtaDeltaMinutes(
  previousIso: string,
  nextIso: string,
): number {
  return Math.round((Date.parse(nextIso) - Date.parse(previousIso)) / 60_000);
}

/**
 * Валидация кандидата ETA относительно now (§3 п.6–8). Возвращает текст ошибки
 * или null. Единый источник границ и для domain-action, и для UI-предпроверки.
 */
export function validateEtaCandidate(
  candidateIso: string,
  nowIso: string,
): string | null {
  const candidateMs = Date.parse(candidateIso);
  if (Number.isNaN(candidateMs)) {
    return "Некорректная дата.";
  }
  const nowMs = Date.parse(nowIso);
  if (candidateMs <= nowMs) {
    return "Новое время должно быть в будущем.";
  }
  if (candidateMs < nowMs + ETA_MIN_AHEAD_MS) {
    return "Новое время должно быть не раньше чем через минуту.";
  }
  if (candidateMs > nowMs + ETA_MAX_AHEAD_MS) {
    return "Новое время не может быть позже чем через 180 минут.";
  }
  return null;
}
