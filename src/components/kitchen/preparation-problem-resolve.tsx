"use client";

import { useState } from "react";

import { useMutationGuard } from "@/components/util/use-mutation-guard";
import { usePrototype } from "@/prototype/prototype-provider";
import { PREPARATION_PROBLEM_RESOLUTION_REASONS } from "@/prototype/actions";
import type { Order, RestaurantWorkspaceRole } from "@/prototype/models";
import {
  getCancellationRequestForOrder,
  getLatestResolvedPreparationProblem,
  getOpenPreparationProblem,
  getRestaurantCancellationUiState,
} from "@/prototype/selectors";
import kds from "./kitchen.module.css";

const RESOLUTION_OTHER = "Другая причина";
const REASON_MAX = 300;

/** Причины запроса отмены у Direct (UI-копия; домен принимает свободный текст). */
const CANCELLATION_REQUEST_REASONS = [
  "Нет возможности приготовить заказ",
  "Нет подходящей замены",
  "Клиент отказался от замены",
  "Другая причина",
] as const;

/** Формы решения и запроса отмены взаимоисключающие: открыта максимум одна. */
type FormMode = "NONE" | "RESOLVE" | "CANCEL";

/**
 * Оператор (в SPLIT) или общий экран «Заказы» (в COMBINED) видит OPEN-проблему
 * приготовления, причину кухни и замыкает её одним из двух действий через
 * существующий CancellationRequest pipeline:
 *   • «Проблема решена» — штатный resolvePreparationProblem (не трогает статус,
 *     ETA, оплату, financials, settlements, pickupCode);
 *   • «Запросить отмену у Direct» — requestRestaurantCancellation (PENDING-запрос
 *     администратору; заказ не отменяется до решения Direct).
 *
 * Прямой отмены заказа здесь нет. Кухонный SPLIT-экран этот блок для решения не
 * использует и кнопку отмены не получает. Состояние запроса выводится из общего
 * state (getRestaurantCancellationUiState), без локального ложного success.
 */
