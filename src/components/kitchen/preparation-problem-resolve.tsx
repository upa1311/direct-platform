"use client";

import { useState } from "react";

import { useMutationGuard } from "@/components/util/use-mutation-guard";
import { usePrototype } from "@/prototype/prototype-provider";
import { PREPARATION_PROBLEM_RESOLUTION_REASONS } from "@/prototype/actions";
import type { Order, RestaurantWorkspaceRole } from "@/prototype/models";
import {
  getLatestResolvedPreparationProblem,
  getOpenPreparationProblem,
} from "@/prototype/selectors";
import kds from "./kitchen.module.css";

const RESOLUTION_OTHER = "Другая причина";
const RESOLUTION_REASON_MAX = 300;

/**
 * Этап 1 из 2: подтверждение решения проблемы приготовления. Оператор (в SPLIT)
 * или общий экран «Заказы» (в COMBINED) видит OPEN-проблему, причину кухни и
 * замыкает цикл кнопкой «Проблема решена» → инлайновой формой.
 *
 * Здесь НЕ отменяется заказ и не создаётся запрос в Direct — только штатный
 * resolvePreparationProblem, который не трогает статус, ETA, позиции, оплату,
 * financials, settlements и pickupCode. Отмена/возврат — отдельный этап.
 */
export function PreparationProblemResolveBlock({
  order,
  workspaceRole,
}: {
  order: Order;
  workspaceRole: RestaurantWorkspaceRole;
}) {
  const { resolvePreparationProblem } = usePrototype();
  const { error, pending, run, clearError } = useMutationGuard();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");

  const problem = getOpenPreparationProblem(order);
  const latestResolved = getLatestResolvedPreparationProblem(order);

  const isOther = reason === RESOLUTION_OTHER;
  const effectiveReason = isOther ? customReason : reason;
  const canConfirm = effectiveReason.trim().length > 0;

  // Проблемы нет: показываем спокойное подтверждение, если недавно решали.
  if (!problem) {
    if (latestResolved) {
      return (
        <p className={kds.units} role="status">
          Проблема решена. Кухня продолжает заказ.
        </p>
      );
    }
    return null;
  }

  const doResolve = async () => {
    if (!canConfirm) return;
    const res = await run(async () => {
      const r = await resolvePreparationProblem(
        order.id,
        problem.problemId,
        effectiveReason,
        "RESTAURANT",
        workspaceRole,
      );
      return { ok: r.ok, error: r.error, changed: r.ok };
    });
    if (res.ok) {
      setOpen(false);
      setReason("");
      setCustomReason("");
    }
  };

  return (
    <div className={kds.dialog} role="group" aria-label="Проблема приготовления">
      <h4 className={kds.dialogTitle}>Проблема приготовления</h4>
      <p className={kds.metaLine}>Причина кухни: {problem.reason}</p>
      <p className={kds.pickupAdminHint}>
        Заказ не отменён. Свяжитесь с клиентом или кухней и подтвердите решение.
      </p>

      {!open ? (
        <div className={kds.btnRowEnd}>
          <button
            className={`${kds.btn} ${kds.btnOutline}`}
            type="button"
            onClick={() => {
              setOpen(true);
              clearError();
            }}
          >
            Проблема решена
          </button>
        </div>
      ) : (
        <>
          <fieldset className={kds.reasonList}>
            {PREPARATION_PROBLEM_RESOLUTION_REASONS.map((r) => (
              <label className={kds.reasonOption} key={r}>
                <input
                  type="radio"
                  name={`resolve-${order.id}`}
                  checked={reason === r}
                  disabled={pending}
                  onChange={() => {
                    setReason(r);
                    clearError();
                  }}
                />
                <span>{r}</span>
              </label>
            ))}
          </fieldset>
          {isOther ? (
            <label className={kds.field}>
              <span>Ваша причина</span>
              <textarea
                maxLength={RESOLUTION_REASON_MAX}
                value={customReason}
                disabled={pending}
                onChange={(event) => {
                  setCustomReason(event.target.value);
                  clearError();
                }}
                placeholder="Опишите решение"
              />
            </label>
          ) : null}
          {error ? (
            <p className={kds.pickupError} role="alert">
              {error}
            </p>
          ) : null}
          <div className={kds.btnRowEnd}>
            <button
              className={`${kds.btn} ${kds.btnOutline}`}
              type="button"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                clearError();
              }}
            >
              Отмена
            </button>
            <button
              className={`${kds.btn} ${kds.btnDark}`}
              type="button"
              disabled={!canConfirm || pending}
              onClick={doResolve}
            >
              {pending ? "Сохраняем…" : "Подтвердить продолжение"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
