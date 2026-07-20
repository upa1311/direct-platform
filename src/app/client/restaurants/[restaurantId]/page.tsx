"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";
import { Gift } from "lucide-react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import mediaStyles from "@/components/menu/menu-media.module.css";
import { MenuMediaImage } from "@/components/menu/menu-media-image";
import { ClientRestaurantSchedule } from "@/components/order-flow/client-restaurant-schedule";
import { useClientAddressConfirmation } from "@/components/order-flow/client-address-confirmation";
import { useClientCartUi } from "@/components/order-flow/client-cart-ui";
import { addItemFeedbackMessage } from "@/components/util/mutation-feedback";
import { useMutationGuard } from "@/components/util/use-mutation-guard";
import { useNowMs } from "@/components/util/use-now";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatMoney,
  getClientRestaurantAvailabilityAt,
  getRestaurant,
  getRestaurantMenu,
  getRestaurantPromotion,
  isAddressReady,
  isMenuItemAvailableAt,
  resolveVariant,
} from "@/prototype/selectors";
import { shouldAutoConfirmAddress } from "@/prototype/pricing-engine";
import {
  effectiveMenuItemVariantPortion,
  formatMenuPortion,
} from "@/prototype/menu-catalog";

export default function ClientRestaurantPage() {
  const params = useParams<{ restaurantId: string }>();
  const { state, addItem, setItemQuantity: setItemQuantityAck } =
    usePrototype();
  // Исправление 5.7/6: изменение количества — через guard с русской ошибкой;
  // добавление — через структурированный результат (см. addItemFeedbackMessage).
  const { error: cartMutationError, run: runCartMutation } = useMutationGuard();
  const setItemQuantity = (
    ...args: Parameters<typeof setItemQuantityAck>
  ) => runCartMutation(() => setItemQuantityAck(...args));
  const { isAddressConfirmed, confirmAddress } = useClientAddressConfirmation();
  const { notifyItemAdded } = useClientCartUi();
  const [feedback, setFeedback] = useState("");
  const [selectedVariants, setSelectedVariants] = useState<
    Record<string, string>
  >({});
  const nowMs = useNowMs();

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
  // §3/§10: единый источник — до гидратации (nowMs=0) заказ заблокирован
  // (SSR-безопасно) и совпадает с каталогом/корзиной/доменом.
  const availability = getClientRestaurantAvailabilityAt(restaurant, nowMs);
  const canOrder = availability.canAcceptOrders;
  const cartQuantity =
    state.cart.restaurantId === restaurant.id
      ? state.cart.items.reduce((total, item) => total + item.quantity, 0)
      : 0;
  // CTA при наличии товаров всегда ведёт в корзину. Адрес заполняется в
  // оформлении; клиента не возвращают в каталог из-за отсутствующего адреса.
  const checkoutHref = "/client/cart#checkout-cart";
  const checkoutLabel = "Перейти к оформлению";

  // Исправление 6: сообщение строится по конкретному статусу (в т.ч.
  // инфраструктурному SYNC_UNAVAILABLE/SAVE_FAILED) — без маскировки под
  // «блюдо недоступно» и без предложения очистить корзину.
  const getAddFeedback = (result: Awaited<ReturnType<typeof addItem>>) =>
    addItemFeedbackMessage(result) ?? "";

  const handleAdd = async (
    menuItemId: string,
    variantId: string | null,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    const target = event.currentTarget;
    const result = await addItem(menuItemId, variantId);

    if (result === "RESTAURANT_CONFLICT") {
      const confirmed = window.confirm(
        "В корзине есть блюда другого ресторана. Очистить корзину и добавить это блюдо?",
      );
      if (!confirmed) {
        return;
      }
      const replacementResult = await addItem(menuItemId, variantId, true);
      setFeedback(
        replacementResult === "ADDED"
          ? "Предыдущая корзина очищена. Блюдо добавлено."
          : getAddFeedback(replacementResult),
      );
      if (replacementResult === "ADDED") notifyItemAdded(target);
      return;
    }

    setFeedback(getAddFeedback(result));
    if (result === "ADDED") notifyItemAdded(target);
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
        <ClientRestaurantSchedule
          restaurant={restaurant}
          nowMs={nowMs}
          showFullSchedule
        />
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

      {/* §1/§2: статус доступности показывает единый бейдж в ClientRestaurantSchedule
          выше — отдельная персиковая плашка удалена, чтобы не дублировать. */}

      <div className={flowStyles.buttonRow} id="restaurant-menu">
        <h2>Меню</h2>
      </div>
      <p className={flowStyles.feedback} aria-live="polite">
        {feedback}
      </p>
      {cartMutationError ? (
        <div className={flowStyles.warningNotice} role="alert">
          {cartMutationError}
        </div>
      ) : null}

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
          const itemAvailable = isMenuItemAvailableAt(menuItem, nowMs);
          // Порция выбранного варианта важнее базовой; без порции строки нет.
          const portionText = formatMenuPortion(
            effectiveMenuItemVariantPortion(
              menuItem.portion ?? null,
              selectedVariant?.portion ?? null,
            ),
          );

          return (
            <article
              className={`${flowStyles.menuItem} ${
                itemAvailable ? "" : flowStyles.menuItemUnavailable
              }`}
              key={menuItem.id}
            >
              <div>
                {menuItem.imageMediaId ? (
                  <MenuMediaImage
                    mediaId={menuItem.imageMediaId}
                    alt={`Фото: ${menuItem.name}`}
                    className={mediaStyles.mediaClientCard}
                  />
                ) : null}
                <h2>{menuItem.name}</h2>
                <p>{menuItem.description}</p>
                <div className={flowStyles.cardMeta}>
                  <span>{menuItem.category}</span>
                  <span>{itemAvailable ? "В наличии" : "Временно нет"}</span>
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
                {portionText ? (
                  <span className={flowStyles.menuPortion}>{portionText}</span>
                ) : null}
                {quantity > 0 && itemAvailable && canOrder ? (
                  <div
                    className={flowStyles.menuQuantity}
                    aria-label={`Количество: ${menuItem.name}`}
                  >
                    <button
                      type="button"
                      aria-label={`Уменьшить количество: ${menuItem.name}`}
                      onClick={() =>
                        void setItemQuantity(menuItem.id, lineVariantId, quantity - 1)
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
                    disabled={!itemAvailable || !canOrder}
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
          <span>Выбрано: {cartQuantity} —</span>
          <strong>{checkoutLabel}</strong>
        </Link>
      ) : null}
    </div>
  );
}
