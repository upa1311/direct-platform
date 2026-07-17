"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Settings } from "lucide-react";

import { useMutationGuard } from "@/components/util/use-mutation-guard";
import { usePrototype } from "@/prototype/prototype-provider";
import { workflowModeLabels } from "@/prototype/selectors";
import type { RestaurantOrderWorkflowMode } from "@/prototype/models";
import {
  RESTAURANT_SETTINGS_BUTTON_LABEL,
  WORKFLOW_MODE_HINTS,
  WORKFLOW_MODE_ORDER,
} from "./restaurant-nav";
import { useRestaurantWorkspace } from "./restaurant-workspace";
import styles from "./workspace-shell.module.css";

/**
 * Режим работы выбранного ресторана: шестерёнка справа в шапке + компактный
 * popover. Отдельной страницы настроек нет.
 *
 * Мутация — штатная setRestaurantWorkflow (меняет только orderWorkflowMode).
 * Второй реализации режима здесь нет: radio отражают ТОЛЬКО подтверждённый
 * общий state, поэтому ложного «сохранено» не бывает, а при ошибке остаётся
 * прежний режим и popover не закрывается.
 */
export function RestaurantSettingsMenu() {
  const { state, isHydrated, setRestaurantWorkflow } = usePrototype();
  const { selectedRestaurantId } = useRestaurantWorkspace();
  const { error, pending, run, clearError } = useMutationGuard();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const radioGroupName = useId();

  const restaurant = state.restaurants.find((r) => r.id === selectedRestaurantId);
  const currentMode: RestaurantOrderWorkflowMode =
    restaurant?.orderWorkflowMode ?? "COMBINED";

  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      clearError();
      if (returnFocus) buttonRef.current?.focus();
    },
    [clearError],
  );

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Escape закрывает и возвращает фокус на шестерёнку.
      if (event.key === "Escape") close(true);
    };
    // Клик вне popover закрывает его, но не перехватывает фокус у того
    // элемента, по которому пользователь кликнул.
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open, close]);

  const selectMode = async (mode: RestaurantOrderWorkflowMode) => {
    // Совпадающий режим — доменная ошибка «уже изменён другой вкладкой»,
    // поэтому текущий вариант не перезапускаем.
    if (!restaurant || mode === currentMode) return;
    const ack = await run(() => setRestaurantWorkflow(restaurant.id, mode));
    if (ack.ok) close(true);
  };

  return (
    <div className={styles.navSettings} ref={containerRef}>
      <button
        ref={buttonRef}
        className={styles.navSettingsButton}
        type="button"
        aria-label={RESTAURANT_SETTINGS_BUTTON_LABEL}
        title={RESTAURANT_SETTINGS_BUTTON_LABEL}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <Settings aria-hidden="true" />
      </button>

      {open ? (
        <div
          className={styles.settingsPopover}
          role="dialog"
          aria-label={RESTAURANT_SETTINGS_BUTTON_LABEL}
        >
          <h2 className={styles.settingsTitle}>Режим работы</h2>

          {isHydrated && restaurant ? (
            <>
              <div
                className={styles.settingsOptions}
                role="radiogroup"
                aria-label="Режим работы"
              >
                {WORKFLOW_MODE_ORDER.map((mode) => (
                  <label className={styles.settingsOption} key={mode}>
                    <input
                      type="radio"
                      name={radioGroupName}
                      checked={currentMode === mode}
                      disabled={pending}
                      onChange={() => void selectMode(mode)}
                    />
                    <span>
                      <span className={styles.settingsOptionName}>
                        {workflowModeLabels[mode]}
                      </span>
                      <span className={styles.settingsOptionHint}>
                        {WORKFLOW_MODE_HINTS[mode]}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              {pending ? (
                <p className={styles.settingsPending} aria-live="polite">
                  Сохраняем…
                </p>
              ) : null}
              {error ? (
                <p className={styles.settingsError} role="alert">
                  {error}
                </p>
              ) : null}
            </>
          ) : (
            <p className={styles.settingsHint}>Загружаем настройки…</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
