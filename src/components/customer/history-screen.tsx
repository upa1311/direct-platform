"use client";

import { ArrowRight, Clock3, Info, PackageCheck, ReceiptText, ShieldCheck } from "lucide-react";
import { formatMoney } from "@/lib/demo-calculations";

interface HistoryScreenProps {
  onOpenActiveOrder: () => void;
  hasActiveOrder: boolean;
}

export function HistoryScreen({ onOpenActiveOrder, hasActiveOrder }: HistoryScreenProps) {
  return (
    <main className="customer-main history-page">
      <div className="page-title-block">
        <p className="eyebrow">Личный раздел</p>
        <h1>История заказов</h1>
        <p>Цены и состав завершённых заказов показаны как неизменяемый снимок.</p>
      </div>

      {hasActiveOrder ? (
        <button className="active-history-card" type="button" onClick={onOpenActiveOrder}>
          <span className="active-history-icon"><Clock3 size={22} /></span>
          <div><small>Активный заказ</small><strong>Ресторан 1 · Готовится</strong><p>Ориентировочно 35–45 минут</p></div>
          <ArrowRight size={20} />
        </button>
      ) : null}

      <section className="history-list-card">
        <div className="subsection-heading"><div><p className="eyebrow">Завершённые</p><h2>Предыдущий тестовый заказ</h2></div><span className="snapshot-badge"><ShieldCheck size={15} /> Снимок сохранён</span></div>
        <article className="history-order">
          <div className="history-order-head"><span><PackageCheck size={22} /></span><div><h3>Ресторан 2</h3><p>10 июля 2026 · Доставлено</p></div><strong>{formatMoney(1380)}</strong></div>
          <div className="history-order-lines">
            <p><span>2 × Позиция 1</span><strong>{formatMoney(1040)}</strong></p>
            <p><span>Доставка Direct</span><strong>{formatMoney(300)}</strong></p>
            <p><span>Применённая скидка</span><strong>− {formatMoney(60)}</strong></p>
          </div>
          <div className="history-snapshot-note"><ReceiptText size={17} /><span><strong>Исторические данные не меняются</strong>Названия, цены, модификаторы, скидки и комиссионные правила сохранены на момент заказа.</span></div>
        </article>
      </section>

      <div className="demo-note"><Info size={17} /> Повтор заказа не добавлен: это действие ещё требует отдельного решения.</div>
    </main>
  );
}
