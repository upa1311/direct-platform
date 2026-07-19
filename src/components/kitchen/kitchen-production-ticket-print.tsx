"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { Order } from "@/prototype/models";
import { KitchenProductionTicket } from "./kitchen-production-ticket";
import { buildKitchenProductionTicketData } from "./kitchen-production-ticket-data";

/** Устойчивый id корня печати; на него ссылается print CSS в globals.css. */
const PRINT_ROOT_ID = "kitchen-production-print-root";
/**
 * Маркер на body: печатается именно производственный тикет. Правило скрытия
 * интерфейса ограничено этим маркером намеренно — без него обычный Ctrl+P на
 * любой странице приложения печатал бы пустой лист.
 */
const PRINT_MARKER = "data-kitchen-production-print";

function ensurePrintRoot(): HTMLElement {
  const existing = document.getElementById(PRINT_ROOT_ID);
  if (existing) return existing;
  const root = document.createElement("div");
  root.id = PRINT_ROOT_ID;
  document.body.appendChild(root);
  return root;
}

/**
 * Печать производственного тикета при принятии заказа. Печать выполняется на
 * уровне страницы (а не карточки, которая после принятия уходит из «Новых»),
 * поэтому используются КАНОНИЧЕСКИЕ данные уже принятого заказа, а не устаревшее
 * pre-accept состояние.
 *
 * `requestPrint(orderId)` ставит заказ в очередь на печать. Тикет строится ТОЛЬКО
 * когда этот заказ в актуальном state перешёл из RESTAURANT_REVIEW (успешно
 * принят); при неуспешном/отсутствующем приёме тикета и печати нет. Ровно один
 * window.print() на запрос (ref-guard); отмена диалога приводит к afterprint и
 * ничего не меняет. Печать НЕ бизнес-мутация: статус, история, revision и финансы
 * не трогаются. setState вызывается только в обработчиках событий, не в effect.
 */
export function useKitchenProductionTicketPrint(
  orders: readonly Order[],
  timeZone: string,
): { requestPrint: (orderId: string) => void; printPortal: ReactNode } {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [printRoot, setPrintRoot] = useState<HTMLElement | null>(null);
  const printedRef = useRef(false);

  // Каноническое принятое состояние: тикет строим в фазе render (без setState),
  // только когда заказ уже НЕ в review.
  const pendingOrder = pendingId
    ? orders.find((order) => order.id === pendingId)
    : undefined;
  const ticket =
    pendingOrder && pendingOrder.status !== "RESTAURANT_REVIEW"
      ? buildKitchenProductionTicketData(pendingOrder, timeZone)
      : null;

  // Печатаем ровно один раз, когда тикет уже в DOM. Ref-guard, без setState.
  useEffect(() => {
    if (!ticket || !printRoot || printedRef.current) return;
    printedRef.current = true;
    document.body.setAttribute(PRINT_MARKER, "");
    window.print();
  }, [ticket, printRoot]);

  useEffect(() => {
    const handleAfterPrint = () => {
      document.body.removeAttribute(PRINT_MARKER);
      printedRef.current = false;
      setPendingId(null);
    };
    window.addEventListener("afterprint", handleAfterPrint);
    return () => window.removeEventListener("afterprint", handleAfterPrint);
  }, []);

  // Корень печати и запрос ставятся в обработчике события (не в effect).
  const requestPrint = (orderId: string) => {
    setPrintRoot(ensurePrintRoot());
    setPendingId(orderId);
  };

  const printPortal =
    ticket && printRoot
      ? createPortal(<KitchenProductionTicket data={ticket} />, printRoot)
      : null;

  return { requestPrint, printPortal };
}
