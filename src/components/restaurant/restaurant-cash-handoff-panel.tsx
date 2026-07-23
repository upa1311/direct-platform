"use client";

import { useRef, useState } from "react";

import kds from "@/components/kitchen/kitchen.module.css";
import sheet from "@/app/driver/driver.module.css";
import { DriverControlSheet } from "@/components/driver/driver-control-sheet";
import { usePrototype } from "@/prototype/prototype-provider";
import { getPlatformDriverCashHandoffView } from "@/prototype/platform-driver-cash-handoff";
import { formatMoney } from "@/prototype/selectors";
import type { Order, RestaurantWorkspaceRole } from "@/prototype/models";

/**
 * Наличные водителя Direct для ресторана (v21). Оператор/общий экран видят сумму
 * к получению и подтверждают фактическое получение; кухне финансовое действие
 * недоступно (панель не показывается). Сумма — из cash snapshot заказа, не
 * пересчитывается. Подтверждение проходит через существующий overlay
 * (DriverControlSheet); домен повторно проверяет право.
 */
export function RestaurantCashHandoffPanel({
  order,
  workspaceRole,
}: {
  order: Order;
  workspaceRole: RestaurantWorkspaceRole;
}) {
  const { state, restaurantConfirmDriverCashReceipt } = usePrototype();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const view = getPlatformDriverCashHandoffView(state, order);
  // Не наличный назначенный заказ водителя — панели нет. Кухня финансовую
  // панель не видит (permission bypass отсутствует и в домене).
  if (view.status === "NOT_APPLICABLE") return null;
  if (workspaceRole === "KITCHEN") return null;

  const amount =
    view.amountCents !== null
      ? formatMoney(view.amountCents, order.financials.currencyCode)
      : "—";

  const openConfirm = (event: React.MouseEvent<HTMLButtonElement>) => {
    triggerRef.current = event.currentTarget;
    setError(null);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setError(null);
  };
  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await restaurantConfirmDriverCashReceipt(
      order.restaurant.id,
      order.id,
      workspaceRole,
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
  };

  return (
    <div className={kds.cashPanel}>
      <h4 className={kds.cashPanelTitle}>Наличные водителя</h4>
      <p className={kds.cashPanelAmount}>Сумма к получению: {amount}</p>

      {view.status === "DRIVER_ACTION_REQUIRED" ? (
        <p className={kds.metaLine}>Ожидаем передачу наличных водителем</p>
      ) : null}

      {view.status === "RESTAURANT_CONFIRMATION_REQUIRED" ? (
        <>
          <p className={kds.metaLine}>Водитель сообщил, что передал {amount}</p>
          <button
            type="button"
            ref={triggerRef}
            className={`${kds.btn} ${kds.btnGreen}`}
            disabled={pending}
            onClick={openConfirm}
          >
            Подтвердить получение {amount}
          </button>
        </>
      ) : null}

      {view.status === "CONFIRMED" ? (
        <p className={kds.metaLine}>Получение {amount} подтверждено</p>
      ) : null}

      {view.status === "REVIEW_REQUIRED" ? (
        <p className={kds.metaLine}>Наличная передача требует проверки Direct.</p>
      ) : null}

      <DriverControlSheet
        open={open}
        title="Подтвердите получение наличных"
        onClose={close}
        triggerRef={triggerRef}
      >
        <p className={sheet.cashSheetText}>
          Подтвердите, что ресторан фактически получил от водителя {amount}{" "}
          наличными.
        </p>
        <div className={sheet.cashConfirmActions}>
          <button
            type="button"
            className={`${sheet.primaryButton} ${sheet.cashConfirmPrimary}`}
            disabled={pending}
            onClick={() => void confirm()}
          >
            Деньги получены
          </button>
          <button
            type="button"
            className={`${sheet.secondaryButton} ${sheet.cashConfirmSecondary}`}
            disabled={pending}
            onClick={close}
          >
            Отмена
          </button>
        </div>
        {error ? (
          <p className={sheet.error} role="alert">
            {error}
          </p>
        ) : null}
      </DriverControlSheet>
    </div>
  );
}
