"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";

import { usePrototype } from "@/prototype/prototype-provider";
import type { Order } from "@/prototype/models";
import { KitchenOrderLabel } from "./kitchen-order-label";
import {
  buildKitchenOrderLabelData,
  type KitchenOrderLabelData,
} from "./kitchen-order-label-data";
import kds from "./kitchen.module.css";

/** Устойчивый id корня печати; на него ссылается print CSS в globals.css. */
const PRINT_ROOT_ID = "kitchen-order-print-root";
/**
 * Маркер на body: печатается именно наклейка. Правило скрытия интерфейса
 * ограничено этим маркером намеренно — без него обычный Ctrl+P на любой
 * странице приложения печатал бы пустой лист.
 */
const PRINT_MARKER = "data-kitchen-print";

function ensurePrintRoot(): HTMLElement {
  const existing = document.getElementById(PRINT_ROOT_ID);
  if (existing) return existing;
  const root = document.createElement("div");
  root.id = PRINT_ROOT_ID;
  document.body.appendChild(root);
  return root;
}

/**
 * Печать одной термонаклейки на весь заказ через штатный диалог браузера.
 *
 * Печать НЕ является бизнес-мутацией: доменных действий здесь нет, статус,
 * история, revision и финансы не меняются, счётчик печати не сохраняется.
 * Повторная печать — повторное нажатие той же кнопки.
 *
 * Порядок: локальный print state → реальный рендер portal → ровно один
 * window.print() (ref-guard от повторного вызова) → очистка по afterprint.
 * Отмена системного диалога тоже приводит к afterprint и ничего не меняет.
 */
export function KitchenLabelPrintButton({ order }: { order: Order }) {
  const { state } = usePrototype();
  const [label, setLabel] = useState<KitchenOrderLabelData | null>(null);
  const [printRoot, setPrintRoot] = useState<HTMLElement | null>(null);
  const printedRef = useRef(false);

  // Печатаем только когда наклейка уже в DOM: effect выполняется после коммита
  // portal, поэтому window.print() не может напечатать пустой или прошлый заказ.
  useEffect(() => {
    if (!label || !printRoot || printedRef.current) return;
    printedRef.current = true;
    document.body.setAttribute(PRINT_MARKER, "");
    window.print();
  }, [label, printRoot]);

  useEffect(() => {
    const handleAfterPrint = () => {
      document.body.removeAttribute(PRINT_MARKER);
      printedRef.current = false;
      setLabel(null);
    };
    window.addEventListener("afterprint", handleAfterPrint);
    return () => window.removeEventListener("afterprint", handleAfterPrint);
  }, []);

  // Если карточка исчезла прямо во время печати — маркер не должен остаться.
  useEffect(() => {
    return () => {
      if (printedRef.current) document.body.removeAttribute(PRINT_MARKER);
    };
  }, []);

  return (
    <>
      <button
        className={`${kds.btn} ${kds.btnOutline} ${kds.printLabelButton}`}
        type="button"
        aria-label={`Печать наклейки для заказа ${order.publicNumber}`}
        onClick={() => {
          setPrintRoot(ensurePrintRoot());
          setLabel(buildKitchenOrderLabelData(state, order));
        }}
      >
        <Printer size={16} aria-hidden="true" />
        Печать наклейки
      </button>
      {label && printRoot
        ? createPortal(<KitchenOrderLabel data={label} />, printRoot)
        : null}
    </>
  );
}
