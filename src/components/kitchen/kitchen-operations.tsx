"use client";

import { useMemo, useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { usePrototype } from "@/prototype/prototype-provider";
import type {
  MenuItem,
  OperationalPauseMode,
  Restaurant,
} from "@/prototype/models";
import {
  getRestaurantMenu,
  getRestaurantOperationalEvents,
  isMenuItemAvailableAt,
  isOperationalPauseActiveAt,
} from "@/prototype/selectors";

const PAUSE_REASONS = [
  "Кухня перегружена",
  "Техническая проблема",
  "Закончились основные продукты",
  "Скоро закрытие",
  "Недостаточно сотрудников",
  "Другая причина",
] as const;

const ITEM_REASONS = [
  "Закончилось блюдо",
  "Закончился ингредиент",
  "Оборудование временно недоступно",
  "Не можем выполнить текущие заказы",
  "Другая причина",
] as const;

type DurationChoice = "15" | "30" | "60" | "UNTIL_NEXT_OPEN" | "MANUAL";

const RESTAURANT_DURATIONS: { value: DurationChoice; label: string }[] = [
  { value: "15", label: "15 минут" },
  { value: "30", label: "30 минут" },
  { value: "60", label: "60 минут" },
  { value: "UNTIL_NEXT_OPEN", label: "До следующего открытия" },
  { value: "MANUAL", label: "До ручного включения" },
];

const ITEM_DURATIONS: { value: DurationChoice; label: string }[] = [
  { value: "30", label: "30 минут" },
  { value: "60", label: "60 минут" },
  { value: "UNTIL_NEXT_OPEN", label: "До следующего открытия" },
  { value: "MANUAL", label: "До ручного включения" },
];

const EVENT_ACTION_LABELS: Record<string, string> = {
  RESTAURANT_PAUSED: "Приём приостановлен",
  RESTAURANT_RESUMED: "Приём возобновлён",
  MENU_ITEM_UNAVAILABLE: "Блюдо отключено",
  MENU_ITEM_AVAILABLE: "Блюдо возвращено",
};

const ACTOR_LABELS: Record<string, string> = {
  RESTAURANT: "Ресторан",
  ADMIN: "Администратор Direct",
  SYSTEM: "Система",
};

/** Перевод выбора длительности в mode + resumeAt для domain-action. */
function durationToPause(choice: DurationChoice): {
  mode: OperationalPauseMode;
  resumeAt: string | null;
} {
  if (choice === "MANUAL") return { mode: "MANUAL", resumeAt: null };
  if (choice === "UNTIL_NEXT_OPEN") {
    return { mode: "UNTIL_NEXT_OPEN", resumeAt: null };
  }
  const minutes = Number(choice);
  return {
    mode: "UNTIL_TIME",
    resumeAt: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
}

function formatTimeInZone(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timeZone || "Europe/Chisinau",
  }).format(new Date(iso));
}

