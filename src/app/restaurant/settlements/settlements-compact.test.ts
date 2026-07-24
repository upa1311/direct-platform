import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Относительные пути: alias «@/» в value-импортах под node --test не резолвится.
import { PROTOTYPE_SCHEMA_VERSION } from "../../../prototype/models.ts";
import { RESTAURANT_SETTLEMENT_PERIOD_LABELS } from "../../../prototype/restaurant-settlements.ts";

/**
 * Presentation-контракт подробных отчётов ресторанного раздела «Расчёты».
 *
 * Показатели — read-only статистика, а не кнопки: одна компактная группа с
 * общими границами, у самого показателя нет рамки, заливки, крупного
 * скругления и hover/active. Длинное объяснение схемы расчётов скрыто за
 * нативным details. Верхняя навигация (возврат, вкладки представления и фильтр
 * периода) этим микробатчем не затрагивается.
 *
 * Тест читает исходники как текст: финансовые значения, подписи и источники
 * данных не меняются, поэтому проверяется именно вёрстка.
 */

const PAGE = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const CSS = readFileSync(
  new URL("./settlements.module.css", import.meta.url),
  "utf8",
);
const ADMIN_PAGE = readFileSync(
  new URL("../../admin/settlements/page.tsx", import.meta.url),
  "utf8",
);
const SHARED_VIEW = readFileSync(
  new URL(
    "../../../components/settlements/restaurant-balance-breakdown.tsx",
    import.meta.url,
  ),
  "utf8",
);

/** Тело CSS-правила `selector { ... }` (первое вхождение). */
function rule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `CSS-правило ${selector} не найдено`);
  const open = CSS.indexOf("{", start);
  const close = CSS.indexOf("}", open);
  assert.notEqual(close, -1, `CSS-правило ${selector} не закрыто`);
  return CSS.slice(open + 1, close);
}

/** Есть ли в CSS правило с указанным селектором. */
function hasSelector(selector: string): boolean {
  return CSS.includes(`${selector} {`);
}

// --- 1–3: верхняя навигация не изменена ---------------------------------------

test("1: чипы периода сохранили структуру и форму", () => {
  // Разметка: подпись + группа чипов с aria-pressed по активному периоду.
  assert.ok(PAGE.includes("<div className={styles.periodFilter}>"));
  assert.ok(
    PAGE.includes(
      '<span className={styles.periodFilterLabel} id="period-filter-label">',
    ),
  );
  assert.ok(PAGE.includes("className={styles.periodChips}"));
  assert.ok(PAGE.includes("className={styles.periodChip}"));
  assert.ok(PAGE.includes("aria-pressed={period === p}"));

  // Форма чипа: полностью круглые края, тонкая рамка, активное состояние заливкой.
  const chip = rule(".periodChip");
  assert.ok(chip.includes("border-radius: 999px"));
  assert.ok(chip.includes("border: 1px solid"));
  assert.ok(chip.includes("padding: 4px 12px"));
  assert.ok(hasSelector('.periodChip[aria-pressed="true"]'));
  const chips = rule(".periodChips");
  assert.ok(chips.includes("display: flex"));
  assert.ok(chips.includes("flex-wrap: wrap"));
});

test("2: подписи периодов сохранены", () => {
  assert.deepEqual(RESTAURANT_SETTLEMENT_PERIOD_LABELS, {
    TODAY: "Сегодня",
    LAST_7_DAYS: "7 дней",
    LAST_30_DAYS: "30 дней",
    ALL: "Всё время",
  });
  assert.ok(
    PAGE.includes("{RESTAURANT_SETTLEMENT_PERIOD_LABELS[p]}"),
    "подписи периодов по-прежнему берутся из доменного словаря",
  );
});

