import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  canConfirmSettlement,
  describeSettlementNet,
  formatSettlementSuccess,
  openEntryIds,
  pluralObligations,
  reconcileSelection,
  selectionCheckboxLabel,
  settlementConfirmLabel,
  settlementHistoryLabel,
  toSettlementHistoryRows,
} from "./settlement-selection.ts";
import type { AdminAccountingRow } from "../../../prototype/restaurant-accounting.ts";
import type { RestaurantSettlementRecord } from "../../../prototype/models.ts";

/**
 * Чистая логика выбора и презентации группового расчёта + контракты страницы
 * и provider (JSX/React в node:test не исполняются — разметка проверяется по
 * исходникам, как в остальных страничных тестах проекта).
 */

const PAGE = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const PROVIDER = readFileSync(
  new URL("../../../prototype/prototype-provider.tsx", import.meta.url),
  "utf8",
);

function row(
  entryId: string,
  overrides: Partial<AdminAccountingRow> = {},
): AdminAccountingRow {
  return {
    entryId,
    publicNumber: `D-${entryId}`,
    recognizedAt: "2026-07-19T10:00:00.000Z",
    settledAt: null,
    direction: "RESTAURANT_OWES_DIRECT",
    type: "PLATFORM_COMMISSION",
    amountCents: 1500,
    currencyCode: "USD",
    status: "OPEN",
    source: "ORDER_FINANCIAL_SNAPSHOT",
    hasOrder: true,
    restaurantName: "Ресторан 1",
    canSettle: true,
    canWaive: true,
    resolution: null,
    ...overrides,
  };
}

// --- Выбор обязательств -----------------------------------------------------------

test("выбирать можно только открытые обязательства", () => {
  const rows = [
    row("a"),
    row("b", { status: "SETTLED", settledAt: "2026-07-19T12:00:00.000Z" }),
    row("c", { status: "WAIVED", settledAt: "2026-07-19T12:00:00.000Z" }),
    row("d"),
  ];
  assert.deepEqual(openEntryIds(rows), ["a", "d"]);
  // Закрытые id вычищаются из выбора автоматически.
  assert.deepEqual(reconcileSelection(["a", "b", "c", "d"], rows), ["a", "d"]);
  // Исчезнувшее обязательство (другой ресторан/удалено) тоже уходит.
  assert.deepEqual(reconcileSelection(["a", "нет"], rows), ["a"]);
  assert.deepEqual(reconcileSelection([], rows), []);
});

test("подпись чекбокса называет заказ и сумму", () => {
  assert.equal(
    selectionCheckboxLabel(row("a"), "$15.00"),
    "Выбрать обязательство заказа D-a на $15.00",
  );
  // Старое начисление без номера заказа.
  assert.equal(
    selectionCheckboxLabel(row("b", { publicNumber: null }), "$8.00"),
    "Выбрать обязательство заказа старого начисления на $8.00",
  );
});

// --- Презентация итога ------------------------------------------------------------

test("тексты итога и кнопки берутся из готового направления", () => {
  const payable = describeSettlementNet("DIRECT_OWES_RESTAURANT");
  assert.equal(payable.title, "Direct должен выплатить ресторану");
  assert.ok(/не выполняет банковский перевод автоматически/.test(payable.warning));
  assert.equal(
    settlementConfirmLabel("DIRECT_OWES_RESTAURANT"),
    "Подтвердить выплату ресторану",
  );

  const receivable = describeSettlementNet("RESTAURANT_OWES_DIRECT");
  assert.equal(receivable.title, "Ресторан должен выплатить Direct");
  assert.equal(
    settlementConfirmLabel("RESTAURANT_OWES_DIRECT"),
    "Подтвердить оплату Direct",
  );

  const balanced = describeSettlementNet("BALANCED");
  assert.equal(balanced.title, "Взаимозачёт без дополнительного платежа");
  assert.equal(
    balanced.warning,
    "Будет зафиксирован взаимозачёт равных обязательств.",
  );
  assert.equal(settlementConfirmLabel("BALANCED"), "Подтвердить взаимозачёт");

  // История — прошедшее время, без сырых enum.
  assert.equal(
    settlementHistoryLabel("DIRECT_OWES_RESTAURANT"),
    "Direct выплатил ресторану",
  );
  assert.equal(
    settlementHistoryLabel("RESTAURANT_OWES_DIRECT"),
    "Ресторан оплатил Direct",
  );
  assert.equal(settlementHistoryLabel("BALANCED"), "Взаимозачёт");
});

