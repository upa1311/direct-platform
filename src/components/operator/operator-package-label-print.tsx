"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";

import type { Order, RestaurantWorkspaceRole } from "@/prototype/models";
import { OperatorPackageLabel } from "./operator-package-label";
import {
  buildOperatorPackageLabelData,
  canPrintOperatorPackageLabel,
  type OperatorPackageLabelData,
} from "./operator-package-label-data";
import kds from "../kitchen/kitchen.module.css";

/** Устойчивый id корня печати; на него ссылается print CSS в globals.css. */
const PRINT_ROOT_ID = "operator-package-label-print-root";
/**
 * Собственный маркер на body: печатается именно пакетная наклейка. Он отдельный
 * от production-ticket маркера, поэтому два механизма печати не мешают друг
 * другу — каждый скрывает интерфейс и очищает только свой маркер.
 */
const PRINT_MARKER = "data-operator-package-label-print";

function ensurePrintRoot(): HTMLElement {
  const existing = document.getElementById(PRINT_ROOT_ID);
  if (existing) return existing;
  const root = document.createElement("div");
  root.id = PRINT_ROOT_ID;
  document.body.appendChild(root);
  return root;
}

/**
 * Печать одной пакетной наклейки на готовый заказ через штатный диалог браузера.
 * Видимость — единый helper canPrintOperatorPackageLabel: только OPERATOR/COMBINED
 * и только READY/READY_FOR_PICKUP; кухне и до готовности компонент не создаётся.
 *
 * Печать НЕ является бизнес-мутацией: доменных действий нет, статус, история,
 * revision и финансы не меняются, счётчик печати не сохраняется. Повторная
 * печать — повторное нажатие. Порядок: локальный state → реальный рендер portal
 * → ровно один window.print() (ref-guard) → очистка по afterprint.
 */
export function OperatorPackageLabelPrintButton({
  order,
  workspaceRole,
}: {
  order: Order;
  workspaceRole: RestaurantWorkspaceRole;
}) {
  const [label, setLabel] = useState<OperatorPackageLabelData | null>(null);
  const [printRoot, setPrintRoot] = useState<HTMLElement | null>(null);
  const printedRef = useRef(false);

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

  // Если карточка исчезла прямо во время печати — свой маркер не должен остаться.
  useEffect(() => {
    return () => {
      if (printedRef.current) document.body.removeAttribute(PRINT_MARKER);
    };
  }, []);

  // Единый источник видимости: кухне и до готовности не рендерим ничего.
  if (!canPrintOperatorPackageLabel(order, workspaceRole)) {
    return null;
  }

  return (
    <>
      <button
        className={`${kds.btn} ${kds.btnOutline} ${kds.printLabelButton}`}
        type="button"
        aria-label={`Печать наклейки на пакет для заказа ${order.publicNumber}`}
        onClick={() => {
          setPrintRoot(ensurePrintRoot());
          setLabel(buildOperatorPackageLabelData(order));
        }}
      >
        <Printer size={16} aria-hidden="true" />
        Печать наклейки на пакет
      </button>
      {label && printRoot
        ? createPortal(<OperatorPackageLabel data={label} />, printRoot)
        : null}
    </>
  );
}
