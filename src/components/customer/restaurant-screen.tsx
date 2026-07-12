"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  CarFront,
  Check,
  Clock3,
  Info,
  MapPin,
  Minus,
  Plus,
  ShoppingBag,
  Tag,
} from "lucide-react";
import { FoodArtwork } from "@/components/brand/food-artwork";
import { deliveryModeLabels } from "@/data/demo-data";
import { formatMoney } from "@/lib/demo-calculations";
import { Modal } from "@/components/ui/modal";
import type { DemoMenuItem, DemoRestaurant } from "@/types/prototype";

interface RestaurantScreenProps {
  restaurant: DemoRestaurant;
  items: DemoMenuItem[];
  cartCount: number;
  onBack: () => void;
  onOpenCart: () => void;
  onAddItem: (item: DemoMenuItem, unitPriceCents: number, variant: string) => void;
}

export function RestaurantScreen({
  restaurant,
  items,
  cartCount,
  onBack,
  onOpenCart,
  onAddItem,
}: RestaurantScreenProps) {
  const categories = useMemo(
    () => ["Все", ...Array.from(new Set(items.map((item) => item.category)))],
    [items],
  );
  const [category, setCategory] = useState("Все");
  const [selectedItem, setSelectedItem] = useState<DemoMenuItem | null>(null);
  const [variant, setVariant] = useState("Обычный");
  const [quantity, setQuantity] = useState(1);

  const visibleItems = items.filter(
    (item) => category === "Все" || item.category === category,
  );

  const selectedPrice = selectedItem
    ? selectedItem.priceCents + (variant === "Большой" ? 200 : 0)
    : 0;

  function openItem(item: DemoMenuItem) {
    if (!item.available) {
      return;
    }
    setSelectedItem(item);
    setVariant("Обычный");
    setQuantity(1);
  }

  function addSelectedItem() {
    if (!selectedItem) {
      return;
    }
    for (let index = 0; index < quantity; index += 1) {
      onAddItem(selectedItem, selectedPrice, variant);
    }
    setSelectedItem(null);
  }

  return (
    <main className="customer-main restaurant-page">
      <button className="back-button" type="button" onClick={onBack}>
        <ArrowLeft size={18} /> Все рестораны
      </button>

      <section className={`restaurant-hero tone-${restaurant.coverTone}`}>
        <div className="restaurant-hero-symbol"><FoodArtwork kind={restaurant.artwork} /></div>
        <div className="restaurant-hero-copy">
          <span className="hero-kicker light-kicker">Опубликованный тестовый ресторан</span>
          <h1>{restaurant.name}</h1>
          <p>{restaurant.description}</p>
          <div className="restaurant-hero-meta">
            <span><Clock3 size={17} /> {restaurant.preparationMinutes} мин на приготовление</span>
            <span><MapPin size={17} /> {restaurant.address}</span>
          </div>
        </div>
        <div className="restaurant-open-card">
          <span className="live-dot" />
          <div><strong>Принимает заказы</strong><small>{restaurant.hours}</small></div>
        </div>
      </section>

      <section className="restaurant-info-strip">
        <div><CarFront size={21} /><p><strong>Способы получения</strong>{restaurant.modes.map((mode) => deliveryModeLabels[mode]).join(" · ")}</p></div>
        <div><Clock3 size={21} /><p><strong>Последний заказ</strong>Сегодня до {restaurant.lastOrderTime}</p></div>
        <div><Info size={21} /><p><strong>Оплата</strong>QR · наличные при выполнении условий</p></div>
      </section>

      <aside className="restaurant-promo-banner">
        <span><Tag size={20} /></span>
        <div><strong>{restaurant.promo}</strong><small>Финансовые правила акции ещё требуют решения</small></div>
        <button type="button" onClick={() => document.getElementById("menu")?.scrollIntoView({ behavior: "smooth" })}>Смотреть меню</button>
      </aside>

      <section className="menu-section" id="menu">
        <div className="section-heading-row menu-heading-row">
          <div>
            <p className="eyebrow">Меню</p>
            <h2>Выберите позицию</h2>
          </div>
          <button className="primary-button floating-cart-button" type="button" onClick={onOpenCart}>
            <ShoppingBag size={18} /> Корзина {cartCount > 0 ? `· ${cartCount}` : ""}
          </button>
        </div>
        <div className="category-tabs" role="tablist" aria-label="Категории меню">
          {categories.map((itemCategory) => (
            <button
              type="button"
              role="tab"
              aria-selected={category === itemCategory}
              className={category === itemCategory ? "is-active" : ""}
              onClick={() => setCategory(itemCategory)}
              key={itemCategory}
            >
              {itemCategory}
            </button>
          ))}
        </div>

        <div className="menu-grid">
          {visibleItems.map((item) => (
            <article className={`menu-card ${item.available ? "" : "is-unavailable"}`} key={item.id}>
              <button
                type="button"
                className={`menu-card-visual tone-${item.tone}`}
                onClick={() => openItem(item)}
                disabled={!item.available}
                aria-label={`Открыть ${item.name}`}
              >
                <FoodArtwork kind={item.artwork} />
                {!item.available ? <strong>Нет в наличии</strong> : null}
              </button>
              <div className="menu-card-copy">
                <p className="menu-card-category">{item.category}</p>
                <h3>{item.name}</h3>
                <p>{item.description}</p>
                <span className="menu-weight">{item.weight}</span>
                <div className="menu-card-footer">
                  <strong>{formatMoney(item.priceCents)}</strong>
                  <button
                    type="button"
                    onClick={() => openItem(item)}
                    disabled={!item.available}
                    aria-label={`Добавить ${item.name}`}
                  >
                    {item.available ? <Plus size={19} /> : "—"}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <Modal
        open={Boolean(selectedItem)}
        onClose={() => setSelectedItem(null)}
        title={selectedItem?.name ?? "Позиция"}
        eyebrow="Настройте тестовую позицию"
        size="large"
      >
        {selectedItem ? (
          <div className="item-modal-grid">
            <div className={`item-modal-visual tone-${selectedItem.tone}`} aria-hidden="true">
              <FoodArtwork kind={selectedItem.artwork} />
              <small>Графическая заглушка блюда</small>
            </div>
            <div className="item-modal-content">
              <p className="item-description">{selectedItem.description}</p>
              <div className="demo-note"><Info size={17} /> Варианты ниже нужны только для кликабельного демо.</div>
              <fieldset className="option-group">
                <legend>Размер</legend>
                {[{ label: "Обычный", extra: 0 }, { label: "Большой", extra: 200 }].map((option) => (
                  <label className={variant === option.label ? "is-selected" : ""} key={option.label}>
                    <input
                      type="radio"
                      name="variant"
                      value={option.label}
                      checked={variant === option.label}
                      onChange={() => setVariant(option.label)}
                    />
                    <span className="radio-mark">{variant === option.label ? <Check size={14} /> : null}</span>
                    <span><strong>{option.label}</strong><small>{option.extra ? `+ ${formatMoney(option.extra)}` : "Без доплаты"}</small></span>
                  </label>
                ))}
              </fieldset>
              <div className="item-modal-footer">
                <div className="quantity-control">
                  <button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))} aria-label="Уменьшить количество"><Minus size={18} /></button>
                  <strong>{quantity}</strong>
                  <button type="button" onClick={() => setQuantity((value) => value + 1)} aria-label="Увеличить количество"><Plus size={18} /></button>
                </div>
                <button className="primary-button grow-button" type="button" onClick={addSelectedItem}>
                  Добавить · {formatMoney(selectedPrice * quantity)}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </main>
  );
}