test("склонение обязательств и текст успеха", () => {
  assert.equal(pluralObligations(1), "обязательство");
  assert.equal(pluralObligations(2), "обязательства");
  assert.equal(pluralObligations(5), "обязательств");
  assert.equal(pluralObligations(11), "обязательств");
  assert.equal(pluralObligations(21), "обязательство");

  // v14: сообщение дополняется способом, фактической суммой и остатком.
  assert.equal(
    formatSettlementSuccess(
      {
        netDirection: "DIRECT_OWES_RESTAURANT",
        netAmountCents: 4300,
        entryCount: 2,
        method: "BANK_TRANSFER",
        transferredAmountCents: 4300,
        remainingOpenEntryCount: 0,
        remainingNetDirection: "BALANCED",
        remainingNetAmountCents: 0,
      },
      "$43.00",
      "$0.00",
    ),
    "Direct выплатил ресторану: $43.00. Способ: Банковский перевод. Закрыто 2 обязательства. Открытая позиция закрыта полностью.",
  );
  assert.equal(
    formatSettlementSuccess(
      {
        netDirection: "BALANCED",
        netAmountCents: 0,
        entryCount: 1,
        method: "NETTING",
        transferredAmountCents: 0,
        remainingOpenEntryCount: 1,
        remainingNetDirection: "RESTAURANT_OWES_DIRECT",
        remainingNetAmountCents: 500,
      },
      "$0.00",
      "$5.00",
    ),
    "Зафиксирован взаимозачёт равных обязательств. Способ: Взаимозачёт. Закрыто 1 обязательство. Остаток: Ресторан оплатил Direct — $5.00, осталось 1 обязательство.",
  );
});

// --- Правила подтверждения ---------------------------------------------------------

test("подтверждение требует выбора, валидного preview, основания и ссылки при net > 0", () => {
  const base = {
    hasSelection: true,
    previewOk: true,
    netDirection: "DIRECT_OWES_RESTAURANT" as const,
    netAmountCents: 4300,
    method: "BANK_TRANSFER" as const,
    amountInput: "43.00",
    note: "Оплата",
    reference: "bank-1",
    pending: false,
  };
  assert.equal(canConfirmSettlement(base), true);
  // Нет выбора / нет preview / идёт мутация.
  assert.equal(canConfirmSettlement({ ...base, hasSelection: false }), false);
  assert.equal(canConfirmSettlement({ ...base, previewOk: false }), false);
  assert.equal(canConfirmSettlement({ ...base, pending: true }), false);
  // Основание обязательно всегда.
  assert.equal(canConfirmSettlement({ ...base, note: "   " }), false);
  // Ссылка обязательна при ненулевом итоге.
  assert.equal(canConfirmSettlement({ ...base, reference: "  " }), false);
  // BALANCED допускается без ссылки — но только взаимозачётом.
  assert.equal(
    canConfirmSettlement({
      ...base,
      netDirection: "BALANCED",
      netAmountCents: 0,
      method: "NETTING",
      amountInput: "",
      reference: "",
    }),
    true,
  );
});

// --- История расчётов ---------------------------------------------------------------

test("история берёт готовые суммы записи и не выводит внутренние id", () => {
  const record: RestaurantSettlementRecord = {
    id: "settlement-record-1",
    restaurantId: "restaurant-1",
    currencyCode: "USD",
    accountingEntryIds: ["c1", "p1"],
    restaurantOwesDirectCents: 800,
    directOwesRestaurantCents: 5100,
    netDirection: "DIRECT_OWES_RESTAURANT",
    netAmountCents: 4300,
    settledAt: "2026-07-20T12:00:00.000Z",
    actor: "ADMIN",
    note: "Перевод",
    externalReference: "bank-777",
    execution: {
      dataStatus: "COMPLETE",
      method: "BANK_TRANSFER",
      transferredAmountCents: 4300,
      remainingOpenEntryCount: 0,
      remainingRestaurantOwesDirectCents: 0,
      remainingDirectOwesRestaurantCents: 0,
      remainingNetDirection: "BALANCED",
      remainingNetAmountCents: 0,
    },
    selection: { scope: "SELECTED_ENTRIES" },
  };
  const rows = toSettlementHistoryRows([record]);
  assert.equal(rows.length, 1);
  const view = rows[0];
  // Только количество обязательств, без самих идентификаторов.
  assert.equal(view.entryCount, 2);
  assert.ok(!("accountingEntryIds" in view));
  // Суммы и направление скопированы как есть, ничего не пересчитано.
  assert.equal(view.restaurantOwesDirectCents, 800);
  assert.equal(view.directOwesRestaurantCents, 5100);
  assert.equal(view.netDirection, "DIRECT_OWES_RESTAURANT");
  assert.equal(view.netAmountCents, 4300);
  assert.equal(view.note, "Перевод");
  assert.equal(view.externalReference, "bank-777");
});

// --- Контракты provider ---------------------------------------------------------------

test("provider: confirmSettlement под serialized lock с одним nowIso", () => {
  assert.ok(PROVIDER.includes("confirmSettlement: ("));
  assert.ok(PROVIDER.includes("const confirmSettlement = useCallback("));
  // Один канонический момент на всю транзакцию.
  // v15: рядом появился confirmFullSettlement — срез ограничивается им.
  const body = PROVIDER.slice(
    PROVIDER.indexOf("const confirmSettlement = useCallback("),
    PROVIDER.indexOf("const confirmFullSettlement = useCallback("),
  );
  assert.equal(body.split("new Date().toISOString()").length - 1, 1);
  assert.ok(body.includes("runSerializedActionMutation({"));
  assert.ok(body.includes("confirmRestaurantSettlement("));
  // v14: объектный вход домена, момент операции добавляется провайдером.
  assert.ok(body.includes("{ ...input, nowIso }"));
  // Инфраструктурная ошибка не выдаёт id расчёта.
  assert.ok(body.includes("settlementRecordId: null"));

  // v15: полный расчёт — отдельный callback, отсечка создаётся ВНУТРИ мутации.
  const fullBody = PROVIDER.slice(
    PROVIDER.indexOf("const confirmFullSettlement = useCallback("),
    PROVIDER.indexOf("const requestRestaurantCancellation"),
  );
  assert.ok(fullBody.includes("confirmFullRestaurantSettlement(baseState, {"));
  assert.ok(fullBody.includes("cutoffAt: new Date().toISOString()"));
  assert.equal(fullBody.split("new Date().toISOString()").length - 1, 1);
});

