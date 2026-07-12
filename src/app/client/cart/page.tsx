"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  calculateCartPricing,
  formatMoney,
  getCartItemViews,
  getRestaurant,
  getSmallOrderMissingAmountCents,
  isAddressReady,
} from "@/prototype/selectors";

export default function ClientCartPage() {
  const router = useRouter();
  const {
    state,
    setItemQuantity,
    setItemComment,
    updateAddress,
    setPaymentMethod,
    createOrder,
  } = usePrototype();
  const [submitError, setSubmitError] = useState("");
  const itemViews = getCartItemViews(state);
  const restaurant = getRestaurant(state, state.cart.restaurantId);
  const pricing = calculateCartPricing(state);
  const smallOrderMissingCents = getSmallOrderMissingAmountCents(state);

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
        <PageHeading
          eyebrow="Клиент"
          title="Корзина"
          description="Здесь будут собраны блюда перед отправкой заказа."
        />
        <div className={flowStyles.emptyState}>
          Корзина пуста. <Link href="/client/catalog">Перейти в каталог</Link>
        </div>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <PageHeading
        eyebrow="Клиент"
        title="Корзина"
        description={`Заказ из ${restaurant.name}. Один заказ содержит блюда только одного ресторана.`}
      />

      <div className={flowStyles.cartLayout}>
        <div className={flowStyles.panelStack}>
          <section className={flowStyles.card}>
            <h2>Блюда</h2>
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
            {state.cart.address.zoneId ? (
              <div className={flowStyles.zoneNotice}>
                Зона определена автоматически: {state.cart.address.zoneId.replace("zone-", "зона ")}.
              </div>
            ) : null}
          </section>

          <section className={flowStyles.card}>
            <fieldset className={flowStyles.radioField}>
              <legend className={flowStyles.radioLegend}>Способ оплаты</legend>
              <div className={flowStyles.paymentOptions}>
                <label className={flowStyles.paymentOption}>
                  <input
                    type="radio"
                    name="paymentMethod"
                    value="ONLINE"
                    checked={state.cart.paymentMethod === "ONLINE"}
                    onChange={() => setPaymentMethod("ONLINE")}
                  />
                  Оплата онлайн
                </label>
                <p>
                  КЛЕВЕР-карта, KleverPay/банковское приложение или QR — после
                  подключения банка.
                </p>
                <label
                  className={`${flowStyles.paymentOption} ${flowStyles.paymentOptionDisabled}`}
                >
                  <input
                    type="radio"
                    name="paymentMethod"
                    value="CASH"
                    checked={state.cart.paymentMethod === "CASH"}
                    disabled
                    onChange={() => setPaymentMethod("CASH")}
                  />
                  Наличные
                </label>
              </div>
            </fieldset>
            <div className={flowStyles.warningNotice}>
              Наличные будут подключены отдельным этапом после завершения и
              проверки водительского маршрута онлайн-заказов. Пока выберите
              оплату онлайн.
            </div>
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
            <div className={flowStyles.summaryRow}>
              <dt>Доплата за небольшой заказ</dt>
              <dd>{formatMoney(pricing.smallOrderFeeCents)}</dd>
            </div>
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
              disabled={!isAddressReady(state.cart.address)}
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
