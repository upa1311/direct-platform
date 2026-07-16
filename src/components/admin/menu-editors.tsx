"use client";

import { useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import {
  feedbackFromAck,
  type MutationFeedback,
} from "@/components/util/mutation-feedback";
import { usePrototype } from "@/prototype/prototype-provider";
import type { MenuItem, Promotion } from "@/prototype/models";
import { formatMoney, parseDollarsToCents } from "@/prototype/selectors";

function MenuItemSizeEditor({ menuItem }: { menuItem: MenuItem }) {
  const { setMenuItemVariants } = usePrototype();
  const hasVariants = Boolean(menuItem.variants && menuItem.variants.length > 0);
  const large = menuItem.variants?.find((v) => v.id === "size-large");
  const [enabled, setEnabled] = useState(hasVariants);
  const [surcharge, setSurcharge] = useState(
    large ? (large.priceDeltaCents / 100).toFixed(2) : "2.00",
  );
  const [largeAvailable, setLargeAvailable] = useState(
    large ? large.available : true,
  );
  const [defaultLarge, setDefaultLarge] = useState(
    menuItem.variants?.find((v) => v.isDefault)?.id === "size-large",
  );
  // Исправление 5.2: «Сохранено» — только после подтверждённого commit;
  // при ошибке показывается русская ошибка, введённые значения сохраняются.
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedback | null>(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await setMenuItemVariants(
        menuItem.id,
        enabled
          ? [
              {
                id: "size-standard",
                name: "Стандартная",
                priceDeltaCents: 0,
                available: true,
                isDefault: !defaultLarge,
              },
              {
                id: "size-large",
                name: "Большая",
                priceDeltaCents: parseDollarsToCents(surcharge),
                available: largeAvailable,
                isDefault: defaultLarge,
              },
            ]
          : null,
      );
      setFeedback(
        feedbackFromAck(
          {
            ...result,
            error: result.error ?? "Не удалось сохранить размеры.",
          },
          "Сохранено",
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={flowStyles.cartLine}>
      <div className={flowStyles.cartLineTop}>
        <div>
          <strong>{menuItem.name}</strong>
          <p>Базовая цена {formatMoney(menuItem.priceCents)}</p>
        </div>
        <label className={flowStyles.sizeOption}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Размеры</span>
        </label>
      </div>
      {enabled ? (
        <div className={flowStyles.fieldGrid}>
          <label className={flowStyles.field}>
            <span>Доплата за «Большая», $</span>
            <input
              value={surcharge}
              onChange={(e) => setSurcharge(e.target.value)}
            />
          </label>
          <label className={flowStyles.sizeOption}>
            <input
              type="checkbox"
              checked={largeAvailable}
              onChange={(e) => setLargeAvailable(e.target.checked)}
            />
            <span>«Большая» доступна</span>
          </label>
          <label className={flowStyles.sizeOption}>
            <input
              type="checkbox"
              checked={defaultLarge}
              onChange={(e) => setDefaultLarge(e.target.checked)}
            />
            <span>«Большая» по умолчанию</span>
          </label>
        </div>
      ) : null}
      <div className={flowStyles.buttonRow}>
        <button
          className={flowStyles.secondaryButton}
          type="button"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Сохраняем…" : "Сохранить размеры"}
        </button>
        {feedback?.kind === "error" ? (
          <span className={flowStyles.errorText} role="alert">
            {feedback.text}
          </span>
        ) : (
          <span className={flowStyles.feedback} aria-live="polite">
            {saving ? "" : (feedback?.text ?? "")}
          </span>
        )}
      </div>
    </div>
  );
}

function PromotionEditor({
  promotion,
  items,
}: {
  promotion: Promotion;
  items: MenuItem[];
}) {
  const { savePromotion, togglePromotion } = usePrototype();
  const [form, setForm] = useState({
    title: promotion.title,
    displayText: promotion.displayText,
    buyQuantity: promotion.buyQuantity.toString(),
    freeQuantity: promotion.freeQuantity.toString(),
    repeat: promotion.repeat,
    eligible: new Set(promotion.eligibleMenuItemIds),
  });
  // Исправление 5.3: success — только после commit; при ошибке форма и данные
  // сохраняются, показывается русская ошибка.
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<MutationFeedback | null>(null);
  // Toggle без ложного optimistic-состояния: чекбокс всегда отражает
  // подтверждённый общий state; на время Promise он блокируется.
  const [togglePending, setTogglePending] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await savePromotion({
        ...promotion,
        title: form.title,
        displayText: form.displayText,
        buyQuantity: Number.parseInt(form.buyQuantity, 10) || 3,
        freeQuantity: Number.parseInt(form.freeQuantity, 10) || 1,
        repeat: form.repeat,
        eligibleMenuItemIds: [...form.eligible],
      });
      setFeedback(
        feedbackFromAck(
          { ...result, error: result.error ?? "Не удалось сохранить акцию." },
          "Сохранено",
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    if (togglePending) return;
    setTogglePending(true);
    setToggleError(null);
    try {
      const result = await togglePromotion(promotion.id, enabled);
      if (!result.ok) {
        setToggleError(result.error ?? "Не удалось изменить акцию.");
      }
    } finally {
      setTogglePending(false);
    }
  };

  return (
    <article className={flowStyles.card}>
      <div className={flowStyles.orderHeader}>
        <h3 className={flowStyles.sectionTitle}>{promotion.title}</h3>
        <label className={flowStyles.sizeOption}>
          <input
            type="checkbox"
            checked={promotion.enabled}
            disabled={togglePending}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span>{promotion.enabled ? "Включена" : "Выключена"}</span>
        </label>
      </div>
      {toggleError ? (
        <p className={flowStyles.errorText} role="alert">
          {toggleError}
        </p>
      ) : null}
      <div className={flowStyles.fieldGrid}>
        <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
          <span>Название для клиента</span>
          <input
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          />
        </label>
        <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
          <span>Текст на карточке</span>
          <input
            value={form.displayText}
            onChange={(e) =>
              setForm((f) => ({ ...f, displayText: e.target.value }))
            }
          />
        </label>
        <label className={flowStyles.field}>
          <span>Количество для покупки</span>
          <input
            value={form.buyQuantity}
            onChange={(e) =>
              setForm((f) => ({ ...f, buyQuantity: e.target.value }))
            }
          />
        </label>
        <label className={flowStyles.field}>
          <span>Количество бесплатно</span>
          <input
            value={form.freeQuantity}
            onChange={(e) =>
              setForm((f) => ({ ...f, freeQuantity: e.target.value }))
            }
          />
        </label>
      </div>
      <label className={flowStyles.sizeOption}>
        <input
          type="checkbox"
          checked={form.repeat}
          onChange={(e) => setForm((f) => ({ ...f, repeat: e.target.checked }))}
        />
        <span>Повторяется</span>
      </label>
      <p className={flowStyles.sectionTitle}>Участвующие блюда</p>
      <div className={flowStyles.buttonRow}>
        {items.map((item) => (
          <label className={flowStyles.sizeOption} key={item.id}>
            <input
              type="checkbox"
              checked={form.eligible.has(item.id)}
              onChange={(e) =>
                setForm((f) => {
                  const eligible = new Set(f.eligible);
                  if (e.target.checked) eligible.add(item.id);
                  else eligible.delete(item.id);
                  return { ...f, eligible };
                })
              }
            />
            <span>{item.name}</span>
          </label>
        ))}
      </div>
      <div className={flowStyles.submitArea}>
        <button
          className={flowStyles.primaryButton}
          type="button"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Сохраняем…" : "Сохранить акцию"}
        </button>
        {feedback?.kind === "error" ? (
          <span className={flowStyles.errorText} role="alert">
            {feedback.text}
          </span>
        ) : (
          <span className={flowStyles.feedback} aria-live="polite">
            {saving ? "" : (feedback?.text ?? "")}
          </span>
        )}
      </div>
    </article>
  );
}

/** Раздел «Размеры» конструктора: размеры блюд одного ресторана. */
export function MenuSizesSection({ restaurantId }: { restaurantId: string }) {
  const { state } = usePrototype();
  const items = state.menuItems.filter(
    (item) => item.restaurantId === restaurantId,
  );
  if (items.length === 0) {
    return (
      <div className={flowStyles.emptyState}>У ресторана пока нет блюд.</div>
    );
  }
  return (
    <div className={flowStyles.cartItems}>
      {items.map((item) => (
        <MenuItemSizeEditor key={item.id} menuItem={item} />
      ))}
    </div>
  );
}

/** Раздел «Меню» конструктора: список блюд ресторана (обзор). */
export function MenuOverviewSection({
  restaurantId,
}: {
  restaurantId: string;
}) {
  const { state } = usePrototype();
  const items = state.menuItems.filter(
    (item) => item.restaurantId === restaurantId,
  );
  if (items.length === 0) {
    return (
      <div className={flowStyles.emptyState}>У ресторана пока нет блюд.</div>
    );
  }
  return (
    <dl className={flowStyles.definitionList}>
      {items.map((item) => (
        <div className={flowStyles.definitionRow} key={item.id}>
          <dt>
            {item.name} · {item.category}
          </dt>
          <dd>
            {formatMoney(item.priceCents)} ·{" "}
            {item.available ? "В наличии" : "Недоступно"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Раздел «Акции» конструктора: акции одного ресторана + создание. */
export function PromotionsSection({ restaurantId }: { restaurantId: string }) {
  const { state, savePromotion } = usePrototype();
  // Исправление 5.3: «Акция создана» — только после подтверждённого commit.
  const [creating, setCreating] = useState(false);
  const [createFeedback, setCreateFeedback] =
    useState<MutationFeedback | null>(null);
  const promotions = state.promotions.filter(
    (promotion) => promotion.restaurantId === restaurantId,
  );
  const items = state.menuItems.filter(
    (item) => item.restaurantId === restaurantId,
  );

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setCreateFeedback(null);
    try {
      const eligible = items.map((item) => item.id);
      const id = `promo-${restaurantId}-${state.promotions.length + 1}`;
      const result = await savePromotion({
        id,
        restaurantId,
        title: "Каждая 4-я пицца — бесплатно",
        enabled: false,
        type: "BUY_N_GET_M_CHEAPEST_FREE",
        buyQuantity: 3,
        freeQuantity: 1,
        repeat: true,
        eligibleMenuItemIds: eligible,
        displayText: "Каждая 4-я пицца — бесплатно",
        createdAt: "",
        updatedAt: "",
      });
      setCreateFeedback(
        feedbackFromAck(
          { ...result, error: result.error ?? "Не удалось создать акцию." },
          "Акция создана (выключена). Настройте ниже.",
        ),
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div className={flowStyles.submitArea}>
        <button
          className={flowStyles.secondaryButton}
          type="button"
          disabled={creating}
          onClick={() => void create()}
        >
          {creating ? "Создаём…" : "Создать акцию"}
        </button>
        {createFeedback?.kind === "error" ? (
          <span className={flowStyles.errorText} role="alert">
            {createFeedback.text}
          </span>
        ) : (
          <span className={flowStyles.feedback} aria-live="polite">
            {creating ? "" : (createFeedback?.text ?? "")}
          </span>
        )}
      </div>
      {promotions.length === 0 ? (
        <div className={flowStyles.emptyState}>Акций пока нет.</div>
      ) : (
        <div className={flowStyles.orderList}>
          {promotions.map((promotion) => (
            <PromotionEditor
              key={promotion.id}
              promotion={promotion}
              items={items}
            />
          ))}
        </div>
      )}
    </>
  );
}