export function PreparationProblemResolveBlock({
  order,
  workspaceRole,
}: {
  order: Order;
  workspaceRole: RestaurantWorkspaceRole;
}) {
  const { state, resolvePreparationProblem, requestRestaurantCancellation } =
    usePrototype();
  const { error, pending, run, clearError } = useMutationGuard();
  const [formMode, setFormMode] = useState<FormMode>("NONE");
  const [resolveReason, setResolveReason] = useState("");
  const [resolveCustom, setResolveCustom] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelCustom, setCancelCustom] = useState("");

  const problem = getOpenPreparationProblem(order);
  const latestResolved = getLatestResolvedPreparationProblem(order);

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

  const request = getCancellationRequestForOrder(state, order.id);
  const cancelState = getRestaurantCancellationUiState(
    request,
    problem.problemId,
  );

  // B. PENDING ресторанный запрос по этой проблеме: ни resolve, ни повторной
  // отмены — только ожидание решения Direct. Источник — общий state.
  if (cancelState === "PENDING") {
    return (
      <div className={kds.dialog} role="group" aria-label="Проблема приготовления">
        <h4 className={kds.dialogTitle}>Проблема приготовления</h4>
        <p className={kds.metaLine}>Причина кухни: {problem.reason}</p>
        <p className={kds.pickupAdminHint} role="status">
          Запрос на отмену отправлен Direct. Ожидается решение администратора.
        </p>
        <p className={kds.metaLine}>Заказ пока не отменён.</p>
      </div>
    );
  }

  // D. APPROVED: обычно заказ уже CANCELED и ушёл с экрана; при кратком
  // stale-render показываем факт без действий.
  if (cancelState === "APPROVED") {
    return (
      <div className={kds.dialog} role="group" aria-label="Проблема приготовления">
        <h4 className={kds.dialogTitle}>Проблема приготовления</h4>
        <p className={kds.pickupAdminHint} role="status">
          Отмена одобрена Direct.
        </p>
      </div>
    );
  }

  const rejected = cancelState === "REJECTED";
  // Кнопку отмены показываем, только если на заказ ещё НЕТ ни одного запроса:
  // один request на заказ — инвариант, поэтому после REJECTED и при уже
  // существующем клиентском/legacy запросе кнопки нет. Resolve при этом остаётся
  // доступным (клиентский/legacy запрос его в домене не блокирует).
  const canRequestCancellation = request == null;

  const resolveIsOther = resolveReason === RESOLUTION_OTHER;
  const effectiveResolve = resolveIsOther ? resolveCustom : resolveReason;
  const canConfirmResolve = effectiveResolve.trim().length > 0;

  const cancelIsOther = cancelReason === RESOLUTION_OTHER;
  const effectiveCancel = cancelIsOther ? cancelCustom : cancelReason;
  const canConfirmCancel = effectiveCancel.trim().length > 0;

  const closeForm = () => {
    setFormMode("NONE");
    clearError();
  };

  const doResolve = async () => {
    if (!canConfirmResolve) return;
    const res = await run(async () => {
      const r = await resolvePreparationProblem(
        order.id,
        problem.problemId,
        effectiveResolve,
        "RESTAURANT",
        workspaceRole,
      );
      return { ok: r.ok, error: r.error, changed: r.ok };
    });
    if (res.ok) {
      setFormMode("NONE");
      setResolveReason("");
      setResolveCustom("");
    }
  };

  const doCancel = async () => {
    if (!canConfirmCancel) return;
    const res = await run(async () => {
      const r = await requestRestaurantCancellation(
        order.id,
        problem.problemId,
        effectiveCancel,
        "RESTAURANT",
        workspaceRole,
      );
      return { ok: r.ok, error: r.error, changed: r.ok };
    });
    // При успехе — форма закрывается, дальше состояние ведёт общий state.
    // При ошибке форма остаётся открытой с сохранённой причиной (без ложного
    // success), показывается одна inline-ошибка.
    if (res.ok) {
      setFormMode("NONE");
      setCancelReason("");
      setCancelCustom("");
    }
  };

  return (
    <div className={kds.dialog} role="group" aria-label="Проблема приготовления">
      <h4 className={kds.dialogTitle}>Проблема приготовления</h4>
      <p className={kds.metaLine}>Причина кухни: {problem.reason}</p>

      {rejected ? (
        <>
          <p className={kds.pickupError} role="status">
            Direct отклонил запрос на отмену: {request?.resolutionNote}
          </p>
          <p className={kds.pickupAdminHint}>
            Заказ не отменён. Решите проблему и продолжите выполнение.
          </p>
        </>
      ) : (
        <p className={kds.pickupAdminHint}>
          Заказ не отменён. Свяжитесь с клиентом или кухней и подтвердите решение.
        </p>
      )}

      {formMode === "NONE" ? (
        <div className={kds.btnRowEnd}>
          <button
            className={`${kds.btn} ${kds.btnOutline}`}
            type="button"
            onClick={() => {
              setFormMode("RESOLVE");
              clearError();
            }}
          >
            Проблема решена
          </button>
          {canRequestCancellation ? (
            <button
              className={`${kds.btn} ${kds.btnRedOutline}`}
              type="button"
              onClick={() => {
                setFormMode("CANCEL");
                clearError();
              }}
            >
              Запросить отмену у Direct
            </button>
          ) : null}
        </div>
      ) : formMode === "RESOLVE" ? (
        <>
          <fieldset className={kds.reasonList}>
            {PREPARATION_PROBLEM_RESOLUTION_REASONS.map((r) => (
              <label className={kds.reasonOption} key={r}>
                <input
                  type="radio"
                  name={`resolve-${order.id}`}
                  checked={resolveReason === r}
                  disabled={pending}
                  onChange={() => {
                    setResolveReason(r);
                    clearError();
                  }}
                />
                <span>{r}</span>
              </label>
            ))}
          </fieldset>
          {resolveIsOther ? (
            <label className={kds.field}>
              <span>Ваша причина</span>
              <textarea
                maxLength={REASON_MAX}
                value={resolveCustom}
                disabled={pending}
                onChange={(event) => {
                  setResolveCustom(event.target.value);
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
              onClick={closeForm}
            >
              Назад
            </button>
            <button
              className={`${kds.btn} ${kds.btnDark}`}
              type="button"
              disabled={!canConfirmResolve || pending}
              onClick={doResolve}
            >
              {pending ? "Сохраняем…" : "Подтвердить продолжение"}
            </button>
          </div>
        </>
      ) : (
        <>
          <fieldset className={kds.reasonList}>
            {CANCELLATION_REQUEST_REASONS.map((r) => (
              <label className={kds.reasonOption} key={r}>
                <input
                  type="radio"
                  name={`cancel-${order.id}`}
                  checked={cancelReason === r}
                  disabled={pending}
                  onChange={() => {
                    setCancelReason(r);
                    clearError();
                  }}
                />
                <span>{r}</span>
              </label>
            ))}
          </fieldset>
          {cancelIsOther ? (
            <label className={kds.field}>
              <span>Ваша причина</span>
              <textarea
                maxLength={REASON_MAX}
                value={cancelCustom}
                disabled={pending}
                onChange={(event) => {
                  setCancelCustom(event.target.value);
                  clearError();
                }}
                placeholder="Опишите причину запроса"
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
              onClick={closeForm}
            >
              Назад
            </button>
            <button
              className={`${kds.btn} ${kds.btnDark}`}
              type="button"
              disabled={!canConfirmCancel || pending}
              onClick={doCancel}
            >
              {pending ? "Отправляем…" : "Отправить запрос Direct"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
