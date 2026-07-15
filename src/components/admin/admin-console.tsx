"use client";

import { useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  CarFront,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  FileText,
  Gift,
  HelpCircle,
  Info,
  LayoutDashboard,
  Map,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Store,
  Users,
  WalletCards,
} from "lucide-react";
import { DirectBrand } from "@/components/brand/direct-brand";
import { FoodArtwork } from "@/components/brand/food-artwork";
import { RestaurantEditor } from "@/components/admin/restaurant-editor";
import { RestaurantList } from "@/components/admin/restaurant-list";
import { Modal } from "@/components/ui/modal";
import { StatusBadge } from "@/components/ui/status-badge";
import { Toast } from "@/components/ui/toast";
import { initialAuditEntries, menuItems, restaurants } from "@/data/demo-data";
import type { AuditEntry, DemoMenuItem, DemoRestaurant } from "@/types/prototype";

type AdminSection =
  | "dashboard"
  | "orders"
  | "restaurants"
  | "drivers"
  | "customers"
  | "menu"
  | "promotions"
  | "zones"
  | "finance"
  | "audit"
  | "settings";

const adminNavigation: Array<{
  id: AdminSection;
  label: string;
  icon: typeof Store;
  group?: string;
}> = [
  { id: "dashboard", label: "Обзор", icon: LayoutDashboard, group: "Работа" },
  { id: "orders", label: "Заказы", icon: ClipboardList },
  { id: "restaurants", label: "Рестораны", icon: Store },
  { id: "drivers", label: "Водители", icon: CarFront },
  { id: "customers", label: "Клиенты", icon: Users },
  { id: "menu", label: "Меню", icon: Menu, group: "Контент" },
  { id: "promotions", label: "Акции", icon: Gift },
  { id: "zones", label: "Зоны и тарифы", icon: Map },
  { id: "finance", label: "Платежи и выплаты", icon: CircleDollarSign, group: "Контроль" },
  { id: "audit", label: "Журнал действий", icon: FileText },
  { id: "settings", label: "Настройки", icon: Settings },
];

