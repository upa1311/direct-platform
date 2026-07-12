"use client";

import {
  ArrowLeft,
  ArrowRight,
  Banknote,
  Check,
  Info,
  MapPin,
  QrCode,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import {
  cashMinimumFoodSubtotalCents,
  deliveryFeeCents,
  formatMoney,
  getSmallOrderFee,
} from "@/lib/demo-calculations";
import type { PaymentMethod } from "@/types/prototype";

interface CheckoutScreenProps {
  foodSubtotalCents: number;
  paymentMethod: PaymentMethod;
  phoneConfirmed: boolean;
  onPaymentMethodChange: (method: PaymentMethod) => void;
  onConfirmPhone: () => void;
  onBack: () => void;
  onSubmit: () => void;
}

export function CheckoutScreen({
  foodSubtotalCents,
  paymentMethod,
  phoneConfirmed,
  onPaymentMethodChange,
  onConfirmPhone,
  onBack,
  onSubmit,
}: CheckoutScreenProps) {
  const cashAvailable = foodSubtotalCents >= cashMinimumFoodSubtotalCents;
  const smallOrderFeeCents = paymentMethod === "QR" ? getSmallOrderFee(foodSubtotalCents) : 0;
  const totalCents = foodSubtotalCents + deliveryFeeCents + smallOrderFeeCents;

  return (
    <main className="customer-main cart-page">
      <button className="back-button" type="button" onClick={onBack}>
        <ArrowLeft size={18} /> Вернуться в корзину
      </button>

      <div className="checkout-layout">
        <section className="checkout-content">
          <div className="page-title-block">
            <p className="eyebrow">Последний шаг</p>
            <h1>Оформление заказа</h1>
            <p>Проверьте тестовые данные перед отправкой ресторану.</p>
          </div>

          <section className="form-card">
            <div className="form-card-heading"><span><MapPin size={20} /></span><div><h2>Адрес доставки</h2><p>Внутренняя зона определена автоматически</p></div></div>
            <label className="field-label">Улица и дом<input defaultValue="Тестовая улица, дом 1" /></label>
            <div className="field-grid">
              <label className="field-label">Квартира<input defaultValue="12" /></label>
              <label className="field-label">Подъезд<input defaultValue="2" /></label>
              <label className="field-label">Этаж<input defaultValue="3" /></label>
            </div>
            <label className="field-label">Комментарий<textarea defaultValue="Позвонить за несколько минут" /></label>
            <div className="zone-result"><Check size={16} /> Определена зона клиента: <strong>Зона 2</strong><span>Тестовое значение</span></div>
          </section>

          <section className="form-card">
            <div className="form-card-heading"><span><QrCode size={20} /></span><div><h2>Способ оплаты</h2><p>Полный демо-сценарий доступен для QR</p></div></div>
            <div className="payment-options">
              <button type="button" className={paymentMethod === "QR" ? "is-selected" : ""} onClick={() => onPaymentMethodChange("QR")}>
                <span><QrCode size={22} /></span><div><strong>QR-оплата</strong><small>После проверки состава рестораном</small></div>{paymentMethod === "QR" ? <Check size={18} /> : null}
              </button>
              <button type="button" className={paymentMethod === "CASH" ? "is-selected" : ""} onClick={() => cashAvailable && onPaymentMethodChange("CASH")} disabled={!cashAvailable}>
                <span><Banknote size={22} /></span><div><strong>Наличными</strong><small>{cashAvailable ? "Требуется cashEnabled-водитель" : `Доступно от ${formatMoney(cashMinimumFoodSubtotalCents)} еды`}</small></div>{paymentMethod === "CASH" ? <Check size={18} /> : null}
              </button>
            </div>
            {!cashAvailable ? (
              <div className="demo-note warning-note"><Info size={17} /> Оплата наличными доступна для заказов еды от $7. Добавьте товаров ещё на {formatMoney(cashMinimumFoodSubtotalCents - foodSubtotalCents)} или выберите QR-оплату.</div>
            ) : null}
          </section>

          <section className="phone-confirm-card">
            <span className={phoneConfirmed ? "is-confirmed" : ""}>{phoneConfirmed ? <ShieldCheck size={23} /> : <Smartphone size={23} />}</span>
            <div><strong>{phoneConfirmed ? "Телефон подтверждён" : "Подтвердите телефон"}</strong><p>{phoneConfirmed ? "+373 ••• •• 12 · демо-подтверждение" : "Для первого заказа требуется подтверждённый номер"}</p></div>
            <button type="button" onClick={onConfirmPhone} disabled={phoneConfirmed}>{phoneConfirmed ? "Готово" : "Подтвердить"}</button>
          </section>
        </section>

        <aside className="order-summary-card checkout-summary">
          <p className="eyebrow">Ваш заказ</p>
          <h2>Проверка суммы</h2>
          <dl className="summary-list">
            <div><dt>Стоимость еды</dt><dd>{formatMoney(foodSubtotalCents)}</dd></div>
            <div><dt>Доставка <small>демо-тариф</small></dt><dd>{formatMoney(deliveryFeeCents)}</dd></div>
            {smallOrderFeeCents > 0 ? <div><dt>Доплата за небольшой заказ</dt><dd>{formatMoney(smallOrderFeeCents)}</dd></div> : null}
          </dl>
          <div className="summary-total"><span>Итого</span><strong>{formatMoney(totalCents)}</strong></div>
          <div className="checkout-safety"><ShieldCheck size={18} /><p><strong>Сначала проверка состава</strong>Ресторан подтвердит наличие до QR-оплаты.</p></div>
          <button className="primary-button summary-button" type="button" onClick={onSubmit} disabled={!phoneConfirmed}>
            Отправить заказ <ArrowRight size={18} />
          </button>
          {!phoneConfirmed ? <p className="summary-caption">Сначала подтвердите телефон демо-кнопкой.</p> : null}
        </aside>
      </div>
    </main>
  );
}
