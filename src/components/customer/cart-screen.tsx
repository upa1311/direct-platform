"use client";

import {
  ArrowLeft,
  ArrowRight,
  CarFront,
  Info,
  Minus,
  Plus,
  ShoppingBag,
  Store,
} from "lucide-react";
import { FoodArtwork } from "@/components/brand/food-artwork";
import { deliveryModeLabels } from "@/data/demo-data";
import {
  deliveryFeeCents,
  formatMoney,
  getSmallOrderFee,
  getSmallOrderMissingAmount,
} from "@/lib/demo-calculations";
import type {
  CartLine,
  DeliveryMode,
  DemoMenuItem,
  DemoRestaurant,
} from "@/types/prototype";

interface CartScreenProps {
  restaurant: DemoRestaurant;
  lines: Array<CartLine & { item: DemoMenuItem }>;
  foodSubtotalCents: number;
  deliveryMode: DeliveryMode;
  onDeliveryModeChange: (mode: DeliveryMode) => void;
  onQuantityChange: (itemId: string, variant: string, quantity: number) => void;
  onBack: () => void;
  onCheckout: () => void;
}

export function CartScreen({
  restaurant,
  lines,
  foodSubtotalCents,
  deliveryMode,
  onDeliveryModeChange,
  onQuantityChange,
  onBack,
  onCheckout,
}: CartScreenProps) {
  const isPlatformDelivery = deliveryMode === "PLATFORM_DRIVER";
  const smallOrderFeeCents = isPlatformDelivery
    ? getSmallOrderFee(foodSubtotalCents)
    : 0;
  const currentDeliveryFeeCents = isPlatformDelivery ? deliveryFeeCents : 0;
  const totalCents =
    foodSubtotalCents + currentDeliveryFeeCents + smallOrderFeeCents;
  const missingCents = getSmallOrderMissingAmount(foodSubtotalCents);

  return (
    <main className="customer-main cart-page">
      <button className="back-button" type="button" onClick={onBack}>
        <ArrowLeft size={18} /> Вернуться в меню
      </button>

      <div className="checkout-layout">
        <section className="checkout-content">
          <div className="page-title-block">
            <p className="eyebrow">Ваш заказ</p>
            <h1>Корзина</h1>
            <p>Заказ из одного ресторана: <strong>{restaurant.name}</strong></p>
          </div>

          {lines.length > 0 ? (
            <div className="cart-lines">
              {lines.map((line) => (
                <article className="cart-line" key={`${line.itemId}-${line.variant}`}>
                  <div className={`cart-line-visual tone-${line.item.tone}`}><FoodArtwork kind={line.item.artwork} /></div>
                  <div className="cart-line-copy">
                    <h3>{line.item.name}</h3>
                    <p>{line.variant} · {line.item.weight}</p>
                    <strong>{formatMoney(line.unitPriceCents)}</strong>
                  </div>
                  <div className="quantity-control cart-quantity">
                    <button
                      type="button"
                      onClick={() => onQuantityChange(line.itemId, line.variant, line.quantity - 1)}
                      aria-label="Уменьшить количество"
                    >
                      <Minus size={17} />
                    </button>
                    <strong>{line.quantity}</strong>
                    <button
                      type="button"
                      onClick={() => onQuantityChange(line.itemId, line.variant, line.quantity + 1)}
                      aria-label="Увеличить количество"
                    >
                      <Plus size={17} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-panel cart-empty">
              <ShoppingBag size={32} />
              <h3>Корзина пока пустая</h3>
              <p>Вернитесь в меню и нажмите плюс у позиции.</p>
              <button className="primary-button" type="button" onClick={onBack}>Открыть меню</button>
            </div>
          )}

          <section className="delivery-mode-card">
            <div className="subsection-heading">
              <div><p className="eyebrow">Получение</p><h2>Как получить заказ?</h2></div>
              <span className="demo-tag">Демо</span>
            </div>
            <div className="delivery-mode-options">
              {restaurant.modes.map((mode) => (
                <button
                  type="button"
                  key={mode}
                  className={deliveryMode === mode ? "is-selected" : ""}
                  onClick={() => onDeliveryModeChange(mode)}
                >
                  <span>{mode === "PLATFORM_DRIVER" ? <CarFront size={21} /> : <Store size={21} />}</span>
                  <div><strong>{deliveryModeLabels[mode]}</strong><small>{mode === "PLATFORM_DRIVER" ? "Полный сценарий демо" : "Показан без полного процесса"}</small></div>
                </button>
              ))}
            </div>
            {!isPlatformDelivery ? (
              <div className="demo-note warning-note"><Info size={17} /> Первым полностью реализуется только «Доставка Direct». Выберите её, чтобы пройти весь сценарий.</div>
            ) : null}
          </section>
        </section>

        <aside className="order-summary-card">
          <div className="summary-heading"><span><ShoppingBag size={19} /></span><div><strong>Итого заказа</strong><small>Предварительный QR-расчёт</small></div></div>
          <dl className="summary-list">
            <div><dt>Стоимость еды</dt><dd>{formatMoney(foodSubtotalCents)}</dd></div>
            <div><dt>Доставка <small>демо-тариф</small></dt><dd>{formatMoney(currentDeliveryFeeCents)}</dd></div>
            {smallOrderFeeCents > 0 ? <div><dt>Доплата за небольшой заказ</dt><dd>{formatMoney(smallOrderFeeCents)}</dd></div> : null}
          </dl>
          {missingCents > 0 && isPlatformDelivery ? (
            <div className="small-order-hint">
              <span>{Math.round((foodSubtotalCents / 667) * 100)}%</span>
              <div><strong>Доплата почти исчезла</strong><p>Добавьте товаров ещё на {formatMoney(missingCents)}, чтобы доплата за небольшой заказ исчезла.</p></div>
            </div>
          ) : null}
          <div className="summary-total"><span>Итого</span><strong>{formatMoney(totalCents)}</strong></div>
          <button
            className="primary-button summary-button"
            type="button"
            onClick={onCheckout}
            disabled={lines.length === 0 || !isPlatformDelivery}
          >
            Перейти к оформлению <ArrowRight size={18} />
          </button>
          <p className="summary-caption">Деньги не списываются при отправке корзины.</p>
        </aside>
      </div>
    </main>
  );
}
