"use client";

import { useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import type { MenuItem, Promotion, Restaurant } from "@/prototype/models";
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
      setMenuItemVariants(menuItem.id, null);
    } else {
      setMenuItemVariants(menuItem.id, [
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
          <div className={flowStyles.field}>
            <span>Параметры «Большая»</span>
            <div className={flowStyles.buttonRow}>
              <label className={flowStyles.sizeOption}>
                <input
                  type="checkbox"
                  checked={largeAvailable}
                  onChange={(e) => setLargeAvailable(e.target.checked)}
                />
                <span>Доступна</span>
              </label>
              <label className={flowStyles.sizeOption}>
                <input
                  type="checkbox"
                  checked={defaultLarge}
                  onChange={(e) => setDefaultLarge(e.target.checked)}
                />
                <span>По умолчанию</span>
              </label>
            </div>
          </div>
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
    savePromotion({
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
        <div>
          <h3 className={flowStyles.sectionTitle}>{promotion.title}</h3>
          <p>{promotion.restaurantId}</p>
        </div>
        <label className={flowStyles.sizeOption}>
          <input
            type="checkbox"
            checked={promotion.enabled}
            onChange={(e) => togglePromotion(promotion.id, e.target.checked)}
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

function CreatePromotionForm({ restaurants }: { restaurants: Restaurant[] }) {
  const { savePromotion, state } = usePrototype();
  const [restaurantId, setRestaurantId] = useState(
    restaurants[0]?.id ?? "restaurant-1",
  );
  const [created, setCreated] = useState("");

  const create = () => {
    const eligible = state.menuItems
      .filter((item) => item.restaurantId === restaurantId)
      .map((item) => item.id);
    const id = `promo-${restaurantId}-${state.promotions.length + 1}`;
    savePromotion({
      id,
      restaurantId,
      title: "Новая акция 3+1",
      enabled: false,
      type: "BUY_N_GET_M_CHEAPEST_FREE",
      buyQuantity: 3,
      freeQuantity: 1,
      repeat: true,
      eligibleMenuItemIds: eligible,
      displayText: "3 + 1 в подарок",
      createdAt: "",
      updatedAt: "",
    });
    setCreated(`Создана ${id} (выключена). Настройте ниже.`);
  };

  return (
    <section className={flowStyles.card}>
      <h2>Создать акцию</h2>
      <div className={flowStyles.fieldGrid}>
        <label className={flowStyles.field}>
          <span>Ресторан</span>
          <select
            value={restaurantId}
            onChange={(e) => setRestaurantId(e.target.value)}
          >
            {restaurants.map((restaurant) => (
              <option value={restaurant.id} key={restaurant.id}>
                {restaurant.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={flowStyles.submitArea}>
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={create}
        >
          Создать акцию 3+1
        </button>
        <p className={flowStyles.feedback} aria-live="polite">
          {created}
        </p>
      </div>
    </section>
  );
}

export default function AdminMenuPage() {
  const { state } = usePrototype();
  const restaurants = state.restaurants;

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Меню и акции"
        description="Размеры блюд и структурированные акции. Изменения не переписывают существующие заказы."
      />

      <section className={flowStyles.card}>
        <h2>Размеры блюд</h2>
        {restaurants.map((restaurant) => {
          const items = state.menuItems.filter(
            (item) => item.restaurantId === restaurant.id,
          );
          if (items.length === 0) return null;
          return (
            <div key={restaurant.id}>
              <h3 className={flowStyles.sectionTitle}>{restaurant.name}</h3>
              <div className={flowStyles.cartItems}>
                {items.map((item) => (
                  <MenuItemSizeEditor key={item.id} menuItem={item} />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <CreatePromotionForm restaurants={restaurants} />

      <div className={flowStyles.orderList}>
        {state.promotions.map((promotion) => (
          <PromotionEditor
            key={promotion.id}
            promotion={promotion}
            items={state.menuItems.filter(
              (item) => item.restaurantId === promotion.restaurantId,
            )}
          />
        ))}
      </div>
    </>
  );
}
