"use client";

import Link from "next/link";
import { useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import {
  MenuOverviewSection,
  MenuSizesSection,
  PromotionsSection,
} from "@/components/admin/menu-editors";
import { usePrototype } from "@/prototype/prototype-provider";
import {
  type DaySchedule,
  type Restaurant,
  type RestaurantDeliveryProvider,
  type WeekdayId,
  type WeeklySchedule,
  type ZoneId,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
} from "@/prototype/models";
import type { RestaurantFormInput } from "@/prototype/actions";
import {
  cloneWeeklySchedule,
  createDefaultWeeklySchedule,
} from "@/prototype/default-state";
import {
  getZoneName,
  parseDollarsToCents,
  publicationStatusLabels,
  workflowModeLabels,
} from "@/prototype/selectors";

const ZONE_IDS: ZoneId[] = ["zone-1", "zone-2", "zone-3", "zone-4"];
/** §5: часовой пояс — русское название, значение хранится как IANA ID. */
// Исправление 5: пользователю показываются только русские подписи; IANA ID
// остаётся техническим value.
const RESTAURANT_TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: "Europe/Chisinau", label: "Кишинёв" },
  { value: "America/New_York", label: "Нью-Йорк" },
  { value: "UTC", label: "Всемирное координированное время" },
];
const STATUSES: Restaurant["status"][] = [
  "DRAFT",
  "PENDING_REVIEW",
  "PUBLISHED",
  "HIDDEN",
  "ARCHIVED",
];
export const ROLE_OPTIONS = [
  "владелец",
  "управляющий",
  "администратор",
  "бухгалтер",
  "другое",
];

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export interface ContactsValue {
  publicPhone: string;
  contactPersonName: string;
  contactPersonRole: string;
  contactPhone: string;
  contactEmail: string;
  contactMessenger: string;
  emergencyPhone: string;
  internalAdminNote: string;
}

export const EMPTY_CONTACTS: ContactsValue = {
  publicPhone: "",
  contactPersonName: "",
  contactPersonRole: "",
  contactPhone: "",
  contactEmail: "",
  contactMessenger: "",
  emergencyPhone: "",
  internalAdminNote: "",
};

export function contactsFromRestaurant(restaurant: Restaurant): ContactsValue {
  return {
    publicPhone: restaurant.publicPhone,
    contactPersonName: restaurant.contactPersonName,
    contactPersonRole: restaurant.contactPersonRole,
    contactPhone: restaurant.contactPhone,
    contactEmail: restaurant.contactEmail,
    contactMessenger: restaurant.contactMessenger,
    emergencyPhone: restaurant.emergencyPhone,
    internalAdminNote: restaurant.internalAdminNote,
  };
}

export function ContactFields({
  value,
  onChange,
}: {
  value: ContactsValue;
  onChange: (patch: Partial<ContactsValue>) => void;
}) {
  return (
    <div className={flowStyles.fieldGrid}>
      <label className={flowStyles.field}>
        <span>Публичный телефон</span>
        <input
          value={value.publicPhone}
          onChange={(e) => onChange({ publicPhone: e.target.value })}
        />
      </label>
      <label className={flowStyles.field}>
        <span>Контактное лицо</span>
        <input
          value={value.contactPersonName}
          onChange={(e) => onChange({ contactPersonName: e.target.value })}
        />
      </label>
      <label className={flowStyles.field}>
        <span>Роль контактного лица</span>
        <select
          value={value.contactPersonRole}
          onChange={(e) => onChange({ contactPersonRole: e.target.value })}
        >
          <option value="">— не указана —</option>
          {ROLE_OPTIONS.map((role) => (
            <option value={role} key={role}>
              {role}
            </option>
          ))}
        </select>
      </label>
      <label className={flowStyles.field}>
        <span>Прямой телефон</span>
        <input
          value={value.contactPhone}
          onChange={(e) => onChange({ contactPhone: e.target.value })}
        />
      </label>
      <label className={flowStyles.field}>
        <span>Рабочая электронная почта</span>
        <input
          type="email"
          value={value.contactEmail}
          onChange={(e) => onChange({ contactEmail: e.target.value })}
        />
      </label>
      <label className={flowStyles.field}>
        <span>Мессенджер (необязательно)</span>
        <input
          value={value.contactMessenger}
          onChange={(e) => onChange({ contactMessenger: e.target.value })}
        />
      </label>
      <label className={flowStyles.field}>
        <span>Срочный телефон (необязательно)</span>
        <input
          value={value.emergencyPhone}
          onChange={(e) => onChange({ emergencyPhone: e.target.value })}
        />
      </label>
      <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
        <span>Внутренняя заметка Direct (клиент и ресторан не видят)</span>
        <textarea
          value={value.internalAdminNote}
          onChange={(e) => onChange({ internalAdminNote: e.target.value })}
          placeholder="Например: по выплатам связываться только с бухгалтером"
        />
      </label>
    </div>
  );
}

