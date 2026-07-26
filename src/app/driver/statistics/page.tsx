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
  const { state, isHydrated } = usePrototype();
  const nowMs = useNowMs();
  const [period, setPeriod] = useState<DriverShiftAnalyticsPeriod>("TODAY");

  if (!isHydrated || nowMs === 0) return <p className={styles.loading} role="status">Загружаем статистику…</p>;
  if (driverId === null) {
    return <div className={styles.authNotice} role="status">Войдите в кабинет водителя, чтобы увидеть свою статистику. <Link href="/driver">Перейти ко входу</Link></div>;
  }
  const view = getDriverShiftAnalyticsView(state, driverId, period, new Date(nowMs).toISOString(), ANALYTICS_TIME_ZONE);
  const noOffers = view.acceptedOfferCount === 0 && view.declinedOfferCount === 0 && view.expiredOfferCount === 0 && view.averageResponseTimeMs === null;
  const hasCoverage = view.coverageStartedAt !== null;
  const showPaused = hasCoverage && ((view.pausedDurationMs !== null && view.pausedDurationMs > 0) || (view.pausedDurationMs === null && view.reviewRequired));
  const showZoneConfirmation = hasCoverage && ((view.zoneConfirmationDurationMs !== null && view.zoneConfirmationDurationMs > 0) || (view.zoneConfirmationDurationMs === null && view.reviewRequired));

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Статистика</h1>
        <p>Время онлайн, заказы и эффективность.</p>
      </header>
      <PeriodSelector value={period} onChange={setPeriod} ariaLabel="Период статистики" />

      {!hasCoverage ? (
        <section className={styles.infoCard} role="status"><h2>Учёт времени ещё не начался</h2><p>Статистика начнёт собираться после следующего изменения вашего статуса или зоны.</p></section>
      ) : view.coverageIncomplete ? (
        <section className={styles.coverageNotice} role="status"><strong>Данные за выбранный период неполные</strong><span>Учёт времени ведётся с {formatCoverageStartedAt(view.coverageStartedAt as string)}.</span></section>
      ) : null}
      {view.reviewRequired ? <p className={styles.reviewNotice} role="alert">Некоторые данные требуют проверки Direct.</p> : null}

      {hasCoverage ? <section className={styles.section} aria-labelledby="driver-time-title">
        <h2 id="driver-time-title">Время</h2>
        <div className={styles.metricGrid}>
          <Metric label="В смене" value={formatAnalyticsDuration(view.shiftDurationMs)} />
          <Metric label="Онлайн" value={formatAnalyticsDuration(view.onlineDurationMs)} />
          <Metric label="Ждал заказы" value={formatAnalyticsDuration(view.waitingDurationMs)} />
          <Metric label="Выполнял доставки" value={formatAnalyticsDuration(view.deliveryDurationMs)} />
        </div>
        {(showPaused || showZoneConfirmation) ? (
          <dl className={styles.compactRows}>
            {showPaused ? <DataRow label="На паузе" value={formatAnalyticsDuration(view.pausedDurationMs)} /> : null}
            {showZoneConfirmation ? <DataRow label="Подтверждение зоны" value={formatAnalyticsDuration(view.zoneConfirmationDurationMs)} /> : null}
          </dl>
        ) : null}
      </section> : null}

      <section className={styles.section} aria-labelledby="driver-result-title">
        <h2 id="driver-result-title">Результат</h2>
        <div className={styles.resultGrid}>
          <Metric label="Завершённых доставок" value={String(view.completedDeliveryCount)} />
          <Metric label="Заработано" value={view.earnedCents === null ? "—" : formatMoney(view.earnedCents)} />
          {hasCoverage ? <Metric label="Загрузка" value={formatUtilization(view.utilizationBps)} /> : null}
          {hasCoverage ? <Metric label="Заработок за час онлайн" value={view.earningsPerOnlineHourCents === null ? "—" : formatMoney(view.earningsPerOnlineHourCents)} /> : null}
          {hasCoverage ? <Metric label="Доставок в час" value={formatDeliveriesPerHour(view.deliveriesPerOnlineHourMilli)} suffix="доставки/ч" /> : null}
        </div>
        {hasCoverage ? <p className={styles.explanation}>Загрузка — доля времени доставки среди активного времени онлайн.</p> : null}
      </section>

      <section className={styles.section} aria-labelledby="driver-offers-title">
        <h2 id="driver-offers-title">Предложения заказов</h2>
        {noOffers ? <p className={styles.empty}>{view.reviewRequired ? "Подтверждённых данных о предложениях за период нет." : "За выбранный период предложений не было."}</p> : (
          <dl className={styles.compactRows}><DataRow label="Принято" value={String(view.acceptedOfferCount)} /><DataRow label="Отклонено" value={String(view.declinedOfferCount)} /><DataRow label="Пропущено" value={String(view.expiredOfferCount)} /><DataRow label="Среднее время ответа" value={formatResponseTime(view.averageResponseTimeMs)} /></dl>
        )}
      </section>

      {hasCoverage ? <section className={styles.section} aria-labelledby="driver-zones-title">
        <h2 id="driver-zones-title">Время по зонам</h2>
        {view.onlineDurationMs === null || view.unassignedZoneDurationMs === null ? <p className={styles.empty}>Данные времени по зонам пока недоступны.</p> : view.zoneDurations.length === 0 && view.unassignedZoneDurationMs === 0 ? <p className={styles.empty}>За выбранный период активного времени в зонах нет.</p> : (
          <ul className={styles.zoneList}>
            {view.zoneDurations.map((zone) => {
              const presentation = getZoneButtonPresentation(zone.zoneId);
              return <li key={zone.zoneId}><span className={styles.zoneMarker} style={{ backgroundColor: presentation?.backgroundColor ?? "#aeb7b1" }} aria-hidden="true" /><span>{analyticsZoneName(state, zone.zoneId)}</span><strong>{formatAnalyticsDuration(zone.durationMs)}</strong><small>{zoneShare(zone.durationMs, view.onlineDurationMs)}</small></li>;
            })}
            {view.unassignedZoneDurationMs > 0 ? <li><span className={`${styles.zoneMarker} ${styles.neutralMarker}`} aria-hidden="true" /><span>Без подтверждённой зоны</span><strong>{formatAnalyticsDuration(view.unassignedZoneDurationMs)}</strong></li> : null}
          </ul>
        )}
      </section> : null}
    </div>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return <div className={styles.metric}><span>{label}</span><strong>{value}</strong>{suffix ? <small>{suffix}</small> : null}</div>;
}

function DataRow({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