// --- Контракты страницы ---------------------------------------------------------------

test("страница строит preview доменной функцией и не считает net сама", () => {
  assert.ok(PAGE.includes("buildRestaurantSettlementPreview("));
  assert.ok(PAGE.includes("previewOk.netAmountCents"));
  assert.ok(PAGE.includes("settlementConfirmLabel(previewOk.netDirection)"));
  // Никакой финансовой арифметики в React.
  assert.ok(!PAGE.includes("directOwesRestaurantCents -"));
  assert.ok(!PAGE.includes("restaurantOwesDirectCents -"));
  assert.ok(!PAGE.includes(".reduce("));
  // Preview не строится на пустом выборе.
  assert.ok(PAGE.includes("if (effectiveSelectedIds.length === 0"));
});

test("страница чистит выбор при смене ресторана и ухода с «Открытых»", () => {
  assert.ok(PAGE.includes("const selectRestaurant = (id: string) => {"));
  assert.ok(PAGE.includes("const changeStatusFilter = (next: StatusFilter) => {"));
  assert.ok(PAGE.includes('if (next !== "OPEN") {'));
  // Согласование выбора со свежим состоянием — производно.
  assert.ok(PAGE.includes("reconcileSelection(selectedEntryIds, allRows)"));
});

test("успех показывается только после ok и очищает форму", () => {
  assert.ok(PAGE.includes("if (res.ok) {"));
  assert.ok(PAGE.includes("setSettlementSuccess({"));
  assert.ok(PAGE.includes("setSelectedEntryIds([]);"));
  assert.ok(PAGE.includes('setSettlementNote("");'));
  assert.ok(PAGE.includes('setSettlementReference("");'));
  assert.ok(PAGE.includes("Расчёт подтверждён"));
  assert.ok(PAGE.includes('aria-live="polite"'));
});

test("одиночный SETTLED удалён, WAIVED оставлен только для canWaive", () => {
  // Из строки больше нельзя закрыть обязательство как исполненное.
  assert.ok(!PAGE.includes('submit("SETTLED")'));
  assert.ok(!PAGE.includes("Подтвердить исполнение"));
  assert.ok(!PAGE.includes("Зафиксировать расчёт"));
  // Списание осталось и гейтится доменным правом (payout списать нельзя).
  assert.ok(PAGE.includes("submitWaive()"));
  // Единственный исход одиночного действия строки — WAIVED.
  assert.ok(/resolveAccountingEntry\(\s*row\.entryId,\s*"WAIVED",/.test(PAGE));
  assert.ok(!/resolveAccountingEntry\(\s*row\.entryId,\s*"SETTLED"/.test(PAGE));
  assert.ok(!PAGE.includes("outcome,"));
  assert.ok(PAGE.includes("row.canWaive && !open"));
  assert.ok(PAGE.includes('row.status === "OPEN" && row.canWaive && open'));
});

test("история и hydration-гейт используют канонические источники", () => {
  assert.ok(PAGE.includes("getRestaurantSettlementRecords(state, activeRestaurantId)"));
  assert.ok(PAGE.includes("toSettlementHistoryRows("));
  assert.ok(PAGE.includes("Подтверждённых групповых расчётов пока нет."));
  assert.ok(PAGE.includes("Количество обязательств: {record.entryCount}"));
  // Внутренние id обязательств пользователю не показываются.
  assert.ok(!PAGE.includes("record.accountingEntryIds"));
  assert.ok(PAGE.includes("{!isHydrated ? ("));
  assert.ok(PAGE.includes("Загружаем расчёты…"));
  assert.ok(PAGE.includes("Рестораны не найдены."));
});

test("мобильная вёрстка: preview и форма без горизонтального overflow", () => {
  const css = readFileSync(
    new URL("./admin-settlements.module.css", import.meta.url),
    "utf8",
  );
  const preview = css.slice(
    css.indexOf(".settlementPreview {"),
    css.indexOf(".settlementNet {"),
  );
  assert.ok(preview.includes("auto-fit"));
  const form = css.slice(
    css.indexOf(".settlementForm {"),
    css.indexOf(".historyList {"),
  );
  assert.ok(form.includes("auto-fit"));
  const panel = css.slice(
    css.indexOf(".settlementPanel {"),
    css.indexOf(".settlementSelectionRow {"),
  );
  assert.ok(panel.includes("min-width: 0"));
});
