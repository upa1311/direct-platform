import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canRestaurantWorkspacePerformAction,
  canRestaurantWorkspaceViewData,
  resolveRestaurantWorkspaceRole,
} from "./restaurant-workflow.ts";

const can = (workflowMode: "COMBINED" | "SPLIT_OPERATOR_KITCHEN", workspaceRole: "COMBINED" | "OPERATOR" | "KITCHEN" | null, action: Parameters<typeof canRestaurantWorkspacePerformAction>[0]["action"]) =>
  canRestaurantWorkspacePerformAction({ workflowMode, workspaceRole, action });

const view = (workflowMode: "COMBINED" | "SPLIT_OPERATOR_KITCHEN", workspaceRole: "COMBINED" | "OPERATOR" | "KITCHEN" | null, data: Parameters<typeof canRestaurantWorkspaceViewData>[0]["data"]) =>
  canRestaurantWorkspaceViewData({ workflowMode, workspaceRole, data });

// --- resolve роли -----------------------------------------------------------

test("COMBINED: старый вызов без роли резолвится в COMBINED", () => {
  assert.equal(resolveRestaurantWorkspaceRole("COMBINED", null), "COMBINED");
  assert.equal(resolveRestaurantWorkspaceRole("COMBINED", undefined), "COMBINED");
});

test("SPLIT без роли → null (fail-closed)", () => {
  assert.equal(resolveRestaurantWorkspaceRole("SPLIT_OPERATOR_KITCHEN", null), null);
  assert.equal(resolveRestaurantWorkspaceRole("SPLIT_OPERATOR_KITCHEN", undefined), null);
});

test("SPLIT с явной ролью → эта роль", () => {
  assert.equal(resolveRestaurantWorkspaceRole("SPLIT_OPERATOR_KITCHEN", "KITCHEN"), "KITCHEN");
  assert.equal(resolveRestaurantWorkspaceRole("SPLIT_OPERATOR_KITCHEN", "OPERATOR"), "OPERATOR");
});

// --- COMBINED действия ------------------------------------------------------

test("COMBINED разрешает все ресторанные действия", () => {
  for (const a of ["ACCEPT_ORDER", "SET_INITIAL_ETA", "ADJUST_ETA", "MARK_READY", "REPORT_PREPARATION_PROBLEM", "RESOLVE_PREPARATION_PROBLEM", "MANAGE_CUSTOMER", "MANAGE_CANCELLATION", "MANAGE_DRIVER", "HANDOFF_ORDER", "PAUSE_RESTAURANT", "CHANGE_MENU_AVAILABILITY"] as const) {
    assert.equal(can("COMBINED", null, a), true, a);
  }
});

// --- SPLIT KITCHEN действия -------------------------------------------------

test("SPLIT KITCHEN: приготовление и время разрешены", () => {
  for (const a of ["ADJUST_ETA", "MARK_READY", "REPORT_PREPARATION_PROBLEM", "PAUSE_RESTAURANT", "CHANGE_MENU_AVAILABILITY"] as const) {
    assert.equal(can("SPLIT_OPERATOR_KITCHEN", "KITCHEN", a), true, a);
  }
});

test("SPLIT KITCHEN: решение по новому заказу запрещено", () => {
  // Непринятый заказ до кухни не доходит: приём и начальное время — у оператора.
  for (const a of ["ACCEPT_ORDER", "SET_INITIAL_ETA"] as const) {
    assert.equal(can("SPLIT_OPERATOR_KITCHEN", "KITCHEN", a), false, a);
  }
});

test("SPLIT KITCHEN: клиент/отмена/водитель/выдача запрещены", () => {
  for (const a of ["MANAGE_CUSTOMER", "MANAGE_CANCELLATION", "MANAGE_DRIVER", "HANDOFF_ORDER"] as const) {
    assert.equal(can("SPLIT_OPERATOR_KITCHEN", "KITCHEN", a), false, a);
  }
});

test("SPLIT: кухня сообщает о проблеме, а решает её оператор", () => {
  // Кухня может сообщить, но не подтвердить решение.
  assert.equal(can("SPLIT_OPERATOR_KITCHEN", "KITCHEN", "REPORT_PREPARATION_PROBLEM"), true);
  assert.equal(can("SPLIT_OPERATOR_KITCHEN", "KITCHEN", "RESOLVE_PREPARATION_PROBLEM"), false);
  // Оператор подтверждает решение, но не сообщает о проблеме.
  assert.equal(can("SPLIT_OPERATOR_KITCHEN", "OPERATOR", "RESOLVE_PREPARATION_PROBLEM"), true);
  assert.equal(can("SPLIT_OPERATOR_KITCHEN", "OPERATOR", "REPORT_PREPARATION_PROBLEM"), false);
});

// --- SPLIT OPERATOR действия ------------------------------------------------

test("SPLIT OPERATOR: клиент/отмена/водитель/выдача разрешены", () => {
  for (const a of ["MANAGE_CUSTOMER", "MANAGE_CANCELLATION", "MANAGE_DRIVER", "HANDOFF_ORDER"] as const) {
    assert.equal(can("SPLIT_OPERATOR_KITCHEN", "OPERATOR", a), true, a);
  }
});