export function WeeklyScheduleEditor({
  value,
  onChange,
}: {
  value: WeeklySchedule;
  onChange: (day: WeekdayId, patch: Partial<DaySchedule>) => void;
}) {
  return (
    <div className={flowStyles.scheduleGrid}>
      {WEEKDAY_ORDER.map((day) => {
        const daySchedule = value[day];
        return (
          <div className={flowStyles.scheduleRow} key={day}>
            <label className={flowStyles.sizeOption}>
              <input
                type="checkbox"
                checked={daySchedule.enabled}
                onChange={(e) => onChange(day, { enabled: e.target.checked })}
              />
              <span>{WEEKDAY_LABELS[day]}</span>
            </label>
            {daySchedule.enabled ? (
              <div className={flowStyles.scheduleTimes}>
                <input
                  type="time"
                  aria-label={`Открытие: ${WEEKDAY_LABELS[day]}`}
                  value={daySchedule.openTime}
                  onChange={(e) => onChange(day, { openTime: e.target.value })}
                />
                <span aria-hidden="true">–</span>
                <input
                  type="time"
                  aria-label={`Закрытие: ${WEEKDAY_LABELS[day]}`}
                  value={daySchedule.closeTime}
                  onChange={(e) => onChange(day, { closeTime: e.target.value })}
                />
              </div>
            ) : (
              <span className={flowStyles.scheduleClosed}>Закрыто</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const BUILDER_TABS = [
  "Основное",
  "Контакты и график",
  "Доставка и оплата",
  "Меню",
  "Размеры",
  "Акции",
  "Публикация",
  "Предпросмотр",
] as const;
type BuilderTab = (typeof BUILDER_TABS)[number];

/** Полноценный редактор ресторана с вкладками (конструктор). */
export function RestaurantBuilderEditor({
  restaurant,
}: {
  restaurant: Restaurant;
}) {
  const { state, updateRestaurantEntry } = usePrototype();
  const settings = restaurant.restaurantDeliverySettings;
  const [tab, setTab] = useState<BuilderTab>("Основное");
  const [form, setForm] = useState({
    name: restaurant.name,
    description: restaurant.description,
    address: restaurant.address,
    zoneId: restaurant.zoneId,
    deliveryProvider: restaurant.deliveryProvider,
    commissionPercent: (restaurant.commissionRateBps / 100).toString(),
    defaultPreparationMinutes: restaurant.defaultPreparationMinutes.toString(),
    pickupEnabled: restaurant.pickupEnabled,
    pickupCash: restaurant.pickupPaymentMethods.includes("CASH"),
    pickupCard: restaurant.pickupPaymentMethods.includes("CARD"),
    status: restaurant.status,
    isAcceptingOrders: restaurant.isAcceptingOrders,
    minimumOrder: settings ? dollars(settings.minimumOrderCents) : "10.00",
    freeThreshold:
      settings && settings.freeDeliveryThresholdCents !== null
        ? dollars(settings.freeDeliveryThresholdCents)
        : "25.00",
    zoneFees: Object.fromEntries(
      ZONE_IDS.map((zone) => [
        zone,
        settings?.zoneFeesCents[zone] !== undefined
          ? dollars(settings.zoneFeesCents[zone] as number)
          : "3.00",
      ]),
    ) as Record<ZoneId, string>,
    servedZones: Object.fromEntries(
      ZONE_IDS.map((zone) => [
        zone,
        settings ? settings.servedZoneIds.includes(zone) : true,
      ]),
    ) as Record<ZoneId, boolean>,
    contacts: contactsFromRestaurant(restaurant),
    weeklySchedule: cloneWeeklySchedule(restaurant.weeklySchedule),
    pickupCommissionPercent: (restaurant.pickupCommissionRateBps / 100).toString(),
    timeZone: restaurant.timeZone,
    orderWorkflowMode: restaurant.orderWorkflowMode,
  });
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  const isRestaurantType = form.deliveryProvider === "RESTAURANT";

  const handleSave = () => {
    const servedZoneIds = ZONE_IDS.filter((zone) => form.servedZones[zone]);
    const patch: Partial<RestaurantFormInput> = {
      name: form.name,
      description: form.description,
      address: form.address,
      zoneId: form.zoneId,
      deliveryProvider: form.deliveryProvider,
      commissionRateBps: Math.round(
        (Number.parseFloat(form.commissionPercent.replace(",", ".")) || 0) *
          100,
      ),
      pickupCommissionRateBps: Math.round(
        (Number.parseFloat(form.pickupCommissionPercent.replace(",", ".")) ||
          0) * 100,
      ),
      timeZone: form.timeZone.trim() || "Europe/Chisinau",
      orderWorkflowMode: form.orderWorkflowMode,
      defaultPreparationMinutes:
        Number.parseInt(form.defaultPreparationMinutes, 10) || 25,
      pickupEnabled: form.pickupEnabled,
      pickupPaymentMethods: [
        ...(form.pickupCash ? (["CASH"] as const) : []),
        ...(form.pickupCard ? (["CARD"] as const) : []),
      ],
      status: form.status,
      isAcceptingOrders: form.isAcceptingOrders,
      restaurantDeliverySettings: isRestaurantType
        ? {
            minimumOrderCents: parseDollarsToCents(form.minimumOrder),
            freeDeliveryThresholdCents: form.freeThreshold.trim()
              ? parseDollarsToCents(form.freeThreshold)
              : null,
            servedZoneIds,
            zoneFeesCents: Object.fromEntries(
              servedZoneIds.map((zone) => [
                zone,
                parseDollarsToCents(form.zoneFees[zone]),
              ]),
            ),
          }
        : restaurant.restaurantDeliverySettings,
      ...form.contacts,
      weeklySchedule: form.weeklySchedule,
    };
    const result = updateRestaurantEntry(restaurant.id, patch);
    if (!result.ok) {
      setSaveError(result.error ?? "Не удалось сохранить ресторан.");
      setSaved(false);
      return;
    }
    setSaveError("");
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const updateSchedule = (day: WeekdayId, patch: Partial<DaySchedule>) =>
    setForm((f) => ({
      ...f,
      weeklySchedule: {
        ...f.weeklySchedule,
        [day]: { ...f.weeklySchedule[day], ...patch },
      },
    }));

  return (
    <section className={flowStyles.card}>
      <div className={flowStyles.builderTopbar}>
        <div>
          <h2>{restaurant.name}</h2>
          <span className={flowStyles.statusBadge}>
            {publicationStatusLabels[restaurant.status]}
          </span>
        </div>
        <div className={flowStyles.buttonRow}>
          <button
            className={flowStyles.primaryButton}
            type="button"
            onClick={handleSave}
          >
            Сохранить
          </button>
          <Link
            className={flowStyles.secondaryButton}
            href={`/client/restaurants/${restaurant.id}`}
            target="_blank"
          >
            Посмотреть глазами клиента
          </Link>
          <Link
            className={flowStyles.backLink}
            href="/admin/restaurant-builder"
          >
            ← Вернуться к списку ресторанов
          </Link>
        </div>
      </div>
      {saved ? (
        <p className={flowStyles.feedback}>
          Сохранено. Существующие заказы не изменены.
        </p>
      ) : null}
      {saveError ? (
        <div className={flowStyles.warningNotice} role="alert">
          {saveError}
        </div>
      ) : null}

      <nav className={flowStyles.builderTabs} aria-label="Разделы конструктора">
        {BUILDER_TABS.map((item) => (
          <button
            key={item}
            type="button"
            className={
              item === tab
                ? `${flowStyles.builderTab} ${flowStyles.builderTabActive}`
                : flowStyles.builderTab
            }
            aria-current={item === tab ? "true" : undefined}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>

      {tab === "Основное" ? (
        <div className={flowStyles.fieldGrid}>
          <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
            <span>Название</span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>
          <label className={`${flowStyles.field} ${flowStyles.fieldFull}`}>
            <span>Описание</span>
            <input
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
            />
          </label>
          <label className={flowStyles.field}>
            <span>Адрес</span>
            <input
              value={form.address}
              onChange={(e) =>
                setForm((f) => ({ ...f, address: e.target.value }))
              }
            />
          </label>
          <label className={flowStyles.field}>
            <span>Зона ресторана</span>
            <select
              value={form.zoneId}
              onChange={(e) =>
                setForm((f) => ({ ...f, zoneId: e.target.value as ZoneId }))
              }
            >
              {ZONE_IDS.map((zone) => (
                <option value={zone} key={zone}>
                  {getZoneName(state, zone)}
                </option>
              ))}
            </select>
          </label>
          <label className={flowStyles.field}>
            <span>Время приготовления, мин</span>
            <input
              value={form.defaultPreparationMinutes}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  defaultPreparationMinutes: e.target.value,
                }))
              }
            />
          </label>
          <label className={flowStyles.field}>
            <span>Часовой пояс ресторана</span>
            <select
              value={form.timeZone}
              onChange={(e) =>
                setForm((f) => ({ ...f, timeZone: e.target.value }))
              }
            >
              {(RESTAURANT_TIMEZONE_OPTIONS.some(
                (o) => o.value === form.timeZone,
              )
                ? RESTAURANT_TIMEZONE_OPTIONS
                : [
                    { value: form.timeZone, label: "Другой часовой пояс" },
                    ...RESTAURANT_TIMEZONE_OPTIONS,
                  ]
              ).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={flowStyles.field}>
            <span>Организация работы с заказами</span>
            <select
              value={form.orderWorkflowMode}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  orderWorkflowMode: e.target
                    .value as Restaurant["orderWorkflowMode"],
                }))
              }
            >
              <option value="COMBINED">
                {workflowModeLabels.COMBINED}
              </option>
              <option value="SPLIT_OPERATOR_KITCHEN">
                {workflowModeLabels.SPLIT_OPERATOR_KITCHEN}
              </option>
            </select>
          </label>
        </div>
      ) : null}

      {tab === "Контакты и график" ? (
        <>
          <h3 className={flowStyles.sectionTitle}>Контакты</h3>
          <ContactFields
            value={form.contacts}
            onChange={(patch) =>
              setForm((f) => ({ ...f, contacts: { ...f.contacts, ...patch } }))
            }
          />
          <h3 className={flowStyles.sectionTitle}>График работы</h3>
          <WeeklyScheduleEditor
            value={form.weeklySchedule}
            onChange={updateSchedule}
          />
        </>
      ) : null}

      {tab === "Доставка и оплата" ? (
        <>
          <div className={flowStyles.fieldGrid}>
            <label className={flowStyles.field}>
              <span>Тип доставки</span>
              <select
                value={form.deliveryProvider}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    deliveryProvider: e.target
                      .value as RestaurantDeliveryProvider,
                  }))
                }
              >
                <option value="DIRECT">С водителями Direct</option>
                <option value="RESTAURANT">Со своим курьером</option>
              </select>
            </label>
            <label className={flowStyles.field}>
              <span>Комиссия Direct за доставку, %</span>
              <input
                value={form.commissionPercent}
                onChange={(e) =>
                  setForm((f) => ({ ...f, commissionPercent: e.target.value }))
                }
              />
            </label>
            <label className={flowStyles.field}>
              <span>Комиссия Direct за самовывоз, %</span>
              <input
                value={form.pickupCommissionPercent}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    pickupCommissionPercent: e.target.value,
                  }))
                }
              />
            </label>
          </div>
          <div className={flowStyles.buttonRow}>
            <label className={flowStyles.sizeOption}>
              <input
                type="checkbox"
                checked={form.pickupEnabled}
                onChange={(e) =>
                  setForm((f) => ({ ...f, pickupEnabled: e.target.checked }))
                }
              />
              <span>Самовывоз</span>
            </label>
          </div>
          <h3 className={flowStyles.sectionTitle}>Оплата на точке самовывоза</h3>
          <div className={flowStyles.buttonRow}>
            <label className={flowStyles.sizeOption}>
              <input
                type="checkbox"
                checked={form.pickupCash}
                onChange={(e) =>
                  setForm((f) => ({ ...f, pickupCash: e.target.checked }))
                }
              />
              <span>Наличные</span>
            </label>
            <label className={flowStyles.sizeOption}>
              <input
                type="checkbox"
                checked={form.pickupCard}
                onChange={(e) =>
                  setForm((f) => ({ ...f, pickupCard: e.target.checked }))
                }
              />
              <span>Карта</span>
            </label>
          </div>
          {isRestaurantType ? (
            <>
              <h3 className={flowStyles.sectionTitle}>Собственная доставка</h3>
              <div className={flowStyles.fieldGrid}>
                <label className={flowStyles.field}>
                  <span>Минимальный заказ, $</span>
                  <input
                    value={form.minimumOrder}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, minimumOrder: e.target.value }))
                    }
                  />
                </label>
                <label className={flowStyles.field}>
                  <span>Бесплатная доставка от, $ (пусто — нет)</span>
                  <input
                    value={form.freeThreshold}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, freeThreshold: e.target.value }))
                    }
                  />
                </label>
              </div>
              <div className={flowStyles.fieldGrid}>
                {ZONE_IDS.map((zone) => (
                  <div className={flowStyles.field} key={zone}>
                    <span>{getZoneName(state, zone)}</span>
                    <div className={flowStyles.buttonRow}>
                      <label className={flowStyles.sizeOption}>
                        <input
                          type="checkbox"
                          checked={form.servedZones[zone]}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              servedZones: {
                                ...f.servedZones,
                                [zone]: e.target.checked,
                              },
                            }))
                          }
                        />
                        <span>Обслуживается</span>
                      </label>
                      <input
                        aria-label={`Тариф ${getZoneName(state, zone)}, $`}
                        value={form.zoneFees[zone]}
                        disabled={!form.servedZones[zone]}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            zoneFees: {
                              ...f.zoneFees,
                              [zone]: e.target.value,
                            },
                          }))
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className={flowStyles.prototypeNote}>
              Ресторан с водителями Direct: тарифы по матрице Direct, оплата
              онлайн.
            </p>
          )}
        </>
      ) : null}

      {tab === "Меню" ? <MenuOverviewSection restaurantId={restaurant.id} /> : null}
      {tab === "Размеры" ? <MenuSizesSection restaurantId={restaurant.id} /> : null}
      {tab === "Акции" ? <PromotionsSection restaurantId={restaurant.id} /> : null}

      {tab === "Публикация" ? (
        <div className={flowStyles.fieldGrid}>
          <label className={flowStyles.field}>
            <span>Статус публикации</span>
            <select
              value={form.status}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  status: e.target.value as Restaurant["status"],
                }))
              }
            >
              {STATUSES.map((status) => (
                <option value={status} key={status}>
                  {publicationStatusLabels[status]}
                </option>
              ))}
            </select>
          </label>
          <label className={flowStyles.sizeOption}>
            <input
              type="checkbox"
              checked={form.isAcceptingOrders}
              onChange={(e) =>
                setForm((f) => ({ ...f, isAcceptingOrders: e.target.checked }))
              }
            />
            <span>Принимает заказы</span>
          </label>
        </div>
      ) : null}

      {tab === "Предпросмотр" ? (
        <div className={flowStyles.emptyState}>
          Клиентская страница ресторана открывается в отдельной вкладке.{" "}
          <Link href={`/client/restaurants/${restaurant.id}`} target="_blank">
            Открыть предпросмотр
          </Link>
        </div>
      ) : null}
    </section>
  );
}

