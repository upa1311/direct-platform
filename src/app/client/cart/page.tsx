"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Gift } from "lucide-react";

import { REPEAT_NOTICE_KEY } from "@/components/order-flow/client-order-actions";
import { ClientRestaurantSchedule } from "@/components/order-flow/client-restaurant-schedule";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { useNowMs } from "@/components/util/use-now";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  calculateCartPricing,
  formatMoney,
  getCartItemViews,
  getClientRestaurantAvailabilityAt,
  getDeliveryModeProviderLabel,
  getPickupPaymentSummary,
  getRestaurant,
  getSmallOrderMissingAmountCents,
  isAddressReady,
  isCustomerNameValid,
  isCustomerPhoneValid,
  isMenuItemAvailableAt,
  pluralizePizza,
} from "@/prototype/selectors";

export default function ClientCartPage() {
  const router = useRouter();
  const {
    state,
    setItemQuantity,
    setItemComment,
    setFulfillmentChoice,
    updateAddress,
    updateCustomer,
    createOrder,
  } = usePrototype();
  const nowMs = useNowMs();
  const [submitError, setSubmitError] = useState("");
  const [addressError, setAddressError] = useState("");
  const [repeatNotice, setRepeatNotice] = useState("");
  // Спокойное уведомление после повторного заказа (§6–7). Читаем sessionStorage
  // только после монтирования, чтобы не расходиться с SSR-разметкой.
  useEffect(() => {
    const notice = window.sessionStorage.getItem(REPEAT_NOTICE_KEY);
    if (notice) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- одноразовое чтение browser-only storage после гидрации
      setRepeatNotice(notice);
      window.sessionStorage.removeItem(REPEAT_NOTICE_KEY);
    }
  }, []);
  const addressSectionRef = useRef<HTMLElement>(null);
  const streetFieldRef = useRef<HTMLSelectElement>(null);
  const houseFieldRef = useRef<HTMLInputElement>(null);
  const itemViews = getCartItemViews(state);
  const restaurant = getRestaurant(state, state.cart.restaurantId);
  const pricing = calculateCartPricing(state);
  const smallOrderMissingCents = getSmallOrderMissingAmountCents(state);
  const hasAddressInput = Boolean(
    state.cart.address.street.trim() || state.cart.address.house.trim(),
  );
  const addressIsReady = isAddressReady(state.cart.address, state);
  const customerNameIsValid = isCustomerNameValid(state.customer.name);
  const customerPhoneIsValid = isCustomerPhoneValid(state.customer.phone);
  const isPickup = state.cart.fulfillmentChoice === "PICKUP";
  const isDelivery = !isPickup;
  const deliveryMode = pricing.deliveryMode;
  const isRestaurantDelivery = deliveryMode === "RESTAURANT_DELIVERY";
  const providerLabel = deliveryMode
    ? getDeliveryModeProviderLabel(deliveryMode)
    : null;
  const restaurantDeliveryReady =
    !isRestaurantDelivery || pricing.restaurantDeliveryStatus === "OK";
  const selectedModeIsSupported =
    deliveryMode !== null &&
    restaurant?.deliveryModes.includes(deliveryMode) === true;
  // Кнопка отправки не блокируется молча из-за адреса: для доставки адрес
  // проверяется при клике (handleSubmit покажет ошибку и сфокусирует поле).
  // §3/§5: единый источник доступности — совпадает с каталогом/меню/доменом.
  const availability = restaurant
    ? getClientRestaurantAvailabilityAt(restaurant, nowMs)
    : null;
  const canAcceptOrders = availability?.canAcceptOrders ?? false;
  const hasUnavailableItem = itemViews.some(
    ({ menuItem }) => !isMenuItemAvailableAt(menuItem, nowMs),
  );
  const canSubmitOrder =
    selectedModeIsSupported &&
    restaurantDeliveryReady &&
    customerNameIsValid &&
    customerPhoneIsValid &&
    itemViews.length > 0 &&
    state.cart.paymentMethod === "ONLINE" &&
    canAcceptOrders &&
    !hasUnavailableItem &&
    (isPickup ? pricing.customerTotalCents !== null : true);

  const focusAddressSection = () => {
    window.requestAnimationFrame(() => {
      addressSectionRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
      // Первое незаполненное поле: сначала улица, затем дом.
      const target = state.cart.address.street.trim()
        ? houseFieldRef.current
        : streetFieldRef.current;
      target?.focus({ preventScroll: true });
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Доставка без корректного адреса: не создаём заказ, показываем ошибку
    // рядом с формой, прокручиваем к адресу и фокусируем первое пустое поле.
    // Клиент не отправляется обратно в каталог.
    if (isDelivery && !addressIsReady) {
      setSubmitError("");
      setAddressError("Введите адрес доставки");
      focusAddressSection();
      return;
    }
    setAddressError("");
    const result = await createOrder();
    if (result.error || !result.orderId) {
      setSubmitError(result.error ?? "Не удалось создать заказ.");
      return;
    }
    router.push(`/client/orders/${result.orderId}`);
  };

  if (!restaurant || itemViews.length === 0) {
    return (
      <>
        <header className={flowStyles.checkoutHeading}>
          <h1>Ваш выбор</h1>
        </header>
        <div className={flowStyles.emptyState}>
          Корзина пуста. <Link href="/client/catalog">Перейти в каталог</Link>
        </div>
      </>
    );
  }

  // Самовывоз в итогах — цифра 0 (не «Бесплатно»); финансово deliveryFee = 0.
  const deliveryValue = isPickup
    ? "0"
    : pricing.deliveryFeeCents !== null
      ? formatMoney(pricing.deliveryFeeCents)
      : isRestaurantDelivery
        ? "—"
        : "Укажите адрес";
  const pickupPaymentSummary = getPickupPaymentSummary(restaurant);

  // Клиентский прогресс: сколько ПЛАТНЫХ пицц осталось до следующей бесплатной.
  // 0 — следующая уже бесплатная; null (нет участвующих) — подсказку не показываем.
  const promoPaidBeforeFree =
    pricing.promotionEligibleUnits > 0 &&
    pricing.promotionPaidUnitsBeforeNextFree !== null
      ? pricing.promotionPaidUnitsBeforeNextFree
      : null;

  return (
    <form id="checkout-cart" onSubmit={handleSubmit}>
      <header className={flowStyles.checkoutHeading}>
        <h1>Ваш выбор</h1>
        <p>{restaurant.name}</p>
        <ClientRestaurantSchedule
          restaurant={restaurant}
          nowMs={nowMs}
          showFullSchedule
        />
        <Link
          className={flowStyles.backToMenuLink}
          href={`/client/restaurants/${restaurant.id}`}
        >
          ← Вернуться в меню
        </Link>
      </header>

      {repeatNotice ? (
        <p className={flowStyles.summaryHint} role="status">
          {repeatNotice}
        </p>
      ) : null}

      {/* §1/§2: статус доступности показывает единый бейдж в
          ClientRestaurantSchedule (заголовок оформления) — большая плашка
          удалена. Компактная причина недоступности оформления — у кнопки. */}
      {/* §0.1: нижняя строка — только факт недоступности. Время возобновления /
          следующего открытия уже показывает ClientRestaurantSchedule/бейдж, поэтому
          detailLabel здесь НЕ дублируем. */}
      {nowMs > 0 && availability && !availability.canAcceptOrders ? (
        <p className={flowStyles.restaurantAvailabilityNote} role="status">
          Оформление временно недоступно.
        </p>
      ) : null}
      {hasUnavailableItem ? (
        <div className={flowStyles.warningNotice} role="alert">
          Некоторые блюда больше недоступны. Удалите их из корзины или выберите
          замену.
        </div>
      ) : null}

      <div className={flowStyles.cartLayout}>
        <div className={flowStyles.panelStack}>
          <section className={flowStyles.card}>
            <h2>Детали заказа</h2>
            <div className={flowStyles.cartItems}>
              {itemViews.map(({ cartItem, menuItem, variant, lineTotalCents }) => (
                <div
                  className={flowStyles.cartLine}
                  key={`${menuItem.id}-${cartItem.variantId ?? "base"}`}
                >
                  <div className={flowStyles.cartLineTop}>
                    <div>
                      <strong>
                        {menuItem.name}
                        {variant && !variant.isDefault
                          ? ` · ${variant.name}`
                          : ""}
                      </strong>
                      <p>{formatMoney(lineTotalCents)}</p>
                      {!isMenuItemAvailableAt(menuItem, nowMs) ? (
                        <p className={flowStyles.cartLineUnavailable}>
                          Сейчас недоступно
                        </p>
                      ) : null}
                    </div>
                    <div className={flowStyles.quantityControls}>
                      <button
                        className={flowStyles.quantityButton}
                        type="button"
                        aria-label={`Уменьшить количество: ${menuItem.name}`}
                        onClick={() =>
                          void setItemQuantity(
                            menuItem.id,
                            cartItem.variantId,
                            cartItem.quantity - 1,
                          )
                        }
                      >
                        −
                      </button>
                      <span>{cartItem.quantity}</span>
                      <button
                        className={flowStyles.quantityButton}
                        type="button"
                        aria-label={`Увеличить количество: ${menuItem.name}`}
                        onClick={() =>
                          void setItemQuantity(
                            menuItem.id,
                            cartItem.variantId,
                            cartItem.quantity + 1,
                          )
                        }
                      >
                        +
                      </button>
                      <button
                        className={flowStyles.removeButton}
                        type="button"
                        onClick={() =>
                          void setItemQuantity(menuItem.id, cartItem.variantId, 0)
                        }
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                  <label className={flowStyles.field}>
                    <span>Комментарий к блюду</span>
                    <input
                      value={cartItem.cookingComment}
                      onChange={(event) =>
                        void setItemComment(
                          menuItem.id,
                          cartItem.variantId,
                          event.target.value,
                        )
                      }
                      placeholder="Например: без лука"
                    />
                  </label>
                </div>
              ))}
            </div>
            {promoPaidBeforeFree !== null ? (
              <p className={flowStyles.promoProgressInline}>
                <Gift aria-hidden="true" className={flowStyles.promoInlineIcon} />
                <span>
                  {promoPaidBeforeFree > 0 ? (
                    <>
                      До следующей бесплатной пиццы добавьте ещё{" "}
                      <strong>{promoPaidBeforeFree}</strong>{" "}
                      {pluralizePizza(promoPaidBeforeFree)}
                    </>
                  ) : (
                    "Следующая пицца будет бесплатной"
                  )}
                </span>
              </p>
            ) : null}
          </section>

          <section className={flowStyles.card}>
            <h2>Контактные данные</h2>
            <div className={flowStyles.fieldGrid}>
              <label className={flowStyles.field}>
                <span>Имя</span>
                <input
                  required
                  value={state.customer.name}
                  aria-invalid={!customerNameIsValid}
                  onChange={(event) =>
                    void updateCustomer({ name: event.target.value })
                  }
                  autoComplete="name"
                />
                {!customerNameIsValid ? (
                  <small className={flowStyles.fieldError}>
                    Укажите имя получателя.
                  </small>
                ) : null}
              </label>
              <label className={flowStyles.field}>
                <span>Телефон</span>
                <input
                  required
                  type="tel"
                  value={state.customer.phone}
                  aria-invalid={!customerPhoneIsValid}
                  onChange={(event) =>
                    void updateCustomer({ phone: event.target.value })
                  }
                  autoComplete="tel"
                  placeholder="Введите номер телефона"
                />
                {!customerPhoneIsValid ? (
                  <small className={flowStyles.fieldError}>
                    В телефоне должно быть не менее 7 цифр.
                  </small>
                ) : null}
              </label>
            </div>
            <p className={flowStyles.prototypeNote}>
              Подтверждение телефона будет подключено позднее.
            </p>
          </section>

          {isDelivery ? (
            <section
              className={flowStyles.card}
              id="delivery-address-section"
              ref={addressSectionRef}
            >
              <h2>Адрес доставки</h2>
              <div className={flowStyles.fieldGrid}>
                <label
                  className={`${flowStyles.field} ${flowStyles.fieldFull}`}
                >
                  <span>Улица</span>
                  <select
                    ref={streetFieldRef}
                    value={state.cart.address.street}
                    onChange={(event) => {
                      void updateAddress({ street: event.target.value });
                      setAddressError("");
                    }}
                  >
                    <option value="">Выберите улицу</option>
                    {state.zones.flatMap((zone) =>
                      zone.streets.map((street) => (
                        <option value={street} key={street}>
                          {street}
                        </option>
                      )),
                    )}
                  </select>
                </label>
                <label className={flowStyles.field}>
                  <span>Дом</span>
                  <input
                    ref={houseFieldRef}
                    value={state.cart.address.house}
                    onChange={(event) => {
                      void updateAddress({ house: event.target.value });
                      setAddressError("");
                    }}
                  />
                </label>
                <label className={flowStyles.field}>
                  <span>Квартира</span>
                  <input
                    value={state.cart.address.apartment}
                    onChange={(event) =>
                      void updateAddress({ apartment: event.target.value })
                    }
                  />
                </label>
                <label className={flowStyles.field}>
                  <span>Подъезд</span>
                  <input
                    value={state.cart.address.entrance}
                    onChange={(event) =>
                      void updateAddress({ entrance: event.target.value })
                    }
                  />
                </label>
                <label className={flowStyles.field}>
                  <span>Этаж</span>
                  <input
                    value={state.cart.address.floor}
                    onChange={(event) =>
                      void updateAddress({ floor: event.target.value })
                    }
                  />
                </label>
                <label
                  className={`${flowStyles.field} ${flowStyles.fieldFull}`}
                >
                  <span>Комментарий к доставке</span>
                  <textarea
                    value={state.cart.address.comment}
                    onChange={(event) =>
                      void updateAddress({ comment: event.target.value })
                    }
                    placeholder="Домофон, ориентир или пожелание"
                  />
                </label>
              </div>
              {hasAddressInput && !addressIsReady ? (
                <div className={flowStyles.warningNotice} role="alert">
                  Выберите известную улицу и укажите номер дома.
                </div>
              ) : null}
              {addressError ? (
                <div className={flowStyles.warningNotice} role="alert">
                  {addressError}
                </div>
              ) : null}
            </section>
          ) : (
            <section className={flowStyles.card}>
              <h2>Точка самовывоза</h2>
              <p className={flowStyles.fulfillmentSummary}>
                <strong>{restaurant.name}</strong>
                <span>{restaurant.address}</span>
              </p>
            </section>
          )}

          <section className={flowStyles.card}>
            <h2>Оплата</h2>
            {isPickup ? (
              <>
                <p className={flowStyles.compactPayment}>
                  Оплата в ресторане при получении
                </p>
                {pickupPaymentSummary ? (
                  <p className={flowStyles.summaryHint}>
                    {pickupPaymentSummary}
                  </p>
                ) : null}
              </>
            ) : isRestaurantDelivery ? (
              <p className={flowStyles.compactPayment}>
                Оплата наличными курьеру ресторана
              </p>
            ) : (
              <p className={flowStyles.compactPayment}>Оплата онлайн</p>
            )}
          </section>
        </div>

        <aside className={flowStyles.card}>
          <div
            id="fulfillment-method"
            className={flowStyles.summaryFulfillment}
          >
            <h3 className={flowStyles.summaryFulfillmentTitle}>
              Как получить заказ
            </h3>
            <fieldset
              className={flowStyles.fulfillmentOptionsCompact}
              aria-label="Способ получения"
            >
              <label className={flowStyles.fulfillmentOptionCompact}>
                <input
                  type="radio"
                  name="checkout-delivery-mode"
                  checked={isDelivery}
                  onChange={() => void setFulfillmentChoice("DELIVERY")}
                />
                <span>Доставка</span>
              </label>
              <label className={flowStyles.fulfillmentOptionCompact}>
                <input
                  type="radio"
                  name="checkout-delivery-mode"
                  checked={isPickup}
                  onChange={() => void setFulfillmentChoice("PICKUP")}
                />
                <span>Самовывоз</span>
              </label>
            </fieldset>
            {isPickup ? (
              <p className={flowStyles.summaryFulfillmentNote}>
                Самовывоз из ресторана
              </p>
            ) : providerLabel ? (
              <p className={flowStyles.summaryFulfillmentNote}>
                {providerLabel}
              </p>
            ) : null}
          </div>

          <h2>Итого</h2>
          <dl className={flowStyles.summaryList}>
            <div className={flowStyles.summaryRow}>
              <dt>Еда</dt>
              <dd>{formatMoney(pricing.foodSubtotalBeforeDiscountsCents)}</dd>
            </div>
            {itemViews
              .filter((view) => view.promotionDiscountCents > 0)
              .map((view) => {
                const freeUnits =
                  view.baseUnitPriceCents > 0
                    ? Math.round(
                        view.promotionDiscountCents / view.baseUnitPriceCents,
                      )
                    : 0;
                return (
                  <div
                    className={flowStyles.summaryRow}
                    key={`discount-${view.menuItem.id}-${view.cartItem.variantId ?? "base"}`}
                  >
                    <dt>
                      Скидка: {view.menuItem.name}
                      {freeUnits > 1 ? ` × ${freeUnits}` : ""}
                    </dt>
                    <dd>−{formatMoney(view.promotionDiscountCents)}</dd>
                  </div>
                );
              })}
            <div className={flowStyles.summaryRow}>
              <dt>{isPickup ? "Самовывоз" : "Доставка"}</dt>
              <dd>{deliveryValue}</dd>
            </div>
            {pricing.smallOrderFeeCents > 0 ? (
              <div className={flowStyles.summaryRow}>
                <dt>Доплата за небольшой заказ</dt>
                <dd>{formatMoney(pricing.smallOrderFeeCents)}</dd>
              </div>
            ) : null}
            <div
              className={`${flowStyles.summaryRow} ${flowStyles.summaryTotal}`}
            >
              <dt>
                {isPickup
                  ? "Оплата в ресторане"
                  : isRestaurantDelivery
                    ? "Оплата курьеру ресторана"
                    : "К оплате"}
              </dt>
              <dd>
                {pricing.customerTotalCents === null
                  ? "—"
                  : formatMoney(pricing.customerTotalCents)}
              </dd>
            </div>
          </dl>

          {isRestaurantDelivery &&
          pricing.restaurantDeliveryStatus === "ZONE_NOT_SERVED" ? (
            <div className={flowStyles.warningNotice}>
              Ресторан пока не доставляет по этому адресу. Доступен самовывоз.
            </div>
          ) : null}
          {isRestaurantDelivery &&
          pricing.restaurantDeliveryStatus === "BELOW_MINIMUM" &&
          pricing.restaurantDeliveryMissingCents !== null ? (
            <p className={flowStyles.summaryHint} role="status">
              До минимальной суммы заказа не хватает{" "}
              {formatMoney(pricing.restaurantDeliveryMissingCents)}. Добавьте
              блюда, чтобы оформить доставку, или воспользуйтесь самовывозом.
            </p>
          ) : null}
          {isRestaurantDelivery &&
          pricing.restaurantDeliveryStatus === "OK" &&
          pricing.freeDeliveryRemainingCents !== null &&
          pricing.freeDeliveryRemainingCents > 0 ? (
            <p className={flowStyles.summaryHint}>
              До бесплатной доставки осталось{" "}
              {formatMoney(pricing.freeDeliveryRemainingCents)}
            </p>
          ) : null}
          {isRestaurantDelivery &&
          pricing.restaurantDeliveryStatus === "OK" &&
          pricing.freeDeliveryThresholdCents !== null &&
          pricing.deliveryFeeCents === 0 ? (
            <p className={flowStyles.summaryHint}>Доставка бесплатно</p>
          ) : null}
          {pricing.smallOrderFeeCents > 0 ? (
            <p className={flowStyles.smallOrderWarningText} role="status">
              Дозакажите на {formatMoney(smallOrderMissingCents)}, и доплата
              исчезнет.
            </p>
          ) : null}

          <div className={flowStyles.submitArea}>
            <button
              className={flowStyles.primaryButton}
              type="submit"
              disabled={!canSubmitOrder}
            >
              Отправить заказ
            </button>
            {submitError ? (
              <div className={flowStyles.warningNotice} role="alert">
                {submitError}
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </form>
  );
}
