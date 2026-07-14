"use client";

import { useMemo, useState } from "react";
import { Pause } from "lucide-react";

import { usePrototype } from "@/prototype/prototype-provider";
import type {
  MenuItem,
  Order,
  OperationalPauseMode,
  Restaurant,
} from "@/prototype/models";
import {
  getKitchenAcceptanceState,
  getRestaurantMenu,
  getRestaurantOperationalEvents,
  isMenuItemAvailableAt,
} from "@/prototype/selectors";
import {
  computeDelayedEtaIso,
  computeEarlierEtaIso,
  computeEtaDeltaMinutes,
  computeEtaFromNowIso,
  validateEtaCandidate,
} from "@/prototype/pricing-engine";
import styles from "./kitchen.module.css";

const DELAY_REASONS = [
  "Высокая загрузка кухни",
  "Блюдо готовится дольше",
  "Проблема с ингредиентом",
  "Техническая задержка",
  "Недостаточно сотрудников",
  "Другая причина",
] as const;

const EARLIER_REASONS = [
  "Заказ будет готов раньше",
  "Освободилась производственная мощность",
  "Подготовка заняла меньше времени",
  "Другая причина",
] as const;

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

/** Живой остаток времени паузы, слова с корректным склонением. */
function formatRemaining(resumeAtIso: string, nowMs: number): string {
  // §7: пока часы не инициализированы — не показываем ложный огромный остаток.
  if (nowMs === 0) return "Рассчитываем оставшееся время…";
  const diffMs = Date.parse(resumeAtIso) - nowMs;
  const minutes = Math.max(0, Math.ceil(diffMs / 60_000));
  const lastTwo = minutes % 100;
  const last = minutes % 10;
  let word = "минут";
  if (lastTwo < 11 || lastTwo > 14) {
    if (last === 1) word = "минуту";
    else if (last >= 2 && last <= 4) word = "минуты";
  }
  return `Осталось ${minutes} ${word}`;
}

