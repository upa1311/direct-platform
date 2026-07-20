"use client";

import { ChevronDown, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import type { Restaurant, RestaurantWorkspaceRole } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import { getRestaurantMenu } from "@/prototype/selectors";
import { dishBuilderNewHref } from "@/components/menu/dish-builder-form";
import { RestaurantMenuCatalogActions } from "@/components/menu/restaurant-menu-catalog-actions";
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
 * аудите остаётся реальная роль, а не жёстко зашитая KITCHEN. Та же роль
 * сохраняется как навигационный контекст конструктора нового блюда (Plus и
 * кнопки внутри панели) — оператор остаётся оператором, кухня кухней.
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
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  // Живой статус: считается от того же тика nowMs, поэтому отключение,
  // восстановление и истечение временной паузы видны сразу.
  const summary = getMenuAvailabilitySummary(
    getRestaurantMenu(state, restaurant.id),
    nowMs,
  );

  // Возврат из конструктора «← Назад к меню» ведёт на #menu: панель
  // раскрывается автоматически, чтобы пользователь оказался там, откуда ушёл.
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.location.hash === "#menu" &&
      detailsRef.current
    ) {
      detailsRef.current.open = true;
    }
  }, []);

  return (
    <details className={styles.menuPanel} id="menu" ref={detailsRef}>
      <summary className={styles.menuSummary}>
        <span className={styles.menuSummaryTitle}>Меню</span>
        <span className={`${styles.menuStatus} ${MENU_TONE_CLASS[summary.tone]}`}>
          <span className={styles.menuStatusDot} aria-hidden="true" />
          {summary.text}
        </span>
        <button
          className={styles.menuAddButton}
          type="button"
          aria-label="Добавить новое блюдо"
          title="Добавить новое блюдо"
          onClick={(event) => {
            // Plus не раскрывает и не закрывает <details> — только открывает
            // отдельную страницу конструктора с сохранением рабочей роли.
            event.preventDefault();
            event.stopPropagation();
            router.push(dishBuilderNewHref(workspaceRole));
          }}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <ChevronDown className={styles.menuChevron} size={18} aria-hidden="true" />
      </summary>
      <RestaurantMenuCatalogActions
        workspaceRole={workspaceRole}
        variant="COMPACT"
      />
      <MenuAvailabilitySection
        restaurant={restaurant}
        nowMs={nowMs}
        workspaceRole={workspaceRole}
        embedded
      />
    </details>
  );
}
