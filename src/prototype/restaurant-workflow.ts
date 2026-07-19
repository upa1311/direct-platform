import type {
  RestaurantOrderWorkflowMode,
  RestaurantWorkspaceAction,
  RestaurantWorkspaceData,
  RestaurantWorkspaceRole,
} from "./models";

/**
 * Чистая матрица прав ресторанной workspace (Этап 3). Без React, localStorage и
 * мутаций — пригодна и для backend. Работает fail-closed: неизвестная/отсутствующая
 * роль в SPLIT блокирует действие и скрывает приватные данные.
 *
 * Инвариант: режим не создаёт второй заказ и не меняет жизненный цикл — он лишь
 * определяет, какая роль что может сделать и что видит.
 */

/**
 * Действия кухни в SPLIT: только уже принятый заказ — приготовление и время.
 * Решение по новому заказу (принять/отклонить и начальное время) кухне не
 * принадлежит: непринятый заказ до неё вообще не доходит.
 */
const KITCHEN_ACTIONS: ReadonlySet<RestaurantWorkspaceAction> = new Set([
  "ADJUST_ETA",
  // Подтверждение начала приготовления — действие только кухни (SPLIT). Оператор
  // за кухню его выполнить не может; сама доменная операция дополнительно требует
  // режим SPLIT, поэтому в COMBINED (где роль резолвится в «COMBINED») она не
  // применяется, даже что матрица общего экрана формально его допускает.
  "START_KITCHEN_PREPARATION",
  "MARK_READY",
  "REPORT_PREPARATION_PROBLEM",
  "PAUSE_RESTAURANT",
  "CHANGE_MENU_AVAILABILITY",
]);

/**
 * Действия оператора в SPLIT: решение по новому заказу (приём и начальное
 * время), клиент, оплата, водитель, выдача. Отклонение проходит через
 * MANAGE_CANCELLATION — отдельного reject-действия в матрице нет.
 */
const OPERATOR_ACTIONS: ReadonlySet<RestaurantWorkspaceAction> = new Set([
  "ACCEPT_ORDER",
  "SET_INITIAL_ETA",
  // Проблему приготовления сообщает кухня, а подтверждает её решение оператор
  // (в COMBINED — тот же общий экран через объединение наборов ниже).
  "RESOLVE_PREPARATION_PROBLEM",
  "MANAGE_CUSTOMER",
  "MANAGE_CANCELLATION",
  "MANAGE_DRIVER",
  "HANDOFF_ORDER",
]);

/** Данные, доступные кухне (приватное клиента/финансы/выдача — скрыты). */
const KITCHEN_VISIBLE: ReadonlySet<RestaurantWorkspaceData> = new Set([
  "ORDER_NUMBER",
  "FULFILLMENT",
  "ORDER_ITEMS",
  "COOKING_COMMENTS",
  "PAYMENT_STATUS",
  "EXPECTED_READY_AT",
  "ETA_ADJUSTMENTS",
  "PREPARATION_PROBLEMS",
]);

/**
 * Резолвит эффективную рабочую роль. В COMBINED любой вызов (в т.ч. старый без
 * роли) → «COMBINED». В SPLIT требуется явная OPERATOR/KITCHEN; иначе null
 * (fail-closed — действие будет заблокировано).
 */
export function resolveRestaurantWorkspaceRole(
  workflowMode: RestaurantOrderWorkflowMode,
  requestedRole?: RestaurantWorkspaceRole | null,
): RestaurantWorkspaceRole | null {
  if (workflowMode === "COMBINED") {
    return "COMBINED";
  }
  if (requestedRole === "OPERATOR" || requestedRole === "KITCHEN") {
    return requestedRole;
  }
  return null;
}

/** Может ли роль выполнить действие в данном режиме (fail-closed). */
export function canRestaurantWorkspacePerformAction({
  workflowMode,
  workspaceRole,
  action,
}: {
  workflowMode: RestaurantOrderWorkflowMode;
  workspaceRole?: RestaurantWorkspaceRole | null;
  action: RestaurantWorkspaceAction;
}): boolean {
  const role = resolveRestaurantWorkspaceRole(workflowMode, workspaceRole);
  if (role === null) return false;
  if (role === "COMBINED") {
    // Общий экран выполняет все ресторанные действия lifecycle.
    return KITCHEN_ACTIONS.has(action) || OPERATOR_ACTIONS.has(action);
  }
  if (role === "KITCHEN") return KITCHEN_ACTIONS.has(action);
  return OPERATOR_ACTIONS.has(action);
}

/**
 * Может ли роль видеть категорию данных (fail-closed). FINANCIAL_BREAKDOWN —
 * внутренние комиссии/выплаты Direct — недоступен любой ресторанной роли
 * (только admin/управляющий на отдельном экране).
 */
export function canRestaurantWorkspaceViewData({
  workflowMode,
  workspaceRole,
  data,
}: {
  workflowMode: RestaurantOrderWorkflowMode;
  workspaceRole?: RestaurantWorkspaceRole | null;
  data: RestaurantWorkspaceData;
}): boolean {
  const role = resolveRestaurantWorkspaceRole(workflowMode, workspaceRole);
  if (role === null) return false;
  if (data === "FINANCIAL_BREAKDOWN") return false;
  if (role === "KITCHEN") return KITCHEN_VISIBLE.has(data);
  // COMBINED и OPERATOR видят всё, кроме финансового breakdown.
  return true;
}
