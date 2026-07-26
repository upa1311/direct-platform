"use client";

import type { DriverShiftAnalyticsPeriod } from "@/prototype/driver-shift-analytics";
import styles from "./period-selector.module.css";

export const ANALYTICS_PERIODS: readonly { id: DriverShiftAnalyticsPeriod; label: string }[] = [
  { id: "TODAY", label: "Сегодня" },
  { id: "LAST_7_DAYS", label: "7 дней" },
  { id: "CURRENT_MONTH", label: "Месяц" },
  { id: "ALL_TIME", label: "За весь период" },
];

interface PeriodSelectorProps {
  value: DriverShiftAnalyticsPeriod;
  onChange: (period: DriverShiftAnalyticsPeriod) => void;
  ariaLabel: string;
}

export function PeriodSelector({ value, onChange, ariaLabel }: PeriodSelectorProps) {
  return (
    <div className={styles.control} role="group" aria-label={ariaLabel}>
      {ANALYTICS_PERIODS.map((period) => (
        <button
          key={period.id}
          type="button"
          className={period.id === value ? `${styles.button} ${styles.active}` : styles.button}
          aria-pressed={period.id === value}
          onClick={() => onChange(period.id)}
        >
          {period.label}
        </button>
      ))}
    </div>
  );
}
