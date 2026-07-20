"use client";

import Link from "next/link";

import type { RestaurantWorkspaceRole } from "@/prototype/models";
import {
  dishBuilderNewHref,
  dishSubmissionsHref,
} from "@/components/menu/dish-builder-form";
import styles from "@/components/kitchen/kitchen.module.css";

/**
 * Единые действия каталога блюд: «Добавить новое блюдо» и «Мои заявки».
 * ОДИН источник ссылок и подписей для обоих мест показа: раскрытой панели
 * «Меню · статус» на рабочих экранах (COMPACT) и полноэкранной страницы
 * «Меню и доступность» (PAGE). Href и роль не дублируются вручную — оба
 * варианта используют dishBuilderNewHref/dishSubmissionsHref с реальной
 * workspaceRole.
 */
export function RestaurantMenuCatalogActions({
  workspaceRole,
  variant,
}: {
  workspaceRole: RestaurantWorkspaceRole;
  variant: "COMPACT" | "PAGE";
}) {
  return (
    <div
      className={
        variant === "PAGE" ? styles.menuPageActions : styles.menuPanelActions
      }
    >
      <Link
        className={styles.menuPanelAddLink}
        href={dishBuilderNewHref(workspaceRole)}
      >
        Добавить новое блюдо
      </Link>
      <Link
        className={styles.menuPanelSubmissionsLink}
        href={dishSubmissionsHref(workspaceRole)}
      >
        Мои заявки
      </Link>
    </div>
  );
}
