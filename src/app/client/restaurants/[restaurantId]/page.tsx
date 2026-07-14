"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";
import { Gift } from "lucide-react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { useClientAddressConfirmation } from "@/components/order-flow/client-address-confirmation";
import { useClientCartUi } from "@/components/order-flow/client-cart-ui";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  canPlacePrototypeOrder,
  formatMoney,
  getRestaurant,
  getRestaurantMenu,
  getRestaurantPromotion,
  isAddressReady,
  resolveVariant,
} from "@/prototype/selectors";
import { shouldAutoConfirmAddress } from "@/prototype/pricing-engine";

function getProductLabel(quantity: number): string {
  const lastTwoDigits = quantity % 100;
  const lastDigit = quantity % 10;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return "товаров";
  if (lastDigit === 1) return "товар";
  if (lastDigit >= 2 && lastDigit <= 4) return "товара";
  return "товаров";
}

export default function ClientRestaurantPage() {
  const params = useParams<{ restaurantId: string }>();
  const { state, addItem, setItemQuantity } = usePrototype();
  const { isAddressConfirmed, confirmAddress } = useClientAddressConfirmation();
  const { notifyItemAdded } = useClientCartUi();
  const [feedback, setFeedback] = useState("");
  const [selectedVariants, setSelectedVariants] = useState<
    Record<string, string>
  >({});

  // При открытии ресторана с уже валидным кратким адресом можно тихо
  // подтвердить его (не блокируя переход). Пустой/неполный адрес не мешает
  // открыть ресторан и выбрать блюда — адрес заполняется позже в корзине.
  const hasValidAddress = isAddressReady(state.cart.address, state);
  useEffect(() => {
    if (
      shouldAutoConfirmAddress({
        fulfillmentChoice: state.cart.fulfillmentChoice,
        isAddressConfirmed,
        hasValidAddress,
      })
    ) {
      confirmAddress();
    }
  }, [
    confirmAddress,
    hasValidAddress,
    isAddressConfirmed,
    state.cart.fulfillmentChoice,
  ]);

  const restaurant = getRestaurant(state, params.restaurantId);

  if (!restaurant || restaurant.status !== "PUBLISHED") {
    return (
      <div className={flowStyles.emptyState}>
        Ресторан не найден. <Link href="/client/catalog">Вернуться в каталог</Link>
      </div>
    );
  }

  const menuItems = getRestaurantMenu(state, restaurant.id);
  const promotion = getRestaurantPromotion(state, restaurant.id);
  const canOrder = canPlacePrototypeOrder(restaurant);
  const cartQuantity =
    state.cart.restaurantId === restaurant.id
      ? state.cart.items.reduce((total, item) => total + item.quantity, 0)
      : 0;
  // CTA при наличии товаров всегда ведёт в корзину. Адрес заполняется в
  // оформлении; клиента не возвращают в каталог из-за отсутствующего адреса.
  const checkoutHref = "/client/cart#checkout-cart";
  const checkoutLabel = "Перейти к оформлению";

  const getAddFeedback = (result: ReturnType<typeof addItem>) => {
    if (result === "ADDED") {
      return "Блюдо добавлено в корзину.";
    }
    if (result === "RESTAURANT_UNAVAILABLE") {
      return "Ресторан сейчас не принимает заказы. Выберите другой ресторан или повторите позже.";
    }
    return "Блюдо сейчас недоступно.";
  };

  const handleAdd = (
    menuItemId: string,
    variantId: string | null,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    const result = addItem(menuItemId, variantId);

    if (result === "RESTAURANT_CONFLICT") {
      const confirmed = window.confirm(
        "В корзине есть блюда другого ресторана. Очистить корзину и добавить это блюдо?",
      );
      if (!confirmed) {
        return;
      }
      const replacementResult = addItem(menuItemId, variantId, true);
      setFeedback(
        replacementResult === "ADDED"
          ? "Предыдущая корзина очищена. Блюдо добавлено."
          : getAddFeedback(replacementResult),
      );
      if (replacementResult === "ADDED") notifyItemAdded(event.currentTarget);
      return;
    }

    setFeedback(getAddFeedback(result));
    if (result === "ADDED") notifyItemAdded(event.currentTarget);
  };

  return (
    <div className={flowStyles.restaurantMenuPage}>
      <div className={flowStyles.detailHeader}>
        <Link className={flowStyles.backLink} href="/client/catalog">
          ← Список ресторанов
        </Link>
        <div>
          <h1>{restaurant.name}</h1>
          <p>{restaurant.description}</p>
        </div>
        <div className={flowStyles.inlineMeta}>
          <span>{restaurant.address}</span>
          <span>Обычно {restaurant.defaultPreparationMinutes} минут</span>
        </div>
        {promotion ? (
          <p className={flowStyles.promoInline}>
            <Gift aria-hidden="true" className={flowStyles.promoInlineIcon} />
            <span>{promotion.title}</span>
          </p>
        ) : null}
        {restaurant.restaurantDeliverySettings ? (
          <div className={flowStyles.restaurantPromo}>
            <strong>
              Минимальный заказ{" "}
              {formatMoney(
                restaurant.restaurantDeliverySettings.minimumOrderCents,
              )}
              {restaurant.restaurantDeliverySettings
                .freeDeliveryThresholdCents !== null
                ? ` · Бесплатная доставка от ${formatMoney(restaurant.restaurantDeliverySettings.freeDeliveryThresholdCents)}`
                : ""}
            </strong>
            <span>Стоимость доставки зависит от вашего адреса</span>
          </div>
        ) : null}
      </div>

      {!canOrder ? (
        <div className={flowStyles.warningNotice}>
          Демонстрационный ресторан — заказы пока недоступны
        </div>
      ) : null}

      <div className={flowStyles.buttonRow} id="restaurant-menu">
        <h2>Меню</h2>
      </div>
      <p className={flowStyles.feedback} aria-live="polite">
        {feedback}
      </p>

      <div className={flowStyles.menuList}>
        {menuItems.map((menuItem) => {
          const variants = menuItem.variants ?? [];
          const hasVariants = variants.length > 0;
          const defaultVariant = resolveVariant(menuItem, null);
          const selectedVariantId = hasVariants
            ? (selectedVariants[menuItem.id] ?? defaultVariant?.id ?? null)
            : null;
          const selectedVariant = resolveVariant(menuItem, selectedVariantId);
          const unitPriceCents =
            menuItem.priceCents + (selectedVariant?.priceDeltaCents ?? 0);
          const lineVariantId = selectedVariant?.id ?? null;
          const cartItem =
            state.cart.restaurantId === restaurant.id
              ? state.cart.items.find(
                  (item) =>
                    item.menuItemId === menuItem.id &&
                    item.variantId === lineVariantId,
                )
              : undefined;
          const quantity = cartItem?.quantity ?? 0;
          const isEligible =
            promotion?.eligibleMenuItemIds.includes(menuItem.id) ?? false;

          return (
            <article
              className={`${flowStyles.menuItem} ${
                menuItem.available ? "" : flowStyles.menuItemUnavailable
              }`}
              key={menuItem.id}
            >
              <div>
                <h2>{menuItem.name}</h2>
                <p>{menuItem.description}</p>
                <div className={flowStyles.cardMeta}>
                  <span>{menuItem.category}</span>
                  <span>{menuItem.available ? "В наличии" : "Недоступно"}</span>
                </div>
                {isEligible ? (
                  <p className={flowStyles.itemPromoTag}>Участвует в акции</p>
                ) : null}
                {hasVariants ? (
                  <div
                    className={flowStyles.sizeSelector}
                    role="group"
                    aria-label={`Размер: ${menuItem.name}`}
                  >
                    {variants.map((variant) => (
                      <label
                        className={flowStyles.sizeOption}
                        key={variant.id}
                      >
                        <input
                          type="radio"
                          name={`size-${menuItem.id}`}
                          checked={variant.id === lineVariantId}
                          disabled={!variant.available}
                          onChange={() =>
                            setSelectedVariants((current) => ({
                              ...current,
                              [menuItem.id]: variant.id,
                            }))
                          }
                        />
                        <span>{variant.name}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className={flowStyles.menuActions}>
                <span className={flowStyles.price}>
                  {formatMoney(unitPriceCents, menuItem.currencyCode)}
                </span>
                {quantity > 0 && menuItem.available && canOrder ? (
                  <div
                    className={flowStyles.menuQuantity}
                    aria-label={`Количество: ${menuItem.name}`}
                  >
                    <button
                      type="button"
                      aria-label={`Уменьшить количество: ${menuItem.name}`}
                      onClick={() =>
                        setItemQuantity(menuItem.id, lineVariantId, quantity - 1)
                      }
                    >
                      −
                    </button>
                    <span aria-live="polite">{quantity}</span>
                    <button
                      type="button"
                      aria-label={`Увеличить количество: ${menuItem.name}`}
                      onClick={(event) =>
                        handleAdd(menuItem.id, lineVariantId, event)
                      }
                    >
                      +
                    </button>
                  </div>
                ) : (
                  <button
                    className={flowStyles.primaryButton}
                    type="button"
                    disabled={!menuItem.available || !canOrder}
                    onClick={(event) =>
                      handleAdd(menuItem.id, lineVariantId, event)
                    }
                  >
                    Добавить
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {cartQuantity > 0 ? (
        <Link className={flowStyles.menuCheckoutCta} href={checkoutHref}>
          <span>
            {cartQuantity} {getProductLabel(cartQuantity)} ·
          </span>
          <strong>{checkoutLabel}</strong>
        </Link>
      ) : null}
    </div>
  );
}
