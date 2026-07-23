"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

import styles from "@/app/driver/driver.module.css";

/**
 * Общий overlay управления сменой: статус и выбор зоны открываются им, а не
 * flow-блоком, который раздвигал бы счётчики, предложения и активный заказ.
 *
 * На телефоне (до 520 px) — нижний sheet поверх залипшего заголовка, под ним
 * backdrop. На широком экране CSS превращает тот же узел в компактный
 * центрированный диалог. Общее поведение: backdrop и Escape закрывают,
 * фокус возвращается на кнопку-триггер, при открытии фокус уходит внутрь,
 * горизонтального переполнения body не возникает.
 */
export function DriverControlSheet({
  open,
  title,
  onClose,
  triggerRef,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}): ReactNode {
  const sheetRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  // Был ли лист открыт — чтобы вернуть фокус на триггер только после закрытия,
  // а не при первом монтировании.
  const wasOpen = useRef(false);

  // Escape закрывает лист (фокус вернётся эффектом ниже).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Открытие — фокус внутрь листа; закрытие — фокус обратно на триггер.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      const first = sheetRef.current?.querySelector<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]",
      );
      first?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      triggerRef.current?.focus();
    }
  }, [open, triggerRef]);

  if (!open) return null;

  return (
    <>
      <div
        className={styles.sheetBackdrop}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className={styles.controlSheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={sheetRef}
      >
        <div className={styles.sheetHeader}>
          <span className={styles.sheetTitle} id={headingId}>
            {title}
          </span>
          <button
            type="button"
            className={styles.sheetClose}
            aria-label="Закрыть"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className={styles.sheetBody}>{children}</div>
      </div>
    </>
  );
}
