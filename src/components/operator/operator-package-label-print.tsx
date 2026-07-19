"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Printer } from "lucide-react";

import type { Order, RestaurantWorkspaceRole } from "@/prototype/models";
import { OperatorPackageLabel } from "./operator-package-label";
import {
  buildOperatorPackageLabelData,
  canPrintOperatorPackageLabel,
  PACKAGE_LABEL_LOGO_ERROR,
  PACKAGE_LABEL_PAYMENT_ERROR,
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
/** Устойчивый селектор логотипа внутри наклейки. */
const LOGO_SELECTOR = "[data-package-label-logo]";

function ensurePrintRoot(): HTMLElement {
  const existing = document.getElementById(PRINT_ROOT_ID);
  if (existing) return existing;
  const root = document.createElement("div");
  root.id = PRINT_ROOT_ID;
  document.body.appendChild(root);
  return root;
}

/**
 * Дожидается реальной готовности логотипа: сначала HTMLImageElement.decode(),
 * а если он недоступен — complete && naturalWidth > 0, иначе события load/error.
 * Реджект означает, что картинки нет: печатать наклейку без логотипа нельзя.
 */
async function waitForLabelLogo(root: HTMLElement): Promise<void> {
  const image = root.querySelector<HTMLImageElement>(LOGO_SELECTOR);
  if (!image) {
    throw new Error("package label logo element is missing");
  }
  if (typeof image.decode === "function") {
    await image.decode();
    return;
  }
  if (image.complete) {
    if (image.naturalWidth > 0) return;
    throw new Error("package label logo failed to load");
  }
  await new Promise<void>((resolve, reject) => {
    image.addEventListener(
      "load",
      () => {
        if (image.naturalWidth > 0) resolve();
        else reject(new Error("package label logo is empty"));
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => reject(new Error("package label logo failed to load")),
      { once: true },
    );
  });
}

/**
 * Печать одной пакетной наклейки на готовый заказ через штатный диалог браузера.
 * Видимость — единый helper canPrintOperatorPackageLabel: только
 * OPERATOR/COMBINED/KITCHEN и только READY/READY_FOR_PICKUP; до готовности
 * компонент не создаётся.
 *
 * Печать НЕ является бизнес-мутацией: доменных действий нет, статус, история,
 * revision и финансы не меняются, счётчик печати не сохраняется.
 *
 * Порядок: платёжный блок должен быть определён → рендер portal → ожидание
 * загрузки логотипа → ровно один window.print() (ref-guard) → очистка по
 * afterprint. Если платёж не распознан или логотип не загрузился, печать не
 * запускается вовсе: маркер снимается, состояние очищается, у кнопки появляется
 * понятная ошибка, а повторное нажатие пробует снова.
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
  const [error, setError] = useState<string | null>(null);
  const printedRef = useRef(false);
  /** Отсекает результат устаревшей попытки (повторное нажатие после ошибки). */
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!label || !printRoot || printedRef.current) return;
    // Guard: одна попытка печати на одну подготовленную наклейку.
    printedRef.current = true;
    const attempt = ++attemptRef.current;
    let canceled = false;

    void waitForLabelLogo(printRoot).then(
      () => {
        if (canceled || attempt !== attemptRef.current) return;
        // Маркер ставится только когда логотип уже готов: наклейка без
        // логотипа не печатается никогда.
        document.body.setAttribute(PRINT_MARKER, "");
        window.print();
      },
      () => {
        if (canceled || attempt !== attemptRef.current) return;
        document.body.removeAttribute(PRINT_MARKER);
        printedRef.current = false;
        setLabel(null);
        setError(PACKAGE_LABEL_LOGO_ERROR);
      },
    );

    return () => {
      canceled = true;
    };
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

  // Единый источник видимости: до готовности не рендерим ничего.
  if (!canPrintOperatorPackageLabel(order, workspaceRole)) {
    return null;
  }

  const handlePrint = () => {
    setError(null);
    // Платёжный блок не угадываем: без него наклейка не печатается.
    const data = buildOperatorPackageLabelData(order);
    if (!data) {
      setError(PACKAGE_LABEL_PAYMENT_ERROR);
      return;
    }
    setPrintRoot(ensurePrintRoot());
    setLabel(data);
  };

  return (
    <>
      <button
        className={`${kds.btn} ${kds.btnOutline} ${kds.printLabelButton}`}
        type="button"
        aria-label={`Печать наклейки на пакет для заказа ${order.publicNumber}`}
        onClick={handlePrint}
      >
        <Printer size={16} aria-hidden="true" />
        Печать наклейки на пакет
      </button>
      {error ? (
        <p className={kds.pickupError} role="alert">
          {error}
        </p>
      ) : null}
      {label && printRoot
        ? createPortal(<OperatorPackageLabel data={label} />, printRoot)
        : null}
    </>
  );
}
