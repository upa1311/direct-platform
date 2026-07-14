"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Order } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";
import { getRestaurant, isActiveOrderStatus } from "@/prototype/selectors";
import styles from "./order-flow.module.css";

/** Ключ sessionStorage для спокойного уведомления после повторного заказа (§6–7). */
export const REPEAT_NOTICE_KEY = "direct-repeat-order-notice";

const CANCEL_REASONS = [
  "Заказал по ошибке",
  "Хочу изменить заказ",
  "Слишком долго ждать",
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

  const handleRepeat = () => {
    setError(null);
    setUnavailable([]);

    // §8: непустая корзина — подтвердить замену перед повтором.
    if (
      state.cart.items.length > 0 &&
      !window.confirm(
        "В корзине уже есть блюда. Заменить их повторным заказом?",
      )
    ) {
      return;
    }

    const result = repeatOrder(order.id);
    if (!result.ok) {
      // Корзина не изменена (проверка до мутации). Показываем причину.
      if (result.unavailableItems.length > 0) {
        setUnavailable(result.unavailableItems);
      } else {
        setError(result.error ?? "Не удалось повторить заказ.");
      }
      return;
    }

    // §6–7: спокойное уведомление показываем уже в корзине.
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
    <div className={styles.submitArea}>
      <button
        className={styles.secondaryButton}
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

/** Диалог клиентской отмены заказа (только RESTAURANT_REVIEW). */
function CancelOrderDialog({ order }: { order: Order }) {
  const { cancelClientOrder } = usePrototype();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [customReason, setCustomReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isOther = reason === "Другая причина";
  const effectiveReason = isOther ? customReason : reason;

  const confirmCancel = () => {
    const result = cancelClientOrder(order.id, effectiveReason);
    if (!result.ok) {
      setError(result.error ?? "Не удалось отменить заказ.");
      return;
    }
    setOpen(false);
    setError(null);
  };

  if (!open) {
    return (
      <div className={styles.submitArea}>
        <button
          className={styles.dangerButton}
          type="button"
          onClick={() => {
            setOpen(true);
            setError(null);
          }}
        >
          Отменить заказ
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

/** Спокойный контактный текст после принятия заказа рестораном (§13). */
function PostAcceptContact({ order }: { order: Order }) {
  const { state } = usePrototype();
  const restaurant = getRestaurant(state, order.restaurant.id);
  // Клиенту доступен только публичный телефон (не внутренние контакты).
  const publicPhone = restaurant?.publicPhone?.trim();
  return (
    <p className={styles.summaryHint} role="status">
      Для отмены свяжитесь с рестораном или поддержкой.
      {publicPhone ? (
        <>
          {" "}
          <a href={`tel:${publicPhone}`}>Позвонить ресторану</a>
        </>
      ) : null}
    </p>
  );
}

/**
 * Единая клиентская панель действий заказа для списка и детальной страницы
 * (§15): отмена только в RESTAURANT_REVIEW, иначе контактный текст, а у
 * завершённых — «Заказать снова». Одна бизнес-логика, общий компонент.
 */
export function ClientOrderActions({ order }: { order: Order }) {
  if (order.status === "RESTAURANT_REVIEW") {
    return <CancelOrderDialog order={order} />;
  }
  if (isCompleted(order)) {
    return <RepeatOrderButton order={order} />;
  }
  return <PostAcceptContact order={order} />;
}
