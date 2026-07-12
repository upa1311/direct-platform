"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  CarFront,
  Clock3,
  Search,
  Tag,
} from "lucide-react";
import { DirectLogoImage } from "@/components/brand/direct-brand";
import { FoodArtwork } from "@/components/brand/food-artwork";
import { deliveryModeLabels } from "@/data/demo-data";
import type { DemoRestaurant } from "@/types/prototype";

interface CatalogScreenProps {
  restaurants: DemoRestaurant[];
  onOpenRestaurant: (restaurantId: string) => void;
}

export function CatalogScreen({ restaurants, onOpenRestaurant }: CatalogScreenProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("Все");

  const filteredRestaurants = useMemo(() => {
    return restaurants.filter((restaurant) =>
      restaurant.name.toLowerCase().includes(query.toLowerCase()),
    );
  }, [query, restaurants]);

  return (
    <main className="customer-main catalog-page">
      <section className="catalog-hero">
        <div className="hero-copy">
          <span className="hero-kicker"><CarFront size={17} /> Direct доставка еды в Бендерах</span>
          <h1>Любимые блюда рядом.</h1>
          <p>Честная стоимость доставки для каждого района.</p>
          <label className="hero-search">
            <Search size={20} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Найти ресторан"
              aria-label="Найти ресторан"
            />
            <span>Найти</span>
          </label>
        </div>
        <div className="hero-visual">
          <div className="hero-logo-frame">
            <DirectLogoImage priority />
          </div>
        </div>
      </section>

      <section className="quick-facts" aria-label="Преимущества демо">
        <div><span><CarFront size={20} /></span><p><strong>3 режима</strong>Direct, ресторан, самовывоз</p></div>
        <div><span><Clock3 size={20} /></span><p><strong>Отслеживание заказа</strong>Весь путь заказа</p></div>
        <div><span><Tag size={20} /></span><p><strong>Акции</strong>Предложения ресторанов</p></div>
      </section>

      <section className="catalog-section">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Каталог</p>
            <h2>Рестораны</h2>
          </div>
          <div className="catalog-filters" role="group" aria-label="Фильтры каталога">
            {["Все", "Доставка Direct", "Самовывоз"].map((label) => (
              <button
                type="button"
                key={label}
                className={filter === label ? "is-active" : ""}
                onClick={() => setFilter(label)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filteredRestaurants.length > 0 ? (
          <div className="restaurant-grid">
            {filteredRestaurants.map((restaurant) => (
              <article className="restaurant-card" key={restaurant.id}>
                <button
                  className={`restaurant-cover tone-${restaurant.coverTone}`}
                  type="button"
                  onClick={() => onOpenRestaurant(restaurant.id)}
                  aria-label={`Открыть ${restaurant.name}`}
                >
                  <span className="restaurant-symbol"><FoodArtwork kind={restaurant.artwork} /></span>
                  <span className="demo-image-label">Демо-ресторан</span>
                  <span className="delivery-time"><Clock3 size={14} /> {restaurant.preparationMinutes + 15}–{restaurant.preparationMinutes + 25} мин</span>
                </button>
                <div className="restaurant-card-body">
                  <div className="restaurant-title-row">
                    <div>
                      <h3>{restaurant.name}</h3>
                      <p>{restaurant.description}</p>
                    </div>
                    <button className="round-arrow" type="button" onClick={() => onOpenRestaurant(restaurant.id)} aria-label="Открыть меню">
                      <ArrowRight size={19} />
                    </button>
                  </div>
                  <div className="restaurant-meta">
                    <span>{deliveryModeLabels[restaurant.modes[0]]}</span>
                  </div>
                  <div className="promo-line"><Tag size={15} /> {restaurant.promo}</div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-panel">
            <Search size={28} />
            <h3>Ничего не найдено</h3>
            <p>Попробуйте написать «Ресторан».</p>
          </div>
        )}
      </section>
    </main>
  );
}