/** Панель выбора причины + срока (общая для паузы ресторана и блюда). */
function ReasonDurationPanel({
  reasons,
  durations,
  onConfirm,
  onCancel,
  confirmLabel,
  affectedLabel,
}: {
  reasons: readonly string[];
  durations: { value: DurationChoice; label: string }[];
  onConfirm: (reason: string, choice: DurationChoice) => void;
  onCancel: () => void;
  confirmLabel: string;
  affectedLabel?: string;
}) {
  const [reason, setReason] = useState(reasons[0]);
  const [custom, setCustom] = useState("");
  const [choice, setChoice] = useState<DurationChoice>(durations[0].value);
  const isOther = reason === "Другая причина";
  const effectiveReason = isOther ? custom : reason;

  return (
    <div className={flowStyles.opPanel}>
      <label className={flowStyles.field}>
        <span>Причина</span>
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {reasons.map((r) => (
            <option value={r} key={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      {isOther ? (
        <label className={flowStyles.field}>
          <span>Ваша причина</span>
          <textarea
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Опишите причину"
          />
        </label>
      ) : null}
      <label className={flowStyles.field}>
        <span>Срок</span>
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value as DurationChoice)}
        >
          {durations.map((d) => (
            <option value={d.value} key={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {affectedLabel ? (
        <p className={flowStyles.summaryHint}>{affectedLabel}</p>
      ) : null}
      <div className={flowStyles.buttonRow}>
        <button
          className={flowStyles.primaryButton}
          type="button"
          disabled={!effectiveReason.trim()}
          onClick={() => onConfirm(effectiveReason, choice)}
        >
          {confirmLabel}
        </button>
        <button
          className={flowStyles.secondaryButton}
          type="button"
          onClick={onCancel}
        >
          Отмена
        </button>
      </div>
    </div>
  );
}

/** §2–4: операционная пауза приёма заказов выбранного ресторана. */
export function RestaurantPauseControl({
  restaurant,
  nowMs,
}: {
  restaurant: Restaurant;
  nowMs: number;
}) {
  const { pauseRestaurant, resumeRestaurant } = usePrototype();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = isOperationalPauseActiveAt(restaurant.orderPause, nowMs);

  const confirmPause = (reason: string, choice: DurationChoice) => {
    const { mode, resumeAt } = durationToPause(choice);
    const res = pauseRestaurant(
      restaurant.id,
      reason,
      mode,
      resumeAt,
      "RESTAURANT",
    );
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setOpen(false);
  };

  if (paused && restaurant.orderPause) {
    const pause = restaurant.orderPause;
    return (
      <section className={flowStyles.opPauseActive} aria-live="polite">
        <div>
          <strong>Приём заказов приостановлен</strong>
          <p className={flowStyles.summaryHint}>Причина: {pause.reason}</p>
          <p className={flowStyles.summaryHint}>
            Начало: {formatTimeInZone(pause.startedAt, restaurant.timeZone)}
            {" · "}
            {pause.resumeAt
              ? `Возобновление примерно в ${formatTimeInZone(pause.resumeAt, restaurant.timeZone)}`
              : "До ручного включения"}
          </p>
        </div>
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={() => resumeRestaurant(restaurant.id, "RESTAURANT")}
        >
          Возобновить приём
        </button>
      </section>
    );
  }

  return (
    <section className={flowStyles.opPauseIdle}>
      <div className={flowStyles.opPauseIdleHead}>
        <strong>Приём заказов включён</strong>
        {!open ? (
          <button
            className={flowStyles.secondaryButton}
            type="button"
            onClick={() => setOpen(true)}
          >
            Приостановить приём
          </button>
        ) : null}
      </div>
      {open ? (
        <ReasonDurationPanel
          reasons={PAUSE_REASONS}
          durations={RESTAURANT_DURATIONS}
          confirmLabel="Приостановить приём"
          onConfirm={confirmPause}
          onCancel={() => {
            setOpen(false);
            setError(null);
          }}
        />
      ) : null}
      {error ? (
        <div className={flowStyles.warningNotice} role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

/** Строка блюда с переключением операционной доступности. */
function MenuAvailabilityRow({
  item,
  restaurant,
  nowMs,
}: {
  item: MenuItem;
  restaurant: Restaurant;
  nowMs: number;
}) {
  const { setMenuItemUnavailable, restoreMenuItem } = usePrototype();
  const [open, setOpen] = useState(false);
  const available = isMenuItemAvailableAt(item, nowMs);

  const confirm = (reason: string, choice: DurationChoice) => {
    const { mode, resumeAt } = durationToPause(choice);
    setMenuItemUnavailable(
      restaurant.id,
      item.id,
      reason,
      mode,
      resumeAt,
      "RESTAURANT",
    );
    setOpen(false);
  };

  return (
    <div
      className={`${flowStyles.opMenuRow} ${available ? "" : flowStyles.opMenuRowMuted}`}
    >
      <div className={flowStyles.opMenuRowTop}>
        <div>
          <strong>{item.name}</strong>
          <div className={flowStyles.inlineMeta}>
            <span>{item.category}</span>
            <span>{available ? "В наличии" : "Временно нет"}</span>
            {!available && item.availabilityPause?.resumeAt ? (
              <span>
                до {formatTimeInZone(item.availabilityPause.resumeAt, restaurant.timeZone)}
              </span>
            ) : null}
          </div>
          {!available && item.availabilityPause ? (
            <p className={flowStyles.summaryHint}>
              Причина: {item.availabilityPause.reason}
            </p>
          ) : null}
        </div>
        {available ? (
          <button
            className={flowStyles.secondaryButton}
            type="button"
            onClick={() => setOpen((v) => !v)}
          >
            Временно нет
          </button>
        ) : (
          <button
            className={flowStyles.primaryButton}
            type="button"
            onClick={() => restoreMenuItem(restaurant.id, item.id, "RESTAURANT")}
          >
            В наличии
          </button>
        )}
      </div>
      {open && available ? (
        <ReasonDurationPanel
          reasons={ITEM_REASONS}
          durations={ITEM_DURATIONS}
          confirmLabel="Отключить блюдо"
          onConfirm={confirm}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** §9–14, §19: секция «Доступность меню» с поиском, фильтром и журналом. */
export function MenuAvailabilitySection({
  restaurant,
  nowMs,
}: {
  restaurant: Restaurant;
  nowMs: number;
}) {
  const { state, pauseCategory, restoreCategory } = usePrototype();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "AVAILABLE" | "UNAVAILABLE"
  >("ALL");
  const [bulkOpen, setBulkOpen] = useState(false);

  const menu = getRestaurantMenu(state, restaurant.id);
  const categories = useMemo(
    () => Array.from(new Set(menu.map((m) => m.category))),
    [menu],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("ru-RU");
    return menu
      .filter((m) => (category === "ALL" ? true : m.category === category))
      .filter((m) =>
        q ? m.name.toLocaleLowerCase("ru-RU").includes(q) : true,
      )
      .filter((m) => {
        if (statusFilter === "ALL") return true;
        const avail = isMenuItemAvailableAt(m, nowMs);
        return statusFilter === "AVAILABLE" ? avail : !avail;
      })
      .sort((a, b) => {
        const av = isMenuItemAvailableAt(a, nowMs) ? 1 : 0;
        const bv = isMenuItemAvailableAt(b, nowMs) ? 1 : 0;
        if (av !== bv) return av - bv; // недоступные (0) сверху
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return a.name.localeCompare(b.name);
      });
  }, [menu, search, category, statusFilter, nowMs]);

  const bulkCategory = category === "ALL" ? categories[0] : category;
  const bulkAffected = menu.filter(
    (m) => m.category === bulkCategory && isMenuItemAvailableAt(m, nowMs),
  ).length;

  const events = getRestaurantOperationalEvents(state, restaurant.id, 10);

  return (
    <section className={flowStyles.card}>
      <h2>Доступность меню</h2>
      <div className={flowStyles.opFilters}>
        <label className={flowStyles.field}>
          <span>Поиск блюда</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Название"
          />
        </label>
        <label className={flowStyles.field}>
          <span>Категория</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="ALL">Все категории</option>
            {categories.map((c) => (
              <option value={c} key={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className={flowStyles.field}>
          <span>Статус</span>
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as typeof statusFilter)
            }
          >
            <option value="ALL">Все</option>
            <option value="AVAILABLE">В наличии</option>
            <option value="UNAVAILABLE">Временно нет</option>
          </select>
        </label>
      </div>

      {bulkCategory ? (
        <div className={flowStyles.opBulk}>
          <div className={flowStyles.buttonRow}>
            <button
              className={flowStyles.secondaryButton}
              type="button"
              onClick={() => setBulkOpen((v) => !v)}
            >
              Временно отключить категорию «{bulkCategory}»
            </button>
            <button
              className={flowStyles.secondaryButton}
              type="button"
              onClick={() =>
                restoreCategory(restaurant.id, bulkCategory, "RESTAURANT")
              }
            >
              Вернуть категорию в меню
            </button>
          </div>
          {bulkOpen ? (
            <ReasonDurationPanel
              reasons={ITEM_REASONS}
              durations={ITEM_DURATIONS}
              confirmLabel="Отключить категорию"
              affectedLabel={`Будет отключено: ${bulkAffected}`}
              onConfirm={(reason, choice) => {
                const { mode, resumeAt } = durationToPause(choice);
                pauseCategory(
                  restaurant.id,
                  bulkCategory,
                  reason,
                  mode,
                  resumeAt,
                  "RESTAURANT",
                );
                setBulkOpen(false);
              }}
              onCancel={() => setBulkOpen(false)}
            />
          ) : null}
        </div>
      ) : null}

      <div className={flowStyles.opMenuList}>
        {visible.length === 0 ? (
          <div className={flowStyles.emptyState}>Блюда не найдены.</div>
        ) : (
          visible.map((item) => (
            <MenuAvailabilityRow
              item={item}
              restaurant={restaurant}
              nowMs={nowMs}
              key={item.id}
            />
          ))
        )}
      </div>

      <h3 className={flowStyles.sectionTitle}>Последние изменения</h3>
      {events.length === 0 ? (
        <p className={flowStyles.summaryHint}>Изменений пока нет.</p>
      ) : (
        <ul className={flowStyles.opEventLog}>
          {events.map((event) => (
            <li key={event.id}>
              <span>{formatTimeInZone(event.occurredAt, restaurant.timeZone)}</span>
              <span>{EVENT_ACTION_LABELS[event.action] ?? event.action}</span>
              {event.menuItemId ? (
                <span>
                  {menu.find((m) => m.id === event.menuItemId)?.name ??
                    "Блюдо"}
                </span>
              ) : null}
              <span>{event.reason}</span>
              <span>{ACTOR_LABELS[event.actor] ?? event.actor}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
