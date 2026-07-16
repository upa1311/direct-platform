"use client";

import { useEffect, useState } from "react";

import { createDefaultTariffs } from "@/prototype/default-state";
import type { TariffMatrix, Zone, ZoneId } from "@/prototype/models";
import styles from "./order-flow.module.css";

function cloneTariffs(tariffs: TariffMatrix): TariffMatrix {
  return {
    "zone-1": { ...tariffs["zone-1"] },
    "zone-2": { ...tariffs["zone-2"] },
    "zone-3": { ...tariffs["zone-3"] },
    "zone-4": { ...tariffs["zone-4"] },
  };
}

function getTariffSignature(tariffs: TariffMatrix): string {
  return JSON.stringify(tariffs);
}

interface TariffEditorProps {
  tariffs: TariffMatrix;
  zones: Zone[];
  /** Возвращает true только после подтверждённого сохранения (Исправление 5.1). */
  onSave: (tariffs: TariffMatrix) => Promise<boolean>;
  onRestore: () => Promise<boolean>;
  disabled?: boolean;
}

export function TariffEditor({
  tariffs,
  zones,
  onSave,
  onRestore,
  disabled = false,
}: TariffEditorProps) {
  const [draft, setDraft] = useState<TariffMatrix>(() =>
    cloneTariffs(tariffs),
  );
  const [acceptedSignature, setAcceptedSignature] = useState(() =>
    getTariffSignature(tariffs),
  );
  const [externalTariffs, setExternalTariffs] =
    useState<TariffMatrix | null>(null);
  const incomingSignature = getTariffSignature(tariffs);
  const draftSignature = getTariffSignature(draft);
  const isDirty = draftSignature !== acceptedSignature;

  useEffect(() => {
    if (incomingSignature === acceptedSignature) {
      return;
    }

    const incomingTariffs = cloneTariffs(tariffs);
    let isActive = true;

    queueMicrotask(() => {
      if (!isActive) {
        return;
      }

      if (isDirty) {
        setExternalTariffs(incomingTariffs);
        return;
      }

      setDraft(incomingTariffs);
      setAcceptedSignature(incomingSignature);
      setExternalTariffs(null);
    });

    return () => {
      isActive = false;
    };
  }, [acceptedSignature, incomingSignature, isDirty, tariffs]);

  const updateTariff = (
    restaurantZoneId: ZoneId,
    customerZoneId: ZoneId,
    dollars: string,
  ) => {
    const cents = Math.max(0, Math.round(Number(dollars || 0) * 100));
    setDraft((current) => ({
      ...current,
      [restaurantZoneId]: {
        ...current[restaurantZoneId],
        [customerZoneId]: cents,
      },
    }));
  };

  const handleSave = async () => {
    // Исправление 5.1: черновик принимается ТОЛЬКО после успешного commit;
    // при ошибке введённые значения сохраняются и остаются «несохранёнными».
    const savedSignature = draftSignature;
    const ok = await onSave(cloneTariffs(draft));
    if (!ok) {
      return;
    }
    setAcceptedSignature(savedSignature);
    setExternalTariffs(null);
  };

  const handleRestore = async () => {
    const ok = await onRestore();
    if (!ok) {
      return;
    }
    const defaultTariffs = createDefaultTariffs();
    setDraft(defaultTariffs);
    setAcceptedSignature(getTariffSignature(defaultTariffs));
    setExternalTariffs(null);
  };

  const keepDraft = () => {
    if (!externalTariffs) {
      return;
    }
    setAcceptedSignature(getTariffSignature(externalTariffs));
    setExternalTariffs(null);
  };

  const loadExternalTariffs = () => {
    if (!externalTariffs) {
      return;
    }
    const nextTariffs = cloneTariffs(externalTariffs);
    setDraft(nextTariffs);
    setAcceptedSignature(getTariffSignature(nextTariffs));
    setExternalTariffs(null);
  };

  return (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.tariffTable}>
          <thead>
            <tr>
              <th scope="col">Зона ресторана</th>
              {zones.map((zone) => (
                <th scope="col" key={zone.id}>
                  Клиент: {zone.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {zones.map((restaurantZone) => (
              <tr key={restaurantZone.id}>
                <th scope="row">{restaurantZone.name}</th>
                {zones.map((customerZone) => (
                  <td key={customerZone.id}>
                    <label>
                      <span className="sr-only">
                        {restaurantZone.name} → {customerZone.name}
                      </span>
                      <input
                        className={styles.tariffInput}
                        type="number"
                        min="0"
                        step="0.01"
                        value={(
                          draft[restaurantZone.id][customerZone.id] / 100
                        ).toFixed(2)}
                        onChange={(event) =>
                          updateTariff(
                            restaurantZone.id,
                            customerZone.id,
                            event.target.value,
                          )
                        }
                      />
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {externalTariffs ? (
        <div className={styles.warningNotice} role="alert">
          <p>
            Тарифы изменились в другой вкладке. Ваш несохранённый черновик
            сохранён. Перезагрузить актуальные значения?
          </p>
          <div className={styles.buttonRow}>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={keepDraft}
            >
              Оставить мой черновик
            </button>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={loadExternalTariffs}
            >
              Загрузить актуальные тарифы
            </button>
          </div>
        </div>
      ) : null}
      <div className={styles.buttonRow}>
        <button
          className={styles.primaryButton}
          type="button"
          disabled={disabled}
          onClick={() => void handleSave()}
        >
          {disabled ? "Сохраняем…" : "Сохранить тарифы"}
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          disabled={disabled}
          onClick={() => void handleRestore()}
        >
          Восстановить начальные значения
        </button>
      </div>
      <p className={styles.feedback} aria-live="polite">
        {isDirty ? "Есть несохранённые изменения." : ""}
      </p>
    </>
  );
}
