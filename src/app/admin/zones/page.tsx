"use client";

import { useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { TariffEditor } from "@/components/order-flow/tariff-editor";
import {
  feedbackFromAck,
  type MutationFeedback,
} from "@/components/util/mutation-feedback";
import { PageHeading } from "@/components/workspaces/route-content";
import type { TariffMatrix } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";

export default function AdminZonesPage() {
  const { state, saveTariffMatrix, restoreTariffs } = usePrototype();
  // Исправление 5.1: success-текст только после подтверждённого commit;
  // до завершения Promise — pending, при ошибке — русская ошибка.
  const [feedback, setFeedback] = useState<MutationFeedback | null>(null);
  const [pending, setPending] = useState(false);

  const handleSave = async (tariffs: TariffMatrix): Promise<boolean> => {
    if (pending) return false;
    setPending(true);
    setFeedback(null);
    try {
      const result = await saveTariffMatrix(tariffs);
      setFeedback(
        feedbackFromAck(
          { ...result, error: result.error ?? "Не удалось сохранить тарифы." },
          "Тарифы сохранены и уже используются в клиентской корзине.",
        ),
      );
      return result.ok;
    } finally {
      setPending(false);
    }
  };

  const handleRestore = async (): Promise<boolean> => {
    if (pending) return false;
    setPending(true);
    setFeedback(null);
    try {
      const result = await restoreTariffs();
      setFeedback(
        feedbackFromAck(
          { ...result, error: result.error ?? "Не удалось сохранить тарифы." },
          "Начальные тарифы восстановлены.",
        ),
      );
      return result.ok;
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Зоны и тарифы"
        description="Матрица стоимости доставки: зона ресторана → зона клиента. Суммы указаны в долларах США."
      />
      <section className={flowStyles.card}>
        <h2>Матрица 4 × 4</h2>
        <TariffEditor
          tariffs={state.tariffs}
          zones={state.zones}
          disabled={pending}
          onSave={handleSave}
          onRestore={handleRestore}
        />
        <div className={flowStyles.submitArea}>
          {feedback?.kind === "error" ? (
            <p className={flowStyles.errorText} role="alert">
              {feedback.text}
            </p>
          ) : (
            <p className={flowStyles.feedback} aria-live="polite">
              {pending ? "Сохраняем…" : (feedback?.text ?? "")}
            </p>
          )}
        </div>
      </section>
    </>
  );
}
