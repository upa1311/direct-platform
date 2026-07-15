"use client";

import { useState } from "react";
import type { FocusEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  CarFront,
  Check,
  ChevronDown,
  Clock3,
  Eye,
  FileCheck2,
  Globe2,
  History,
  ImagePlus,
  Info,
  MapPin,
  Menu,
  MoreHorizontal,
  Save,
  Send,
  Settings2,
  ShieldAlert,
  Store,
  Users,
} from "lucide-react";
import { FoodArtwork } from "@/components/brand/food-artwork";
import { deliveryModeLabels } from "@/data/demo-data";
import { formatMoney } from "@/lib/demo-calculations";
import { StatusBadge } from "@/components/ui/status-badge";
import type { AuditEntry, DemoMenuItem, DemoRestaurant } from "@/types/prototype";

type EditorTab =
  | "overview"
  | "work"
  | "delivery"
  | "finance"
  | "menu"
  | "moderation"
  | "audit";

interface RestaurantEditorProps {
  restaurant: DemoRestaurant;
  items: DemoMenuItem[];
  auditEntries: AuditEntry[];
  onBack: () => void;
  onPreview: () => void;
  onSave: (restaurant: DemoRestaurant, previousName: string) => void;
  onItemUpdate: (item: DemoMenuItem, previousValue: string, newValue: string) => void;
  onDecisionRequired: (title: string, message: string) => void;
}

const tabs: Array<{ id: EditorTab; label: string; icon: typeof Store }> = [
  { id: "overview", label: "Обзор", icon: Store },
  { id: "work", label: "Работа", icon: Clock3 },
  { id: "delivery", label: "Доставка и зоны", icon: CarFront },
  { id: "finance", label: "Финансы", icon: Banknote },
  { id: "menu", label: "Меню", icon: Menu },
  { id: "moderation", label: "Модерация", icon: FileCheck2 },
  { id: "audit", label: "Аудит", icon: History },
];

