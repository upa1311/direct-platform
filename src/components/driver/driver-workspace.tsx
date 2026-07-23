"use client";

import { useEffect, useMemo, useState } from "react";

import { usePrototype } from "@/prototype/prototype-provider";
import { formatMoney, getDriverActiveOrder } from "@/prototype/selectors";
import {
  getOpenDriverOffersForDriver,
  getOrderForOffer,
} from "@/prototype/driver-offers";
import {
  resolveDriverDeliveryStage,
  type DriverDeliveryStage,
} from "@/prototype/driver-delivery";
import { useNowMs } from "@/components/util/use-now";
import type {
  DeliveryAddress,
  DriverProfile,
  Order,
  ZoneId,
} from "@/prototype/models";
import { authenticateDriver, getDriverDisplayName } from "./driver-auth";
import {
  clearAuthenticatedDriverId,
  clearLegacySelectedDriverId,
  useAuthenticatedDriverId,
  writeAuthenticatedDriverId,
} from "./driver-session";
import { DriverOfferSoundButton } from "./driver-offer-sound";
import { DriverOfferCard, restaurantTimeZoneOf } from "./driver-offer-card";
import styles from "@/app/driver/driver.module.css";

/**
 * Единый рабочий экран водителя «Заказы». Один водитель входит под своим именем
 * и телефоном — выбора между профилями нет. После входа на одном экране:
 * профиль и статус, управление доступностью/зоной, счётчики «Новые / В работе»,
 * один колокольчик, новые предложения и активный заказ.
 */
export function DriverWorkspace() {
  const { state, isHydrated } = usePrototype();
  const sessionDriverId = useAuthenticatedDriverId();

  const driver = useMemo(
    () => state.drivers.find((d) => d.id === sessionDriverId) ?? null,
    [state.drivers, sessionDriverId],
  );

  // Недействительная сохранённая сессия (driverId больше нет) — очищаем и
  // показываем форму входа. Эффект только синхронизирует внешнее хранилище.
  useEffect(() => {
    if (isHydrated && sessionDriverId !== null && driver === null) {
      clearAuthenticatedDriverId();
    }
  }, [isHydrated, sessionDriverId, driver]);

  if (!isHydrated) {
    return <div className={styles.empty}>Загружаем кабинет водителя…</div>;
  }
  if (driver === null) {
    return <DriverLoginForm />;
  }
  // key по подсказке зоны: новая подсказка после доставки заново инициализирует
  // черновик выбора без синхронизации через эффект.
  return (
    <WorkspaceScreen
      key={`${driver.id}:${driver.suggestedZoneId ?? ""}`}
      driver={driver}
    />
  );
}

// --- Вход водителя -------------------------------------------------------------