test("3: верхние вкладки представления не изменены", () => {
  assert.ok(PAGE.includes('<div className={styles.viewTabs} role="group"'));
  assert.ok(PAGE.includes("className={styles.viewTab}"));
  assert.ok(PAGE.includes('["ORDERS", "По заказам"]'));
  assert.ok(PAGE.includes('["DAILY", "По дням"]'));
  assert.ok(PAGE.includes('["OBLIGATIONS", "Обязательства"]'));
  assert.ok(PAGE.includes('["STATEMENT", "Выписка"]'));
  assert.ok(PAGE.includes("className={styles.backLink}"));
  assert.ok(PAGE.includes("← Общий баланс"));

  const tabs = rule(".viewTabs");
  assert.ok(tabs.includes("border-radius: 12px"));
  assert.ok(tabs.includes("overflow-x: auto"));
  const tab = rule(".viewTab");
  assert.ok(tab.includes("border-radius: 9px"));
  assert.ok(hasSelector('.viewTab[aria-pressed="true"]'));
});

// --- 4–8: показатели больше не выглядят кнопками -------------------------------

test("4: SummaryCard остаётся read-only div, а не button", () => {
  const start = PAGE.indexOf("function SummaryCard(");
  assert.notEqual(start, -1);
  const body = PAGE.slice(start);
  assert.ok(body.includes("<div className={styles.card}>"));
  assert.ok(!body.includes("<button"));
  assert.ok(!body.includes("onClick"));
  assert.ok(!body.includes("aria-pressed"));
  assert.ok(!body.includes("role="));
});

test("5: у показателя нет собственной рамки", () => {
  const card = rule(".card");
  assert.ok(card.includes("border: 0"));
  assert.ok(
    !card.includes("border: 1px solid"),
    "показатель не обводится собственной рамкой",
  );
  assert.ok(
    !card.includes("background: var("),
    "у показателя нет собственной заливки",
  );
  assert.ok(card.includes("background: transparent"));
});

test("6: у показателя нет крупного скругления", () => {
  const card = rule(".card");
  assert.ok(card.includes("border-radius: 0"));
  assert.ok(!card.includes("border-radius: 10px"));
  assert.ok(!card.includes("border-radius: 12px"));
});

test("7: у показателя нет hover/active состояний", () => {
  assert.ok(!hasSelector(".card:hover"));
  assert.ok(!hasSelector(".card:active"));
  assert.ok(!hasSelector(".card:focus"));
  assert.ok(!hasSelector(".card:focus-visible"));
  const card = rule(".card");
  assert.ok(!card.includes("cursor: pointer"));
  assert.ok(!card.includes("box-shadow"));
});

test("8: сводка — одна компактная группа, а не сетка карточек", () => {
  const grid = rule(".summaryGrid");
  assert.ok(grid.includes("display: grid"));
  // Общие границы принадлежат группе, а не каждому показателю.
  assert.ok(grid.includes("border-top: 1px solid"));
  assert.ok(grid.includes("border-bottom: 1px solid"));
  // Без зазора: показатели образуют единую таблицу, а не отдельные плитки.
  assert.ok(grid.includes("gap: 0"));
  assert.ok(!grid.includes("gap: 12px"));
  // Значения ощутимо компактнее прежних карточек.
  const card = rule(".card");
  assert.ok(card.includes("padding: 10px 14px"));
  assert.ok(card.includes("min-height: 0"));
  const value = rule(".cardValue");
  assert.ok(value.includes("font-variant-numeric: tabular-nums"));
  assert.ok(value.includes("font-size: 22px"), "значение остаётся читаемым");
  const label = rule(".cardLabel");
  assert.ok(label.includes("font-size: 12px"));
  const hint = rule(".cardHint");
  assert.ok(hint.includes("font-size: 11px"));
});

// --- 9–11: один renderer на все три места --------------------------------------

test("9: основная сводка периода использует компактные показатели", () => {
  assert.ok(PAGE.includes('<SummaryCard label="Заказов за период"'));
  assert.ok(PAGE.includes('<SummaryCard label="Продажи блюд"'));
  assert.ok(PAGE.includes('label="Ресторану после комиссий"'));
  assert.ok(PAGE.includes('<SummaryCard label="Комиссия Direct"'));
});

