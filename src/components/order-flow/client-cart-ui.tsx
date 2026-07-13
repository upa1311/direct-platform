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
  const { state, setItemQuantity } = usePrototype();
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
  const fulfillmentLabel =
    state.cart.deliveryMode === "PICKUP"
      ? "Самовывоз"
      : state.cart.deliveryMode === "PLATFORM_DRIVER"
        ? "Доставка"
        : "Получение";
  const fulfillmentValue =
    state.cart.deliveryMode === null
      ? "Выберите способ"
      : pricing.deliveryFeeCents === null
        ? "Укажите адрес"
        : formatMoney(pricing.deliveryFeeCents);
  const checkoutHref =
    state.cart.deliveryMode === null
      ? "/client/cart#fulfillment-method"
      : "/client/cart#checkout-cart";
  const checkoutLabel =
    state.cart.deliveryMode === null
      ? "Выбрать способ получения"
      : "Перейти к оформлению";

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
                  {itemViews.map(({ cartItem, menuItem, lineTotalCents }) => (
                    <article key={menuItem.id}>
                      <div><strong>{menuItem.name}</strong><span>{formatMoney(lineTotalCents)}</span></div>
                      <div className={styles.drawerQuantity}>
                        <button type="button" aria-label={`Уменьшить количество: ${menuItem.name}`} onClick={() => setItemQuantity(menuItem.id, cartItem.quantity - 1)}><Minus aria-hidden="true" /></button>
                        <span>{cartItem.quantity}</span>
                        <button type="button" aria-label={`Увеличить количество: ${menuItem.name}`} onClick={() => setItemQuantity(menuItem.id, cartItem.quantity + 1)}><Plus aria-hidden="true" /></button>
                        <button type="button" aria-label={`Удалить: ${menuItem.name}`} onClick={() => setItemQuantity(menuItem.id, 0)}><Trash2 aria-hidden="true" /></button>
                      </div>
                    </article>
                  ))}
                </div>
                <dl className={styles.drawerSummary}>
                  <div><dt>Еда</dt><dd>{formatMoney(pricing.foodSubtotalCents)}</dd></div>
                  <div><dt>{fulfillmentLabel}</dt><dd>{fulfillmentValue}</dd></div>
                  {state.cart.deliveryMode !== null &&
                  pricing.smallOrderFeeCents > 0 ? (
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