function DriverLoginForm() {
  const { state } = usePrototype();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Старый ключ выбора демо-водителя не должен превращаться во вход.
  useEffect(() => {
    clearLegacySelectedDriverId();
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const driver = authenticateDriver(state.drivers, name, phone);
    if (driver === null) {
      // Одна общая ошибка: не раскрываем, что именно неверно.
      setError("Не удалось войти. Проверьте имя и номер телефона.");
      return;
    }
    setError(null);
    writeAuthenticatedDriverId(driver.id);
  };

  return (
    <form className={styles.loginCard} onSubmit={submit} noValidate>
      <h2 className={styles.sectionTitle}>Вход водителя</h2>
      <p className={styles.loginHint}>
        Введите имя и номер телефона, указанные в вашем профиле Direct.
      </p>

      <label className={styles.field}>
        <span>Имя</span>
        <input
          className={styles.textInput}
          type="text"
          name="name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>

      <label className={styles.field}>
        <span>Номер телефона</span>
        <input
          className={styles.textInput}
          type="tel"
          name="phone"
          autoComplete="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />
      </label>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className={styles.primaryButton}>
        Войти
      </button>
    </form>
  );
}

// --- Рабочий экран после входа -------------------------------------------------

function WorkspaceScreen({ driver }: { driver: DriverProfile }) {
  const { state } = usePrototype();
  const nowMs = useNowMs();
  const zones = state.zones;
  const zoneName = (zoneId: ZoneId | null): string =>
    zones.find((z) => z.id === zoneId)?.name ?? "—";

  const openOffers =
    nowMs > 0 ? getOpenDriverOffersForDriver(state, driver.id, nowMs) : [];
  const activeOrder = getDriverActiveOrder(state, driver.id);
  const newCount = openOffers.length;
  const workCount = activeOrder ? 1 : 0;

  return (
    <>
      <ProfileLine driver={driver} zoneName={zoneName} />

      <StatusZoneControl driver={driver} zoneName={zoneName} />

      {/* Рабочая панель в стиле кухни: компактные счётчики + один колокольчик. */}
      <div className={styles.workBar}>
        <div className={styles.workCounters}>
          <span className={styles.workCount}>Новые — {newCount}</span>
          <span className={styles.workCount}>В работе — {workCount}</span>
        </div>
        <DriverOfferSoundButton />
      </div>

      <NewOffersSection driver={driver} nowMs={nowMs} zoneName={zoneName} />

      <ActiveOrderSection driver={driver} order={activeOrder} zoneName={zoneName} />
    </>
  );
}

/** Компактная строка профиля: имя без «Водитель» и короткий статус·зона. */
function ProfileLine({
  driver,
  zoneName,
}: {
  driver: DriverProfile;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  return (
    <section className={styles.profileLine} aria-label="Профиль водителя">
      <div className={styles.profileText}>
        <span className={styles.driverName}>{getDriverDisplayName(driver)}</span>
        <span className={styles.statusValue}>
          {statusZoneSummary(driver, zoneName)}
        </span>
      </div>
      <LogoutButton />
    </section>
  );
}

function LogoutButton() {
  return (
    <button
      type="button"
      className={styles.linkButton}
      onClick={() => clearAuthenticatedDriverId()}
    >
      Выйти из аккаунта
    </button>
  );
}

/** Короткая сводка статуса и зоны для строки профиля. */
function statusZoneSummary(
  driver: DriverProfile,
  zoneName: (zoneId: ZoneId | null) => string,
): string {
  switch (driver.status) {
    case "AVAILABLE":
      return `Онлайн · ${zoneName(driver.currentZoneId)}`;
    case "PAUSED":
      return `Пауза · ${zoneName(driver.currentZoneId)}`;
    case "BUSY_DIRECT":
      return "Выполняет заказ Direct";
    case "ZONE_CONFIRMATION_REQUIRED":
      return "Подтвердите текущую зону";
    default:
      return "Не в сети";
  }
}

// --- Управление статусом и зоной ----------------------------------------------

/** Общий helper вызова provider-действия с блокировкой и ошибкой. */
function useAction(): {
  pending: boolean;
  error: string | null;
  run: (
    action: () => Promise<{ ok: boolean; error: string | null }>,
  ) => Promise<void>;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    action: () => Promise<{ ok: boolean; error: string | null }>,
  ) => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (!result.ok) setError(result.error);
  };
  return { pending, error, run };
}

