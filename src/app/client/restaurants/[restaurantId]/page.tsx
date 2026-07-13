"use client";

import { useState, type MouseEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { TEST_RESTAURANT_ID } from "@/prototype/default-state";
import { useClientCartUi } from "@/components/order-flow/client-cart-ui";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatMoney,
  getDeliveryProviderLabel,
  getRestaurant,
  getRestaurantMenu,
} from "@/prototype/selectors";

export default function ClientRestaurantPage() {
  const params = useParams<{ restaurantId: string }>();
  const { state, addItem, setItemQuantity } = usePrototype();
  const { notifyItemAdded } = useClientCartUi();
  const [feedback, setFeedback] = useState("");
  const restaurant = getRestaurant(state, params.restaurantId);

  if (!restaurant || restaurant.status !== "PUBLISHED") {
    return (
      <div className={flowStyles.emptyState}>
        Ресторан не найден. <Link href="/client/catalog">Вернуться в каталог</Link>
      </div>
    );
  }

  const menuItems = getRestaurantMenu(state, restaurant.id);
  const canOrder =
    restaurant.id === TEST_RESTAURANT_ID &&
    restaurant.isAcceptingOrders &&
    restaurant.deliveryModes.includes("PLATFORM_DRIVER") &&
    restaurant.paymentMethods.includes("ONLINE");
  const deliveryProviderLabel = getDeliveryProviderLabel(restaurant);

  const getAddFeedback = (result: ReturnType<typeof addItem>) => {
    if (result === "ADDED") {
      return "Блюдо добавлено в корзину.";
    }
    if (result === "RESTAURANT_UNAVAILABLE") {
      return "Ресторан сейчас не принимает заказы. Выберите другой ресторан или повторите позже.";
    }
    return "Блюдо сейчас недоступно.";
  };

  const handleAdd = (menuItemId: string, event: MouseEvent<HTMLButtonElement>) => {
    const result = addItem(menuItemId);

    if (result === "RESTAURANT_CONFLICT") {
      const confirmed = window.confirm(
        "В корзине есть блюда другого ресторана. Очистить корзину и добавить это блюдо?",
      );
      if (!confirmed) {
        return;
      }
      const replacementResult = addItem(menuItemId, true);
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
    <>
      <div className={flowStyles.detailHeader}>
        <Link href="/client/catalog">← Каталог</Link>
        <div>
          <h1>{restaurant.name}</h1>
          <p>{restaurant.description}</p>
        </div>
        <div className={flowStyles.inlineMeta}>
          <span>{restaurant.address}</span>
          <span>Обычно {restaurant.defaultPreparationMinutes} минут</span>
        </div>
        {canOrder && deliveryProviderLabel ? (
          <p className={flowStyles.deliveryProvider}>
            {deliveryProviderLabel}
          </p>
        ) : null}
      </div>

      {!canOrder ? (
        <div className={flowStyles.warningNotice}>
          Демонстрационный ресторан — заказы пока недоступны
        </div>
      ) : null}

      <div className={flowStyles.buttonRow}>
        <h2>Меню</h2>
        <Link href="/client/cart">Открыть корзину →</Link>
      </div>
      <p className={flowStyles.feedback} aria-live="polite">
        {feedback}
      </p>

      <div className={flowStyles.menuList}>
        {menuItems.map((menuItem) => {
          const cartItem =
            state.cart.restaurantId === restaurant.id
              ? state.cart.items.find(
                  (item) => item.menuItemId === menuItem.id,
                )
              : undefined;
          const quantity = cartItem?.quantity ?? 0;

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
            </div>
            <div className={flowStyles.menuActions}>
              <span className={flowStyles.price}>
                {formatMoney(menuItem.priceCents, menuItem.currencyCode)}
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
                      setItemQuantity(menuItem.id, quantity - 1)
                    }
                  >
                    −
                  </button>
                  <span aria-live="polite">{quantity}</span>
                  <button
                    type="button"
                    aria-label={`Увеличить количество: ${menuItem.name}`}
                    onClick={(event) => handleAdd(menuItem.id, event)}
                  >
                    +
                  </button>
                </div>
              ) : (
                <button
                  className={flowStyles.primaryButton}
                  type="button"
                  disabled={!menuItem.available || !canOrder}
                  onClick={(event) => handleAdd(menuItem.id, event)}
                >
                  Добавить
                </button>
              )}
            </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
