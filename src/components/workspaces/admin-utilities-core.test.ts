import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PROTOTYPE_SCHEMA_VERSION } from "../../prototype/models.ts";
import {
  buildMondayFirstCalendarGrid,
  calculateBinary,
  calculatorReducer,
  createInitialCalculatorState,
  formatCalendarMonthTitle,
  getDatePartsInTimeZone,
  shiftCalendarMonth,
  type CalculatorAction,
  type CalculatorState,
} from "./admin-utilities-core.ts";

const HEADER = readFileSync("src/components/workspaces/admin-header.tsx", "utf8");
const UTILITIES = readFileSync(
  "src/components/workspaces/admin-utilities.tsx",
  "utf8",
);
const CSS = readFileSync(
  "src/components/workspaces/admin-utilities.module.css",
  "utf8",
);

function reduce(actions: CalculatorAction[]): CalculatorState {
  return actions.reduce(calculatorReducer, createInitialCalculatorState());
}

test("timezone parts use Europe/Chisinau rather than the machine timezone", () => {
  assert.deepEqual(
    getDatePartsInTimeZone(
      new Date("2026-01-31T22:30:00.000Z"),
      "Europe/Chisinau",
    ),
    { year: 2026, month: 2, day: 1 },
  );
});

test("calendar month navigation crosses year boundaries", () => {
  assert.deepEqual(shiftCalendarMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftCalendarMonth(2026, 12, 1), { year: 2027, month: 1 });
});

test("calendar grid starts on Monday and contains complete weeks", () => {
  const grid = buildMondayFirstCalendarGrid(2026, 7, {
    year: 2026,
    month: 7,
    day: 26,
  });
  const first = grid[0];
  const weekday = new Date(Date.UTC(first.year, first.month - 1, first.day)).getUTCDay();

  assert.equal(weekday, 1);
  assert.ok(grid.length === 35 || grid.length === 42);
  assert.equal(grid.filter((cell) => cell.isToday).length, 1);
});

test("leap and non-leap February contain the correct number of current-month days", () => {
  const today = { year: 2024, month: 2, day: 1 };
  assert.equal(
    buildMondayFirstCalendarGrid(2024, 2, today).filter(
      (cell) => cell.inCurrentMonth,
    ).length,
    29,
  );
  assert.equal(
    buildMondayFirstCalendarGrid(2025, 2, today).filter(
      (cell) => cell.inCurrentMonth,
    ).length,
    28,
  );
});

test("calendar navigation is deterministic and independent of machine timezone", () => {
  assert.deepEqual(shiftCalendarMonth(2026, 3, -1), { year: 2026, month: 2 });
});

test("calendar title is Russian and contains the year", () => {
  assert.equal(formatCalendarMonthTitle(2026, 7), "Июль 2026");
});

test("calculator performs the four binary operations", () => {
  assert.equal(calculateBinary(2, "ADD", 3), 5);
  assert.equal(calculateBinary(10, "SUBTRACT", 4), 6);
  assert.equal(calculateBinary(3, "MULTIPLY", 4), 12);
  assert.equal(calculateBinary(8, "DIVIDE", 2), 4);
});

test("calculator reducer evaluates a basic expression", () => {
  assert.equal(
    reduce([
      { type: "DIGIT", digit: "2" },
      { type: "OPERATION", operation: "ADD" },
      { type: "DIGIT", digit: "3" },
      { type: "EQUALS" },
    ]).display,
    "5",
  );
});

test("division by zero reports an error and a digit starts a new calculation", () => {
  const failed = reduce([
    { type: "DIGIT", digit: "8" },
    { type: "OPERATION", operation: "DIVIDE" },
    { type: "DIGIT", digit: "0" },
    { type: "EQUALS" },
  ]);
  assert.equal(failed.display, "Ошибка");
  assert.equal(failed.error, "Деление на ноль невозможно.");
  assert.deepEqual(calculatorReducer(failed, { type: "DIGIT", digit: "7" }), {
    ...createInitialCalculatorState(),
    display: "7",
    waitingForOperand: false,
  });
});

test("decimal point is added only once", () => {
  assert.equal(
    reduce([
      { type: "DIGIT", digit: "1" },
      { type: "DECIMAL" },
      { type: "DECIMAL" },
      { type: "DIGIT", digit: "5" },
    ]).display,
    "1.5",
  );
});

test("toggle sign, percent, backspace and clear update isolated state", () => {
  const negative = reduce([
    { type: "DIGIT", digit: "5" },
    { type: "TOGGLE_SIGN" },
  ]);
  assert.equal(negative.display, "-5");
  assert.equal(calculatorReducer(negative, { type: "PERCENT" }).display, "-0.05");
  assert.equal(
    reduce([
      { type: "DIGIT", digit: "1" },
      { type: "DIGIT", digit: "2" },
      { type: "BACKSPACE" },
    ]).display,
    "1",
  );
  assert.deepEqual(
    calculatorReducer(negative, { type: "CLEAR" }),
    createInitialCalculatorState(),
  );
});