function StatusZoneControl({
  driver,
  zoneName,
}: {
  driver: DriverProfile;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  const {
    state,
    driverGoOnline,
    driverPause,
    driverResume,
    driverGoOffline,
    driverChangeZone,
    driverConfirmZone,
  } = usePrototype();
  const { pending, error, run } = useAction();
  const zones = state.zones;
  const [zoneDraft, setZoneDraft] = useState<ZoneId>(
    driver.suggestedZoneId ?? driver.currentZoneId ?? zones[0]?.id ?? "zone-1",
  );
  // Раскрытие ручного выбора зоны при подтверждении.
  const [pickingZone, setPickingZone] = useState(driver.suggestedZoneId === null);

  const status = driver.status;

  const zoneSelect = (
    <label className={styles.zoneField}>
      <span>Текущая зона</span>
      <select
        className={styles.zoneSelect}
        value={zoneDraft}
        disabled={pending}
        onChange={(e) => setZoneDraft(e.target.value as ZoneId)}
      >
        {zones.map((zone) => (
          <option key={zone.id} value={zone.id}>
            {zone.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className={styles.statusCard} aria-label="Статус и зона">
      {status === "OFFLINE" ? (
        <>
          <span className={styles.statusValue}>Не в сети</span>
          <span className={styles.statusHint}>
            Выберите текущую зону, чтобы получать новые заказы.
          </span>
          {zoneSelect}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={pending}
              onClick={() => run(() => driverGoOnline(driver.id, zoneDraft))}
            >
              Выйти онлайн
            </button>
          </div>
        </>
      ) : null}

      {status === "AVAILABLE" ? (
        <>
          <span className={styles.statusValue}>
            Онлайн · {zoneName(driver.currentZoneId)}
          </span>
          {zoneSelect}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={pending}
              onClick={() => run(() => driverPause(driver.id))}
            >
              Пауза
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending}
              onClick={() => run(() => driverChangeZone(driver.id, zoneDraft))}
            >
              Изменить зону
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending}
              onClick={() => run(() => driverGoOffline(driver.id))}
            >
              Выйти из сети
            </button>
          </div>
        </>
      ) : null}

      {status === "PAUSED" ? (
        <>
          <span className={styles.statusValue}>
            Пауза · {zoneName(driver.currentZoneId)}
          </span>
          <span className={styles.statusHint}>
            Новые заказы временно не поступают.
          </span>
          {zoneSelect}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={pending}
              onClick={() => run(() => driverResume(driver.id))}
            >
              Возобновить
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending}
              onClick={() => run(() => driverChangeZone(driver.id, zoneDraft))}
            >
              Изменить зону
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending}
              onClick={() => run(() => driverGoOffline(driver.id))}
            >
              Выйти из сети
            </button>
          </div>
        </>
      ) : null}

      {status === "BUSY_DIRECT" ? (
        <span className={styles.statusValue}>Выполняет заказ Direct</span>
      ) : null}

      {status === "ZONE_CONFIRMATION_REQUIRED" ? (
        <div className={styles.zoneConfirm}>
          <span className={styles.statusValue}>Подтвердите текущую зону</span>
          {driver.suggestedZoneId !== null ? (
            <span className={styles.statusHint}>
              Заказ был завершён в зоне: {zoneName(driver.suggestedZoneId)}
            </span>
          ) : null}

          {pickingZone ? zoneSelect : null}

          <div className={styles.actions}>
            {!pickingZone && driver.suggestedZoneId !== null ? (
              <button
                type="button"
                className={styles.primaryButton}
                disabled={pending}
                onClick={() =>
                  run(() =>
                    driverConfirmZone(
                      driver.id,
                      driver.suggestedZoneId as ZoneId,
                      "AVAILABLE",
                    ),
                  )
                }
              >
                Да, я в {zoneName(driver.suggestedZoneId)}
              </button>
            ) : null}

            {!pickingZone && driver.suggestedZoneId !== null ? (
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={pending}
                onClick={() => setPickingZone(true)}
              >
                Выбрать другую зону
              </button>
            ) : null}

            {pickingZone ? (
              <button
                type="button"
                className={styles.primaryButton}
                disabled={pending}
                onClick={() =>
                  run(() => driverConfirmZone(driver.id, zoneDraft, "AVAILABLE"))
                }
              >
                Подтвердить и искать заказы
              </button>
            ) : null}

            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending}
              onClick={() =>
                run(() =>
                  driverConfirmZone(
                    driver.id,
                    pickingZone ? zoneDraft : (driver.suggestedZoneId ?? zoneDraft),
                    "PAUSED",
                  ),
                )
              }
            >
              Поставить Direct на паузу
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// --- Новые предложения ---------------------------------------------------------

function NewOffersSection({
  driver,
  nowMs,
  zoneName,
}: {
  driver: DriverProfile;
  nowMs: number;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  const { state, driverAcceptOffer, driverDeclineOffer } = usePrototype();
  const { pending, error, run } = useAction();

  const offers = nowMs > 0 ? getOpenDriverOffersForDriver(state, driver.id, nowMs) : [];

  // После принятия НЕ переходим на отдельный маршрут: предложение исчезает из
  // «Новые», заказ появляется в «В работе», счётчики обновляются сами.
  const accept = (offerId: string) =>
    run(() => driverAcceptOffer(driver.id, offerId));
  const decline = (offerId: string) =>
    run(() => driverDeclineOffer(driver.id, offerId));

  if (offers.length === 0) {
    return (
      <div className={styles.notice} role="status">
        {emptyOffersText(driver.status)}
      </div>
    );
  }

  return (
    <>
      <ul className={styles.offerList}>
        {offers.map((offer) => {
          const order = getOrderForOffer(state, offer);
          if (order === null) return null;
          return (
            <li key={offer.id}>
              <DriverOfferCard
                order={order}
                remainingMs={Date.parse(offer.expiresAt) - nowMs}
                zoneName={zoneName}
                restaurantTimeZone={restaurantTimeZoneOf(state, order)}
                disabled={pending}
                onAccept={() => accept(offer.id)}
                onDecline={() => decline(offer.id)}
              />
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function emptyOffersText(status: DriverProfile["status"]): string {
  switch (status) {
    case "AVAILABLE":
      return "Новых предложений пока нет. При новом заказе прозвучит сигнал.";
    case "OFFLINE":
      return "Чтобы получать новые заказы, выйдите онлайн.";
    case "PAUSED":
      return "Новые заказы не поступают, пока включена пауза.";
    case "BUSY_DIRECT":
      return "Во время выполнения заказа новые предложения не поступают.";
    default:
      return "Подтвердите текущую зону, чтобы снова получать новые заказы.";
  }
}

// --- Активный заказ ------------------------------------------------------------

function ActiveOrderSection({
  driver,
  order,
  zoneName,
}: {
  driver: DriverProfile;
  order: Order | null;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  // Приватные данные только назначенному водителю.
  const owned = order !== null && order.assignedDriverId === driver.id;

  if (!owned) {
    // Противоречивое состояние: занят, но активного назначенного заказа нет.
    if (driver.status === "BUSY_DIRECT") {
      return (
        <div className={styles.notice} role="status">
          Данные активного заказа требуют проверки Direct.
        </div>
      );
    }
    return <div className={styles.empty}>Активного заказа нет.</div>;
  }

  return <ActiveOrderCard driverId={driver.id} order={order} zoneName={zoneName} />;
}

/** Опорные точки маршрута для компактного прогресса. */
const PROGRESS_STEPS = ["Ресторан", "Получение", "Клиент", "Доставка"] as const;

function activeStepIndex(stage: DriverDeliveryStage): number {
  switch (stage) {
    case "GO_TO_RESTAURANT":
    case "WAITING_AT_RESTAURANT":
      return 0;
    case "READY_TO_PICK_UP":
      return 1;
    case "GO_TO_CUSTOMER":
      return 2;
    case "ARRIVING_TO_CUSTOMER":
      return 3;
    default:
      return -1;
  }
}

function ActiveOrderCard({
  driverId,
  order,
  zoneName,
}: {
  driverId: string;
  order: Order;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  const {
    state,
    driverArriveAtRestaurant,
    driverPickUpOrder,
    driverMarkArriving,
    driverCompleteDelivery,
  } = usePrototype();
  const { pending, error, run } = useAction();
  const stage = resolveDriverDeliveryStage(state, driverId, order.id);
  const activeIndex = activeStepIndex(stage);

  return (
    <>
      <ol className={styles.progress} aria-label="Этапы доставки">
        {PROGRESS_STEPS.map((label, index) => (
          <li
            key={label}
            className={
              index === activeIndex
                ? `${styles.progressStep} ${styles.progressStepActive}`
                : styles.progressStep
            }
            aria-current={index === activeIndex ? "step" : undefined}
          >
            {label}
          </li>
        ))}
      </ol>

      <StagePanel
        stage={stage}
        pending={pending}
        onArrive={() => run(() => driverArriveAtRestaurant(driverId, order.id))}
        onPickUp={() => run(() => driverPickUpOrder(driverId, order.id))}
        onArriving={() => run(() => driverMarkArriving(driverId, order.id))}
        onDeliver={() => run(() => driverCompleteDelivery(driverId, order.id))}
      />

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <OrderDetails order={order} zoneName={zoneName} />
    </>
  );
}

function StagePanel({
  stage,
  pending,
  onArrive,
  onPickUp,
  onArriving,
  onDeliver,
}: {
  stage: DriverDeliveryStage;
  pending: boolean;
  onArrive: () => void;
  onPickUp: () => void;
  onArriving: () => void;
  onDeliver: () => void;
}) {
  switch (stage) {
    case "GO_TO_RESTAURANT":
      return (
        <StageCard title="Следующий шаг" hint="Доберитесь до ресторана и подтвердите прибытие.">
          <MainButton label="Я в ресторане" pending={pending} onClick={onArrive} />
        </StageCard>
      );
    case "WAITING_AT_RESTAURANT":
      return (
        <StageCard title="Вы в ресторане" hint="Заказ ещё готовится. Ожидаем готовность заказа.">
          {null}
        </StageCard>
      );
    case "READY_TO_PICK_UP":
      return (
        <StageCard title="Заказ готов" hint="Проверьте заказ и заберите его у ресторана.">
          <MainButton label="Заказ получен" pending={pending} onClick={onPickUp} />
        </StageCard>
      );
    case "GO_TO_CUSTOMER":
      return (
        <StageCard title="Доставьте заказ клиенту">
          <MainButton label="Я подъезжаю" pending={pending} onClick={onArriving} />
        </StageCard>
      );
    case "ARRIVING_TO_CUSTOMER":
      return (
        <StageCard
          title="Вы подъезжаете к клиенту"
          hint="Свяжитесь с клиентом при необходимости."
        >
          <MainButton label="Заказ доставлен" pending={pending} onClick={onDeliver} />
        </StageCard>
      );
    default:
      return (
        <div className={styles.notice} role="status">
          Этап заказа требует проверки Direct. Не выполняйте следующий переход,
          пока данные не будут проверены.
        </div>
      );
  }
}

function StageCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.stageCard}>
      <span className={styles.stageTitle}>{title}</span>
      {hint ? <span className={styles.stageHint}>{hint}</span> : null}
      {children}
    </div>
  );
}

function MainButton({
  label,
  pending,
  onClick,
}: {
  label: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.primaryButton}
      disabled={pending}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function OrderDetails({
  order,
  zoneName,
}: {
  order: Order;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  return (
    <>
      <div className={styles.detailCard}>
        <span className={styles.orderLine}>Заказ {order.publicNumber}</span>
        <span className={styles.detailRowValue}>Заказ принят</span>
      </div>

      <div className={styles.detailCard}>
        <span className={styles.detailRowLabel}>Забрать</span>
        <span className={styles.detailRowValue}>{order.restaurant.name}</span>
        <span className={styles.detailRowValue}>{order.restaurant.address}</span>
        <span className={styles.detailRowValue}>
          {zoneName(order.restaurant.zoneId)}
        </span>
      </div>

      <div className={styles.detailCard}>
        <span className={styles.detailRowLabel}>Доставить</span>
        <span className={styles.detailRowValue}>
          {formatCustomerAddress(order.address)}
        </span>
        <span className={styles.detailRowValue}>
          {zoneName(order.financials.customerZoneId)}
        </span>
        {order.address && addressExtras(order.address) ? (
          <span className={styles.detailRowValue}>
            {addressExtras(order.address)}
          </span>
        ) : null}
      </div>

      <div className={styles.detailCard}>
        <span className={styles.detailRowLabel}>Клиент</span>
        <span className={styles.detailRowValue}>{order.customer.name}</span>
        <a className={styles.phoneLink} href={`tel:${order.customer.phone}`}>
          {order.customer.phone}
        </a>
        {order.address && order.address.comment.trim() !== "" ? (
          <span className={styles.detailRowValue}>
            Комментарий: {order.address.comment}
          </span>
        ) : null}
      </div>

      <div className={styles.detailCard}>
        <span className={styles.detailRowValue}>Оплата онлайн</span>
        <span className={styles.detailRowValue}>
          Ваша выплата:{" "}
          {formatMoney(
            order.financials.driverPayoutCents,
            order.financials.currencyCode,
          )}
        </span>
      </div>
    </>
  );
}

function formatCustomerAddress(address: DeliveryAddress | null): string {
  if (address === null) return "—";
  const house = address.house.trim();
  return house !== "" ? `${address.street}, ${house}` : address.street;
}

function addressExtras(address: DeliveryAddress): string {
  const parts: string[] = [];
  if (address.apartment.trim() !== "") parts.push(`кв. ${address.apartment}`);
  if (address.entrance.trim() !== "") parts.push(`подъезд ${address.entrance}`);
  if (address.floor.trim() !== "") parts.push(`этаж ${address.floor}`);
  return parts.join(" · ");
}
