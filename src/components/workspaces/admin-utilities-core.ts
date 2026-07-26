export interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

export interface CalendarCell {
  key: string;
  year: number;
  month: number;
  day: number;
  inCurrentMonth: boolean;
  isToday: boolean;
}

export function getDatePartsInTimeZone(
  now: Date,
  timeZone: string,
): CalendarDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
  };
}

export function buildMondayFirstCalendarGrid(
  year: number,
  month: number,
  today: CalendarDateParts,
): CalendarCell[] {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const leadingDays = (firstWeekday + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cellCount = leadingDays + daysInMonth <= 35 ? 35 : 42;

  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, index - leadingDays + 1));
    const cellYear = date.getUTCFullYear();
    const cellMonth = date.getUTCMonth() + 1;
    const day = date.getUTCDate();

    return {
      key: `${cellYear}-${String(cellMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      year: cellYear,
      month: cellMonth,
      day,
      inCurrentMonth: cellYear === year && cellMonth === month,
      isToday:
        cellYear === today.year &&
        cellMonth === today.month &&
        day === today.day,
    };
  });
}

export function shiftCalendarMonth(
  year: number,
  month: number,
  delta: -1 | 1,
): { year: number; month: number } {
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
  };
}

export function formatCalendarMonthTitle(year: number, month: number): string {
  const monthName = new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  return `${monthName[0].toUpperCase()}${monthName.slice(1)} ${year}`;
}

export type CalculatorOperation =
  | "ADD"
  | "SUBTRACT"
  | "MULTIPLY"
  | "DIVIDE";

export interface CalculatorState {
  display: string;
  accumulator: number | null;
  pendingOperation: CalculatorOperation | null;
  waitingForOperand: boolean;
  expressionLabel: string;
  error: string | null;
}

export type CalculatorAction =
  | { type: "DIGIT"; digit: string }
  | { type: "DECIMAL" }
  | { type: "OPERATION"; operation: CalculatorOperation }
  | { type: "EQUALS" }
  | { type: "CLEAR" }
  | { type: "BACKSPACE" }
  | { type: "TOGGLE_SIGN" }
  | { type: "PERCENT" };

const OPERATION_SYMBOLS: Record<CalculatorOperation, string> = {
  ADD: "+",
  SUBTRACT: "−",
  MULTIPLY: "×",
  DIVIDE: "÷",
};

const DIVISION_BY_ZERO_ERROR = "Деление на ноль невозможно.";
const NON_FINITE_ERROR = "Результат слишком большой.";

export function createInitialCalculatorState(): CalculatorState {
  return {
    display: "0",
    accumulator: null,
    pendingOperation: null,
    waitingForOperand: true,
    expressionLabel: "",
    error: null,
  };
}

export function calculateBinary(
  left: number,
  operation: CalculatorOperation,
  right: number,
): number {
  switch (operation) {
    case "ADD":
      return left + right;
    case "SUBTRACT":
      return left - right;
    case "MULTIPLY":
      return left * right;
    case "DIVIDE":
      return left / right;
  }
}

export function formatCalculatorNumber(value: number): string {
  if (!Number.isFinite(value)) return "Ошибка";
  if (Object.is(value, -0)) return "0";

  return new Intl.NumberFormat("en-US", {
    useGrouping: false,
    maximumSignificantDigits: 15,
  }).format(value);
}

function significantDigitCount(value: string): number {
  return value.replace("-", "").replace(".", "").replace(/^0+/, "").length;
}

function errorState(message: string): CalculatorState {
  return {
    ...createInitialCalculatorState(),
    display: "Ошибка",
    error: message,
  };
}

function applyOperation(
  left: number,
  operation: CalculatorOperation,
  right: number,
): CalculatorState | number {
  if (operation === "DIVIDE" && right === 0) {
    return errorState(DIVISION_BY_ZERO_ERROR);
  }

  const result = calculateBinary(left, operation, right);
  return Number.isFinite(result) ? result : errorState(NON_FINITE_ERROR);
}

export function calculatorReducer(
  state: CalculatorState,
  action: CalculatorAction,
): CalculatorState {
  if (action.type === "CLEAR") return createInitialCalculatorState();

  if (state.error && action.type !== "DIGIT" && action.type !== "DECIMAL") {
    return state;
  }

  if (action.type === "DIGIT") {
    if (!/^\d$/.test(action.digit)) return state;
    const nextDisplay =
      state.error || state.waitingForOperand || state.display === "0"
        ? action.digit
        : `${state.display}${action.digit}`;
    if (significantDigitCount(nextDisplay) > 15) return state;

    return {
      ...(state.error ? createInitialCalculatorState() : state),
      display: nextDisplay,
      waitingForOperand: false,
      error: null,
    };
  }

  if (action.type === "DECIMAL") {
    if (state.error || state.waitingForOperand) {
      return {
        ...(state.error ? createInitialCalculatorState() : state),
        display: "0.",
        waitingForOperand: false,
        error: null,
      };
    }
    return state.display.includes(".")
      ? state
      : { ...state, display: `${state.display}.` };
  }

  if (action.type === "BACKSPACE") {
    if (state.waitingForOperand) return state;
    const shortened = state.display.slice(0, -1);
    return {
      ...state,
      display: shortened === "" || shortened === "-" ? "0" : shortened,
    };
  }

  if (action.type === "TOGGLE_SIGN") {
    if (state.display === "0") return state;
    return {
      ...state,
      display: state.display.startsWith("-")
        ? state.display.slice(1)
        : `-${state.display}`,
    };
  }

  if (action.type === "PERCENT") {
    const result = Number(state.display) / 100;
    if (!Number.isFinite(result)) return errorState(NON_FINITE_ERROR);
    return { ...state, display: formatCalculatorNumber(result) };
  }

  if (action.type === "OPERATION") {
    const current = Number(state.display);
    if (state.pendingOperation && state.accumulator !== null && !state.waitingForOperand) {
      const result = applyOperation(
        state.accumulator,
        state.pendingOperation,
        current,
      );
      if (typeof result !== "number") return result;
      const display = formatCalculatorNumber(result);
      return {
        display,
        accumulator: result,
        pendingOperation: action.operation,
        waitingForOperand: true,
        expressionLabel: `${display} ${OPERATION_SYMBOLS[action.operation]}`,
        error: null,
      };
    }

    const accumulator = state.accumulator ?? current;
    return {
      ...state,
      accumulator,
      pendingOperation: action.operation,
      waitingForOperand: true,
      expressionLabel: `${formatCalculatorNumber(accumulator)} ${OPERATION_SYMBOLS[action.operation]}`,
    };
  }

  if (action.type === "EQUALS") {
    if (state.pendingOperation === null || state.accumulator === null) return state;
    const right = Number(state.display);
    const result = applyOperation(
      state.accumulator,
      state.pendingOperation,
      right,
    );
    if (typeof result !== "number") return result;
    const display = formatCalculatorNumber(result);
    return {
      display,
      accumulator: null,
      pendingOperation: null,
      waitingForOperand: true,
      expressionLabel: `${formatCalculatorNumber(state.accumulator)} ${OPERATION_SYMBOLS[state.pendingOperation]} ${formatCalculatorNumber(right)} =`,
      error: null,
    };
  }

  return state;
}
