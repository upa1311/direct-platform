"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Order } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  canClientCancelDirectly,
  canClientRequestCancellation,
  getCancellationRequestForOrder,
  getClientCancellationMessage,
  getPostPreparationWarning,
  isActiveOrderStatus,
} from "@/prototype/selectors";
import styles from "./order-flow.module.css";

/** Ключ sessionStorage для спокойного уведомления после повторного заказа. */
export const REPEAT_NOTICE_KEY = "direct-repeat-order-notice";

/** Причины бесплатной отмены (до приготовления). */
const CANCEL_REASONS = [
  "Заказал по ошибке",
  "Хочу изменить заказ",
  "Слишком долго ждать",
  "Другая причина",
] as const;

/** Причины запроса на отмену (после начала приготовления, §10). */
const REQUEST_REASONS = [
  "Хочу изменить заказ",
  "Изменились планы",
  "Слишком долго ждать",
  "Ошибка в адресе",
  "Другая причина",
] as const;

function isCompleted(order: Order): boolean {
  return !isActiveOrderStatus(order.status);
}

/** Кнопка «Заказать снова» с проверкой конфликта корзины и уведомлениями. */
function RepeatOrderButton({ order }: { order: Order }) {
  const router = useRouter();
  const { state, repeatOrder } = usePrototype();
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string[]>([]);

  const handleRepeat = async () => {
    setError(null);
    setUnavailable([]);
    if (
      state.cart.items.length > 0 &&
      !window.confirm("В корзине уже есть блюда. Заменить их повторным заказом?")
    ) {
      return;
    }
    const result = await repeatOrder(order.id);
    if (!result.ok) {
      if (result.unavailableItems.length > 0) {
        setUnavailable(result.unavailableItems);
      } else {
        setError(result.error ?? "Не удалось повторить заказ.");
      }
      return;
    }
    const notices: string[] = [];
    if (result.fulfillmentChanged) {
      notices.push(
        "Прежний способ получения недоступен. Проверьте выбранный вариант.",
      );
    }
    if (result.pricesChanged) {
      notices.push(
        "Заказ добавлен в корзину. Некоторые цены изменились — проверьте итог перед оформлением.",
      );
    }
    if (notices.length > 0) {
      window.sessionStorage.setItem(REPEAT_NOTICE_KEY, notices.join(" "));
    }
    router.push("/client/cart#checkout-cart");
  };

  return (
    <div className={styles.repeatOrderArea}>
      <button
        className={styles.repeatOrderButton}
        type="button"
        onClick={handleRepeat}
      >
        Заказать снова
      </button>
      {unavailable.length > 0 ? (
        <div className={styles.warningNotice} role="alert">
          <strong>Не удалось повторить заказ. Сейчас недоступны:</strong>
          <ul className={styles.plainList}>
            {unavailable.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? (
        <div className={styles.warningNotice} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** Компактная бесплатная отмена (RESTAURANT_REVIEW / AWAITING_PAYMENT), §6–7. */
function DirectCancel({ order }: { order: Order }) {
  const { cancelClientOrder } = usePrototype();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isOther = reason === "Другая причина";
  const effectiveReason = isOther ? customReason : reason;

  const confirmCancel = async () => {
    const result = await cancelClientOrder(order.id, effectiveReason);
    if (!result.ok) {
      setError(result.error ?? "Не удалось отменить заказ.");
      return;
    }
    setOpen(false);
    setError(null);
  };

  if (!open) {
    return (
      <div className={styles.cancelActionRow}>
        <button
          className={`${styles.secondaryButton} ${styles.cancelInlineButton}`}
          type="button"
          onClick={() => {
            setOpen(true);
            setError(null);
          }}
        >
          Отменить
        </button>
      </div>
    );
  }

  return (
    <div className={styles.cancelDialog} role="group" aria-label="Отмена заказа">
      <h3 className={styles.sectionTitle}>Отменить заказ?</h3>
      <p className={styles.summaryHint}>Укажите причину отмены.</p>
      <fieldset className={styles.cancelReasons}>
        {CANCEL_REASONS.map((r) => (
          <label className={styles.cancelReasonOption} key={r}>
            <input
              type="radio"
              name={`cancel-reason-${order.id}`}
              checked={reason === r}
              onChange={() => {
                setReason(r);
                setError(null);
              }}
            />
            <span>{r}</span>
          </label>
        ))}
      </fieldset>
      {isOther ? (
        <label className={styles.field}>
          <span>Ваша причина</span>
          <textarea
            value={customReason}
            onChange={(event) => {
              setCustomReason(event.target.value);
              setError(null);
            }}
            placeholder="Опишите причину отмены"
          />
        </label>
      ) : null}
      {error ? (
        <div className={styles.warningNotice} role="alert">
          {error}
        </div>
      ) : null}
      <div className={styles.buttonRow}>
        <button
          className={styles.dangerButton}
          type="button"
          disabled={!effectiveReason.trim()}
          onClick={confirmCancel}
        >
          Подтвердить отмену
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Не отменять
        </button>
      </div>
    </div>
  );
}

/** Запрос на отмену после начала приготовления (§8, §10, §13). */
function RequestCancellation({ order }: { order: Order }) {
  const { state, requestCancellation } = usePrototype();
  const request = getCancellationRequestForOrder(state, order.id);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isOther = reason === "Другая причина";
  const effectiveReason = isOther ? customReason : reason;

  // Уже есть запрос — показываем его статус, кнопку скрываем.
  if (request) {
    const statusMessage = getClientCancellationMessage(request);
    return (
      <div className={styles.requestStatusBlock} role="status">
        <strong>{statusMessage}</strong>
        {request.status === "PENDING" ? (
          <p className={styles.summaryHint}>
            Пока администратор рассматривает запрос, заказ продолжает
            выполняться.
          </p>
        ) : null}
        {request.status === "REJECTED" ? (
          <p className={styles.summaryHint}>Заказ продолжает выполняться.</p>
        ) : null}
      </div>
    );
  }

  const submitRequest = async () => {
    const result = await requestCancellation(order.id, effectiveReason);
    if (!result.ok) {
      setError(result.error ?? "Не удалось отправить запрос.");
      return;
    }
    setOpen(false);
    setError(null);
  };

  return (
    <div className={styles.requestCancelBlock}>
      <p className={styles.requestWarningText}>
        {getPostPreparationWarning(order)}
      </p>
      {!open ? (
        <div className={styles.cancelActionRow}>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => {
              setOpen(true);
              setError(null);
            }}
          >
            Запросить отмену
          </button>
        </div>
      ) : (
        <div
          className={styles.cancelDialog}
          role="group"
          aria-label="Запрос на отмену"
        >
          <h3 className={styles.sectionTitle}>Запросить отмену?</h3>
          <p className={styles.summaryHint}>Укажите причину запроса.</p>
          <fieldset className={styles.cancelReasons}>
            {REQUEST_REASONS.map((r) => (
              <label className={styles.cancelReasonOption} key={r}>
                <input
                  type="radio"
                  name={`request-reason-${order.id}`}
                  checked={reason === r}
                  onChange={() => {
                    setReason(r);
                    setError(null);
                  }}
                />
                <span>{r}</span>
              </label>
            ))}
          </fieldset>
          {isOther ? (
            <label className={styles.field}>
              <span>Ваша причина</span>
              <textarea
                value={customReason}
                onChange={(event) => {
                  setCustomReason(event.target.value);
                  setError(null);
                }}
                placeholder="Опишите причину запроса"
              />
            </label>
          ) : null}
          {error ? (
            <div className={styles.warningNotice} role="alert">
              {error}
            </div>
          ) : null}
          <div className={styles.buttonRow}>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={!effectiveReason.trim()}
              onClick={submitRequest}
            >
              Отправить запрос
            </button>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Не отправлять
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Завершённый заказ: сообщение об одобренной отмене (§4) + «Заказать снова». */
function CompletedActions({ order }: { order: Order }) {
  const { state } = usePrototype();
  const request = getCancellationRequestForOrder(state, order.id);
  return (
    <>
      {request?.status === "APPROVED" ? (
        <div className={styles.requestStatusBlock} role="status">
          <strong>{getClientCancellationMessage(request)}</strong>
        </div>
      ) : null}
      <RepeatOrderButton order={order} />
    </>
  );
}

/**
 * Единая клиентская панель действий заказа (§15). До приготовления — компактная
 * бесплатная «Отменить»; во время приготовления/доставки — запрос на отмену и
 * его статус; у завершённых — сообщение об одобрении (если было) + «Заказать
 * снова». Статус запроса показывается ТОЛЬКО здесь (§4), без дублей на карточке.
 */
export function ClientOrderActions({
  order,
  compact = false,
}: {
  order: Order;
  /**
   * §3: компактный режим для списка «Мои заказы». До приготовления — компактная
   * «Отменить»; после начала приготовления — ничего (полный запрос на отмену и
   * длинное предупреждение остаются на детальной странице, без дублирования);
   * у завершённого — только «Заказать снова».
   */
  compact?: boolean;
}) {
  if (canClientCancelDirectly(order)) {
    return <DirectCancel order={order} />;
  }
  if (canClientRequestCancellation(order)) {
    return compact ? null : <RequestCancellation order={order} />;
  }
  if (isCompleted(order)) {
    return compact ? <RepeatOrderButton order={order} /> : (
      <CompletedActions order={order} />
    );
  }
  return null;
}
