"use client";

import { ChevronDown } from "lucide-react";

import type { Restaurant, RestaurantWorkspaceRole } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import { getRestaurantMenu } from "@/prototype/selectors";
import { MenuAvailabilitySection } from "./kitchen-operations";
import {
  getMenuAvailabilitySummary,
  type MenuAvailabilityTone,
} from "./menu-availability-summary";
import styles from "./kitchen.module.css";

/**
 * Компактная строка «Меню · статус» внизу рабочего экрана заказов. Закрыта по
 * умолчанию; раскрывается в существующий MenuAvailabilitySection — второй
 * реализации управления меню нет.
 *
 * Один компонент на все ресторанные экраны: общий (COMBINED), кухня и оператор в
 * SPLIT. Роль приходит снаружи и передаётся в доменные действия, поэтому в
 * аудите остаётся реальная роль, а не жёстко зашитая KITCHEN.
 */

/** Визуальное состояние задаётся машинным tone, а не разбором русского текста. */
const MENU_TONE_CLASS: Record<MenuAvailabilityTone, string> = {
  EMPTY: "",
  OK: styles.menuToneOk,
  PARTIAL: styles.menuTonePartial,
  ALL_UNAVAILABLE: styles.menuToneDown,
};

export function RestaurantMenuAvailabilityPanel({
  restaurant,
  nowMs,
  workspaceRole,
}: {
  restaurant: Restaurant;
  nowMs: number;
  workspaceRole: RestaurantWorkspaceRole;
}) {
  const { state } = usePrototype();
  // Живой статус: считается от того же тика nowMs, поэтому отключение,
  // восстановление и истечение временной паузы видны сразу.
  const summary = getMenuAvailabilitySummary(
    getRestaurantMenu(state, restaurant.id),
    nowMs,
  );

  return (
    <details className={styles.menuPanel}>
      <summary className={styles.menuSummary}>
        <span className={styles.menuSummaryTitle}>Меню</span>
        <span className={`${styles.menuStatus} ${MENU_TONE_CLASS[summary.tone]}`}>
          <span className={styles.menuStatusDot} aria-hidden="true" />
          {summary.text}
        </span>
        <ChevronDown className={styles.menuChevron} size={18} aria-hidden="true" />
      </summary>
      <MenuAvailabilitySection
        restaurant={restaurant}
        nowMs={nowMs}
        workspaceRole={workspaceRole}
        embedded
      />
    </details>
  );
}
