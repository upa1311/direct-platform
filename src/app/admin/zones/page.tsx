"use client";

import { useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { TariffEditor } from "@/components/order-flow/tariff-editor";
import { PageHeading } from "@/components/workspaces/route-content";
import type { TariffMatrix } from "@/prototype/models";
import { usePrototype } from "@/prototype/prototype-provider";

export default function AdminZonesPage() {
  const { state, saveTariffMatrix, restoreTariffs } = usePrototype();
  const [feedback, setFeedback] = useState("");

  const handleSave = (tariffs: TariffMatrix) => {
    saveTariffMatrix(tariffs);
    setFeedback("Тарифы сохранены и уже используются в клиентской корзине.");
  };

  const handleRestore = () => {
    restoreTariffs();
    setFeedback("Начальные тарифы восстановлены.");
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
          onSave={handleSave}
          onRestore={handleRestore}
        />
        <div className={flowStyles.submitArea}>
          <p className={flowStyles.feedback} aria-live="polite">
            {feedback}
          </p>
        </div>
      </section>
    </>
  );
}
