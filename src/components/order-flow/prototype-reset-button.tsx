"use client";

import { usePrototype } from "@/prototype/prototype-provider";
import styles from "@/components/workspaces/workspace-shell.module.css";

export function PrototypeResetButton() {
  const { resetPrototype } = usePrototype();

  const handleReset = () => {
    const confirmed = window.confirm(
      "Сбросить корзину, заказы и тарифы до начальных тестовых данных?",
    );
    if (confirmed) {
      void resetPrototype();
    }
  };

  return (
    <button className={styles.resetButton} type="button" onClick={handleReset}>
      Сбросить данные
    </button>
  );
}
