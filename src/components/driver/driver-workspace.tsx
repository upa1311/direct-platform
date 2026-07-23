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

      {/* Компактная верхняя панель: статус, зона, колокольчик — в одной строке. */}
      <DriverQuickControls driver={driver} zoneName={zoneName} />

      {/* Счётчики сразу под панелью. Колокольчик один — он в панели выше. */}
      <div className={styles.workBar}>
        <div className={styles.workCounters}>
          <span className={styles.workCount}>Новые — {newCount}</span>
          <span className={styles.workCount}>В работе — {workCount}</span>
        </div>
      </div>

      <NewOffersSection driver={driver} nowMs={nowMs} zoneName={zoneName} />

      <ActiveOrderSection driver={driver} order={activeOrder} zoneName={zoneName} />
    </>
  );
}

/** Компактная строка профиля: имя без «Водитель», короткий статус·зона и «⋯». */
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
      <ProfileMenu />
    </section>
  );
}

/** Меню «⋯» справа сверху: содержит «Выйти из аккаунта» (это не «Выйти из сети»). */
function ProfileMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.overflowWrap}>
      <button
        type="button"
        className={styles.overflowButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Меню аккаунта"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open ? (
        <div className={styles.overflowMenu} role="menu">
          <button
            type="button"
            className={styles.overflowMenuItem}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              clearAuthenticatedDriverId();
            }}
          >
            Выйти из аккаунта
          </button>
        </div>
      ) : null}
    </div>
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