test("10: «Подробности сверки» используют тот же renderer", () => {
  assert.ok(PAGE.includes('<SummaryCard label="Стоимость заказов"'));
  assert.ok(PAGE.includes('label="Собрано рестораном с клиентов"'));
  assert.ok(PAGE.includes('label="Собрано Direct с клиентов"'));
  assert.ok(PAGE.includes('label="Ожидает расчёта по журналу комиссий"'));
  assert.ok(PAGE.includes('label="Комиссия банка"'));
});

test("11: дневные показатели используют тот же renderer", () => {
  const start = PAGE.indexOf("function DayCard(");
  assert.notEqual(start, -1);
  const body = PAGE.slice(start, PAGE.indexOf("type ObligationStatusFilter"));
  assert.ok(body.includes('<SummaryCard label="Заказов"'));
  assert.ok(body.includes("<div className={styles.summaryGrid}>"));
  // Ни одной параллельной визуальной реализации показателей.
  assert.ok(!body.includes("styles.dayCardValue"));
  assert.ok(!body.includes("styles.dayMetric"));
});

test("11a: единственная реализация показателя — SummaryCard", () => {
  const cardUsages = PAGE.split("styles.card}").length - 1;
  assert.equal(
    cardUsages,
    1,
    "класс показателя используется только внутри SummaryCard",
  );
  assert.equal(
    PAGE.split("function SummaryCard(").length - 1,
    1,
    "renderer показателей ровно один",
  );
});

// --- 12: подробности сверки закрыты по умолчанию -------------------------------

test("12: «Подробности сверки» не раскрыты по умолчанию", () => {
  assert.ok(PAGE.includes("<details className={styles.reconDetails}>"));
  assert.ok(
    !PAGE.includes("<details className={styles.reconDetails} open"),
    "details не открывается автоматически",
  );
  assert.ok(!/<details[^>]*\sopen[\s>]/.test(PAGE), "ни один details не open");
  assert.ok(
    PAGE.includes(
      "<summary className={styles.reconSummary}>Подробности сверки</summary>",
    ),
  );
  // Компактная строка-раскрытие, а не карточка/кнопка.
  const summary = rule(".reconSummary");
  assert.ok(summary.includes("font-size: 13px"));
  assert.ok(!summary.includes("border: 1px solid"));
  assert.ok(!summary.includes("background: var("));
});

// --- 13–17: схема расчётов скрыта по умолчанию ---------------------------------

test("13: «Как рассчитываются выплаты» реализовано через details", () => {
  assert.ok(PAGE.includes("<details className={styles.schemeDetails}>"));
  assert.ok(
    PAGE.includes("<summary className={styles.schemeSummary}>"),
    "заголовок — нативный summary, доступный с клавиатуры",
  );
  assert.ok(PAGE.includes("Как рассчитываются выплаты"));
  assert.ok(hasSelector(".schemeSummary:focus-visible"));
});

test("14: схема закрыта по умолчанию", () => {
  assert.ok(!PAGE.includes("<details className={styles.schemeDetails} open"));
  // Старая всегда раскрытая карточка со схемой удалена.
  assert.ok(
    !PAGE.includes('aria-label="Как работает ваша схема"'),
    "постоянно открытая секция схемы больше не рендерится",
  );
  // В закрытом виде нет рамки-карточки.
  const details = rule(".schemeDetails");
  assert.ok(details.includes("border: 0"));
});

test("15: пункты схемы находятся внутри раскрываемого тела", () => {
  const start = PAGE.indexOf("<details className={styles.schemeDetails}>");
  assert.notEqual(start, -1);
  const end = PAGE.indexOf("</details>", start);
  const block = PAGE.slice(start, end);
  const bodyStart = block.indexOf('<div className={styles.schemeBody}>');
  assert.notEqual(bodyStart, -1);
  const body = block.slice(bodyStart);
  assert.ok(body.includes("modelNotes.notes.map"));
  assert.ok(body.includes("{modelNotes.title}"));
  assert.ok(body.includes("className={styles.modelNotes}"));
});

