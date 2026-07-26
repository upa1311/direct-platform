"use client";

import Link from "next/link";
import { useState } from "react";

import { useAuthenticatedDriverId } from "@/components/driver/driver-session";
import { useNowMs } from "@/components/util/use-now";
import { PeriodSelector } from "@/components/analytics/period-selector";
import {
  ANALYTICS_TIME_ZONE,
  analyticsZoneName,
  formatAnalyticsDuration,
  formatCoverageStartedAt,
  formatDeliveriesPerHour,
  formatResponseTime,
  formatUtilization,
  zoneShare,
} from "@/components/analytics/analytics-presentation";
import { getZoneButtonPresentation } from "@/lib/zones/zone-presentation";
import { getDriverShiftAnalyticsView, type DriverShiftAnalyticsPeriod } from "@/prototype/driver-shift-analytics";
import { usePrototype } from "@/prototype/prototype-provider";
import { formatMoney } from "@/prototype/selectors";
import styles from "./statistics.module.css";

export default function DriverStatisticsPage() {
  const driverId = useAuthenticatedDriverId();
  const { state } = usePrototype();
  const nowMs = useNowMs();
  const [period, setPeriod] = useState<DriverShiftAnalyticsPeriod>("TODAY");

  if (driverId === null) {
    return <div className={styles.authNotice} role="status">Войдите в кабинет водителя, чтобы увидеть свою статистику. <Link href="/driver">Перейти ко входу</Link></div>;
  }
  if (nowMs === 0) return <p className={styles.loading} role="status">Загружаем статистику…</p>;

  const view = getDriverShiftAnalyticsView(state, driverId, period, new Date(nowMs).toISOString(), ANALYTICS_TIME_ZONE);
  const noOffers = view.acceptedOfferCount === 0 && view.declinedOfferCount === 0 && view.expiredOfferCount === 0 && view.averageResponseTimeMs === null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Статистика</h1>
        <p>Время онлайн, заказы и эффективность.</p>
      </header>
      <PeriodSelector value={period} onChange={setPeriod} ariaLabel="Период статистики" />

      {view.coverageStartedAt === null ? (
        <section className={styles.infoCard} role="status"><h2>Учёт времени ещё не начался</h2><p>Статистика начнёт собираться после следующего изменения вашего статуса или зоны.</p></section>
      ) : view.coverageIncomplete ? (
        <section className={styles.coverageNotice} role="status"><strong>Данные за выбранный период неполные</strong><span>Учёт времени ведётся с {formatCoverageStartedAt(view.coverageStartedAt)}.</span></section>
      ) : null}
      {view.reviewRequired ? <p className={styles.reviewNotice} role="alert">Некоторые данные требуют проверки Direct.</p> : null}

      <section className={styles.section} aria-labelledby="driver-time-title">
        <h2 id="driver-time-title">Время</h2>
        <div className={styles.metricGrid}>
          <Metric label="В смене" value={formatAnalyticsDuration(view.shiftDurationMs)} />
          <Metric label="Онлайн" value={formatAnalyticsDuration(view.onlineDurationMs)} />
          <Metric label="Ждал заказы" value={formatAnalyticsDuration(view.waitingDurationMs)} />
          <Metric label="Выполнял доставки" value={formatAnalyticsDuration(view.deliveryDurationMs)} />
        </div>
        {(view.pausedDurationMs !== 0 || view.zoneConfirmationDurationMs !== 0) ? (
          <dl className={styles.compactRows}>
            {view.pausedDurationMs !== 0 ? <DataRow label="На паузе" value={formatAnalyticsDuration(view.pausedDurationMs)} /> : null}
            {view.zoneConfirmationDurationMs !== 0 ? <DataRow label="Подтверждение зоны" value={formatAnalyticsDuration(view.zoneConfirmationDurationMs)} /> : null}
          </dl>
        ) : null}
      </section>

      <section className={styles.section} aria-labelledby="driver-result-title">
        <h2 id="driver-result-title">Результат</h2>
        <div className={styles.resultGrid}>
          <Metric label="Завершённых доставок" value={String(view.completedDeliveryCount)} />
          <Metric label="Заработано" value={view.earnedCents === null ? "—" : formatMoney(view.earnedCents)} />
          <Metric label="Загрузка" value={formatUtilization(view.utilizationBps)} />
          <Metric label="Заработок за час онлайн" value={view.earningsPerOnlineHourCents === null ? "—" : formatMoney(view.earningsPerOnlineHourCents)} />
          <Metric label="Доставок в час" value={formatDeliveriesPerHour(view.deliveriesPerOnlineHourMilli)} suffix="доставки/ч" />
        </div>
        <p className={styles.explanation}>Загрузка — доля времени доставки среди активного времени онлайн.</p>
      </section>

      <section className={styles.section} aria-labelledby="driver-offers-title">
        <h2 id="driver-offers-title">Предложения заказов</h2>
        {noOffers ? <p className={styles.empty}>За выбранный период предложений не было.</p> : (
          <dl className={styles.compactRows}><DataRow label="Принято" value={String(view.acceptedOfferCount)} /><DataRow label="Отклонено" value={String(view.declinedOfferCount)} /><DataRow label="Пропущено" value={String(view.expiredOfferCount)} /><DataRow label="Среднее время ответа" value={formatResponseTime(view.averageResponseTimeMs)} /></dl>
        )}
      </section>

      <section className={styles.section} aria-labelledby="driver-zones-title">
        <h2 id="driver-zones-title">Время по зонам</h2>
        {view.zoneDurations.length === 0 && view.unassignedZoneDurationMs === 0 ? <p className={styles.empty}>За выбранный период активного времени в зонах нет.</p> : (
          <ul className={styles.zoneList}>
            {view.zoneDurations.map((zone) => {
              const presentation = getZoneButtonPresentation(zone.zoneId);
              return <li key={zone.zoneId}><span className={styles.zoneMarker} style={{ backgroundColor: presentation?.backgroundColor ?? "#aeb7b1" }} aria-hidden="true" /><span>{analyticsZoneName(state, zone.zoneId)}</span><strong>{formatAnalyticsDuration(zone.durationMs)}</strong><small>{zoneShare(zone.durationMs, view.onlineDurationMs)}</small></li>;
            })}
            {(view.unassignedZoneDurationMs ?? 0) > 0 ? <li><span className={`${styles.zoneMarker} ${styles.neutralMarker}`} aria-hidden="true" /><span>Без подтверждённой зоны</span><strong>{formatAnalyticsDuration(view.unassignedZoneDurationMs)}</strong></li> : null}
          </ul>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return <div className={styles.metric}><span>{label}</span><strong>{value}</strong>{suffix ? <small>{suffix}</small> : null}</div>;
}

function DataRow({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
