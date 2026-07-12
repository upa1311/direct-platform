"use client";

import {
  ArrowLeft,
  CarFront,
  Check,
  CheckCircle2,
  Clock3,
  Info,
  MapPin,
  MessageCircle,
  PackageCheck,
  Phone,
  QrCode,
  ReceiptText,
  RefreshCcw,
  Store,
} from "lucide-react";
import { FoodArtwork } from "@/components/brand/food-artwork";
import { formatMoney } from "@/lib/demo-calculations";
import type { OrderStage } from "@/types/prototype";

interface OrderScreenProps {
  stage: OrderStage;
  totalCents: number;
  onStageChange: (stage: OrderStage) => void;
  onCancel: () => void;
  onHistory: () => void;
  onCallDemo: () => void;
}

export function OrderScreen({
  stage,
  totalCents,
  onStageChange,
  onCancel,
  onHistory,
  onCallDemo,
}: OrderScreenProps) {
  if (stage === "replacement") {
    return (
      <main className="customer-main order-flow-page">
        <section className="order-flow-card replacement-card">
          <span className="flow-icon warning-flow-icon"><RefreshCcw size={30} /></span>
          <p className="eyebrow">Нужен ваш ответ</p>
          <h1>Ресторан предлагает замену</h1>
          <p>Позиции 2 сейчас нет. Можно заменить её тестовой позицией из актуального меню.</p>
          <div className="replacement-timer"><Clock3 size={20} /><span><strong>03:00</strong><small>на решение</small></span></div>
          <div className="replacement-compare">
            <div><small>Было</small><span className="replace-symbol tone-green"><FoodArtwork kind="salad" /></span><strong>Позиция 2</strong><p>{formatMoney(380)}</p></div>
            <span className="replace-arrow">→</span>
            <div className="is-new"><small>Предложено</small><span className="replace-symbol tone-violet"><FoodArtwork kind="noodles" /></span><strong>Позиция 3</strong><p>{formatMoney(640)}</p></div>
          </div>
          <div className="demo-note"><Info size={17} /> Это демонстрация утверждённого сценария: принять замену или отменить весь заказ.</div>
          <div className="flow-actions split-actions">
            <button className="secondary-button" type="button" onClick={onCancel}>Отменить весь заказ</button>
            <button className="primary-button" type="button" onClick={() => onStageChange("payment")}><Check size={18} /> Принять замену</button>
          </div>
        </section>
      </main>
    );
  }

  if (stage === "payment") {
    return (
      <main className="customer-main order-flow-page">
        <section className="order-flow-card payment-card">
          <span className="flow-icon"><QrCode size={30} /></span>
          <p className="eyebrow">Состав подтверждён</p>
          <h1>Оплатите по QR</h1>
          <p>В настоящем приложении здесь будет QR провайдера. В демо деньги не списываются.</p>
          <div className="qr-layout">
            <div className="fake-qr" aria-label="Демонстрационный QR-код">
              {Array.from({ length: 81 }, (_, index) => <span className={(index * 7 + index % 5) % 3 === 0 ? "is-dark" : ""} key={index} />)}
              <strong>D</strong>
            </div>
            <div className="payment-details">
              <span className="payment-timer"><Clock3 size={17} /> 05:00 на оплату</span>
              <small>К оплате</small>
              <strong>{formatMoney(totalCents)}</strong>
              <p>Поведение после истечения 5 минут ещё требует бизнес-решения.</p>
            </div>
          </div>
          <button className="primary-button wide-button" type="button" onClick={() => onStageChange("active")}>
            <CheckCircle2 size={19} /> Подтвердить демо-оплату
          </button>
          <button className="text-button" type="button" onClick={() => onStageChange("review")}><ArrowLeft size={16} /> Вернуться к проверке</button>
        </section>
      </main>
    );
  }

  if (stage === "active") {
    return (
      <main className="customer-main active-order-page">
        <section className="active-order-hero">
          <div>
            <span className="active-status"><span /> Готовится</span>
            <p className="eyebrow">Демо-заказ · внутренний ID скрыт</p>
            <h1>Заказ принят в работу</h1>
            <p>Ресторан готовит заказ, а Direct начнёт поиск водителя за 10 минут до готовности.</p>
          </div>
          <div className="eta-card"><small>Ориентировочно</small><strong>35–45</strong><span>минут</span></div>
        </section>

        <div className="active-order-grid">
          <section className="order-progress-card">
            <div className="subsection-heading"><div><p className="eyebrow">Статус</p><h2>Что происходит сейчас</h2></div><span className="live-badge">Обновляется</span></div>
            <ol className="order-timeline">
              <li className="is-done"><span><Check size={16} /></span><div><strong>Состав подтверждён</strong><small>Ресторан проверил наличие</small></div><time>14:35</time></li>
              <li className="is-done"><span><Check size={16} /></span><div><strong>Оплата подтверждена</strong><small>Демонстрационная QR-оплата</small></div><time>14:37</time></li>
              <li className="is-current"><span><Store size={17} /></span><div><strong>Ресторан готовит</strong><small>Подтверждено 25 минут</small></div><time>сейчас</time></li>
              <li><span><CarFront size={17} /></span><div><strong>Поиск водителя</strong><small>Начнётся ближе к готовности</small></div><time>далее</time></li>
              <li><span><PackageCheck size={17} /></span><div><strong>Передача заказа</strong><small>Точный код требует решения</small></div><time>далее</time></li>
            </ol>
          </section>

          <aside className="driver-card">
            <div className="driver-card-header"><span>В1</span><div><small>Назначенный водитель</small><h2>Водитель 1</h2><p>Тестовый автомобиль · белый</p></div></div>
            <div className="driver-route"><MapPin size={18} /><div><small>Маршрут</small><strong>Ресторан 1 → ваш адрес</strong></div></div>
            <button className="secondary-button wide-button" type="button" onClick={onCallDemo}><Phone size={18} /> Позвонить водителю</button>
            <p className="privacy-caption"><Info size={15} /> Контакт доступен только во время активного заказа.</p>
          </aside>
        </div>

        <section className="order-support-strip">
          <span><MessageCircle size={21} /></span><div><strong>Нужна помощь?</strong><p>Служба поддержки увидит временную шкалу и таймеры заказа.</p></div><button type="button" onClick={onCallDemo}>Открыть поддержку</button>
        </section>

        <button className="text-button centered-text-button" type="button" onClick={onHistory}><ReceiptText size={17} /> Посмотреть историю заказов</button>
      </main>
    );
  }

  return (
    <main className="customer-main order-flow-page">
      <section className="order-flow-card review-card">
        <span className="flow-icon"><Store size={30} /></span>
        <p className="eyebrow">Заказ отправлен</p>
        <h1>Ресторан проверяет наличие и состав заказа</h1>
        <p>Деньги ещё не списаны. После проверки ресторан подтвердит состав или предложит замену.</p>
        <div className="review-loader" aria-hidden="true"><span /><span /><span /></div>
        <div className="demo-controls">
          <div><strong>Демо-управление</strong><small>Выберите, какой сценарий посмотреть</small></div>
          <button className="secondary-button" type="button" onClick={() => onStageChange("replacement")}><RefreshCcw size={17} /> Предложена замена</button>
          <button className="primary-button" type="button" onClick={() => onStageChange("payment")}><Check size={18} /> Состав подтверждён</button>
        </div>
      </section>
    </main>
  );
}
