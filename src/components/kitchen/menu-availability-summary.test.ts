import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { getMenuAvailabilitySummary } from "./menu-availability-summary.ts";
import type { MenuItem, OperationalPause } from "../../prototype/models.ts";

/**
 * Сводка доступности меню для компактной строки внизу экрана заказов: точные
 * тексты, склонения, tone и учёт временной availabilityPause. Разметка нижнего
 * блока и embedded-режим дополнительно проверяются контрактно по исходникам
 * (JSX в node:test не исполняется).
 */

const NOW = Date.parse("2026-07-19T12:00:00.000Z");

function item(
  id: string,
  available: boolean,
  availabilityPause: OperationalPause | null = null,
): MenuItem {
  return {
    id,
    restaurantId: "restaurant-1",
    category: "Основное",
    name: `Блюдо ${id}`,
    description: "",
    priceCents: 500,
    currencyCode: "USD",
    available,
    availabilityPause,
  } as unknown as MenuItem;
}

function items(count: number, available: boolean): MenuItem[] {
  return Array.from({ length: count }, (_, i) => item(`i${i}`, available));
}

// 1 --------------------------------------------------------------------------

test("пустое меню: «Блюд пока нет», tone EMPTY", () => {
  const summary = getMenuAvailabilitySummary([], NOW);
  assert.equal(summary.text, "Блюд пока нет");
  assert.equal(summary.tone, "EMPTY");
  assert.equal(summary.total, 0);
  assert.equal(summary.unavailable, 0);
});

// 2 --------------------------------------------------------------------------

test("все блюда доступны: «Все позиции доступны», tone OK", () => {
  const summary = getMenuAvailabilitySummary(items(4, true), NOW);
  assert.equal(summary.text, "Все позиции доступны");
  assert.equal(summary.tone, "OK");
  assert.equal(summary.total, 4);
  assert.equal(summary.unavailable, 0);
});

// 3 --------------------------------------------------------------------------

test("часть недоступна: верное количество и tone PARTIAL", () => {
  const menu = [...items(3, true), ...items(2, false).map((m, i) => item(`u${i}`, false))];
  const summary = getMenuAvailabilitySummary(menu, NOW);
  assert.equal(summary.total, 5);
  assert.equal(summary.unavailable, 2);
  assert.equal(summary.text, "2 позиции недоступны");
  assert.equal(summary.tone, "PARTIAL");
});

// 4 --------------------------------------------------------------------------

test("все недоступны: «Все позиции недоступны», tone ALL_UNAVAILABLE", () => {
  const summary = getMenuAvailabilitySummary(items(3, false), NOW);
  assert.equal(summary.text, "Все позиции недоступны");
  assert.equal(summary.tone, "ALL_UNAVAILABLE");
  assert.equal(summary.unavailable, 3);
});

// 5 — русские склонения -------------------------------------------------------

test("склонения: 1 позиция, 2 позиции, 5 позиций, 11 позиций, 21 позиция", () => {
  // В каждом случае одно блюдо доступно, чтобы ветка была именно PARTIAL.
  const cases: [number, string][] = [
    [1, "1 позиция недоступна"],
    [2, "2 позиции недоступны"],
    [3, "3 позиции недоступны"],
    [4, "4 позиции недоступны"],
    [5, "5 позиций недоступны"],
    [11, "11 позиций недоступны"],
    [12, "12 позиций недоступны"],
    [14, "14 позиций недоступны"],
    [21, "21 позиция недоступна"],
    [22, "22 позиции недоступны"],
    [25, "25 позиций недоступны"],
    [101, "101 позиция недоступна"],
    [111, "111 позиций недоступны"],
  ];
  for (const [count, expected] of cases) {
    const menu = [
      ...Array.from({ length: count }, (_, i) => item(`u${i}`, false)),
      item("ok", true),
    ];
    const summary = getMenuAvailabilitySummary(menu, NOW);
    assert.equal(summary.tone, "PARTIAL", String(count));
    assert.equal(summary.unavailable, count);
    assert.equal(summary.text, expected);
  }
});

// 6 — временная пауза через isMenuItemAvailableAt ------------------------------