export function AdminConsole() {
  const [section, setSection] = useState<AdminSection>("restaurants");
  const [restaurantState, setRestaurantState] = useState<DemoRestaurant[]>(restaurants);
  const [itemState, setItemState] = useState<DemoMenuItem[]>(menuItems);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>(initialAuditEntries);
  const [selectedRestaurantId, setSelectedRestaurantId] = useState<string | null>(null);
  const [previewRestaurantId, setPreviewRestaurantId] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [decision, setDecision] = useState<{ title: string; message: string } | null>(null);
  const [toast, setToast] = useState("");

  const selectedRestaurant = restaurantState.find(
    (restaurant) => restaurant.id === selectedRestaurantId,
  );
  const previewRestaurant = restaurantState.find(
    (restaurant) => restaurant.id === previewRestaurantId,
  );

  function addAuditEntry(
    entity: string,
    previousValue: string,
    newValue: string,
    reason = "Демонстрационное изменение",
  ) {
    const entry: AuditEntry = {
      id: `audit-${Date.now()}`,
      actor: "SUPER_ADMIN",
      timestamp: "только что · демо",
      entity,
      previousValue,
      newValue,
      reason,
    };
    setAuditEntries((entries) => [entry, ...entries]);
  }

  function saveRestaurant(nextRestaurant: DemoRestaurant, previousName: string) {
    setRestaurantState((currentRestaurants) =>
      currentRestaurants.map((restaurant) =>
        restaurant.id === nextRestaurant.id ? nextRestaurant : restaurant,
      ),
    );
    addAuditEntry(
      `${nextRestaurant.name} · карточка ресторана`,
      previousName,
      nextRestaurant.name,
    );
    setToast("Демо-изменения сохранены и добавлены в аудит");
  }

  function updateMenuItem(
    nextItem: DemoMenuItem,
    previousValue: string,
    newValue: string,
  ) {
    setItemState((currentItems) =>
      currentItems.map((item) => (item.id === nextItem.id ? nextItem : item)),
    );
    addAuditEntry(`${nextItem.name} · меню`, previousValue, newValue);
    setToast(`${nextItem.name}: изменение применено в демо`);
  }

  function openDecision(title: string, message: string) {
    setDecision({ title, message });
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><DirectBrand compact inverted /><div><small>Admin Console</small></div></div>
        <nav aria-label="Разделы административной панели">
          {adminNavigation.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.id}>
                {item.group ? <p className="sidebar-group-label">{item.group}</p> : null}
                <button
                  type="button"
                  className={section === item.id ? "is-active" : ""}
                  onClick={() => {
                    setSection(item.id);
                    setSelectedRestaurantId(null);
                  }}
                >
                  <Icon size={18} />
                  {item.label}
                  {item.id === "orders" ? <span className="nav-count">3</span> : null}
                </button>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-help"><span><HelpCircle size={19} /></span><div><strong>Это прототип</strong><p>Данные не уходят на сервер</p></div></div>
      </aside>

      <div className="admin-workspace">
        <header className="admin-topbar">
          <label className="admin-global-search"><Search size={18} /><input placeholder="Поиск по админке" /></label>
          <div className="admin-topbar-actions"><span className="test-environment"><span /> Тестовая среда</span><button className="notification-button" type="button" aria-label="Уведомления"><Bell size={19} /><span>2</span></button><button className="admin-profile" type="button"><span>ГА</span><div><strong>Главный администратор</strong><small>Полный демо-доступ</small></div><ChevronDown size={16} /></button></div>
        </header>

        <div className="admin-content">
          {section === "restaurants" && !selectedRestaurant ? (
            <RestaurantList
              restaurants={restaurantState}
              onOpenRestaurant={setSelectedRestaurantId}
              onPreviewRestaurant={setPreviewRestaurantId}
              onCreateRestaurant={() => setCreateModalOpen(true)}
            />
          ) : null}

          {section === "restaurants" && selectedRestaurant ? (
            <RestaurantEditor
              restaurant={selectedRestaurant}
              items={itemState}
              auditEntries={auditEntries}
              onBack={() => setSelectedRestaurantId(null)}
              onPreview={() => setPreviewRestaurantId(selectedRestaurant.id)}
              onSave={saveRestaurant}
              onItemUpdate={updateMenuItem}
              onDecisionRequired={openDecision}
            />
          ) : null}

          {section !== "restaurants" ? (
            <section className="admin-placeholder-page">
              <span className="placeholder-big-icon">
                {section === "orders" ? <ClipboardList size={30} /> : section === "finance" ? <WalletCards size={30} /> : section === "zones" ? <Map size={30} /> : <BarChart3 size={30} />}
              </span>
              <p className="eyebrow">Раздел прототипа</p>
              <h1>{adminNavigation.find((item) => item.id === section)?.label}</h1>
              <p>Раздел предусмотрен в структуре Direct. Для первого кликабельного прототипа детально собран сценарий управления ресторанами.</p>
              <button className="admin-primary-button" type="button" onClick={() => setSection("restaurants")}><Store size={17} /> Перейти к ресторанам</button>
            </section>
          ) : null}
        </div>
      </div>

      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Новый ресторан"
        eyebrow="Создание черновика · демо"
        size="medium"
      >
        <div className="modal-form-stack">
          <label className="field-label">Название<input placeholder="Тестовое название" /></label>
          <label className="field-label">Адрес<input placeholder="Бендеры · адрес" /></label>
          <label className="field-label">Контактный email<input type="email" placeholder="name@example.test" /></label>
          <div className="demo-note"><Info size={17} /> Условия обязательных полей перед первой публикацией ещё не утверждены.</div>
          <button className="admin-primary-button wide-button" type="button" onClick={() => { setCreateModalOpen(false); setToast("Форма работает визуально; новый ресторан не сохранён без базы данных"); }}><Store size={17} /> Подготовить демо-черновик</button>
        </div>
      </Modal>

      <Modal
        open={Boolean(previewRestaurant)}
        onClose={() => setPreviewRestaurantId(null)}
        title="Предварительный просмотр"
        eyebrow="Так ресторан увидит клиент"
        size="large"
      >
        {previewRestaurant ? (
          <div className="admin-preview-shell">
            <div className="preview-browser-bar"><span /><span /><span /><p>direct.local/restaurants/{previewRestaurant.id}</p></div>
            <div className={`preview-restaurant-cover tone-${previewRestaurant.coverTone}`}><span><FoodArtwork kind={previewRestaurant.artwork} /></span><div><small>Предпросмотр</small><h2>{previewRestaurant.name}</h2><p>{previewRestaurant.description}</p></div></div>
            <div className="preview-meta"><span><Store size={16} /> {previewRestaurant.hours}</span><span><CarFront size={16} /> {previewRestaurant.preparationMinutes} мин</span><StatusBadge status={previewRestaurant.status} compact /></div>
            <div className="demo-note"><Info size={17} /> Черновой preview доступен только уполномоченным пользователям. Механизм защищённой ссылки ещё не выбран.</div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(decision)}
        onClose={() => setDecision(null)}
        title={decision?.title ?? "Требует решения"}
        eyebrow="Открытый бизнес-вопрос"
        size="small"
      >
        <div className="decision-message admin-decision-message"><span><AlertTriangle size={24} /></span><p>{decision?.message}</p></div>
        <div className="demo-note"><ShieldCheck size={17} /> Кнопка остаётся кликабельной, но прототип не закрепляет спорный переход или полномочие.</div>
        <button className="admin-primary-button wide-button" type="button" onClick={() => setDecision(null)}><CheckCircle2 size={17} /> Понятно</button>
      </Modal>

      {toast ? <Toast message={toast} onClose={() => setToast("")} /> : null}
    </div>
  );
}
