"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useClientAddressConfirmation } from "@/components/order-flow/client-address-confirmation";
import flowStyles from "@/components/order-flow/order-flow.module.css";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  calculateCartPricing,
  formatMoney,
  getCartItemViews,
  getDeliveryProviderLabel,
  getRestaurant,
  getSmallOrderMissingAmountCents,
  isAddressReady,
  isCustomerNameValid,
  isCustomerPhoneValid,
} from "@/prototype/selectors";

export default function ClientCartPage() {
  const router = useRouter();
  const { isAddressConfirmed, isConfirmationHydrated } =
    useClientAddressConfirmation();
  const {
    state,
    setItemQuantity,
    setItemComment,
    updateAddress,
    updateCustomer,
    createOrder,
  } = usePrototype();
  const [submitError, setSubmitError] = useState("");
  const itemViews = getCartItemViews(state);
  const restaurant = getRestaurant(state, state.cart.restaurantId);
  const pricing = calculateCartPricing(state);
  const smallOrderMissingCents = getSmallOrderMissingAmountCents(state);
  const hasAddressInput = Boolean(
    state.cart.address.street.trim() || state.cart.address.house.trim(),
  );
  const addressIsReady = isAddressReady(state.cart.address, state);
  const deliveryProviderLabel = restaurant
    ? getDeliveryProviderLabel(restaurant)
    : null;
  const customerNameIsValid = isCustomerNameValid(state.customer.name);
  const customerPhoneIsValid = isCustomerPhoneValid(state.customer.phone);
  const canSubmitOrder =
    isAddressConfirmed &&
    customerNameIsValid &&
    customerPhoneIsValid &&
    addressIsReady &&
    itemViews.length > 0 &&
    state.cart.paymentMethod === "ONLINE" &&
    restaurant?.isAcceptingOrders === true &&
    restaurant.deliveryModes.includes("PLATFORM_DRIVER") &&
    restaurant.paymentMethods.includes("ONLINE") &&
    itemViews.every(({ menuItem }) => menuItem.available);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = createOrder();
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
          <h1>Ваш заказ</h1>
        </header>
        <div className={flowStyles.emptyState}>
          Корзина пуста. <Link href="/client/catalog">Перейти в каталог</Link>
        </div>
      </>
    );
  }

  return (
    <form id="checkout-cart" onSubmit={handleSubmit}>
      <header className={flowStyles.checkoutHeading}>
        <h1>Ваш заказ</h1>
        <p>{restaurant.name}</p>
      </header>

      {isConfirmationHydrated && !isAddressConfirmed ? (
        <div className={flowStyles.addressConfirmationPrompt} role="status">
          <Link href="/client/catalog#delivery-address">
            Подтвердите адрес доставки
          </Link>
        </div>
      ) : null}

      <div className={flowStyles.cartLayout}>
        <div className={flowStyles.panelStack}>
          <section className={flowStyles.card}>
            <h2>Состав заказа</h2>
            <div className={flowStyles.cartItems}>
              {itemViews.map(({ cartItem, menuItem, lineTotalCents }) => (
                <div className={flowStyles.cartLine} key={menuItem.id}>
                  <div className={flowStyles.cartLineTop}>
                    <div>
                      <strong>{menuItem.name}</strong>
                      <p>{formatMoney(lineTotalCents)}</p>
                    </div>
                    <div className={flowStyles.quantityControls}>
                      <button
                        className={flowStyles.quantityButton}
                        type="button"
                        aria-label={`Уменьшить количество: ${menuItem.name}`}
                        onClick={() =>
                          setItemQuantity(menuItem.id, cartItem.quantity - 1)
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
                          setItemQuantity(menuItem.id, cartItem.quantity + 1)
                        }
                      >
                        +
                      </button>
                      <button
                        className={flowStyles.removeButton}
                        type="button"
                        onClick={() => setItemQuantity(menuItem.id, 0)}
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
                        setItemComment(menuItem.id, event.target.value)
                      }
                      placeholder="Например: без лука"
                    />
                  </label>
                </div>
              ))}
            </div>
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
                    updateCustomer({ name: event.target.value })
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
                    updateCustomer({ phone: event.target.value })
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

          <section className={flowStyles.card}>
            <h2>Адрес доставки</h2>
            <div className={flowStyles.fieldGrid}>
              <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
                <span>Улица</span>
                <select
                  required
                  value={state.cart.address.street}
                  onChange={(event) =>
                    updateAddress({ street: event.target.value })
                  }
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
                  required
                  value={state.cart.address.house}
                  onChange={(event) => updateAddress({ house: event.target.value })}
                />
              </label>
              <label className={flowStyles.field}>
                <span>Квартира</span>
                <input
                  value={state.cart.address.apartment}
                  onChange={(event) =>
                    updateAddress({ apartment: event.target.value })
                  }
                />
              </label>
              <label className={flowStyles.field}>
                <span>Подъезд</span>
                <input
                  value={state.cart.address.entrance}
                  onChange={(event) =>
                    updateAddress({ entrance: event.target.value })
                  }
                />
              </label>
              <label className={flowStyles.field}>
                <span>Этаж</span>
                <input
                  value={state.cart.address.floor}
                  onChange={(event) => updateAddress({ floor: event.target.value })}
                />
              </label>
              <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
                <span>Комментарий к доставке</span>
                <textarea
                  value={state.cart.address.comment}
                  onChange={(event) =>
                    updateAddress({ comment: event.target.value })
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
          </section>

          <section className={flowStyles.card}>
            <h2>Оплата</h2>
            <p className={flowStyles.compactPayment}>Оплата онлайн</p>
            {deliveryProviderLabel ? (
              <p className={flowStyles.deliveryProvider}>
                {deliveryProviderLabel}
              </p>
            ) : null}
          </section>
        </div>

        <aside className={flowStyles.card}>
          <h2>Итого</h2>
          <dl className={flowStyles.summaryList}>
            <div className={flowStyles.summaryRow}>
              <dt>Еда</dt>
              <dd>{formatMoney(pricing.foodSubtotalCents)}</dd>
            </div>
            <div className={flowStyles.summaryRow}>
              <dt>Доставка</dt>
              <dd>
                {pricing.deliveryFeeCents === null
                  ? "Укажите адрес"
                  : formatMoney(pricing.deliveryFeeCents)}
              </dd>
            </div>
            {pricing.smallOrderFeeCents > 0 ? (
              <div className={flowStyles.summaryRow}>
                <dt>Доплата за небольшой заказ</dt>
                <dd>{formatMoney(pricing.smallOrderFeeCents)}</dd>
              </div>
            ) : null}
            <div className={`${flowStyles.summaryRow} ${flowStyles.summaryTotal}`}>
              <dt>К оплате</dt>
              <dd>
                {pricing.customerTotalCents === null
                  ? "—"
                  : formatMoney(pricing.customerTotalCents)}
              </dd>
            </div>
          </dl>
          {pricing.smallOrderFeeCents > 0 ? (
            <div className={flowStyles.warningNotice}>
              Добавьте товаров ещё на {formatMoney(smallOrderMissingCents)},
              чтобы доплата исчезла.
            </div>
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
