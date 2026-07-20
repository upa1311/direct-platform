"use client";

import type { RestaurantWorkspaceRole } from "@/prototype/models";

/**
 * Навигационная подсказка рабочего экрана для раздела «Меню и доступность».
 * Только sessionStorage и только контекст навигации: OPERATOR/KITCHEN/COMBINED
 * запоминаются при работе в соответствующем кабинете, чтобы переход по общей
 * ссылке «Меню и доступность» сохранял реальную роль. Никакие права из этой
 * подсказки не выводятся — домен проверяет MANAGE_MENU_CATALOG на каждом
 * действии; повреждённое значение просто игнорируется резолвером.
 */
const MENU_WORKSPACE_ROLE_KEY = "direct-menu-workspace-role";

/** Запоминает рабочий экран как навигационный контекст меню. */
export function rememberMenuWorkspaceRole(role: RestaurantWorkspaceRole): void {
  try {
    sessionStorage.setItem(MENU_WORKSPACE_ROLE_KEY, role);
  } catch {
    // Недоступный sessionStorage не ломает работу: просто нет подсказки.
  }
}

/** Сырая подсказка (валидируется резолвером, не здесь). */
export function readMenuWorkspaceRoleHint(): unknown {
  try {
    return sessionStorage.getItem(MENU_WORKSPACE_ROLE_KEY);
  } catch {
    return null;
  }
}
