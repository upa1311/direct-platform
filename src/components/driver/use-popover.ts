"use client";

import { useEffect, type RefObject } from "react";

/**
 * Закрытие компактного popover/меню по клику снаружи и по Escape. По Escape
 * фокус возвращается на кнопку-триггер (доступность). Клик снаружи фокус не
 * перехватывает — пользователь уже указал, куда идёт.
 */
export function useDismissable({
  open,
  onClose,
  containerRef,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLElement | null>;
}): void {
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        triggerRef?.current?.focus();
      }
    };
    const handlePointer = (event: MouseEvent) => {
      const container = containerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handlePointer);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handlePointer);
    };
  }, [open, onClose, containerRef, triggerRef]);
}