function DriverQuickControls({
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
  const status = driver.status;

  // Черновик зоны нужен в OFFLINE (до выхода онлайн) и при подтверждении зоны.
  const [zoneDraft, setZoneDraft] = useState<ZoneId>(
    driver.suggestedZoneId ?? driver.currentZoneId ?? zones[0]?.id ?? "zone-1",
  );
  // Что раскрыто под верхней строкой: меню статуса, список зон или ничего.
  const [openMenu, setOpenMenu] = useState<"status" | "zone" | null>(null);
  // Блок подтверждения зоны (обязательное действие) раскрыт по умолчанию.
  const [confirmOpen, setConfirmOpen] = useState(true);
  const [confirmPicking, setConfirmPicking] = useState(
    driver.suggestedZoneId === null,
  );

  const runAndClose = (
    action: () => Promise<{ ok: boolean; error: string | null }>,
  ) => {
    setOpenMenu(null);
    return run(action);
  };

  // Подпись кнопки статуса и её поведение зависят от статуса.
  const statusButton = () => {
    if (status === "OFFLINE") {
      return (
        <button
          type="button"
          className={styles.quickButton}
          disabled={pending}
          onClick={() => runAndClose(() => driverGoOnline(driver.id, zoneDraft))}
        >
          Выйти онлайн
        </button>
      );
    }
    if (status === "BUSY_DIRECT") {
      return (
        <button type="button" className={styles.quickButton} disabled>
          В работе
        </button>
      );
    }
    if (status === "ZONE_CONFIRMATION_REQUIRED") {
      return (
        <button
          type="button"
          className={styles.quickButton}
          aria-expanded={confirmOpen}
          onClick={() => setConfirmOpen((v) => !v)}
        >
          Подтвердить зону
        </button>
      );
    }
    // AVAILABLE / PAUSED — открывают компактное меню действий.
    return (
      <button
        type="button"
        className={styles.quickButton}
        aria-haspopup="menu"
        aria-expanded={openMenu === "status"}
        disabled={pending}
        onClick={() => setOpenMenu((m) => (m === "status" ? null : "status"))}
      >
        {status === "AVAILABLE" ? "Онлайн" : "Пауза"}
      </button>
    );
  };

  // Зона на кнопке: черновик в OFFLINE, иначе текущая/предложенная.
  const shownZone =
    status === "OFFLINE"
      ? zoneDraft
      : driver.currentZoneId ?? driver.suggestedZoneId ?? zoneDraft;
  const zoneDisabled =
    status === "BUSY_DIRECT" || status === "ZONE_CONFIRMATION_REQUIRED";

  const chooseZone = (zoneId: ZoneId) => {
    setOpenMenu(null);
    if (status === "OFFLINE") {
      // Только черновик — применится при «Выйти онлайн».
      setZoneDraft(zoneId);
    } else {
      void run(() => driverChangeZone(driver.id, zoneId));
    }
  };

  return (
    <section aria-label="Управление сменой">
      <div className={styles.quickControls}>
        {statusButton()}

        <button
          type="button"
          className={styles.quickButton}
          aria-haspopup="menu"
          aria-expanded={openMenu === "zone"}
          disabled={pending || zoneDisabled}
          onClick={() => setOpenMenu((m) => (m === "zone" ? null : "zone"))}
        >
          <span className={styles.quickButtonText}>{zoneName(shownZone)}</span>
          <span aria-hidden="true">&#9662;</span>
        </button>

        <DriverOfferSoundButton iconOnly />
      </div>

      {/* Меню действий статуса (AVAILABLE/PAUSED). */}
      {openMenu === "status" && status === "AVAILABLE" ? (
        <div className={styles.quickMenu} role="menu">
          <button
            type="button"
            className={styles.quickMenuItem}
            role="menuitem"
            disabled={pending}
            onClick={() => runAndClose(() => driverPause(driver.id))}
          >
            Поставить на паузу
          </button>
          <button
            type="button"
            className={styles.quickMenuItem}
            role="menuitem"
            disabled={pending}
            onClick={() => runAndClose(() => driverGoOffline(driver.id))}
          >
            Выйти из сети
          </button>
        </div>
      ) : null}

      {openMenu === "status" && status === "PAUSED" ? (
        <div className={styles.quickMenu} role="menu">
          <button
            type="button"
            className={styles.quickMenuItem}
            role="menuitem"
            disabled={pending}
            onClick={() => runAndClose(() => driverResume(driver.id))}
          >
            Возобновить
          </button>
          <button
            type="button"
            className={styles.quickMenuItem}
            role="menuitem"
            disabled={pending}
            onClick={() => runAndClose(() => driverGoOffline(driver.id))}
          >
            Выйти из сети
          </button>
        </div>
      ) : null}

      {/* Список зон. */}
      {openMenu === "zone" ? (
        <div className={styles.quickMenu} role="menu">
          {zones.map((zone) => (
            <button
              key={zone.id}
              type="button"
              className={styles.quickMenuItem}
              role="menuitem"
              disabled={pending}
              onClick={() => chooseZone(zone.id)}
            >
              {zone.name}
            </button>
          ))}
        </div>
      ) : null}

      {/* Обязательное подтверждение зоны — компактным блоком под строкой. */}
      {status === "ZONE_CONFIRMATION_REQUIRED" && confirmOpen ? (
        <div className={styles.zoneConfirm}>
          {driver.suggestedZoneId !== null ? (
            <span className={styles.statusHint}>
              Заказ был завершён в зоне: {zoneName(driver.suggestedZoneId)}
            </span>
          ) : null}

          {confirmPicking || driver.suggestedZoneId === null ? (
            <div className={styles.quickMenu} role="menu">
              {zones.map((zone) => (
                <button
                  key={zone.id}
                  type="button"
                  className={
                    zone.id === zoneDraft
                      ? `${styles.quickMenuItem} ${styles.quickMenuItemActive}`
                      : styles.quickMenuItem
                  }
                  role="menuitemradio"
                  aria-checked={zone.id === zoneDraft}
                  disabled={pending}
                  onClick={() => setZoneDraft(zone.id)}
                >
                  {zone.name}
                </button>
              ))}
            </div>
          ) : null}

          <div className={styles.actions}>
            {!confirmPicking && driver.suggestedZoneId !== null ? (
              <>
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
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={pending}
                  onClick={() => setConfirmPicking(true)}
                >
                  Выбрать другую зону
                </button>
              </>
            ) : (
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
            )}

            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending}
              onClick={() =>
                run(() =>
                  driverConfirmZone(
                    driver.id,
                    confirmPicking || driver.suggestedZoneId === null
                      ? zoneDraft
                      : (driver.suggestedZoneId ?? zoneDraft),
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
