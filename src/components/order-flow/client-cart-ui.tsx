"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Minus, Plus, ShoppingCart, Trash2, X } from "lucide-react";

import { useMutationGuard } from "@/components/util/use-mutation-guard";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  calculateCartPricing,
  formatMoney,
  getCartItemViews,
  getRestaurant,
} from "@/prototype/selectors";
import styles from "./order-flow.module.css";

interface ClientCartUiValue {
  cartQuantity: number;
  openCart: () => void;
  notifyItemAdded: (source: HTMLElement) => void;
  cartButtonRef: RefObject<HTMLButtonElement | null>;
  badgePulse: boolean;
}

interface FlyStyle extends CSSProperties {
  "--fly-x": string;
  "--fly-y": string;
  "--fly-end-x": string;
  "--fly-end-y": string;
}

const ClientCartUiContext = createContext<ClientCartUiValue | null>(null);

export function ClientCartUiProvider({ children }: { children: ReactNode }) {
  const { state, setItemQuantity: setItemQuantityAck } = usePrototype();
  // Исправление 5.7: изменение количества в мини-корзине — с русской ошибкой;
  // количество на экране всегда из подтверждённого общего state.
  const { error: cartMutationError, run: runCartMutation } = useMutationGuard();
  const setItemQuantity = (
    ...args: Parameters<typeof setItemQuantityAck>
  ) => runCartMutation(() => setItemQuantityAck(...args));
  const [isOpen, setIsOpen] = useState(false);
  const [badgePulse, setBadgePulse] = useState(false);
  const [flyStyle, setFlyStyle] = useState<FlyStyle | null>(null);
  const cartButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemViews = getCartItemViews(state);
  const restaurant = getRestaurant(state, state.cart.restaurantId);
  const pricing = calculateCartPricing(state);
  const cartQuantity = state.cart.items.reduce((sum, item) => sum + item.quantity, 0);
  const isPickup = state.cart.fulfillmentChoice === "PICKUP";
  const fulfillmentLabel = isPickup ? "Самовывоз" : "Доставка";
  // Самовывоз — цифра 0 (не «Бесплатно»), как в основных итогах корзины.
  const fulfillmentValue = isPickup
    ? "0"
    : pricing.deliveryFeeCents === null
      ? "Укажите адрес"
      : formatMoney(pricing.deliveryFeeCents);
  const checkoutHref = "/client/cart#checkout-cart";
  const checkoutLabel = "Перейти к оформлению";

  const closeCart = useCallback(() => setIsOpen(false), []);
  const openCart = useCallback(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setIsOpen(true);
  }, []);

  const notifyItemAdded = useCallback((source: HTMLElement) => {
    const cartButton = cartButtonRef.current;
    if (cartButton) {
      const from = source.getBoundingClientRect();
      const to = cartButton.getBoundingClientRect();
      setFlyStyle({
        "--fly-x": `${from.left + from.width / 2}px`,
        "--fly-y": `${from.top + from.height / 2}px`,
        "--fly-end-x": `${to.left + to.width / 2}px`,
        "--fly-end-y": `${to.top + to.height / 2}px`,
      });
      if (flyTimerRef.current) clearTimeout(flyTimerRef.current);
      flyTimerRef.current = setTimeout(() => setFlyStyle(null), 700);
    }
    setBadgePulse(false);
    window.requestAnimationFrame(() => setBadgePulse(true));
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = setTimeout(() => setBadgePulse(false), 650);
  }, []);

  useEffect(() => () => {
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    if (flyTimerRef.current) clearTimeout(flyTimerRef.current);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeCart();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = closeButtonRef.current?.closest<HTMLElement>("[role='dialog']");
      const focusable = dialog
        ? Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"))
        : [];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [closeCart, isOpen]);

  const value = useMemo(() => ({ cartQuantity, openCart, notifyItemAdded, cartButtonRef, badgePulse }), [badgePulse, cartQuantity, notifyItemAdded, openCart]);

  return (
    <ClientCartUiContext.Provider value={value}>
      {children}
      {flyStyle ? <span className={styles.cartFlyToken} style={flyStyle}><ShoppingCart aria-hidden="true" /></span> : null}
      {isOpen ? (
        <div className={styles.cartDrawerLayer}>
          <button className={styles.cartDrawerBackdrop} type="button" aria-label="Закрыть корзину" onClick={closeCart} />
          <aside className={styles.cartDrawer} role="dialog" aria-modal="true" aria-labelledby="cart-drawer-title">
            <div className={styles.cartDrawerHeader}>
              <div><span>Корзина</span><h2 id="cart-drawer-title">{restaurant?.name ?? "Ваш заказ"}</h2></div>
              <button ref={closeButtonRef} type="button" aria-label="Закрыть корзину" onClick={closeCart}><X aria-hidden="true" /></button>
            </div>
            {itemViews.length === 0 ? (
              <div className={styles.cartDrawerEmpty}>Корзина пуста.<Link href="/client/catalog" onClick={closeCart}>Выбрать ресторан</Link></div>
            ) : (
              <>
                <div className={styles.cartDrawerItems}>
                  {itemViews.map(({ cartItem, menuItem, variant, lineTotalCents }) => (
                    <article key={`${menuItem.id}-${cartItem.variantId ?? "base"}`}>
                      <div>
                        <strong>
                          {menuItem.name}
                          {variant && !variant.isDefault ? ` · ${variant.name}` : ""}
                        </strong>
                        <span>{formatMoney(lineTotalCents)}</span>
                      </div>
                      <div className={styles.drawerQuantity}>
                        <button type="button" aria-label={`Уменьшить количество: ${menuItem.name}`} onClick={() => void setItemQuantity(menuItem.id, cartItem.variantId, cartItem.quantity - 1)}><Minus aria-hidden="true" /></button>
                        <span>{cartItem.quantity}</span>
                        <button type="button" aria-label={`Увеличить количество: ${menuItem.name}`} onClick={() => void setItemQuantity(menuItem.id, cartItem.variantId, cartItem.quantity + 1)}><Plus aria-hidden="true" /></button>
                        <button type="button" aria-label={`Удалить: ${menuItem.name}`} onClick={() => void setItemQuantity(menuItem.id, cartItem.variantId, 0)}><Trash2 aria-hidden="true" /></button>
                      </div>
                    </article>
                  ))}
                </div>
                {cartMutationError ? (
                  <p className={styles.errorText} role="alert">
                    {cartMutationError}
                  </p>
                ) : null}
                <dl className={styles.drawerSummary}>
                  <div><dt>Еда</dt><dd>{formatMoney(pricing.foodSubtotalBeforeDiscountsCents)}</dd></div>
                  {pricing.appliedPromotion ? (
                    <div><dt>Скидка</dt><dd>−{formatMoney(pricing.promotionDiscountCents)}</dd></div>
                  ) : null}
                  <div><dt>{fulfillmentLabel}</dt><dd>{fulfillmentValue}</dd></div>
                  {pricing.smallOrderFeeCents > 0 ? (
                    <div><dt>Доплата за небольшой заказ</dt><dd>{formatMoney(pricing.smallOrderFeeCents)}</dd></div>
                  ) : null}
                  <div><dt>Итого</dt><dd>{pricing.customerTotalCents === null ? "—" : formatMoney(pricing.customerTotalCents)}</dd></div>
                </dl>
                <Link
                  className={styles.primaryLink}
                  href={checkoutHref}
                  onClick={closeCart}
                >
                  {checkoutLabel}
                </Link>
              </>
            )}
          </aside>
        </div>
      ) : null}
    </ClientCartUiContext.Provider>
  );
}

export function useClientCartUi(): ClientCartUiValue {
  const context = useContext(ClientCartUiContext);
  if (!context) throw new Error("useClientCartUi must be used inside ClientCartUiProvider");
  return context;
}
