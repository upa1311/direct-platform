"use client";

import { useState } from "react";

import { PeriodSelector } from "@/components/analytics/period-selector";
import {
  ANALYTICS_TIME_ZONE,
  DRIVER_STATUS_LABELS,
  analyticsZoneName,
  formatAnalyticsDuration,
  formatDeliveriesPerHour,
  formatResponseTime,
  formatUtilization,
  sumAvailableDurations,
  zoneShare,
} from "@/components/analytics/analytics-presentation";
import { useNowMs } from "@/components/util/use-now";
import { PageHeading } from "@/components/workspaces/route-content";
import { getZoneButtonPresentation } from "@/lib/zones/zone-presentation";
import { getAdminDriverShiftAnalyticsView, type AdminDriverShiftAnalyticsRow, type DriverShiftAnalyticsPeriod } from "@/prototype/driver-shift-analytics";
import { usePrototype } from "@/prototype/prototype-provider";
import { formatMoney } from "@/prototype/selectors";
import styles from "./driver-analytics.module.css";

export default function AdminDriverAnalyticsPage() {
  const { state } = usePrototype();
  const nowMs = useNowMs();
  const [period, setPeriod] = useState<DriverShiftAnalyticsPeriod>("TODAY");
  if (nowMs === 0) return <p className={styles.loading} role="status">Загружаем аналитику водителей…</p>;

  const rows = getAdminDriverShiftAnalyticsView(state, period, new Date(nowMs).toISOString(), ANALYTICS_TIME_ZONE);
  const onlineNow = rows.filter((row) => row.status === "AVAILABLE" || row.status === "BUSY_DIRECT").length;
  const busyNow = rows.filter((row) => row.status === "BUSY_DIRECT").length;
  const totalOnline = sumAvailableDurations(rows.map((row) => row.analytics.onlineDurationMs));
  const completed = rows.reduce((total, row) => total + row.analytics.completedDeliveryCount, 0);

  return (
    <div className={styles.page}>
      <PageHeading eyebrow="Администратор" title="Аналитика водителей" description="Время онлайн, ожидание заказов, доставки и эффективность за выбранный период." />
      <PeriodSelector value={period} onChange={setPeriod} ariaLabel="Период аналитики водителей" />
      <section className={styles.summary} aria-label="Сводка по водителям">
        <SummaryMetric label="Водителей сейчас онлайн" value={String(onlineNow)} />
        <SummaryMetric label="Сейчас выполняют доставку" value={String(busyNow)} />
        <SummaryMetric label="Подтверждённое время онлайн" value={formatAnalyticsDuration(totalOnline)} note={totalOnline === null ? "По доступным данным" : undefined} />
        <SummaryMetric label="Завершено доставок" value={String(completed)} />
      </section>
      <section aria-labelledby="drivers-analytics-list" className={styles.listSection}>
        <h2 id="drivers-analytics-list">Водители</h2>
        <div className={styles.cards}>{rows.map((row) => <DriverAnalyticsCard key={row.driverId} row={row} state={state} />)}</div>
      </section>
    </div>
  );
}

function SummaryMetric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div><span>{label}</span><strong>{value}</strong>{note ? <small>{note}</small> : null}</div>;
}

function DriverAnalyticsCard({ row, state }: { row: AdminDriverShiftAnalyticsRow; state: ReturnType<typeof usePrototype>["state"] }) {
  const view = row.analytics;
  const zoneName = row.currentZoneId === null ? "Без подтверждённой зоны" : analyticsZoneName(state, row.currentZoneId);
  return (
    <article className={styles.card}>
      <header className={styles.cardHeader}>
        <div><h3>{row.driverName}</h3><p>{DRIVER_STATUS_LABELS[row.status]} · {zoneName}</p></div>
        <div className={styles.badges}>{view.coverageIncomplete ? <span>Неполный период</span> : null}{view.reviewRequired ? <strong>Требует проверки</strong> : null}</div>
      </header>
      {row.statusNote ? <p className={styles.statusNote}>{row.statusNote}</p> : null}
      <dl className={styles.primaryMetrics}>
        <Metric label="Онлайн" value={formatAnalyticsDuration(view.onlineDurationMs)} />
        <Metric label="Ждал" value={formatAnalyticsDuration(view.waitingDurationMs)} />
        <Metric label="В доставках" value={formatAnalyticsDuration(view.deliveryDurationMs)} />
        <Metric label="Доставок" value={String(view.completedDeliveryCount)} />
        <Metric label="Загрузка" value={formatUtilization(view.utilizationBps)} />
      </dl>
      <details className={styles.details}>
        <summary>Подробная статистика</summary>
        <dl className={styles.detailMetrics}>
          <Metric label="В смене" value={formatAnalyticsDuration(view.shiftDurationMs)} />
          <Metric label="На паузе" value={formatAnalyticsDuration(view.pausedDurationMs)} muted={view.pausedDurationMs === 0} />
          <Metric label="Подтверждение зоны" value={formatAnalyticsDuration(view.zoneConfirmationDurationMs)} muted={view.zoneConfirmationDurationMs === 0} />
          <Metric label="Заработано" value={view.earnedCents === null ? "—" : formatMoney(view.earnedCents)} />
          <Metric label="Заработок/час" value={view.earningsPerOnlineHourCents === null ? "—" : formatMoney(view.earningsPerOnlineHourCents)} />
          <Metric label="Доставок в час" value={formatDeliveriesPerHour(view.deliveriesPerOnlineHourMilli)} />
          <Metric label="Принято" value={String(view.acceptedOfferCount)} muted={view.acceptedOfferCount === 0} />
          <Metric label="Отклонено" value={String(view.declinedOfferCount)} muted={view.declinedOfferCount === 0} />
          <Metric label="Пропущено" value={String(view.expiredOfferCount)} muted={view.expiredOfferCount === 0} />
          <Metric label="Средний ответ" value={formatResponseTime(view.averageResponseTimeMs)} />
        </dl>
        <h4>Время по зонам</h4>
        <ul className={styles.zones}>
          {view.zoneDurations.map((zone) => <ZoneRow key={zone.zoneId} name={analyticsZoneName(state, zone.zoneId)} duration={zone.durationMs} share={zoneShare(zone.durationMs, view.onlineDurationMs)} color={getZoneButtonPresentation(zone.zoneId)?.backgroundColor} />)}
          {(view.unassignedZoneDurationMs ?? 0) > 0 ? <ZoneRow name="Без подтверждённой зоны" duration={view.unassignedZoneDurationMs as number} share={zoneShare(view.unassignedZoneDurationMs as number, view.onlineDurationMs)} /> : null}
          {view.zoneDurations.length === 0 && view.unassignedZoneDurationMs === 0 ? <li>Активного времени в зонах нет.</li> : null}
        </ul>
      </details>
    </article>
  );
}

function Metric({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return <div className={muted ? styles.mutedMetric : undefined}><dt>{label}</dt><dd>{value}</dd></div>;
}

function ZoneRow({ name, duration, share, color }: { name: string; duration: number; share: string | null; color?: string }) {
  return <li><span className={styles.zoneMarker} style={{ backgroundColor: color ?? "#aeb7b1" }} aria-hidden="true" /><span>{name}</span><strong>{formatAnalyticsDuration(duration)}</strong>{share ? <small>{share}</small> : null}</li>;
}