/** Форма создания ресторана (в конструкторе). */
export function CreateRestaurantForm() {
  const { createRestaurantEntry } = usePrototype();
  const [template, setTemplate] = useState<RestaurantDeliveryProvider>(
    "DIRECT",
  );
  const [name, setName] = useState("");
  const [contacts, setContacts] = useState<ContactsValue>(EMPTY_CONTACTS);
  const [weeklySchedule, setWeeklySchedule] = useState<WeeklySchedule>(
    createDefaultWeeklySchedule(),
  );
  const [created, setCreated] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);

  const handleCreate = () => {
    const input: RestaurantFormInput = {
      name: name.trim() || "Новый ресторан",
      description: "",
      // §4: без публикации и без подставного «тестового адреса» — заполняется в
      // конструкторе. Ресторан создаётся черновиком и не принимает заказы.
      address: "",
      zoneId: "zone-1",
      deliveryProvider: template,
      commissionRateBps: template === "RESTAURANT" ? 700 : 1500,
      defaultPreparationMinutes: 25,
      pickupEnabled: true,
      status: "DRAFT",
      isAcceptingOrders: false,
      restaurantDeliverySettings: null,
      pickupPaymentMethods: ["CASH", "CARD"],
      ...contacts,
      weeklySchedule,
    };
    const result = createRestaurantEntry(input);
    if (!result.restaurantId) {
      setCreated(result.error ?? "Не удалось создать ресторан.");
      setCreatedId(null);
      return;
    }
    setCreated(
      `Ресторан «${input.name}» создан как черновик (не принимает заказы и не виден клиенту). Опубликуйте и включите приём заказов в конструкторе.`,
    );
    setCreatedId(result.restaurantId);
    setName("");
    setContacts(EMPTY_CONTACTS);
    setWeeklySchedule(createDefaultWeeklySchedule());
  };

  const updateSchedule = (day: WeekdayId, patch: Partial<DaySchedule>) =>
    setWeeklySchedule((current) => ({
      ...current,
      [day]: { ...current[day], ...patch },
    }));

  return (
    <section className={flowStyles.card}>
      <h2>Создать ресторан</h2>
      <div className={flowStyles.fieldGrid}>
        <label className={flowStyles.field}>
          <span>Шаблон</span>
          <select
            value={template}
            onChange={(e) =>
              setTemplate(e.target.value as RestaurantDeliveryProvider)
            }
          >
            <option value="DIRECT">
              С водителями Direct (15%, матрица Direct)
            </option>
            <option value="RESTAURANT">
              Со своим курьером (7%, своя доставка)
            </option>
          </select>
        </label>
        <label className={flowStyles.field}>
          <span>Название</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <h3 className={flowStyles.sectionTitle}>Контакты</h3>
      <ContactFields
        value={contacts}
        onChange={(patch) => setContacts((c) => ({ ...c, ...patch }))}
      />
      <h3 className={flowStyles.sectionTitle}>График работы</h3>
      <WeeklyScheduleEditor value={weeklySchedule} onChange={updateSchedule} />
      <div className={flowStyles.submitArea}>
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={handleCreate}
        >
          Создать
        </button>
        <p className={flowStyles.feedback} aria-live="polite">
          {created}
        </p>
        {createdId ? (
          <Link
            className={flowStyles.backLink}
            href={`/admin/restaurant-builder/${createdId}`}
          >
            Открыть в конструкторе →
          </Link>
        ) : null}
      </div>
    </section>
  );
}