export function RestaurantEditor({
  restaurant,
  items,
  auditEntries,
  onBack,
  onPreview,
  onSave,
  onItemUpdate,
  onDecisionRequired,
}: RestaurantEditorProps) {
  const [tab, setTab] = useState<EditorTab>("overview");
  const [draft, setDraft] = useState<DemoRestaurant>(restaurant);
  const [hasChanges, setHasChanges] = useState(false);

  function updateDraft<K extends keyof DemoRestaurant>(key: K, value: DemoRestaurant[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setHasChanges(true);
  }

  function saveDraft() {
    onSave(draft, restaurant.name);
    setHasChanges(false);
  }

  function updateItemPrice(item: DemoMenuItem, event: FocusEvent<HTMLInputElement>) {
    const parsedPrice = Number(event.currentTarget.value.replace(",", "."));
    if (!Number.isFinite(parsedPrice)) {
      event.currentTarget.value = (item.priceCents / 100).toFixed(2);
      return;
    }
    const nextPrice = Math.max(0, Math.round(parsedPrice * 100));
    if (nextPrice !== item.priceCents) {
      onItemUpdate(
        { ...item, priceCents: nextPrice },
        formatMoney(item.priceCents),
        formatMoney(nextPrice),
      );
    }
    event.currentTarget.value = (nextPrice / 100).toFixed(2);
  }

  return (
    <div className="admin-page restaurant-editor-page">
      <button className="admin-back-button" type="button" onClick={onBack}><ArrowLeft size={17} /> Все рестораны</button>

      <header className="restaurant-editor-header">
        <div className="editor-identity">
          <span className={`editor-avatar tone-${draft.coverTone}`}><FoodArtwork kind={draft.artwork} /></span>
          <div><div className="editor-title-line"><h1>{draft.name}</h1><StatusBadge status={draft.status} compact /></div><p>{draft.address} · Зона {draft.zone}</p></div>
        </div>
        <div className="editor-actions">
          {hasChanges ? <span className="unsaved-label"><span /> Есть изменения</span> : null}
          <button className="admin-secondary-button" type="button" onClick={onPreview}><Eye size={17} /> Предпросмотр</button>
          <button className="admin-secondary-button" type="button" onClick={() => onDecisionRequired("Отправить на проверку", "Точная матрица переходов и право отправки на модерацию ещё не утверждены.")}><Send size={17} /> На проверку</button>
          <button className="admin-primary-button" type="button" onClick={() => onDecisionRequired("Опубликовать ресторан", "Условия первой публикации, обязательные поля и полномочия утверждающего ещё требуют решения.")}><Globe2 size={17} /> Опубликовать</button>
          <button className="admin-icon-button" type="button" onClick={() => onDecisionRequired("Другие действия", "Скрытие, приостановка, архивирование и восстановление требуют утверждённой схемы переходов.")} aria-label="Другие действия"><MoreHorizontal size={19} /></button>
        </div>
      </header>

      <nav className="editor-tabs" aria-label="Разделы ресторана">
        {tabs.map((item) => {
          const Icon = item.icon;
          return <button type="button" className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)} key={item.id}><Icon size={17} />{item.label}</button>;
        })}
      </nav>

      {tab === "overview" ? (
        <div className="editor-content-grid">
          <section className="admin-form-card wide-form-card">
            <div className="admin-card-heading"><div><p className="eyebrow">Публичная карточка</p><h2>Основная информация</h2></div><span className="demo-tag">Тестовые поля</span></div>
            <div className="media-upload-row">
              <div className={`logo-placeholder tone-${draft.coverTone}`}><FoodArtwork kind={draft.artwork} /><button type="button"><ImagePlus size={15} /> Заменить</button></div>
              <button className={`cover-placeholder tone-${draft.coverTone}`} type="button"><ImagePlus size={20} /><span><strong>Обложка ресторана</strong><small>Нажмите для визуального выбора</small></span></button>
            </div>
            <div className="field-grid two-columns">
              <label className="field-label">Название ресторана<input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
              <label className="field-label">Публичный телефон<input value={draft.phone} onChange={(event) => updateDraft("phone", event.target.value)} /></label>
            </div>
            <label className="field-label">Описание<textarea value={draft.description} onChange={(event) => updateDraft("description", event.target.value)} /><small>Новое описание может потребовать модерации Direct.</small></label>
            <div className="field-grid two-columns">
              <label className="field-label">Электронная почта<input value={draft.email} onChange={(event) => updateDraft("email", event.target.value)} /></label>
              <label className="field-label">Адрес<input value={draft.address} onChange={(event) => updateDraft("address", event.target.value)} /></label>
            </div>
            <button className="admin-primary-button save-card-button" type="button" onClick={saveDraft} disabled={!hasChanges}><Save size={17} /> Сохранить демо-изменения</button>
          </section>

          <aside className="admin-side-stack">
            <section className="admin-form-card"><div className="admin-card-heading"><div><p className="eyebrow">Контакты</p><h2>Контактное лицо</h2></div><Users size={19} /></div><div className="structure-placeholder"><Info size={19} /><p><strong>Структура полей не утверждена</strong>В прототипе блок не придумывает должность, документы или уровень доступа.</p></div><button className="admin-secondary-button wide-button" type="button" onClick={() => onDecisionRequired("Контактное лицо", "Набор полей и правила доступа к персональным данным контактного лица ещё не утверждены.")}>Посмотреть вопрос</button></section>
            <section className="admin-form-card"><div className="admin-card-heading"><div><p className="eyebrow">Юридические данные</p><h2>Реквизиты</h2></div><ShieldAlert size={19} /></div><div className="structure-placeholder"><Info size={19} /><p><strong>Требует юридического решения</strong>Обязательные сведения, проверка и влияние на публикацию пока не определены.</p></div></section>
          </aside>
        </div>
      ) : null}

      {tab === "work" ? (
        <div className="editor-content-grid">
          <section className="admin-form-card wide-form-card">
            <div className="admin-card-heading"><div><p className="eyebrow">Операционная работа</p><h2>График и приготовление</h2></div><Clock3 size={20} /></div>
            <div className="field-grid two-columns"><label className="field-label">Часы работы<input value={draft.hours} onChange={(event) => updateDraft("hours", event.target.value)} /></label><label className="field-label">Последний заказ<input value={draft.lastOrderTime} onChange={(event) => updateDraft("lastOrderTime", event.target.value)} /></label></div>
            <label className="field-label">Стандартное время приготовления<div className="number-field"><input type="number" min="1" value={draft.preparationMinutes} onChange={(event) => updateDraft("preparationMinutes", Number(event.target.value))} /><span>минут</span></div><small>Ресторан может изменить время при принятии конкретного заказа.</small></label>
            <div className="demo-note warning-note"><Info size={17} /> Праздники, перерывы, ночные интервалы и точный смысл «последнего заказа» требуют решения.</div>
            <button className="admin-primary-button save-card-button" type="button" onClick={saveDraft} disabled={!hasChanges}><Save size={17} /> Сохранить</button>
          </section>
          <aside className="admin-form-card operating-preview"><p className="eyebrow">Как увидит клиент</p><h2>{draft.name}</h2><div className="operating-preview-row"><span className="live-dot" /><div><strong>{draft.isAcceptingOrders ? "Принимает заказы" : "Сейчас закрыт"}</strong><small>{draft.hours}</small></div></div><dl><div><dt>Приготовление</dt><dd>около {draft.preparationMinutes} мин</dd></div><div><dt>Последний заказ</dt><dd>{draft.lastOrderTime}</dd></div></dl></aside>
        </div>
      ) : null}

      {tab === "delivery" ? (
        <div className="editor-content-grid">
          <section className="admin-form-card wide-form-card">
            <div className="admin-card-heading"><div><p className="eyebrow">Получение заказа</p><h2>Режимы доставки и оплаты</h2></div><CarFront size={20} /></div>
            <div className="admin-mode-list">{Object.entries(deliveryModeLabels).map(([mode, label]) => <label key={mode} className={draft.modes.includes(mode as DemoRestaurant["modes"][number]) ? "is-enabled" : ""}><input type="checkbox" checked={draft.modes.includes(mode as DemoRestaurant["modes"][number])} onChange={() => onDecisionRequired(label, "Приоритет глобальных и ресторанных настроек, а также допустимые способы оплаты для режима ещё не утверждены.")} /><span><Check size={14} /></span><div><strong>{label}</strong><small>{mode}</small></div></label>)}</div>
            <div className="settings-row"><div><strong>QR-оплата</strong><small>Настройки провайдера не определены</small></div><button type="button" onClick={() => onDecisionRequired("Настройки QR", "Договорные и технические QR-параметры ещё не разделены.")}><Settings2 size={16} /> Настроить</button></div>
            <div className="settings-row"><div><strong>Наличные PLATFORM_DRIVER</strong><small>Глобальный минимум еды: $7</small></div><button type="button" onClick={() => onDecisionRequired("Настройки наличных", "Не определено, какие параметры можно менять по ресторану.")}><Settings2 size={16} /> Настроить</button></div>
          </section>
          <aside className="admin-side-stack">
            <section className="admin-form-card zone-card"><div className="admin-card-heading"><div><p className="eyebrow">Зона ресторана</p><h2>Автоопределение</h2></div><MapPin size={19} /></div><div className="zone-map-placeholder"><span className="map-pin-large"><MapPin size={22} /></span><small>Тестовая карта Бендер</small></div><dl><div><dt>Автоматически</dt><dd>Зона {draft.zone}</dd></div><div><dt>Ручное значение</dt><dd>Не задано</dd></div><div><dt>Итоговая зона</dt><dd><strong>Зона {draft.zone}</strong></dd></div></dl><button className="admin-secondary-button wide-button" type="button" onClick={() => onDecisionRequired("Ручное переопределение зоны", "Не определено, кто может менять зону, обязательна ли причина и когда снова применяется автоматическое значение.")}><MapPin size={16} /> Переопределить</button></section>
          </aside>
        </div>
      ) : null}

      {tab === "finance" ? (
        <div className="editor-content-grid">
          <section className="admin-form-card wide-form-card">
            <div className="admin-card-heading"><div><p className="eyebrow">Финансовые условия</p><h2>Комиссии и расчёты</h2></div><Banknote size={20} /></div>
            <div className="conflict-banner"><AlertTriangle size={20} /><div><strong>Найдено противоречие</strong><p>Ставки 15% / 7% / 15% утверждены, но одновременно должны редактироваться в админке. Прототип не меняет их молча.</p></div></div>
            <div className="finance-grid"><article><small>PLATFORM_DRIVER</small><strong>15%</strong><span>после ресторанных скидок</span></article><article><small>RESTAURANT_DELIVERY</small><strong>7%</strong><span>после скидок</span></article><article><small>PICKUP</small><strong>15%</strong><span>после скидок</span></article></div>
            <div className="field-grid two-columns"><label className="field-label">Режим расчёта<select defaultValue="UNRESOLVED" onChange={() => onDecisionRequired("Режим расчёта", "Для пилота ещё не выбран основной режим PER_ORDER или DAILY.")}><option value="UNRESOLVED">Не выбран для пилота</option><option value="PER_ORDER">PER_ORDER</option><option value="DAILY">DAILY</option><option value="MANUAL">MANUAL</option></select></label><label className="field-label">Лимит задолженности<input value="Не утверждён" readOnly /></label></div>
            <button className="admin-secondary-button" type="button" onClick={() => onDecisionRequired("Редактирование комиссий", "Нужно определить, являются ли ставки фиксированными для пилота, глобальными значениями или договорными настройками.")}><Settings2 size={16} /> Открыть спорное действие</button>
          </section>
          <aside className="admin-form-card"><p className="eyebrow">Историческая целостность</p><h2>Снимки заказов</h2><div className="snapshot-illustration"><span><FileCheck2 size={26} /></span><div><strong>Старые заказы защищены</strong><p>Изменение условий не переписывает цены, скидки, модификаторы и комиссионные правила.</p></div></div></aside>
        </div>
      ) : null}

      {tab === "menu" ? (
        <section className="admin-form-card admin-menu-card">
          <div className="admin-card-heading"><div><p className="eyebrow">Контент ресторана</p><h2>Категории и позиции</h2></div><button className="admin-primary-button" type="button" onClick={() => onDecisionRequired("Новая позиция", "Новая позиция может требовать модерации. Политика и роли ещё не утверждены.")}>+ Добавить позицию</button></div>
          <div className="admin-menu-layout">
            <aside className="admin-category-list"><button className="is-active" type="button">Популярное <span>2</span></button><button type="button">Горячее <span>1</span></button><button type="button">Напитки <span>1</span></button><button type="button">Десерты <span>1</span></button><button className="add-category-button" type="button" onClick={() => onDecisionRequired("Новая категория", "Публикационный процесс категории ещё не определён.")}>+ Категория</button></aside>
            <div className="admin-item-list">{items.map((item) => <article key={item.id}><span className={`admin-item-image tone-${item.tone}`}><FoodArtwork kind={item.artwork} /></span><div className="admin-item-copy"><strong>{item.name}</strong><small>{item.category} · {item.weight}</small><span className={item.available ? "availability-on" : "availability-off"}>{item.available ? "В наличии" : "Нет в наличии"}</span></div><label className="price-field"><small>Цена, USD</small><input type="text" inputMode="decimal" defaultValue={(item.priceCents / 100).toFixed(2)} onBlur={(event) => updateItemPrice(item, event)} /></label><button className={`availability-toggle ${item.available ? "is-on" : ""}`} type="button" onClick={() => onItemUpdate({ ...item, available: !item.available }, item.available ? "В наличии" : "Нет в наличии", item.available ? "Нет в наличии" : "В наличии")} aria-label={`Изменить доступность ${item.name}`}><span /></button><button className="admin-icon-button" type="button" onClick={() => onDecisionRequired("Редактор позиции", "Термины модификаторов, опций, размеров и дополнений ещё требуют формального разграничения.")} aria-label={`Редактировать ${item.name}`}><MoreHorizontal size={18} /></button></article>)}</div>
          </div>
        </section>
      ) : null}

      {tab === "moderation" ? (
        <section className="admin-form-card moderation-card">
          <div className="admin-card-heading"><div><p className="eyebrow">Публикационный процесс</p><h2>Очередь модерации</h2></div><span className="pending-count">1 изменение</span></div>
          <div className="moderation-item"><span className="moderation-icon"><FileCheck2 size={21} /></span><div className="moderation-copy"><span>Новое описание · Позиция 2</span><h3>Сравнение «было / стало»</h3><div className="diff-grid"><div><small>Предыдущее значение</small><p>Короткое описание</p></div><div className="diff-new"><small>Новое значение</small><p>Обновлённое тестовое описание позиции</p></div></div><p className="moderation-author">RESTAURANT_OWNER · 11 июля, 13:10</p></div><div className="moderation-actions"><button className="admin-secondary-button" type="button" onClick={() => onDecisionRequired("Отклонить изменение", "Обязательность причины отклонения и повторная отправка ещё не утверждены.")}>Отклонить</button><button className="admin-primary-button" type="button" onClick={() => onDecisionRequired("Одобрить изменение", "Не определено, может ли автор одобрить свою редакцию и какая роль утверждает публикацию.")}>Одобрить</button></div></div>
          <div className="demo-note"><Info size={17} /> Политика модерации настраивается, но её уровень и начальное значение ещё не утверждены.</div>
        </section>
      ) : null}

      {tab === "audit" ? (
        <section className="admin-form-card audit-card">
          <div className="admin-card-heading"><div><p className="eyebrow">Полная история</p><h2>Журнал изменений</h2></div><button className="admin-secondary-button" type="button" onClick={() => onDecisionRequired("Экспорт аудита", "Формат, права и правила выгрузки журнала ещё не определены.")}>Экспорт <ChevronDown size={15} /></button></div>
          <div className="audit-table"><div className="audit-head"><span>Время и участник</span><span>Сущность</span><span>Было</span><span>Стало</span><span>Причина</span></div>{auditEntries.map((entry) => <article key={entry.id}><div><strong>{entry.actor}</strong><small>{entry.timestamp}</small></div><span>{entry.entity}</span><code>{entry.previousValue}</code><code className="new-value">{entry.newValue}</code><span>{entry.reason}</span></article>)}</div>
        </section>
      ) : null}
    </div>
  );
}