test("активная availabilityPause делает блюдо недоступным", () => {
  const activePause: OperationalPause = {
    startedAt: "2026-07-19T11:00:00.000Z",
    reason: "Закончился ингредиент",
    mode: "UNTIL_TIME",
    resumeAt: "2026-07-19T13:00:00.000Z",
    startedBy: "RESTAURANT",
  };
  // available === true, но активная пауза перевешивает.
  const menu = [item("paused", true, activePause), item("ok", true)];
  const summary = getMenuAvailabilitySummary(menu, NOW);
  assert.equal(summary.unavailable, 1);
  assert.equal(summary.text, "1 позиция недоступна");
  assert.equal(summary.tone, "PARTIAL");
});

test("истёкшая availabilityPause снова делает блюдо доступным", () => {
  const expiredPause: OperationalPause = {
    startedAt: "2026-07-19T09:00:00.000Z",
    reason: "Закончился ингредиент",
    mode: "UNTIL_TIME",
    resumeAt: "2026-07-19T11:00:00.000Z", // раньше NOW
    startedBy: "RESTAURANT",
  };
  const menu = [item("resumed", true, expiredPause), item("ok", true)];
  const summary = getMenuAvailabilitySummary(menu, NOW);
  assert.equal(summary.unavailable, 0);
  assert.equal(summary.text, "Все позиции доступны");
  assert.equal(summary.tone, "OK");
});

test("MANUAL-пауза активна без resumeAt и не зависит от nowMs", () => {
  const manualPause: OperationalPause = {
    startedAt: "2026-07-19T09:00:00.000Z",
    reason: "Нет продукта",
    mode: "MANUAL",
    resumeAt: null,
    startedBy: "RESTAURANT",
  };
  const menu = [item("manual", true, manualPause)];
  const summary = getMenuAvailabilitySummary(menu, NOW);
  assert.equal(summary.tone, "ALL_UNAVAILABLE");
  assert.equal(summary.text, "Все позиции недоступны");
});

test("tone не выводится из русского текста: поля независимы", () => {
  const summary = getMenuAvailabilitySummary(items(2, true), NOW);
  assert.equal(typeof summary.tone, "string");
  assert.ok(["EMPTY", "OK", "PARTIAL", "ALL_UNAVAILABLE"].includes(summary.tone));
  assert.equal(typeof summary.total, "number");
  assert.equal(typeof summary.unavailable, "number");
});

// 7/8 — нижний блок экрана заказов -------------------------------------------

/**
 * Переводы строк нормализуем: рабочая копия на Windows может быть с CRLF, а в
 * CI файл выгружается с LF. Без этого контрактные проверки по исходникам ведут
 * себя по-разному на разных ОС.
 */
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

const KITCHEN_PAGE = readSource("../../app/restaurant/kitchen/page.tsx");
const OPERATOR_PAGE = readSource("../../app/restaurant/operator/page.tsx");
const PROVIDER = readSource("../../prototype/prototype-provider.tsx");
// Компактный блок вынесен в переиспользуемый компонент: разметку details/summary
// проверяем в нём, а страницы — только на использование этого компонента.
const PANEL = readSource("./restaurant-menu-availability-panel.tsx");
const MENU_PAGE = readSource("../../app/restaurant/menu/page.tsx");
const OPERATIONS = readSource("./kitchen-operations.tsx");

test("компактный блок — native details/summary, закрытый по умолчанию", () => {
  assert.ok(PANEL.includes("<details"), "используется native details");
  assert.ok(PANEL.includes("<summary"), "используется native summary");
  // Закрыт по умолчанию: атрибут open не выставляется.
  assert.ok(!/<details[^>]*\sopen/.test(PANEL), "details не открыт по умолчанию");
});

test("точный заголовок «Меню» без старого блока", () => {
  assert.ok(PANEL.includes(">Меню</span>"), "есть точный заголовок «Меню»");
  for (const page of [KITCHEN_PAGE, OPERATOR_PAGE]) {
    assert.ok(!page.includes("Меню и доступность"));
    assert.ok(!page.includes("Открыть меню"));
    assert.ok(
      !page.includes(
        "Отключение блюд и управление доступностью находятся в отдельном",
      ),
    );
  }
});