/** §5–§9: панель корректировки ожидаемого времени готовности PREPARING-заказа. */
export function EtaAdjustPanel({
  order,
  restaurant,
  onDone,
}: {
  order: Order;
  restaurant: Restaurant;
  onDone: (success: boolean) => void;
}) {
  const { adjustOrderEta } = usePrototype();
  const current = order.expectedReadyAt;
  const tz = restaurant.timeZone;
  const [candidateIso, setCandidateIso] = useState<string | null>(null);
  const [customMinutes, setCustomMinutes] = useState("");
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const nowIso = () => new Date().toISOString();
  const lastAdjustment = order.etaAdjustments.at(-1) ?? null;

  const delta =
    candidateIso && current ? computeEtaDeltaMinutes(current, candidateIso) : 0;
  const isDelay = delta >= 0;
  const reasons = isDelay ? DELAY_REASONS : EARLIER_REASONS;
  const selectedReason = (reasons as readonly string[]).includes(reason)
    ? reason
    : reasons[0];
  const isOther = selectedReason === "Другая причина";
  const effectiveReason = isOther ? customReason : selectedReason;

  const chooseDelay = (minutes: number) => {
    if (!current) return;
    setCandidateIso(computeDelayedEtaIso(current, minutes, nowIso()));
    setCustomMinutes("");
    setError(null);
  };
  const chooseEarlier = (minutes: number) => {
    if (!current) return;
    const candidate = computeEarlierEtaIso(current, minutes);
    const validation = validateEtaCandidate(candidate, nowIso());
    if (validation) {
      setCandidateIso(null);
      setError(validation);
      return;
    }
    setCandidateIso(candidate);
    setCustomMinutes("");
    setError(null);
  };
  const chooseCustom = (value: string) => {
    setCustomMinutes(value);
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 180) {
      setCandidateIso(null);
      return;
    }
    setCandidateIso(computeEtaFromNowIso(nowIso(), n));
    setError(null);
  };

  const submit = () => {
    if (!candidateIso) {
      setError("Выберите новое время.");
      return;
    }
    if (!effectiveReason.trim()) {
      setError("Укажите причину.");
      return;
    }
    const res = adjustOrderEta(
      order.id,
      candidateIso,
      effectiveReason,
      "RESTAURANT",
    );
    // §9: при ошибке панель не закрываем и показываем domain error рядом.
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDone(true);
  };

  const deltaLabel =
    candidateIso === null
      ? null
      : delta > 0
        ? `Задержка на ${delta} мин`
        : delta < 0
          ? `Будет готов на ${-delta} мин раньше`
          : "Без изменений";

  return (
    <div className={styles.panel}>
      <p className={styles.panelHint}>
        Текущее ожидаемое: {formatTimeInZone(current, tz)} · Первоначальная
        оценка: {order.preparationMinutes ?? "—"} мин
      </p>
      {lastAdjustment ? (
        <p className={styles.panelHint}>
          Последняя корректировка:{" "}
          {formatTimeInZone(lastAdjustment.previousExpectedReadyAt, tz)} →{" "}
          {formatTimeInZone(lastAdjustment.nextExpectedReadyAt, tz)} ·{" "}
          {lastAdjustment.reason}
        </p>
      ) : null}

      <div className={styles.field}>
        <span>Задержка</span>
        <div className={styles.btnRow}>
          {[5, 10, 15].map((m) => (
            <button
              key={m}
              className={`${styles.btn} ${styles.btnOutline}`}
              type="button"
              onClick={() => chooseDelay(m)}
            >
              +{m} мин
            </button>
          ))}
        </div>
      </div>
      <div className={styles.field}>
        <span>Будет готов раньше</span>
        <div className={styles.btnRow}>
          {[5, 10].map((m) => (
            <button
              key={m}
              className={`${styles.btn} ${styles.btnOutline}`}
              type="button"
              onClick={() => chooseEarlier(m)}
            >
              На {m} мин раньше
            </button>
          ))}
        </div>
      </div>
      <label className={styles.field}>
        <span>Будет готов через N минут</span>
        <input
          type="number"
          min={1}
          max={180}
          value={customMinutes}
          onChange={(e) => chooseCustom(e.target.value)}
          placeholder="например, 20"
        />
      </label>

      <label className={styles.field}>
        <span>Причина</span>
        <select value={selectedReason} onChange={(e) => setReason(e.target.value)}>
          {reasons.map((r) => (
            <option value={r} key={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      {isOther ? (
        <label className={styles.field}>
          <span>Ваша причина</span>
          <textarea
            maxLength={300}
            value={customReason}
            onChange={(e) => setCustomReason(e.target.value)}
            placeholder="Опишите причину"
          />
        </label>
      ) : null}

      {candidateIso ? (
        <p className={styles.panelHint}>
          Новое ожидаемое время: <strong>{formatTimeInZone(candidateIso, tz)}</strong>
          {deltaLabel ? ` · ${deltaLabel}` : ""}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.btnRowEnd}>
        <button
          className={`${styles.btn} ${styles.btnOutline}`}
          type="button"
          onClick={() => onDone(false)}
        >
          Отмена
        </button>
        <button
          className={`${styles.btn} ${styles.btnDark}`}
          type="button"
          disabled={!candidateIso || !effectiveReason.trim()}
          onClick={submit}
        >
          Обновить время
        </button>
      </div>
    </div>
  );
}

/** Строгая встроенная форма причины + срока (KDS). */
function ReasonDurationPanel({
  reasons,
  durations,
  onConfirm,
  onCancel,
  confirmLabel,
  affectedLabel,
  error,
}: {
  reasons: readonly string[];
  durations: { value: DurationChoice; label: string }[];
  onConfirm: (reason: string, choice: DurationChoice) => void;
  onCancel: () => void;
  confirmLabel: string;
  affectedLabel?: string;
  error?: string | null;
}) {
  const [reason, setReason] = useState<string>(reasons[0]);
  const [custom, setCustom] = useState("");
  const [choice, setChoice] = useState<DurationChoice>(durations[0].value);
  const isOther = reason === "Другая причина";
  const effectiveReason = isOther ? custom : reason;

  return (
    <div className={styles.panel}>
      <label className={styles.field}>
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
        <label className={styles.field}>
          <span>Ваша причина</span>
          <textarea
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Опишите причину"
          />
        </label>
      ) : null}
      <label className={styles.field}>
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
      {affectedLabel ? <p className={styles.panelHint}>{affectedLabel}</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.btnRowEnd}>
        <button
          className={`${styles.btn} ${styles.btnOutline}`}
          type="button"
          onClick={onCancel}
        >
          Отмена
        </button>
        <button
          className={`${styles.btn} ${styles.btnDark}`}
          type="button"
          disabled={!effectiveReason.trim()}
          onClick={() => onConfirm(effectiveReason, choice)}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

/** §2–4, §7: операционная пауза приёма заказов выбранного ресторана. */
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
  const [resumeError, setResumeError] = useState<string | null>(null);
  // Единый источник состояния приёма (§ единый helper).
  const acceptance = getKitchenAcceptanceState(restaurant, nowMs);

  const confirmPause = (reason: string, choice: DurationChoice) => {
    const { mode, resumeAt } = durationToPause(choice);
    const res = pauseRestaurant(restaurant.id, reason, mode, resumeAt, "RESTAURANT");
    // §11: панель не закрываем и показываем ошибку, если действие не прошло.
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setOpen(false);
  };

  if (acceptance === "ADMIN_DISABLED") {
    return (
      <section className={styles.pauseWrap}>
        <div className={styles.disabledBlock}>
          <span className={`${styles.dot} ${styles.dotOff}`} aria-hidden="true" />
          <div>
            <p className={styles.pauseTitle}>
              Приём заказов отключён администратором Direct.
            </p>
            <p className={styles.pauseMeta}>
              Изменить этот статус можно в административном кабинете.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (acceptance === "OPERATIONAL_PAUSE" && restaurant.orderPause) {
    const pause = restaurant.orderPause;
    return (
      <section className={styles.pauseWrap} aria-live="polite">
        <div className={styles.pauseActive}>
          <div>
            <p className={styles.pauseTitle}>Приём заказов приостановлен</p>
            <p className={styles.pauseMeta}>
              {pause.resumeAt
                ? `${formatRemaining(pause.resumeAt, nowMs)} · Возобновление в ${formatTimeInZone(pause.resumeAt, restaurant.timeZone)}`
                : "До ручного включения"}
            </p>
            <p className={styles.pauseMeta}>Причина: {pause.reason}</p>
          </div>
          <button
            className={`${styles.btn} ${styles.btnDark}`}
            type="button"
            onClick={() => {
              // §6: показываем ошибку возобновления рядом с блоком.
              const res = resumeRestaurant(restaurant.id, "RESTAURANT");
              setResumeError(res.ok ? null : res.error);
            }}
          >
            Возобновить
          </button>
        </div>
        {resumeError ? (
          <p className={styles.pauseError} role="alert">
            {resumeError}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className={styles.pauseWrap}>
      <div className={styles.pauseRow}>
        <div className={styles.acceptStatusLeft}>
          <span className={`${styles.dot} ${styles.dotOk}`} aria-hidden="true" />
          Приём заказов включён
        </div>
        {!open ? (
          <button
            className={`${styles.btn} ${styles.btnOutline}`}
            type="button"
            onClick={() => {
              setOpen(true);
              setError(null);
            }}
          >
            <Pause size={16} aria-hidden="true" />
            Пауза
          </button>
        ) : null}
      </div>
      {open ? (
        <div className={styles.pausePanel}>
          <ReasonDurationPanel
            reasons={PAUSE_REASONS}
            durations={RESTAURANT_DURATIONS}
            confirmLabel="Приостановить приём"
            error={error}
            onConfirm={confirmPause}
            onCancel={() => {
              setOpen(false);
              setError(null);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

/** §9, §11: строка блюда с переключением доступности (плотная). */
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
  const [error, setError] = useState<string | null>(null);
  const available = isMenuItemAvailableAt(item, nowMs);

  const confirm = (reason: string, choice: DurationChoice) => {
    const { mode, resumeAt } = durationToPause(choice);
    const res = setMenuItemUnavailable(
      restaurant.id,
      item.id,
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

  const restore = () => {
    const res = restoreMenuItem(restaurant.id, item.id, "RESTAURANT");
    setError(res.ok ? null : res.error);
  };

  return (
    <div className={`${styles.menuRow} ${available ? "" : styles.menuRowOff}`}>
      <div className={styles.menuName}>{item.name}</div>
      <div className={styles.menuCategory}>{item.category}</div>
      <div className={styles.menuStatus}>
        <span
          className={`${styles.dot} ${available ? styles.statusOk : styles.statusOff}`}
          aria-hidden="true"
        />
        {available ? "В наличии" : "Временно нет"}
        {!available && item.availabilityPause?.resumeAt ? (
          <span className={styles.menuUntil}>
            {" "}
            до {formatTimeInZone(item.availabilityPause.resumeAt, restaurant.timeZone)}
          </span>
        ) : null}
      </div>
      {available ? (
        <button
          className={`${styles.btn} ${styles.btnRedOutline}`}
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            setError(null);
          }}
        >
          Отключить
        </button>
      ) : (
        <button
          className={`${styles.btn} ${styles.btnGreen}`}
          type="button"
          onClick={restore}
        >
          Вернуть
        </button>
      )}
      {!available && item.availabilityPause ? (
        <p className={styles.menuReason}>Причина: {item.availabilityPause.reason}</p>
      ) : null}
      {error && !open ? (
        <p className={styles.menuReason}>
          <span className={styles.error}>{error}</span>
        </p>
      ) : null}
      {open && available ? (
        <div className={styles.menuRowPanel}>
          <ReasonDurationPanel
            reasons={ITEM_REASONS}
            durations={ITEM_DURATIONS}
            confirmLabel="Отключить блюдо"
            error={error}
            onConfirm={confirm}
            onCancel={() => {
              setOpen(false);
              setError(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** §9–14: секция «Доступность меню» — плотный операционный список. */
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
  const [bulkError, setBulkError] = useState<string | null>(null);

  const menu = getRestaurantMenu(state, restaurant.id);
  const categories = useMemo(
    () => Array.from(new Set(menu.map((m) => m.category))),
    [menu],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("ru-RU");
    return menu
      .filter((m) => (category === "ALL" ? true : m.category === category))
      .filter((m) => (q ? m.name.toLocaleLowerCase("ru-RU").includes(q) : true))
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

  // §10: массовые действия — ТОЛЬКО при выбранной конкретной категории.
  // «Все категории» не подставляет первую категорию.
  const bulkCategory = category === "ALL" ? null : category;
  const bulkAffected = bulkCategory
    ? menu.filter(
        (m) => m.category === bulkCategory && isMenuItemAvailableAt(m, nowMs),
      ).length
    : 0;

  const events = getRestaurantOperationalEvents(state, restaurant.id, 10);

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Доступность меню</h2>
      <div className={styles.filters}>
        <label className={styles.field}>
          <span>Поиск блюда</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Название"
          />
        </label>
        <label className={styles.field}>
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
        <label className={styles.field}>
          <span>Статус</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          >
            <option value="ALL">Все</option>
            <option value="AVAILABLE">В наличии</option>
            <option value="UNAVAILABLE">Временно нет</option>
          </select>
        </label>
      </div>

      {bulkCategory ? (
        <div>
          <div className={styles.bulkBar}>
            <span className={styles.bulkCategory}>Категория: {bulkCategory}</span>
            <button
              className={`${styles.btn} ${styles.btnRedOutline}`}
              type="button"
              onClick={() => {
                setBulkOpen((v) => !v);
                setBulkError(null);
              }}
            >
              Отключить категорию
            </button>
            <button
              className={`${styles.btn} ${styles.btnGreen}`}
              type="button"
              onClick={() => {
                const res = restoreCategory(restaurant.id, bulkCategory, "RESTAURANT");
                setBulkError(res.ok ? null : res.error);
              }}
            >
              Вернуть категорию
            </button>
          </div>
          {bulkError && !bulkOpen ? (
            <p className={styles.error} role="alert">
              {bulkError}
            </p>
          ) : null}
          {bulkOpen ? (
            <ReasonDurationPanel
              reasons={ITEM_REASONS}
              durations={ITEM_DURATIONS}
              confirmLabel="Отключить категорию"
              affectedLabel={`Будет отключено: ${bulkAffected}`}
              error={bulkError}
              onConfirm={(reason, choice) => {
                const { mode, resumeAt } = durationToPause(choice);
                const res = pauseCategory(
                  restaurant.id,
                  bulkCategory,
                  reason,
                  mode,
                  resumeAt,
                  "RESTAURANT",
                );
                if (!res.ok) {
                  setBulkError(res.error);
                  return;
                }
                setBulkError(null);
                setBulkOpen(false);
              }}
              onCancel={() => {
                setBulkOpen(false);
                setBulkError(null);
              }}
            />
          ) : null}
        </div>
      ) : (
        <p className={styles.bulkHint}>
          Выберите конкретную категорию для массового действия.
        </p>
      )}

      {visible.length === 0 ? (
        <div className={styles.empty}>Блюда не найдены.</div>
      ) : (
        <div className={styles.menuList}>
          {visible.map((item) => (
            <MenuAvailabilityRow
              item={item}
              restaurant={restaurant}
              nowMs={nowMs}
              key={item.id}
            />
          ))}
        </div>
      )}

      <h3 className={styles.sectionTitle} style={{ marginTop: 18 }}>
        Последние изменения
      </h3>
      {events.length === 0 ? (
        <p className={styles.panelHint}>Изменений пока нет.</p>
      ) : (
        <ul className={styles.eventLog}>
          {events.map((event) => (
            <li className={styles.eventRow} key={event.id}>
              <span className={styles.eventTime}>
                {formatTimeInZone(event.occurredAt, restaurant.timeZone)}
              </span>
              <span className={styles.eventMain}>
                <span>{EVENT_ACTION_LABELS[event.action] ?? event.action}</span>
                {event.menuItemId ? (
                  <span>
                    {menu.find((m) => m.id === event.menuItemId)?.name ?? "Блюдо"}
                  </span>
                ) : null}
                <span className={styles.eventActor}>
                  {ACTOR_LABELS[event.actor] ?? event.actor}
                </span>
              </span>
              <span className={styles.eventReason}>{event.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