test("SPLIT OPERATOR: решение по новому заказу и начальное время разрешены", () => {
  for (const a of ["ACCEPT_ORDER", "SET_INITIAL_ETA"] as const) {
    assert.equal(can("SPLIT_OPERATOR_KITCHEN", "OPERATOR", a), true, a);
  }
});

test("SPLIT OPERATOR: приготовление и готовность запрещены", () => {
  // Готовит кухня: оператор не меняет ETA, не сообщает о проблеме, не готовит и
  // не подтверждает начало приготовления. Меню сюда НЕ входит — им управляют все
  // три ресторанные роли.
  for (const a of [
    "ADJUST_ETA",
    "MARK_READY",
    "START_KITCHEN_PREPARATION",
    "REPORT_PREPARATION_PROBLEM",
    "PAUSE_RESTAURANT",
  ] as const) {
    assert.equal(can("SPLIT_OPERATOR_KITCHEN", "OPERATOR", a), false, a);
  }
});

test("меню ведут все три ресторанные роли", () => {
  // Доступность блюд и каталог заявок доступны COMBINED, кухне и оператору.
  for (const a of ["CHANGE_MENU_AVAILABILITY", "MANAGE_MENU_CATALOG"] as const) {
    assert.equal(can("COMBINED", "COMBINED", a), true, `COMBINED ${a}`);
    assert.equal(can("SPLIT_OPERATOR_KITCHEN", "KITCHEN", a), true, `KITCHEN ${a}`);
    assert.equal(can("SPLIT_OPERATOR_KITCHEN", "OPERATOR", a), true, `OPERATOR ${a}`);
    // Без явной роли в SPLIT — по-прежнему fail-closed.
    assert.equal(can("SPLIT_OPERATOR_KITCHEN", null, a), false, `null ${a}`);
  }
});

test("SPLIT без роли блокирует любое действие", () => {
  assert.equal(can("SPLIT_OPERATOR_KITCHEN", null, "ACCEPT_ORDER"), false);
  assert.equal(can("SPLIT_OPERATOR_KITCHEN", null, "HANDOFF_ORDER"), false);
});

// --- Видимость данных -------------------------------------------------------

test("KITCHEN не видит телефон, адрес, финансы, pickup-выдачу, водителя", () => {
  for (const d of ["CUSTOMER_PHONE", "FULL_ADDRESS", "FINANCIAL_BREAKDOWN", "PICKUP_HANDOFF", "DRIVER_DETAILS", "CUSTOMER_NAME"] as const) {
    assert.equal(view("SPLIT_OPERATOR_KITCHEN", "KITCHEN", d), false, d);
  }
});

test("KITCHEN видит состав, комментарии, оплату (без breakdown), ETA", () => {
  for (const d of ["ORDER_NUMBER", "FULFILLMENT", "ORDER_ITEMS", "COOKING_COMMENTS", "PAYMENT_STATUS", "EXPECTED_READY_AT", "ETA_ADJUSTMENTS", "PREPARATION_PROBLEMS"] as const) {
    assert.equal(view("SPLIT_OPERATOR_KITCHEN", "KITCHEN", d), true, d);
  }
});

test("OPERATOR видит клиента/телефон/адрес/водителя/выдачу, но не финансы", () => {
  for (const d of ["CUSTOMER_NAME", "CUSTOMER_PHONE", "FULL_ADDRESS", "DRIVER_DETAILS", "PICKUP_HANDOFF", "PAYMENT_STATUS"] as const) {
    assert.equal(view("SPLIT_OPERATOR_KITCHEN", "OPERATOR", d), true, d);
  }
  assert.equal(view("SPLIT_OPERATOR_KITCHEN", "OPERATOR", "FINANCIAL_BREAKDOWN"), false);
});

test("Финансовый breakdown скрыт от всех ресторанных ролей", () => {
  assert.equal(view("COMBINED", "COMBINED", "FINANCIAL_BREAKDOWN"), false);
  assert.equal(view("SPLIT_OPERATOR_KITCHEN", "OPERATOR", "FINANCIAL_BREAKDOWN"), false);
  assert.equal(view("SPLIT_OPERATOR_KITCHEN", "KITCHEN", "FINANCIAL_BREAKDOWN"), false);
});

test("SPLIT без роли не видит приватные данные (fail-closed)", () => {
  assert.equal(view("SPLIT_OPERATOR_KITCHEN", null, "ORDER_NUMBER"), false);
  assert.equal(view("SPLIT_OPERATOR_KITCHEN", null, "CUSTOMER_PHONE"), false);
});

test("COMBINED видит всё, кроме финансового breakdown", () => {
  for (const d of ["ORDER_NUMBER", "CUSTOMER_PHONE", "FULL_ADDRESS", "PICKUP_HANDOFF", "DRIVER_DETAILS"] as const) {
    assert.equal(view("COMBINED", null, d), true, d);
  }
});
