"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  Eye,
  Filter,
  MapPin,
  Plus,
  Search,
  SlidersHorizontal,
  Store,
} from "lucide-react";
import { deliveryModeLabels, publicationStatusLabels } from "@/data/demo-data";
import { FoodArtwork } from "@/components/brand/food-artwork";
import { StatusBadge } from "@/components/ui/status-badge";
import type { DemoRestaurant, PublicationStatus } from "@/types/prototype";

interface RestaurantListProps {
  restaurants: DemoRestaurant[];
  onOpenRestaurant: (restaurantId: string) => void;
  onPreviewRestaurant: (restaurantId: string) => void;
  onCreateRestaurant: () => void;
}

export function RestaurantList({
  restaurants,
  onOpenRestaurant,
  onPreviewRestaurant,
  onCreateRestaurant,
}: RestaurantListProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<PublicationStatus | "ALL">("ALL");

  const filteredRestaurants = useMemo(
    () =>
      restaurants.filter((restaurant) => {
        const matchesQuery = restaurant.name
          .toLowerCase()
          .includes(query.toLowerCase());
        const matchesStatus = status === "ALL" || restaurant.status === status;
        return matchesQuery && matchesStatus;
      }),
    [query, restaurants, status],
  );

  return (
    <div className="admin-page restaurant-list-page">
      <div className="admin-page-heading">
        <div>
          <p className="eyebrow">Управление контентом</p>
          <h1>Рестораны</h1>
          <p>Создавайте, настраивайте и просматривайте тестовые рестораны без изменения кода.</p>
        </div>
        <button className="admin-primary-button" type="button" onClick={onCreateRestaurant}>
          <Plus size={18} /> Создать ресторан
        </button>
      </div>

      <section className="admin-metric-grid" aria-label="Сводка ресторанов">
        <article><span className="metric-icon metric-violet"><Store size={20} /></span><div><small>Всего ресторанов</small><strong>{restaurants.length}</strong><p>тестовые данные</p></div></article>
        <article><span className="metric-icon metric-green"><Eye size={20} /></span><div><small>Опубликованы</small><strong>{restaurants.filter((restaurant) => restaurant.status === "PUBLISHED").length}</strong><p>видны клиенту</p></div></article>
        <article><span className="metric-icon metric-amber"><SlidersHorizontal size={20} /></span><div><small>Требуют внимания</small><strong>{restaurants.filter((restaurant) => restaurant.status !== "PUBLISHED").length}</strong><p>черновики и скрытые</p></div></article>
      </section>

      <section className="admin-table-card">
        <header className="admin-table-toolbar">
          <label className="admin-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск ресторана" /></label>
          <label className="admin-select"><Filter size={17} /><select value={status} onChange={(event) => setStatus(event.target.value as PublicationStatus | "ALL")}><option value="ALL">Все статусы</option>{Object.entries(publicationStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        </header>

        <div className="admin-restaurant-list">
          <div className="admin-list-head"><span>Ресторан</span><span>Статус</span><span>Зона</span><span>Получение</span><span>Действия</span></div>
          {filteredRestaurants.map((restaurant) => (
            <article className="admin-restaurant-row" key={restaurant.id}>
              <div className="admin-restaurant-identity"><span className={`admin-avatar tone-${restaurant.coverTone}`}><FoodArtwork kind={restaurant.artwork} /></span><div><strong>{restaurant.name}</strong><small>{restaurant.address}</small></div></div>
              <div><StatusBadge status={restaurant.status} compact /></div>
              <div className="admin-zone"><MapPin size={16} /> Зона {restaurant.zone}</div>
              <div className="admin-modes">{restaurant.modes.slice(0, 2).map((mode) => <span key={mode}>{deliveryModeLabels[mode]}</span>)}</div>
              <div className="admin-row-actions"><button type="button" onClick={() => onPreviewRestaurant(restaurant.id)} aria-label={`Предпросмотр ${restaurant.name}`}><Eye size={17} /></button><button className="open-admin-row" type="button" onClick={() => onOpenRestaurant(restaurant.id)}>Открыть <ArrowRight size={16} /></button></div>
            </article>
          ))}
          {filteredRestaurants.length === 0 ? <div className="admin-empty"><Search size={26} /><strong>Ничего не найдено</strong><p>Измените запрос или фильтр.</p></div> : null}
        </div>
      </section>
    </div>
  );
}
