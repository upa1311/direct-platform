"use client";

import { useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
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
  const [saved, setSaved] = useState(false);

  const save = () => {
    if (!enabled) {
      void setMenuItemVariants(menuItem.id, null);
    } else {
      void setMenuItemVariants(menuItem.id, [
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
      ]);
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
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
          onClick={save}
        >
          Сохранить размеры
        </button>
        <span className={flowStyles.feedback} aria-live="polite">
          {saved ? "Сохранено" : ""}
        </span>
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
  const [saved, setSaved] = useState(false);

  const save = () => {
    void savePromotion({
      ...promotion,
      title: form.title,
      displayText: form.displayText,
      buyQuantity: Number.parseInt(form.buyQuantity, 10) || 3,
      freeQuantity: Number.parseInt(form.freeQuantity, 10) || 1,
      repeat: form.repeat,
      eligibleMenuItemIds: [...form.eligible],
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  return (
    <article className={flowStyles.card}>
      <div className={flowStyles.orderHeader}>
        <h3 className={flowStyles.sectionTitle}>{promotion.title}</h3>
        <label className={flowStyles.sizeOption}>
          <input
            type="checkbox"
            checked={promotion.enabled}
            onChange={(e) => void togglePromotion(promotion.id, e.target.checked)}
          />
          <span>{promotion.enabled ? "Включена" : "Выключена"}</span>
        </label>
      </div>
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
          <span>Купить (N)</span>
          <input
            value={form.buyQuantity}
            onChange={(e) =>
              setForm((f) => ({ ...f, buyQuantity: e.target.value }))
            }
          />
        </label>
        <label className={flowStyles.field}>
          <span>Бесплатно (M)</span>
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
          onClick={save}
        >
          Сохранить акцию
        </button>
        <span className={flowStyles.feedback} aria-live="polite">
          {saved ? "Сохранено" : ""}
        </span>
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
  const [created, setCreated] = useState("");
  const promotions = state.promotions.filter(
    (promotion) => promotion.restaurantId === restaurantId,
  );
  const items = state.menuItems.filter(
    (item) => item.restaurantId === restaurantId,
  );

  const create = () => {
    const eligible = items.map((item) => item.id);
    const id = `promo-${restaurantId}-${state.promotions.length + 1}`;
    void savePromotion({
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
    setCreated("Акция создана (выключена). Настройте ниже.");
  };

  return (
    <>
      <div className={flowStyles.submitArea}>
        <button
          className={flowStyles.secondaryButton}
          type="button"
          onClick={create}
        >
          Создать акцию
        </button>
        <span className={flowStyles.feedback} aria-live="polite">
          {created}
        </span>
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
