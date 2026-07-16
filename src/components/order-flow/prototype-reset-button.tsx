"use client";

import { useState } from "react";

import { usePrototype } from "@/prototype/prototype-provider";
import styles from "@/components/workspaces/workspace-shell.module.css";

export function PrototypeResetButton() {
  const { resetPrototype } = usePrototype();
  // Исправление 5.4: сброс не считается выполненным без подтверждённого commit;
  // при ошибке показывается русское сообщение, кнопка блокируется на время операции.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReset = async () => {
    if (pending) return;
    const confirmed = window.confirm(
      "Сбросить корзину, заказы и тарифы до начальных тестовых данных?",
    );
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      const result = await resetPrototype();
      if (!result.ok) {
        setError(result.error ?? "Не удалось сбросить данные.");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button
        className={styles.resetButton}
        type="button"
        disabled={pending}
        onClick={() => void handleReset()}
      >
        {pending ? "Сбрасываем…" : "Сбросить данные"}
      </button>
      {error ? (
        <span className={styles.resetError} role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