test("раскрытый блок использует существующий MenuAvailabilitySection в embedded", () => {
  assert.ok(PANEL.includes("<MenuAvailabilitySection"));
  assert.ok(PANEL.includes("embedded"));
  // Chevron скрыт от скринридера. Единственный интерактив внутри summary —
  // компактный Plus «Добавить новое блюдо»: он не переключает <details>
  // (preventDefault + stopPropagation), а открывает страницу конструктора.
  assert.ok(PANEL.includes("ChevronDown"));
  const summaryStart = PANEL.indexOf("<summary");
  const summaryEnd = PANEL.indexOf("</summary>");
  const summaryMarkup = PANEL.slice(summaryStart, summaryEnd);
  assert.equal(
    summaryMarkup.split("<button").length - 1,
    1,
    "внутри summary ровно одна кнопка — Plus конструктора",
  );
  assert.ok(summaryMarkup.includes('aria-label="Добавить новое блюдо"'));
  assert.ok(summaryMarkup.includes("event.preventDefault()"));
  assert.ok(summaryMarkup.includes("event.stopPropagation()"));
  assert.ok(!summaryMarkup.includes("<Link"), "внутри summary нет ссылки");
  assert.ok(summaryMarkup.includes('aria-hidden="true"'), "chevron aria-hidden");
});

test("обе рабочие страницы используют один и тот же компонент с реальной ролью", () => {
  // Ни одна страница не строит вторую реализацию: только общий компонент.
  for (const page of [KITCHEN_PAGE, OPERATOR_PAGE]) {
    assert.ok(page.includes("<RestaurantMenuAvailabilityPanel"));
    assert.ok(!page.includes("<details"), "страница не дублирует разметку блока");
    assert.ok(!page.includes("<MenuAvailabilitySection"));
  }
  // Кухонный экран различает SPLIT-кухню и общий экран, оператор — всегда OPERATOR.
  assert.ok(KITCHEN_PAGE.includes('isSplit ? "KITCHEN" : "COMBINED"'));
  assert.ok(OPERATOR_PAGE.includes('workspaceRole="OPERATOR"'));
});

test("роль не угадывается внутри секции: она приходит пропом", () => {
  assert.ok(OPERATIONS.includes("workspaceRole: RestaurantWorkspaceRole"));
  assert.ok(
    OPERATIONS.includes("workspaceRole={workspaceRole}"),
    "секция передаёт роль в строку блюда",
  );
  assert.ok(!PANEL.includes('"KITCHEN"'), "панель не зашивает роль");
});

test("provider не зашивает роль в действия доступности меню", () => {
  // Четыре метода принимают реальную роль экрана вместо литерала «KITCHEN».
  // Проверяем тело каждого useCallback, а не весь файл: роль KITCHEN законно
  // остаётся в кухонных действиях (например, корректировка ETA).
  for (const fn of [
    "setMenuItemUnavailable",
    "restoreMenuItem",
    "pauseCategory",
    "restoreCategory",
  ]) {
    const start = PROVIDER.indexOf(`const ${fn} = useCallback(`);
    assert.ok(start > -1, `${fn} найден`);
    // Границей тела служит следующее объявление верхнего уровня в компоненте.
    const end = PROVIDER.indexOf("\n  const ", start + 1);
    const body = PROVIDER.slice(start, end === -1 ? PROVIDER.length : end);
    assert.ok(
      body.includes("workspaceRole: RestaurantWorkspaceRole"),
      `${fn} принимает роль`,
    );
    assert.ok(!body.includes('"KITCHEN"'), `${fn} не зашивает KITCHEN`);
  }
});

// 9/10 — embedded-режим и отдельная страница ---------------------------------

test("embedded-режим не показывает второй заголовок «Доступность меню»", () => {
  assert.ok(OPERATIONS.includes("embedded = false"), "по умолчанию embedded=false");
  assert.ok(
    OPERATIONS.includes("embedded ? null : ("),
    "заголовок скрывается только во встроенном режиме",
  );
  assert.ok(
    OPERATIONS.includes("embedded ? styles.menuEmbedded : styles.section"),
    "во встроенном режиме нет второй тяжёлой рамки",
  );
});

test("/restaurant/menu использует обычный не-embedded режим", () => {
  assert.ok(MENU_PAGE.includes("<MenuAvailabilitySection"));
  assert.ok(!MENU_PAGE.includes("embedded"), "на отдельной странице режим прежний");
  // Роль НЕ угадывается: в SPLIT страницу открывают и оператор, и кухня —
  // реальный рабочий экран приходит валидируемым навигационным контекстом.
  // Без контекста раздел НЕ скрывается: он работает read-only (см. тесты
  // dish-builder), а fail-closed заглушка осталась только у конструктора.
  assert.ok(MENU_PAGE.includes("resolveMenuPageRole"));
  assert.ok(!MENU_PAGE.includes("DishBuilderRoleError"));
});
