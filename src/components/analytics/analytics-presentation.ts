import type { DriverStatus, PrototypeState, ZoneId } from "../../prototype/models";
import { getZoneName } from "../../prototype/selectors";

export const ANALYTICS_TIME_ZONE = "Europe/Chisinau";

export function formatAnalyticsDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs === 0) return "0 мин";
  if (durationMs < 60_000) return "< 1 мин";
  const totalMinutes = Math.floor(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} мин`;
  return minutes === 0 ? `${hours} ч` : `${hours} ч ${minutes} мин`;
}

export function formatResponseTime(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs < 1_000) return "< 1 сек";
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} сек`;
  return seconds === 0 ? `${minutes} мин` : `${minutes} мин ${seconds} сек`;
}

export function formatUtilization(valueBps: number | null): string {
  if (valueBps === null) return "—";
  const value = valueBps / 100;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

export function formatDeliveriesPerHour(valueMilli: number | null): string {
  if (valueMilli === null) return "—";
  const value = valueMilli / 1_000;
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

export function formatCoverageStartedAt(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: ANALYTICS_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export const DRIVER_STATUS_LABELS: Record<DriverStatus, string> = {
  OFFLINE: "Не в сети",
  AVAILABLE: "Онлайн — ждёт заказ",
  BUSY_DIRECT: "Выполняет доставку",
  PAUSED: "На паузе",
  ZONE_CONFIRMATION_REQUIRED: "Подтверждает зону",
};

export function analyticsZoneName(state: PrototypeState, zoneId: ZoneId): string {
  return getZoneName(state, zoneId);
}

export function zoneShare(durationMs: number, onlineDurationMs: number | null): string | null {
  if (onlineDurationMs === null || onlineDurationMs <= 0) return null;
  return formatUtilization(Math.round((durationMs * 10_000) / onlineDurationMs));
}

export function sumAvailableDurations(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  let total = 0;
  for (const value of values) {
    const next = total + (value as number);
    if (!Number.isSafeInteger(next)) return null;
    total = next;
  }
  return total;
}
