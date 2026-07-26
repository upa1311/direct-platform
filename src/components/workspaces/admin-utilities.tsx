"use client";

import {
  Calculator,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Delete,
  X,
} from "lucide-react";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  buildMondayFirstCalendarGrid,
  calculatorReducer,
  createInitialCalculatorState,
  formatCalendarMonthTitle,
  getDatePartsInTimeZone,
  shiftCalendarMonth,
  type CalculatorAction,
  type CalculatorOperation,
  type CalculatorState,
} from "./admin-utilities-core";
import styles from "./admin-utilities.module.css";

type AdminUtility = "CALENDAR" | "CALCULATOR" | null;

const ADMIN_TIME_ZONE = "Europe/Chisinau";
const WEEKDAYS = [
  ["Пн", "Понедельник"],
  ["Вт", "Вторник"],
  ["Ср", "Среда"],
  ["Чт", "Четверг"],
  ["Пт", "Пятница"],
  ["Сб", "Суббота"],
  ["Вс", "Воскресенье"],
] as const;

function getCurrentDate() {
  return getDatePartsInTimeZone(new Date(), ADMIN_TIME_ZONE);
}

function CalendarPanel() {
  const [today, setToday] = useState(getCurrentDate);
  const [view, setView] = useState(() => ({
    year: today.year,
    month: today.month,
  }));
  const [selectedKey, setSelectedKey] = useState(
    `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`,
  );
  const cells = useMemo(
    () => buildMondayFirstCalendarGrid(view.year, view.month, today),
    [today, view],
  );

  const showToday = () => {
    const current = getCurrentDate();
    setToday(current);
    setView({ year: current.year, month: current.month });
    setSelectedKey(
      `${current.year}-${String(current.month).padStart(2, "0")}-${String(current.day).padStart(2, "0")}`,
    );
  };

  return (
    <div className={styles.calendar}>
      <div className={styles.calendarToolbar}>
        <button
          type="button"
          aria-label="Предыдущий месяц"
          onClick={() => setView(shiftCalendarMonth(view.year, view.month, -1))}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <strong>{formatCalendarMonthTitle(view.year, view.month)}</strong>
        <button
          type="button"
          aria-label="Следующий месяц"
          onClick={() => setView(shiftCalendarMonth(view.year, view.month, 1))}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
      <div
        className={styles.calendarGrid}
        role="grid"
        aria-label={formatCalendarMonthTitle(view.year, view.month)}
      >
        {WEEKDAYS.map(([short, full]) => (
          <span key={short} className={styles.weekday} role="columnheader">
            <abbr title={full}>{short}</abbr>
          </span>
        ))}
        {cells.map((cell, index) => {
          const weekend = index % 7 >= 5;
          return (
            <button
              key={cell.key}
              type="button"
              role="gridcell"
              className={`${styles.calendarCell} ${!cell.inCurrentMonth ? styles.calendarCellMuted : ""} ${weekend ? styles.calendarCellWeekend : ""} ${selectedKey === cell.key ? styles.calendarCellSelected : ""}`}
              aria-label={`${cell.day}.${cell.month}.${cell.year}${weekend ? ", выходной" : ""}`}
              aria-current={cell.isToday ? "date" : undefined}
              aria-selected={selectedKey === cell.key}
              onClick={() => setSelectedKey(cell.key)}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
      <button className={styles.todayButton} type="button" onClick={showToday}>
        Сегодня
      </button>
    </div>
  );
}

const CALCULATOR_KEYS: Array<{
  label: string;
  ariaLabel: string;
  action: CalculatorAction;
  kind?: "operation" | "equals";
  icon?: boolean;
}> = [
  { label: "C", ariaLabel: "Очистить", action: { type: "CLEAR" } },
  { label: "±", ariaLabel: "Изменить знак", action: { type: "TOGGLE_SIGN" } },
  { label: "%", ariaLabel: "Процент", action: { type: "PERCENT" } },
  { label: "÷", ariaLabel: "Разделить", action: { type: "OPERATION", operation: "DIVIDE" }, kind: "operation" },
  ...["7", "8", "9"].map((digit) => ({ label: digit, ariaLabel: digit, action: { type: "DIGIT" as const, digit } })),
  { label: "×", ariaLabel: "Умножить", action: { type: "OPERATION", operation: "MULTIPLY" }, kind: "operation" },
  ...["4", "5", "6"].map((digit) => ({ label: digit, ariaLabel: digit, action: { type: "DIGIT" as const, digit } })),
  { label: "−", ariaLabel: "Вычесть", action: { type: "OPERATION", operation: "SUBTRACT" }, kind: "operation" },
  ...["1", "2", "3"].map((digit) => ({ label: digit, ariaLabel: digit, action: { type: "DIGIT" as const, digit } })),
  { label: "+", ariaLabel: "Сложить", action: { type: "OPERATION", operation: "ADD" }, kind: "operation" },
  { label: "0", ariaLabel: "0", action: { type: "DIGIT", digit: "0" } },
  { label: ".", ariaLabel: "Десятичная точка", action: { type: "DECIMAL" } },
  { label: "⌫", ariaLabel: "Удалить последнюю цифру", action: { type: "BACKSPACE" }, icon: true },
  { label: "=", ariaLabel: "Равно", action: { type: "EQUALS" }, kind: "equals" },
];

function CalculatorPanel({
  state,
  dispatch,
}: {
  state: CalculatorState;
  dispatch: (action: CalculatorAction) => void;
}) {
  return (
    <div className={styles.calculator}>
      <div className={styles.calculatorDisplay} aria-live="polite">
        <span>{state.expressionLabel || "Текущий расчёт"}</span>
        <strong>{state.display}</strong>
      </div>
      {state.error ? <p role="alert">{state.error}</p> : null}
      <div className={styles.calculatorKeys}>
        {CALCULATOR_KEYS.map((key) => (
          <button
            key={key.ariaLabel}
            type="button"
            className={
              key.kind === "equals"
                ? styles.equalsKey
                : key.kind === "operation"
                  ? styles.operationKey
                  : undefined
            }
            aria-label={key.ariaLabel}
            onClick={() => dispatch(key.action)}
          >
            {key.icon ? <Delete aria-hidden="true" /> : key.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function keyboardAction(key: string): CalculatorAction | null {
  if (/^\d$/.test(key)) return { type: "DIGIT", digit: key };
  if (key === "." || key === ",") return { type: "DECIMAL" };
  if (key === "Enter" || key === "=") return { type: "EQUALS" };
  if (key === "Backspace") return { type: "BACKSPACE" };
  if (key === "%") return { type: "PERCENT" };
  const operations: Record<string, CalculatorOperation> = {
    "+": "ADD",
    "-": "SUBTRACT",
    "*": "MULTIPLY",
    "/": "DIVIDE",
  };
  return operations[key]
    ? { type: "OPERATION", operation: operations[key] }
    : null;
}

export function AdminUtilities() {
  const pathname = usePathname();
  const [openState, setOpenState] = useState<{
    utility: Exclude<AdminUtility, null>;
    pathname: string;
  } | null>(null);
  const activeUtility =
    openState?.pathname === pathname ? openState.utility : null;
  const [isMobile, setIsMobile] = useState(false);
  const [calculatorState, calculatorDispatch] = useReducer(
    calculatorReducer,
    undefined,
    createInitialCalculatorState,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const calendarTriggerRef = useRef<HTMLButtonElement>(null);
  const calculatorTriggerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const calendarPanelId = useId();
  const calculatorPanelId = useId();

  const closePanel = useCallback((restoreFocus = true) => {
    setOpenState(null);
    if (restoreFocus) requestAnimationFrame(() => openerRef.current?.focus());
  }, []);

  const toggleUtility = (
    utility: Exclude<AdminUtility, null>,
    trigger: HTMLButtonElement,
  ) => {
    if (activeUtility === utility) {
      closePanel();
      return;
    }
    openerRef.current = trigger;
    setOpenState({ utility, pathname });
  };

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!activeUtility) return;
    closeButtonRef.current?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePanel();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [activeUtility, closePanel]);

  useEffect(() => {
    if (!activeUtility) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
        return;
      }
      if (activeUtility !== "CALCULATOR") return;
      const target = event.target as HTMLElement;
      if (
        target.matches("input, textarea, select") ||
        target.isContentEditable
      ) {
        return;
      }
      const action = keyboardAction(event.key);
      if (!action) return;
      event.preventDefault();
      calculatorDispatch(action);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeUtility, closePanel]);

  const panelId =
    activeUtility === "CALENDAR" ? calendarPanelId : calculatorPanelId;

  return (
    <div className={styles.utilities} ref={rootRef}>
      <div className={styles.utilityButtons}>
        <button
          ref={calendarTriggerRef}
          type="button"
          className={activeUtility === "CALENDAR" ? styles.utilityButtonActive : undefined}
          aria-label="Открыть календарь"
          title="Календарь"
          aria-expanded={activeUtility === "CALENDAR"}
          aria-controls={calendarPanelId}
          aria-haspopup="dialog"
          onClick={(event) => toggleUtility("CALENDAR", event.currentTarget)}
        >
          <CalendarDays aria-hidden="true" />
        </button>
        <button
          ref={calculatorTriggerRef}
          type="button"
          className={activeUtility === "CALCULATOR" ? styles.utilityButtonActive : undefined}
          aria-label="Открыть калькулятор"
          title="Калькулятор"
          aria-expanded={activeUtility === "CALCULATOR"}
          aria-controls={calculatorPanelId}
          aria-haspopup="dialog"
          onClick={(event) => toggleUtility("CALCULATOR", event.currentTarget)}
        >
          <Calculator aria-hidden="true" />
        </button>
      </div>

      {activeUtility ? (
        <>
          <button
            type="button"
            className={styles.backdrop}
            aria-label="Закрыть панель"
            tabIndex={-1}
            onClick={() => closePanel()}
          />
          <section
            id={panelId}
            className={styles.panel}
            role="dialog"
            aria-modal={isMobile || undefined}
            aria-labelledby={titleId}
          >
            <div className={styles.panelHeader}>
              <div>
                <h2 id={titleId}>
                  {activeUtility === "CALENDAR" ? "Календарь" : "Калькулятор"}
                </h2>
                <p>
                  {activeUtility === "CALENDAR"
                    ? "Текущая дата и просмотр месяцев"
                    : "Быстрые расчёты без изменения данных Direct"}
                </p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className={styles.closeButton}
                aria-label="Закрыть панель"
                onClick={() => closePanel()}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            {activeUtility === "CALENDAR" ? (
              <CalendarPanel />
            ) : (
              <CalculatorPanel
                state={calculatorState}
                dispatch={calculatorDispatch}
              />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
