"use client";

import { useState } from "react";

import flowStyles from "@/components/order-flow/order-flow.module.css";
import { PageHeading } from "@/components/workspaces/route-content";
import { usePrototype } from "@/prototype/prototype-provider";
import type {
  Restaurant,
  RestaurantDeliveryProvider,
  ZoneId,
} from "@/prototype/models";
import type { RestaurantFormInput } from "@/prototype/actions";
import {
  parseDollarsToCents,
  publicationStatusLabels,
} from "@/prototype/selectors";

const ZONE_IDS: ZoneId[] = ["zone-1", "zone-2", "zone-3", "zone-4"];
const STATUSES: Restaurant["status"][] = [
  "DRAFT",
  "PENDING_REVIEW",
  "PUBLISHED",
  "HIDDEN",
  "ARCHIVED",
];

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function RestaurantEditor({ restaurant }: { restaurant: Restaurant }) {
  const { updateRestaurantEntry } = usePrototype();
  const settings = restaurant.restaurantDeliverySettings;
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

  return (
    <article className={flowStyles.card}>
      <div className={flowStyles.orderHeader}>
        <div>
          <h3 className={flowStyles.sectionTitle}>{restaurant.name}</h3>
          <p>{restaurant.id}</p>
        </div>
        <span className={flowStyles.statusBadge}>
          {publicationStatusLabels[restaurant.status]}
        </span>
      </div>

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
                {zone}
              </option>
            ))}
          </select>
        </label>
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
          <span>Комиссия Direct, %</span>
          <input
            value={form.commissionPercent}
            onChange={(e) =>
              setForm((f) => ({ ...f, commissionPercent: e.target.value }))
            }
          />
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
          <span>Публикация</span>
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
      </div>

      <div className={flowStyles.buttonRow}>
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

      <h4 className={flowStyles.sectionTitle}>Оплата на точке самовывоза</h4>
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
          <h4 className={flowStyles.sectionTitle}>Собственная доставка</h4>
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
                <span>{zone}</span>
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
                    aria-label={`Тариф ${zone}, $`}
                    value={form.zoneFees[zone]}
                    disabled={!form.servedZones[zone]}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        zoneFees: { ...f.zoneFees, [zone]: e.target.value },
                      }))
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className={flowStyles.submitArea}>
        <button
          className={flowStyles.primaryButton}
          type="button"
          onClick={handleSave}
        >
          Сохранить ресторан
        </button>
        <p className={flowStyles.feedback} aria-live="polite">
          {saved ? "Сохранено. Существующие заказы не изменены." : ""}
        </p>
        {saveError ? (
          <div className={flowStyles.warningNotice} role="alert">
            {saveError}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function CreateRestaurantForm() {
  const { createRestaurantEntry } = usePrototype();
  const [template, setTemplate] = useState<RestaurantDeliveryProvider>(
    "DIRECT",
  );
  const [name, setName] = useState("");
  const [created, setCreated] = useState("");

  const handleCreate = () => {
    const input: RestaurantFormInput = {
      name: name.trim() || "Новый ресторан",
      description: "Новый тестовый ресторан.",
      address: "Бендеры · тестовый адрес",
      zoneId: "zone-1",
      deliveryProvider: template,
      commissionRateBps: template === "RESTAURANT" ? 700 : 1500,
      defaultPreparationMinutes: 25,
      pickupEnabled: true,
      status: "PUBLISHED",
      isAcceptingOrders: true,
      restaurantDeliverySettings: null,
      pickupPaymentMethods: ["CASH", "CARD"],
    };
    const result = createRestaurantEntry(input);
    if (!result.restaurantId) {
      setCreated(result.error ?? "Не удалось создать ресторан.");
      return;
    }
    setCreated(`Создан ${result.restaurantId}. Отредактируйте детали ниже.`);
    setName("");
  };

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
      </div>
    </section>
  );
}

export default function AdminRestaurantsPage() {
  const { state } = usePrototype();

  return (
    <>
      <PageHeading
        eyebrow="Администратор"
        title="Рестораны"
        description="Создание и редактирование ресторанов обоих типов. Изменения не переписывают существующие заказы."
      />
      <CreateRestaurantForm />
      <div className={flowStyles.orderList}>
        {state.restaurants.map((restaurant) => (
          <RestaurantEditor key={restaurant.id} restaurant={restaurant} />
        ))}
      </div>
    </>
  );
}