test("non-finite results are rejected", () => {
  const state: CalculatorState = {
    display: "10",
    accumulator: Number.MAX_VALUE,
    pendingOperation: "MULTIPLY",
    waitingForOperand: false,
    expressionLabel: "",
    error: null,
  };
  assert.equal(calculatorReducer(state, { type: "EQUALS" }).error, "Результат слишком большой.");
});

test("calculator input is limited to fifteen significant digits", () => {
  const state = reduce(
    "1234567890123456".split("").map((digit) => ({ type: "DIGIT", digit })),
  );
  assert.equal(state.display, "123456789012345");
});

test("calculator reducer does not mutate its source state", () => {
  const state = createInitialCalculatorState();
  const snapshot = structuredClone(state);
  calculatorReducer(state, { type: "DIGIT", digit: "4" });
  assert.deepEqual(state, snapshot);
});

test("admin header renders utilities before prototype reset", () => {
  assert.match(HEADER, /<AdminUtilities \/>/);
  assert.ok(HEADER.indexOf("<AdminUtilities />") < HEADER.indexOf("<PrototypeResetButton />"));
});

test("utility triggers use lucide icons and accessible dialog attributes", () => {
  assert.match(UTILITIES, /CalendarDays/);
  assert.match(UTILITIES, /Calculator/);
  assert.match(UTILITIES, /aria-label="Открыть календарь"/);
  assert.match(UTILITIES, /aria-label="Открыть калькулятор"/);
  assert.match(UTILITIES, /aria-haspopup="dialog"/);
  assert.match(UTILITIES, /aria-expanded=/);
  assert.match(UTILITIES, /aria-controls=/);
});

test("only one utility panel is represented by one active state", () => {
  assert.match(UTILITIES, /type AdminUtility = "CALENDAR" \| "CALCULATOR" \| null/);
  assert.match(UTILITIES, /activeUtility === "CALENDAR"/);
  assert.match(UTILITIES, /activeUtility === "CALCULATOR"/);
});

test("panel closes with Escape and outside pointer, restoring trigger focus", () => {
  assert.match(UTILITIES, /event\.key === "Escape"/);
  assert.match(UTILITIES, /document\.addEventListener\("pointerdown"/);
  assert.match(UTILITIES, /openerRef\.current\?\.focus\(\)/);
});

test("calendar exposes Monday-first weekday headings and Today action", () => {
  for (const weekday of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]) {
    assert.match(UTILITIES, new RegExp(`\\["${weekday}",`));
  }
  assert.match(UTILITIES, />\s*Сегодня\s*</);
  assert.match(UTILITIES, /aria-current=\{cell\.isToday \? "date"/);
  assert.match(UTILITIES, /aria-selected=/);
});

test("calculator UI contains all required operations and keyboard support", () => {
  for (const label of ["Очистить", "Изменить знак", "Процент", "Разделить", "Умножить", "Вычесть", "Сложить", "Равно"]) {
    assert.match(UTILITIES, new RegExp(`ariaLabel: "${label}"`));
  }
  assert.match(UTILITIES, /key === ","/);
  assert.match(UTILITIES, /key === "Enter"/);
  assert.match(UTILITIES, /key === "Backspace"/);
});

test("mobile utility panel uses a safe-area bottom sheet without horizontal overflow", () => {
  assert.match(CSS, /@media \(max-width: 760px\)/);
  assert.match(CSS, /env\(safe-area-inset-bottom\)/);
  assert.match(CSS, /position: fixed/);
  assert.match(CSS, /width: 100%/);
  assert.match(CSS, /overflow-y: auto/);
  assert.match(CSS, /min-height: 48px/);
});

test("admin utilities remain isolated from prototype persistence and unsafe evaluation", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 31);
  const prototypeHook = ["use", "Prototype"].join("");
  const browserStorage = ["local", "Storage"].join("");
  const htmlMutation = ["inner", "HTML"].join("");
  const unsafeEval = ["ev", "al("].join("");
  const unsafeFunction = ["new", "Function"].join(" ");
  assert.equal(UTILITIES.includes(prototypeHook), false);
  assert.equal(UTILITIES.includes(browserStorage), false);
  assert.equal(UTILITIES.includes(htmlMutation), false);
  assert.equal(UTILITIES.includes(unsafeEval), false);
  assert.equal(UTILITIES.includes(unsafeFunction), false);
});
