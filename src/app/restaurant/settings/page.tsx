"use client";

import { useRestaurantWorkspace } from "@/components/workspaces/restaurant-workspace";
import { usePrototype } from "@/prototype/prototype-provider";
import type { RestaurantOrderWorkflowMode } from "@/prototype/models";
import { workflowModeLabels } from "@/prototype/selectors";
import styles from "./settings.module.css";

/**
 * Этап 10: настройки ресторана — организация работы с заказами. Две radio-card;
 * выбор меняет ТОЛЬКО Restaurant.orderWorkflowMode (заказы, статусы, ETA, оплату,
 * водителя, финансовые данные и историю не трогает). Enum пользователю не виден.
 */
const MODE_OPTIONS: readonly {
  mode: RestaurantOrderWorkflowMode;
  text: string;
  fits: string;
}[] = [
  {
    mode: "COMBINED",
    text: "Один сотрудник принимает заказы, указывает время приготовления, контролирует готовность и выдачу.",
    fits: "Подходит для небольшого ресторана или одного планшета.",
  },
  {
    mode: "SPLIT_OPERATOR_KITCHEN",
    text: "Кухня отвечает за приготовление и время. Оператор работает с клиентом, оплатой, водителем и выдачей.",
    fits: "Подходит, если у кухни есть отдельный экран или планшет.",
  },
];

export default function RestaurantSettingsPage() {
  const { state, isHydrated, setRestaurantWorkflow } = usePrototype();
  const {
    selectedRestaurantId,
    setSelectedRestaurantId,
    workspaceRestaurants,
  } = useRestaurantWorkspace();

  const restaurant = state.restaurants.find(
    (r) => r.id === selectedRestaurantId,
  );

  if (!isHydrated || !restaurant) {
    return <p className={styles.hint}>Загружаем настройки…</p>;
  }

  const currentMode = restaurant.orderWorkflowMode;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Настройки</h1>

      <div className={styles.restaurantRow}>
        <span>Ресторан</span>
        <select
          className={styles.restaurantSelect}
          aria-label="Выбрать ресторан"
          value={selectedRestaurantId}
          onChange={(event) => setSelectedRestaurantId(event.target.value)}
        >
          {workspaceRestaurants.map((r) => (
            <option value={r.id} key={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <h2 className={styles.sectionTitle}>Организация работы с заказами</h2>
      <p className={styles.hint}>
        Режим определяет, какие рабочие экраны использует ресторан. Заказы,
        статусы, время готовности и оплата при смене режима не меняются.
      </p>

      <div
        className={styles.modeGrid}
        role="radiogroup"
        aria-label="Организация работы с заказами"
      >
        {MODE_OPTIONS.map((option) => {
          const active = currentMode === option.mode;
          return (
            <label
              key={option.mode}
              className={`${styles.modeCard} ${active ? styles.modeCardActive : ""}`}
            >
              <input
                type="radio"
                name="workflow-mode"
                checked={active}
                onChange={() =>
                  setRestaurantWorkflow(restaurant.id, option.mode)
                }
              />
              <span className={styles.modeBody}>
                <span className={styles.modeName}>
                  {workflowModeLabels[option.mode]}
                </span>
                <p className={styles.modeText}>{option.text}</p>
                <p className={styles.modeFits}>{option.fits}</p>
              </span>
            </label>
          );
        })}
      </div>

      <p className={styles.appliedNote} role="status">
        Сейчас выбрано: {workflowModeLabels[currentMode]}.
      </p>
    </div>
  );
}
