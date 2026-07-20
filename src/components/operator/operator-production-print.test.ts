import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { canPrintOperatorProductionTicket } from "./operator-production-print.ts";
import type {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from "../../prototype/models.ts";

/**
 * Момент печати производственного листа у SPLIT-оператора: принятие ничего не
 * печатает, лист появляется отдельным действием, когда заказ реально готовится.
 * Разметка проверяется контрактно по исходникам — JSX в node:test не исполняется.
 */

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

const OPERATOR_PAGE = readSource("../../app/restaurant/operator/page.tsx");
const KITCHEN_PAGE = readSource("../../app/restaurant/kitchen/page.tsx");

function order(
  status: OrderStatus,
  paymentMethod: PaymentMethod,
  paymentStatus: PaymentStatus,
): Order {
  return { id: "o1", status, paymentMethod, paymentStatus } as unknown as Order;
}

// 5/6/7 — ONLINE ---------------------------------------------------------------

test("ONLINE + AWAITING_PAYMENT: печати нет", () => {
  assert.equal(
    canPrintOperatorProductionTicket(
      order("AWAITING_PAYMENT", "ONLINE", "AWAITING_PAYMENT"),
    ),
    false,
  );
});

test("ONLINE + PREPARING + PAID: печать доступна", () => {
  assert.equal(
    canPrintOperatorProductionTicket(order("PREPARING", "ONLINE", "PAID")),
    true,
  );
});

test("ONLINE + PREPARING без PAID: fail-closed", () => {
  for (const paymentStatus of [
    "NOT_STARTED",
    "AWAITING_PAYMENT",
    "CASH_ON_DELIVERY",
    "DUE_AT_PICKUP",
  ] as const) {
    assert.equal(
      canPrintOperatorProductionTicket(
        order("PREPARING", "ONLINE", paymentStatus),
      ),
      false,
      paymentStatus,
    );
  }
});

// 8/9 — оплата не онлайн --------------------------------------------------------

test("PAY_AT_RESTAURANT + PREPARING: печать сразу после принятия", () => {
  assert.equal(
    canPrintOperatorProductionTicket(
      order("PREPARING", "PAY_AT_RESTAURANT", "DUE_AT_PICKUP"),
    ),
    true,
  );
});

test("CASH_TO_RESTAURANT_COURIER + PREPARING: печать сразу после принятия", () => {
  assert.equal(
    canPrintOperatorProductionTicket(
      order("PREPARING", "CASH_TO_RESTAURANT_COURIER", "DUE_TO_RESTAURANT_COURIER"),
    ),
    true,
  );
});

// 2/10/11 — статусы и неизвестный способ ----------------------------------------

test("до принятия печати нет", () => {
  assert.equal(
    canPrintOperatorProductionTicket(
      order("RESTAURANT_REVIEW", "PAY_AT_RESTAURANT", "DUE_AT_PICKUP"),
    ),
    false,
  );
});

test("после готовности производственного листа больше нет", () => {
  for (const status of ["READY", "READY_FOR_PICKUP", "PICKED_UP", "DELIVERED", "CANCELED"] as const) {
    assert.equal(
      canPrintOperatorProductionTicket(
        order(status, "PAY_AT_RESTAURANT", "DUE_AT_PICKUP"),
      ),
      false,
      status,
    );
  }
});

test("неизвестный способ оплаты — fail-closed", () => {
  assert.equal(
    canPrintOperatorProductionTicket(
      order("PREPARING", "CASH" as PaymentMethod, "CASH_ON_DELIVERY"),
    ),
    false,
  );
});

test("решение принимается только по каноническому заказу", () => {
  const source = readSource("./operator-production-print.ts");
  for (const forbidden of ["document", "useState", "history", "Date.now", "window"]) {
    assert.ok(!source.includes(forbidden), `helper не использует ${forbidden}`);
  }
});

// 1/3 — у нового заказа печати нет ----------------------------------------------

test("в OperatorAcceptPanel нет «Принять и распечатать» и doAcceptAndPrint", () => {
  const start = OPERATOR_PAGE.indexOf("function OperatorAcceptPanel");
  const end = OPERATOR_PAGE.indexOf("\nfunction ", start + 1);
  const panel = OPERATOR_PAGE.slice(start, end === -1 ? OPERATOR_PAGE.length : end);
  assert.ok(!panel.includes("Принять и распечатать"));
  assert.ok(!panel.includes("doAcceptAndPrint"));
  assert.ok(!panel.includes("onRequestPrint"), "панель не получает печать");
  // Принять и отклонить остаются.
  assert.ok(panel.includes('"Принять"'));
  assert.ok(panel.includes("<OperatorRejectPanel"));
  // Принятие не печатает ни при успехе, ни при ошибке.
  assert.ok(!panel.includes("requestPrint"));
});

test("во всём операторском экране нет «Принять и распечатать»", () => {
  assert.ok(!OPERATOR_PAGE.includes("Принять и распечатать"));
  assert.ok(!OPERATOR_PAGE.includes("doAcceptAndPrint"));
});

// 12 — кнопка печати после принятия ---------------------------------------------

test("кнопка «Распечатать заказ» гейтится helper и зовёт существующий requestPrint", () => {
  assert.ok(OPERATOR_PAGE.includes("canPrintOperatorProductionTicket(order)"));
  assert.ok(OPERATOR_PAGE.includes("Распечатать заказ"));
  assert.ok(OPERATOR_PAGE.includes("onRequestPrint(order.id)"));
  // Второй print-hook и второй portal не создаются.
  assert.equal(
    OPERATOR_PAGE.split("useKitchenProductionTicketPrint").length - 1,
    2,
    "один импорт и один вызов существующего хука",
  );
});

// 7/11 — пакетная наклейка не тронута -------------------------------------------

test("пакетная наклейка осталась отдельным документом с прежними правами", () => {
  assert.ok(
    OPERATOR_PAGE.includes('<OperatorPackageLabelPrintButton order={order} workspaceRole="OPERATOR" />'),
  );
  // В PREPARING её не переносили: видимостью по-прежнему управляет свой helper.
  assert.ok(!OPERATOR_PAGE.includes("canPrintOperatorPackageLabel"));
});

// 14 — COMBINED не изменён --------------------------------------------------------

test("COMBINED-экран сохранил «Принять и распечатать»", () => {
  assert.ok(KITCHEN_PAGE.includes("Принять и распечатать"));
  assert.ok(KITCHEN_PAGE.includes("doAcceptAndPrint"));
  // И не получил операторский helper.
  assert.ok(!KITCHEN_PAGE.includes("canPrintOperatorProductionTicket"));
});
