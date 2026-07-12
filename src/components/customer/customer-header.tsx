"use client";

import { ChevronDown, Clock3, MapPin, ShoppingBag, UserRound } from "lucide-react";
import { DirectBrand } from "@/components/brand/direct-brand";
import type { CustomerScreen } from "@/types/prototype";

interface CustomerHeaderProps {
  screen: CustomerScreen;
  cartCount: number;
  onHome: () => void;
  onHistory: () => void;
  onCart: () => void;
}

export function CustomerHeader({
  screen,
  cartCount,
  onHome,
  onHistory,
  onCart,
}: CustomerHeaderProps) {
  return (
    <>
      <header className="customer-header">
        <div className="customer-header-inner">
          <button className="customer-wordmark" type="button" onClick={onHome}>
            <DirectBrand />
          </button>
          <button className="address-button" type="button">
            <span className="address-icon"><MapPin size={18} /></span>
            <span>
              <small>Доставить в</small>
              Бендеры · тестовый адрес
            </span>
            <ChevronDown size={17} />
          </button>
          <nav className="customer-nav" aria-label="Навигация клиента">
            <button
              className={screen === "history" ? "is-active" : ""}
              type="button"
              onClick={onHistory}
            >
              <Clock3 size={18} />
              Заказы
            </button>
            <button className="profile-button" type="button">
              <UserRound size={18} />
              Профиль
            </button>
            <button className="cart-button" type="button" onClick={onCart}>
              <ShoppingBag size={18} />
              Корзина
              {cartCount > 0 ? <span>{cartCount}</span> : null}
            </button>
          </nav>
        </div>
      </header>

      <nav className="mobile-customer-nav" aria-label="Мобильная навигация">
        <button type="button" onClick={onHome} className={screen === "catalog" ? "is-active" : ""}>
          <MapPin size={20} />
          Каталог
        </button>
        <button type="button" onClick={onHistory} className={screen === "history" ? "is-active" : ""}>
          <Clock3 size={20} />
          Заказы
        </button>
        <button type="button" onClick={onCart} className={screen === "cart" ? "is-active" : ""}>
          <ShoppingBag size={20} />
          Корзина {cartCount > 0 ? `· ${cartCount}` : ""}
        </button>
      </nav>
    </>
  );
}