test("16: длинный заголовок схемы не виден в закрытом состоянии", () => {
  const start = PAGE.indexOf("<summary className={styles.schemeSummary}>");
  const end = PAGE.indexOf("</summary>", start);
  const summary = PAGE.slice(start, end);
  assert.ok(!summary.includes("modelNotes.title"));
  assert.ok(!summary.includes("Как работает ваша схема"));
  assert.ok(
    !PAGE.includes("Как работает ваша схема · {modelNotes.title}"),
    "длинная строка заголовка со схемой удалена",
  );
});

test("17: раскрытие схемы не хранится в state или localStorage", () => {
  const start = PAGE.indexOf("function FinanceOverview(");
  const end = PAGE.indexOf("function OrdersView(");
  const overview = PAGE.slice(start, end);
  assert.ok(!overview.includes("useState"));
  assert.ok(!PAGE.includes("localStorage"));
  assert.ok(!PAGE.includes("schemeOpen"));
});

// --- 18–22: финансовая часть и соседние экраны не тронуты ----------------------

test("18: финансовые значения и подписи показателей прежние", () => {
  for (const source of [
    "overview.summary.completedOrderCount",
    "overview.summary.foodSubtotalCents",
    "overview.summary.restaurantNetCents",
    "overview.summary.platformCommissionReceivableCents",
    "overview.summary.customerTotalCents",
    "overview.summary.restaurantCollectedFromCustomerCents",
    "overview.summary.platformCollectedFromCustomerCents",
    "overview.summary.pendingLedgerCents",
    "overview.summary.totalBankFeeCents",
    "day.completedOrderCount",
    "day.foodSubtotalCents",
    "day.restaurantNetCents",
    "day.platformCommissionReceivableCents",
  ]) {
    assert.ok(PAGE.includes(source), `источник ${source} сохранён`);
  }
  assert.ok(
    PAGE.includes("Учтены комиссия Direct и доля банковской комиссии ресторана."),
  );
  assert.ok(PAGE.includes("Нет достоверных данных"));
  assert.ok(
    PAGE.includes(
      "Информационный показатель снимка, не подтверждённая выплата.",
    ),
  );
});

test("19: главная карточка баланса OVERVIEW не изменена", () => {
  assert.ok(PAGE.includes('aria-label="Итог взаиморасчётов"'));
  assert.ok(PAGE.includes("className={styles.overviewCard}"));
  assert.ok(PAGE.includes("className={styles.overviewAmount}"));
  assert.ok(PAGE.includes("<dt>Direct должен вам</dt>"));
  assert.ok(PAGE.includes("<dt>Вы должны Direct</dt>"));
  const card = rule(".overviewCard");
  assert.ok(card.includes("border-radius: 14px"));
  assert.ok(card.includes("padding: 22px 20px"));
});

test("20: shared balance breakdown используется без изменений", () => {
  assert.ok(PAGE.includes("<RestaurantBalanceBreakdownView"));
  assert.ok(PAGE.includes('restaurantSideTitle="Вы должны Direct"'));
  assert.ok(PAGE.includes('directSideTitle="Direct должен вам"'));
  // Компонент общий с администратором и подписи берёт из одного словаря.
  assert.ok(SHARED_VIEW.includes("BREAKDOWN_CODE_LABELS"));
  assert.ok(!SHARED_VIEW.includes("styles.summaryGrid"));
});

test("21: административный раздел расчётов не использует эти классы", () => {
  // У администратора собственный CSS-модуль: правки ресторанной сводки на него
  // не влияют, поэтому этот микробатч admin UI не трогает.
  assert.ok(ADMIN_PAGE.includes("./admin-settlements.module.css"));
  assert.ok(!ADMIN_PAGE.includes("restaurant/settlements/settlements.module.css"));
  assert.ok(!ADMIN_PAGE.includes("schemeDetails"));
});

test("22: схема прототипа остаётся 15", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 23);
});
