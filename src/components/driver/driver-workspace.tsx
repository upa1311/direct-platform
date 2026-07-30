"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { usePrototype } from "@/prototype/prototype-provider";
import {
  formatDateTime,
  formatMoney,
  getDriverActiveOrder,
  getPlatformDriverCashSnapshot,
} from "@/prototype/selectors";
import {
  DRIVER_ORDER_INCIDENT_REASONS,
  DRIVER_ORDER_INCIDENT_REASON_LABELS,
  getDriverActiveOrderIncidentView,
} from "@/prototype/driver-order-incidents";
import {
  getOpenDriverOffersForDriver,
  getOrderForOffer,
} from "@/prototype/driver-offers";
import {
  resolveDriverDeliveryStage,
  type DriverDeliveryStage,
} from "@/prototype/driver-delivery";
import {
  getRestaurantWaitingSummary,
  getRestaurantWaitingView,
  type RestaurantWaitingSummaryModel,
  type RestaurantWaitingView,
} from "@/prototype/restaurant-waiting-analytics";
import {
  getPlatformDriverCashHandoffView,
  type PlatformDriverCashHandoffView,
} from "@/prototype/platform-driver-cash-handoff";
import {
  getPlatformDriverCustomerCashCollectionView,
  type PlatformDriverCustomerCashCollectionView,
} from "@/prototype/platform-driver-cash-collection";
import { useNowMs } from "@/components/util/use-now";
import {
  ANALYTICS_TIME_ZONE,
  SHIFT_DURATION_LABEL,
  formatAnalyticsDuration,
} from "@/components/analytics/analytics-presentation";
import { getDriverShiftAnalyticsView } from "@/prototype/driver-shift-analytics";
import type {
  DeliveryAddress,
  DriverOffer,
  DriverOrderIncidentReason,
  DriverProfile,
  Order,
  Zone,
  ZoneId,
} from "@/prototype/models";
import { authenticateDriver, getDriverDisplayName } from "./driver-auth";
import {
  clearAuthenticatedDriverId,
  clearLegacySelectedDriverId,
  useAuthenticatedDriverId,
  writeAuthenticatedDriverId,
} from "./driver-session";
import { Banknote, BellOff, BellRing, CarFront, CircleAlert, Clock3, CreditCard, MapPin } from "lucide-react";

import { useDriverOfferSoundPreference } from "./driver-offer-sound";
import { DriverOfferCard, restaurantTimeZoneOf } from "./driver-offer-card";
import { driverOrderZoneView } from "@/lib/zones/driver-zone-view";
import { getZoneButtonPresentation } from "@/lib/zones/zone-presentation";
import { useDismissable } from "./use-popover";
import { DriverControlSheet } from "./driver-control-sheet";
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
  const todayAnalytics = nowMs > 0
    ? getDriverShiftAnalyticsView(
        state,
        driver.id,
        "TODAY",
        new Date(nowMs).toISOString(),
        ANALYTICS_TIME_ZONE,
      )
    : null;
  const todayTime = todayAnalytics !== null && todayAnalytics.coverageStartedAt !== null
    ? {
        shiftDuration: formatAnalyticsDuration(todayAnalytics.shiftDurationMs),
        onlineDuration: formatAnalyticsDuration(todayAnalytics.onlineDurationMs),
      }
    : null;

  return (
    <>
      <ProfileLine driver={driver} todayTime={todayTime} />

      {/* Компактная верхняя панель: статус, зона, колокольчик — в одной строке. */}
      <div className={styles.quickControlsSpacing}>
        <DriverQuickControls
          driver={driver}
          zoneName={zoneName}
        />
      </div>

      {/* Счётчики сразу под панелью. Колокольчик один — он в панели выше. */}
      <div className={styles.workBar}>
        <div className={styles.workCounters}>
          <span className={styles.workCount}>Новые — {newCount}</span>
          <span className={styles.workCount}>В работе — {workCount}</span>
        </div>
      </div>

      <NewOffersSection driver={driver} nowMs={nowMs} zoneName={zoneName} />

      <ActiveOrderSection
        driver={driver}
        order={activeOrder}
        nowMs={nowMs}
        zoneName={zoneName}
      />
    </>
  );
}

/**
 * Строка профиля: добровольная заметка водителя (облако, если есть), крупное имя
 * с оранжевым акцентом, постоянный badge доступа к наличным и меню «⋯».
 * Дублирующая сводка статуса и зоны под именем убрана — они видны в панели
 * управления сменой ниже.
 */
function ProfileLine({
  driver,
  todayTime,
}: {
  driver: DriverProfile;
  todayTime: { shiftDuration: string; onlineDuration: string } | null;
}) {
  return (
    <section className={styles.profileLine} aria-label="Профиль водителя">
      <div className={styles.profileText}>
        {driver.statusNote ? (
          <>
            <p className={styles.noteBubble} aria-label="Ваша заметка для Direct">
              {driver.statusNote}
            </p>
            {/* Дорожка «мыслей» ведёт от иконки машины к облаку заметки. */}
            <span className={styles.thoughtTrail} aria-hidden="true">
              <span className={styles.thoughtDot} />
              <span className={styles.thoughtDot} />
            </span>
          </>
        ) : null}
        <span className={styles.driverName}>
          <CarFront size={22} aria-hidden="true" className={styles.driverNameIcon} />
          <span className={styles.driverNameText}>
            Водитель {getDriverDisplayName(driver)}
          </span>
        </span>
        {/* Компактная информационная строка о способах оплаты (не кнопка),
            сдвинута правее иконки машины. Иконки декоративные (aria-hidden). */}
        <span
          className={
            driver.cashEnabled ? styles.cashAccessOn : styles.cashAccessOff
          }
        >
          {driver.cashEnabled ? (
            <>
              {/* Допуск ИМЕННО к наличным заказам — только иконка Banknote, без
                  карты (это не полный список способов оплаты клиента). */}
              <Banknote size={15} aria-hidden="true" className={styles.cashAccessIcon} />
              Доступны наличные заказы
            </>
          ) : (
            <>
              <CreditCard size={15} aria-hidden="true" className={styles.cashAccessIcon} />
              Только безналичные заказы
            </>
          )}
        </span>
        {todayTime ? (
          <span
            className={styles.driverTimeSummary}
            aria-label={`Время водителя сегодня: на смене ${todayTime.shiftDuration}, онлайн ${todayTime.onlineDuration}`}
          >
            <Clock3 size={15} aria-hidden="true" className={styles.driverTimeIcon} />
            <span>{SHIFT_DURATION_LABEL} <strong>{todayTime.shiftDuration}</strong></span>
            <span aria-hidden="true">·</span>
            <span>Онлайн <strong>{todayTime.onlineDuration}</strong></span>
          </span>
        ) : null}
      </div>
      <ProfileMenu driver={driver} />
    </section>
  );
}

const ACCOUNT_MENU_ID = "driver-account-menu";

/**
 * Меню «⋯» справа сверху с безопасным выходом из аккаунта (это НЕ «Выйти из
 * сети»). Свободный водитель не должен остаться онлайн без интерфейса, поэтому:
 *  - OFFLINE — сразу очистить сессию;
 *  - AVAILABLE/PAUSED/ZONE_CONFIRMATION_REQUIRED — сначала driverGoOffline и
 *    только при успехе очистить сессию (при ошибке сессия сохраняется);
 *  - BUSY_DIRECT — выход запрещён (нельзя бросить активный заказ).
 * Popover закрывается по клику снаружи, Escape и после успешного действия.
 */
function ProfileMenu({ driver }: { driver: DriverProfile }) {
  const { driverGoOffline } = usePrototype();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useDismissable({
    open,
    onClose: () => setOpen(false),
    containerRef,
    triggerRef,
  });

  const busy = driver.status === "BUSY_DIRECT";

  const logout = async () => {
    if (pending) return;
    if (driver.status === "OFFLINE") {
      setOpen(false);
      clearAuthenticatedDriverId();
      return;
    }
    // AVAILABLE / PAUSED / ZONE_CONFIRMATION_REQUIRED: сначала уходим из сети.
    setPending(true);
    setError(null);
    const result = await driverGoOffline(driver.id);
    setPending(false);
    if (!result.ok) {
      // Сессию не очищаем, меню оставляем открытым с ошибкой.
      setError(result.error);
      return;
    }
    setOpen(false);
    clearAuthenticatedDriverId();
  };

  return (
    <div className={styles.overflowWrap} ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.overflowButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={ACCOUNT_MENU_ID}
        aria-label="Меню водителя"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open ? (
        <div className={styles.overflowMenu} role="menu" id={ACCOUNT_MENU_ID}>
          <button
            type="button"
            className={styles.overflowMenuItem}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setNoteOpen(true);
            }}
          >
            Моя заметка
          </button>
          {busy ? (
            <button
              type="button"
              className={styles.overflowMenuItem}
              role="menuitem"
              disabled
            >
              Сначала завершите текущий заказ
            </button>
          ) : (
            <button
              type="button"
              className={styles.overflowMenuItem}
              role="menuitem"
              disabled={pending}
              onClick={() => void logout()}
            >
              Выйти из аккаунта
            </button>
          )}
          {error ? (
            <span className={styles.error} role="alert">
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
      <DriverNoteSheet
        driver={driver}
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        triggerRef={triggerRef}
      />
    </div>
  );
}

const NOTE_MAX = 120;

/**
 * Редактор добровольной заметки водителя (v27). Администратор увидит её рядом с
 * именем; заметка не влияет на распределение заказов. Пустая строка удаляет
 * заметку. Момент создаётся в provider внутри сериализованной мутации.
 */
function DriverNoteSheet({
  driver,
  open,
  onClose,
  triggerRef,
}: {
  driver: DriverProfile;
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <DriverControlSheet
      open={open}
      title="Заметка для Direct"
      onClose={onClose}
      triggerRef={triggerRef}
    >
      {/* Форма монтируется заново при каждом открытии (лист возвращает null, пока
          закрыт), поэтому начальное значение берётся из сохранённой заметки без
          побочного эффекта. */}
      <NoteForm driver={driver} onClose={onClose} />
    </DriverControlSheet>
  );
}

function NoteForm({
  driver,
  onClose,
}: {
  driver: DriverProfile;
  onClose: () => void;
}) {
  const { updateDriverStatusNote } = usePrototype();
  const [text, setText] = useState(driver.statusNote ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (value: string) => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await updateDriverStatusNote(driver.id, value);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  };

  return (
    <>
      <p className={styles.noteEditorDescription}>
        Администратор увидит её рядом с вашим именем. Заметка не влияет на
        распределение заказов.
      </p>
      <label className={styles.noteEditorField}>
        <span className={styles.srOnly}>Текст заметки</span>
        <textarea
          className={styles.noteEditorTextarea}
          value={text}
          maxLength={NOTE_MAX}
          rows={3}
          placeholder="Например: я на мойке, скоро освобожусь"
          onChange={(ev) => setText(ev.target.value)}
        />
      </label>
      <span className={styles.noteEditorCounter} aria-live="polite">
        {text.length} / {NOTE_MAX}
      </span>
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
      <div className={styles.noteEditorActions}>
        <button
          type="button"
          className={styles.noteEditorSave}
          disabled={pending}
          onClick={() => void save(text)}
        >
          Сохранить
        </button>
        {driver.statusNote ? (
          <button
            type="button"
            className={styles.noteEditorDelete}
            disabled={pending}
            onClick={() => void save("")}
          >
            Удалить заметку
          </button>
        ) : null}
      </div>
    </>
  );
}

// --- Управление статусом и зоной ----------------------------------------------

type ActionResult = { ok: boolean; error: string | null };

/** Общий helper вызова provider-действия с блокировкой и ошибкой. */
function useAction(): {
  pending: boolean;
  error: string | null;
  clearError: () => void;
  run: (action: () => Promise<ActionResult>) => Promise<ActionResult>;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    action: () => Promise<ActionResult>,
  ): Promise<ActionResult> => {
    if (pending) return { ok: false, error: null };
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (!result.ok) setError(result.error);
    return result;
  };
  return { pending, error, clearError: () => setError(null), run };
}

/**
 * Один общий список зон для всех сценариев (OFFLINE-черновик, смена зоны в сети,
 * выбор зоны при подтверждении). Раньше он дублировался — теперь единственный.
 */
function ZoneOptions({
  zones,
  selectedZoneId,
  onSelect,
  pending,
}: {
  zones: Zone[];
  selectedZoneId: ZoneId | null;
  onSelect: (zoneId: ZoneId) => void;
  pending: boolean;
}) {
  return (
    <div className={styles.sheetOptions} role="menu">
      {zones.map((zone) => {
        // Каждая кнопка зоны — своим цветом из versioned Bender Zone Registry
        // (тот же presentation helper, что и кнопка текущей зоны). Цвет не
        // единственный сигнал: остаются MapPin, название и маркер выбора.
        const presentation = getZoneButtonPresentation(zone.id);
        const selected = zone.id === selectedZoneId;
        return (
          <button
            key={zone.id}
            type="button"
            className={
              selected
                ? `${styles.zoneOption} ${styles.zoneOptionSelected}`
                : styles.zoneOption
            }
            style={
              presentation
                ? {
                    background: presentation.backgroundColor,
                    color: presentation.foregroundColor,
                    borderColor: presentation.borderColor,
                  }
                : undefined
            }
            role="menuitemradio"
            aria-checked={selected}
            disabled={pending}
            onClick={() => onSelect(zone.id)}
          >
            <MapPin size={16} aria-hidden="true" className={styles.zoneOptionIcon} />
            <span className={styles.zoneOptionName}>{zone.name}</span>
            {selected ? (
              <span aria-hidden="true" className={styles.zoneOptionCheck}>
                ✓
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

const STATUS_MENU_ID = "driver-status-menu";
const ZONE_MENU_ID = "driver-zone-menu";

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
  const { pending, error, clearError, run } = useAction();
  // Единственный звуковой control страницы — иконка в этой панели.
  const { soundEnabled, soundBlocked, enableSound, disableSound } =
    useDriverOfferSoundPreference();
  const zones = state.zones;
  const status = driver.status;

  // Черновик зоны нужен в OFFLINE (до выхода онлайн) и при подтверждении зоны.
  const [zoneDraft, setZoneDraft] = useState<ZoneId>(
    driver.suggestedZoneId ?? driver.currentZoneId ?? zones[0]?.id ?? "zone-1",
  );
  // Что открыто overlay-листом: меню статуса, выбор зоны или ничего. Лист —
  // fixed-оверлей, а не flow-блок, поэтому он не сдвигает контент под собой.
  const [openMenu, setOpenMenu] = useState<"status" | "zone" | null>(null);
  // Блок подтверждения зоны (обязательное действие) раскрыт по умолчанию.
  const [confirmOpen, setConfirmOpen] = useState(true);
  const [confirmPicking, setConfirmPicking] = useState(
    driver.suggestedZoneId === null,
  );

  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  const zoneTriggerRef = useRef<HTMLButtonElement>(null);

  const closeSheet = () => {
    setOpenMenu(null);
    clearError();
  };

  // Действие статуса/зоны: закрыть лист только при успехе, иначе оставить
  // открытым и показать ошибку внутри листа.
  const runAndCloseSheet = async (action: () => Promise<ActionResult>) => {
    const result = await run(action);
    if (result.ok) setOpenMenu(null);
  };

  // Подпись кнопки статуса и её поведение зависят от статуса.
  const statusButton = () => {
    if (status === "OFFLINE") {
      // Видимый текст описывает СОСТОЯНИЕ (серая нейтральная кнопка), а действие
      // выхода онлайн объясняет aria-label/title. Нажатие по-прежнему выполняет
      // driverGoOnline — кнопка кликабельна, не disabled по состоянию.
      return (
        <button
          type="button"
          className={`${styles.quickButton} ${styles.quickButtonOffline}`}
          aria-label="Выйти онлайн и начать получать заказы"
          title="Нажмите, чтобы выйти онлайн"
          disabled={pending}
          onClick={() => void run(() => driverGoOnline(driver.id, zoneDraft))}
        >
          <span className={styles.quickButtonStatusText}>Сейчас не в сети</span>
        </button>
      );
    }
    if (status === "BUSY_DIRECT") {
      return (
        <button type="button" className={styles.quickButton} disabled>
          <span className={styles.quickButtonText}>В работе</span>
        </button>
      );
    }
    if (status === "ZONE_CONFIRMATION_REQUIRED") {
      return (
        <button
          type="button"
          className={styles.quickButton}
          aria-label="Подтвердить текущую зону"
          aria-expanded={confirmOpen}
          onClick={() => setConfirmOpen((v) => !v)}
        >
          <span className={styles.quickButtonText}>
            <span className={styles.mobileControlLabel}>Подтвердить</span>
            <span className={styles.regularControlLabel}>Подтвердить зону</span>
          </span>
        </button>
      );
    }
    // AVAILABLE / PAUSED — показывают текущее состояние полной подписью и по
    // нажатию открывают overlay-лист действий. Онлайн выделен зелёным, пауза —
    // красным, чтобы состояние читалось с одного взгляда. Подпись статуса не
    // сокращается: при нехватке места ужимается только название зоны.
    return (
      <button
        type="button"
        ref={statusTriggerRef}
        className={
          status === "AVAILABLE"
            ? `${styles.quickButton} ${styles.quickButtonOnline}`
            : `${styles.quickButton} ${styles.quickButtonPaused}`
        }
        aria-haspopup="dialog"
        aria-expanded={openMenu === "status"}
        aria-controls={STATUS_MENU_ID}
        disabled={pending}
        onClick={() => setOpenMenu((m) => (m === "status" ? null : "status"))}
      >
        <span className={styles.quickButtonStatusText}>
          {status === "AVAILABLE" ? "Сейчас онлайн" : "Сейчас на паузе"}
        </span>
      </button>
    );
  };

  // Зона на кнопке: черновик в OFFLINE, иначе текущая/предложенная.
  const shownZone =
    status === "OFFLINE"
      ? zoneDraft
      : driver.currentZoneId ?? driver.suggestedZoneId ?? zoneDraft;
  // Подпись зоны: «Выбрать зону», если у онлайн-водителя зона не подтверждена.
  const zoneLabel =
    status !== "OFFLINE" && driver.currentZoneId === null
      ? "Выбрать зону"
      : zoneName(shownZone);
  // Зона, отмеченная в списке как выбранная.
  const markedZone = status === "OFFLINE" ? zoneDraft : driver.currentZoneId;
  const zoneDisabled =
    status === "BUSY_DIRECT" || status === "ZONE_CONFIRMATION_REQUIRED";

  // Выбор зоны в overlay-листе. Доменная семантика зависит от статуса, но UI
  // (общий ZoneOptions) один и тот же.
  const chooseZone = (zoneId: ZoneId) => {
    if (status === "OFFLINE") {
      // Только черновик — применится при «Выйти онлайн».
      setZoneDraft(zoneId);
      setOpenMenu(null);
    } else if (status === "ZONE_CONFIRMATION_REQUIRED") {
      // При подтверждении зоны выбор — тоже черновик; применит кнопка блока.
      setZoneDraft(zoneId);
      setConfirmPicking(true);
      setOpenMenu(null);
    } else {
      // AVAILABLE / PAUSED — реальная смена зоны без optimistic update.
      void runAndCloseSheet(() => driverChangeZone(driver.id, zoneId));
    }
  };

  // Зона, отмеченная в листе выбора: черновик при подтверждении, иначе markedZone.
  const sheetSelectedZone =
    status === "ZONE_CONFIRMATION_REQUIRED" ? zoneDraft : markedZone;

  // Кнопка текущей зоны целиком окрашивается в цвет реальной зоны из versioned
  // Bender Zone Registry (не по номеру вручную): фон, рамка и контрастный текст.
  // OFFLINE и неподтверждённая зона остаются нейтральными.
  const zonePresentation =
    status !== "OFFLINE" && driver.currentZoneId !== null && shownZone !== null
      ? getZoneButtonPresentation(shownZone)
      : null;

  return (
    <section aria-label="Управление сменой">
      <div className={styles.quickControls}>
        {statusButton()}

        <button
          type="button"
          ref={zoneTriggerRef}
          className={
            zonePresentation
              ? `${styles.quickButton} ${styles.quickButtonZone}`
              : styles.quickButton
          }
          style={
            zonePresentation
              ? {
                  background: zonePresentation.backgroundColor,
                  color: zonePresentation.foregroundColor,
                  borderColor: zonePresentation.borderColor,
                }
              : undefined
          }
          aria-haspopup="dialog"
          aria-expanded={openMenu === "zone"}
          aria-controls={ZONE_MENU_ID}
          disabled={pending || zoneDisabled}
          onClick={() => setOpenMenu((m) => (m === "zone" ? null : "zone"))}
        >
          {/* Иконка-капля местоположения остаётся всегда, поверх цвета зоны. */}
          <MapPin size={16} aria-hidden="true" className={styles.quickButtonIcon} />
          <span className={styles.quickButtonText}>{zoneLabel}</span>
          <span aria-hidden="true" className={styles.quickButtonIcon}>
            &#9662;
          </span>
        </button>

        <button
          type="button"
          className={styles.soundIconButton}
          aria-pressed={soundEnabled}
          aria-label={soundEnabled ? "Выключить звук" : "Включить звук"}
          title={
            soundBlocked
              ? "Браузер не разрешил включить звук. Нажмите ещё раз."
              : soundEnabled
                ? "Выключить звук"
                : "Включить звук"
          }
          onClick={soundEnabled ? disableSound : () => void enableSound()}
        >
          {soundEnabled ? (
            <BellRing size={18} aria-hidden="true" />
          ) : (
            <BellOff size={18} aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Браузер заблокировал звук — компактная подсказка под панелью. */}
      {soundBlocked ? (
        <p className={styles.soundHint} role="alert">
          Браузер не разрешил включить звук. Нажмите ещё раз.
        </p>
      ) : null}

      {/* Overlay-лист статуса (AVAILABLE/PAUSED): действия сменой, не flow-блок. */}
      <DriverControlSheet
        open={openMenu === "status"}
        title="Изменить статус"
        onClose={closeSheet}
        triggerRef={statusTriggerRef}
      >
        <div className={styles.sheetOptions} role="menu" id={STATUS_MENU_ID}>
          {status === "AVAILABLE" ? (
            <button
              type="button"
              className={styles.sheetOption}
              role="menuitem"
              disabled={pending}
              onClick={() => void runAndCloseSheet(() => driverPause(driver.id))}
            >
              Поставить на паузу
            </button>
          ) : null}
          {status === "PAUSED" ? (
            <button
              type="button"
              className={styles.sheetOption}
              role="menuitem"
              disabled={pending}
              onClick={() => void runAndCloseSheet(() => driverResume(driver.id))}
            >
              Возобновить поиск заказов
            </button>
          ) : null}
          <button
            type="button"
            className={styles.sheetOption}
            role="menuitem"
            disabled={pending}
            onClick={() => void runAndCloseSheet(() => driverGoOffline(driver.id))}
          >
            Выйти из сети
          </button>
        </div>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </DriverControlSheet>

      {/* Overlay-лист выбора зоны: общий ZoneOptions, не flow-список. */}
      <DriverControlSheet
        open={openMenu === "zone"}
        title="Выберите текущую зону"
        onClose={closeSheet}
        triggerRef={zoneTriggerRef}
      >
        <div id={ZONE_MENU_ID}>
          <ZoneOptions
            zones={zones}
            selectedZoneId={sheetSelectedZone}
            onSelect={chooseZone}
            pending={pending}
          />
        </div>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </DriverControlSheet>

      {/* Обязательное подтверждение зоны — компактным блоком под строкой. */}
      {status === "ZONE_CONFIRMATION_REQUIRED" && confirmOpen ? (
        <div className={styles.zoneConfirm}>
          {driver.suggestedZoneId !== null ? (
            <span className={styles.statusHint}>
              Заказ был завершён в зоне: {zoneName(driver.suggestedZoneId)}
            </span>
          ) : null}

          {confirmPicking || driver.suggestedZoneId === null ? (
            <span className={styles.statusHint}>
              Выбрана: {zoneName(zoneDraft)}
            </span>
          ) : null}

          <div className={styles.zoneConfirmActions}>
            {!confirmPicking && driver.suggestedZoneId !== null ? (
              <>
                <button
                  type="button"
                  className={`${styles.primaryButton} ${styles.zoneConfirmButton} ${styles.zoneConfirmPrimary}`}
                  disabled={pending}
                  onClick={() =>
                    void run(() =>
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
                  className={`${styles.secondaryButton} ${styles.zoneConfirmButton}`}
                  disabled={pending}
                  onClick={() => setOpenMenu("zone")}
                >
                  Выбрать другую зону
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={`${styles.primaryButton} ${styles.zoneConfirmButton} ${styles.zoneConfirmPrimary}`}
                  disabled={pending}
                  onClick={() =>
                    void run(() =>
                      driverConfirmZone(driver.id, zoneDraft, "AVAILABLE"),
                    )
                  }
                >
                  Подтвердить и искать заказы
                </button>
                <button
                  type="button"
                  className={`${styles.secondaryButton} ${styles.zoneConfirmButton}`}
                  disabled={pending}
                  onClick={() => setOpenMenu("zone")}
                >
                  Выбрать другую зону
                </button>
              </>
            )}

            <button
              type="button"
              className={`${styles.secondaryButton} ${styles.zoneConfirmButton}`}
              disabled={pending}
              onClick={() =>
                void run(() =>
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

      {/* Ошибка вне листов (OFFLINE go-online, подтверждение зоны). */}
      {error && openMenu === null ? (
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
  const { pending, error, clearError, run } = useAction();

  const offers = nowMs > 0 ? getOpenDriverOffersForDriver(state, driver.id, nowMs) : [];

  // Открытое подтверждение наличных: id предложения + сумма к ресторану из
  // валидного cash snapshot заказа. Сумма не пересчитывается в UI.
  const [cashConfirm, setCashConfirm] = useState<{
    offerId: string;
    handoffCents: number;
    currencyCode: string;
  } | null>(null);
  const cashTriggerRef = useRef<HTMLButtonElement>(null);

  const decline = (offerId: string) =>
    void run(() => driverDeclineOffer(driver.id, offerId));

  // Онлайн — принять сразу (one-tap, без подтверждения). Наличные — первое
  // нажатие открывает лист подтверждения, а не назначает заказ.
  const handleAccept =
    (offer: DriverOffer, order: Order, cashHandoffCents: number | null) =>
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (cashHandoffCents !== null) {
        cashTriggerRef.current = event.currentTarget;
        setCashConfirm({
          offerId: offer.id,
          handoffCents: cashHandoffCents,
          currencyCode: order.financials.currencyCode,
        });
      } else {
        void run(() =>
          driverAcceptOffer(driver.id, offer.id, { cashReserveConfirmed: false }),
        );
      }
    };

  // Только главная кнопка листа принимает наличный заказ с подтверждением.
  const confirmCash = async () => {
    if (cashConfirm === null) return;
    const result = await run(() =>
      driverAcceptOffer(driver.id, cashConfirm.offerId, {
        cashReserveConfirmed: true,
      }),
    );
    if (result.ok) setCashConfirm(null);
  };

  const closeCash = () => {
    setCashConfirm(null);
    clearError();
  };

  if (offers.length === 0) {
    const empty = emptyOffersText(driver.status);
    return (
      <div className={styles.emptyOffers} role="status">
        <span className={styles.emptyOffersTitle}>{empty.title}</span>
        {empty.subtext ? (
          <span className={styles.emptyOffersSubtext}>{empty.subtext}</span>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <ul className={styles.offerList}>
        {offers.map((offer) => {
          const order = getOrderForOffer(state, offer);
          if (order === null) return null;
          // Наличное предложение — только при валидном cash snapshot заказа.
          const cashSnapshot = getPlatformDriverCashSnapshot(order);
          const cashHandoffCents = cashSnapshot
            ? cashSnapshot.restaurantHandoffCents
            : null;
          return (
            <li key={offer.id}>
              <DriverOfferCard
                order={order}
                remainingMs={Date.parse(offer.expiresAt) - nowMs}
                zoneName={zoneName}
                restaurantTimeZone={restaurantTimeZoneOf(state, order)}
                disabled={pending}
                cashHandoffCents={cashHandoffCents}
                onAccept={handleAccept(offer, order, cashHandoffCents)}
                onDecline={() => decline(offer.id)}
              />
            </li>
          );
        })}
      </ul>

      {/* Обязательное подтверждение денежного запаса перед принятием наличного
          заказа. Тот же overlay-лист, что и в quick controls. */}
      <DriverControlSheet
        open={cashConfirm !== null}
        title="Подтвердите наличные"
        onClose={closeCash}
        triggerRef={cashTriggerRef}
      >
        {cashConfirm !== null ? (
          <>
            <p className={styles.cashSheetText}>
              Для получения заказа у вас должно быть при себе{" "}
              {formatMoney(cashConfirm.handoffCents, cashConfirm.currencyCode)}{" "}
              наличными. Эту сумму нужно будет передать ресторану.
            </p>
            <div className={styles.cashConfirmActions}>
              <button
                type="button"
                className={`${styles.primaryButton} ${styles.cashConfirmPrimary}`}
                disabled={pending}
                onClick={() => void confirmCash()}
              >
                У меня есть эта сумма
              </button>
              <button
                type="button"
                className={`${styles.secondaryButton} ${styles.cashConfirmSecondary}`}
                disabled={pending}
                onClick={closeCash}
              >
                Отмена
              </button>
            </div>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
          </>
        ) : null}
      </DriverControlSheet>

      {/* Ошибка вне листа (онлайн-принятие / отказ). */}
      {error && cashConfirm === null ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function emptyOffersText(status: DriverProfile["status"]): {
  title: string;
  subtext: string | null;
} {
  switch (status) {
    case "AVAILABLE":
      return {
        title: "Новых предложений пока нет",
        subtext: "При новом заказе прозвучит сигнал.",
      };
    case "OFFLINE":
      return { title: "Чтобы получать новые заказы, будьте онлайн.", subtext: null };
    case "PAUSED":
      return { title: "Новые заказы не поступают, пока включена пауза.", subtext: null };
    case "BUSY_DIRECT":
      return {
        title: "Во время выполнения заказа новые предложения не поступают.",
        subtext: null,
      };
    default:
      return {
        title: "Подтвердите текущую зону, чтобы снова получать новые заказы.",
        subtext: null,
      };
  }
}

// --- Активный заказ ------------------------------------------------------------

function ActiveOrderSection({
  driver,
  order,
  nowMs,
  zoneName,
}: {
  driver: DriverProfile;
  order: Order | null;
  nowMs: number;
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
    return <div className={styles.emptyActive}>Активного заказа нет.</div>;
  }

  return (
    <ActiveOrderCard
      driverId={driver.id}
      order={order}
      nowMs={nowMs}
      zoneName={zoneName}
    />
  );
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
  nowMs,
  zoneName,
}: {
  driverId: string;
  order: Order;
  nowMs: number;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  const {
    state,
    driverArriveAtRestaurant,
    driverPickUpOrder,
    driverMarkArriving,
    driverCompleteDelivery,
    driverReportOrderIncident,
  } = usePrototype();
  const { pending, error, run } = useAction();
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [incidentReason, setIncidentReason] =
    useState<DriverOrderIncidentReason | null>(null);
  const [incidentDetails, setIncidentDetails] = useState("");
  const [incidentError, setIncidentError] = useState<string | null>(null);
  const [incidentPending, setIncidentPending] = useState(false);
  const incidentPendingRef = useRef(false);
  const incidentTriggerRef = useRef<HTMLButtonElement>(null);
  const stage = resolveDriverDeliveryStage(state, driverId, order.id);
  const incidentView = getDriverActiveOrderIncidentView(
    state,
    order.id,
    driverId,
  );
  const waitingView =
    nowMs > 0
      ? getRestaurantWaitingView(state, order.id, new Date(nowMs).toISOString())
      : null;
  const activeIndex = activeStepIndex(stage);
  // После получения заказа главная точка маршрута — клиент, а не ресторан.
  const pickedUp =
    order.status === "OUT_FOR_DELIVERY" || order.status === "ARRIVING";
  // Наличный заказ ведёт отдельный блок с передачей денег ресторану.
  const cashView = getPlatformDriverCashHandoffView(state, order);
  const isCash = cashView.status !== "NOT_APPLICABLE";
  const canReportIncident = ["READY", "OUT_FOR_DELIVERY", "ARRIVING"].includes(
    order.status,
  );
  const canReportDelay =
    waitingView?.status === "WAITING" &&
    waitingView.restaurantDelayMs !== null &&
    waitingView.restaurantDelayMs > 0;

  const openIncidentSheet = (reason: DriverOrderIncidentReason | null = null) => {
    setIncidentError(null);
    setIncidentReason(reason);
    setIncidentOpen(true);
  };

  const closeIncidentSheet = () => {
    if (!incidentPendingRef.current) setIncidentOpen(false);
  };

  const submitIncident = async () => {
    if (incidentPendingRef.current) return;
    if (incidentReason === null) {
      setIncidentError("Выберите причину проблемы.");
      return;
    }
    incidentPendingRef.current = true;
    setIncidentPending(true);
    setIncidentError(null);
    try {
      const result = await driverReportOrderIncident(
        driverId,
        order.id,
        incidentReason,
        incidentDetails,
      );
      if (!result.ok) {
        setIncidentError(result.error ?? "Не удалось сообщить о проблеме.");
        return;
      }
      setIncidentOpen(false);
      setIncidentReason(null);
      setIncidentDetails("");
    } finally {
      incidentPendingRef.current = false;
      setIncidentPending(false);
    }
  };

  return (
    <>
      {/* Блок 1: текущий этап и одна главная кнопка — вверху активного заказа. */}
      {incidentView.status === "OPEN" && incidentView.incident !== null ? (
        <div className={styles.incidentOpenCard} role="status">
          <span className={styles.incidentStateTitle}>Direct разбирается</span>
          <span>Не выполняйте следующий шаг, пока Direct не закроет проблему.</span>
          <dl className={styles.incidentStateDetails}>
            <div><dt>Заказ</dt><dd>{order.publicNumber}</dd></div>
            <div><dt>Причина</dt><dd>{DRIVER_ORDER_INCIDENT_REASON_LABELS[incidentView.incident.reason]}</dd></div>
            {incidentView.incident.details !== null ? (
              <div><dt>Комментарий</dt><dd>{incidentView.incident.details}</dd></div>
            ) : null}
            <div><dt>Сообщено</dt><dd>{formatDateTime(incidentView.incident.reportedAt)}</dd></div>
          </dl>
        </div>
      ) : incidentView.status === "REVIEW_REQUIRED" ? (
        <div className={styles.incidentReviewCard} role="alert">
          <span className={styles.incidentStateTitle}>Данные проблемы требуют проверки Direct</span>
          <span>Не выполняйте следующий шаг, пока данные не будут проверены.</span>
        </div>
      ) : isCash ? (
        <DriverCashHandoffBlock
          driverId={driverId}
          order={order}
          stage={stage}
          view={cashView}
          collectionView={getPlatformDriverCustomerCashCollectionView(state, order)}
          restaurantTimeZone={restaurantTimeZoneOf(state, order)}
          waitingView={waitingView}
          onReportDelay={() => openIncidentSheet("ORDER_DELAYED")}
          delayIncidentTriggerRef={incidentTriggerRef}
        />
      ) : (
        <>
          <StagePanel
            stage={stage}
            restaurantTimeZone={restaurantTimeZoneOf(state, order)}
            waitingView={waitingView}
            pending={pending}
            onArrive={() => run(() => driverArriveAtRestaurant(driverId, order.id))}
            onPickUp={() => run(() => driverPickUpOrder(driverId, order.id))}
            onArriving={() => run(() => driverMarkArriving(driverId, order.id))}
            onDeliver={() =>
              run(() =>
                // ONLINE: одно нажатие, без подтверждения наличных.
                driverCompleteDelivery(driverId, order.id, {
                  cashCollectionConfirmed: false,
                }),
              )
            }
            onReportDelay={() => openIncidentSheet("ORDER_DELAYED")}
            delayIncidentTriggerRef={incidentTriggerRef}
          />
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}

      {(incidentView.status === "NONE" || incidentView.status === "RESOLVED") &&
      canReportIncident ? (
        <button
          type="button"
          className={styles.incidentReportButton}
          ref={incidentTriggerRef}
          onClick={() => openIncidentSheet()}
        >
          <CircleAlert size={18} aria-hidden="true" />
          Проблема с заказом
        </button>
      ) : null}

      <DriverControlSheet
        open={incidentOpen}
        title="Проблема с заказом"
        onClose={closeIncidentSheet}
        triggerRef={incidentTriggerRef}
      >
        <form
          className={styles.incidentForm}
          aria-busy={incidentPending}
          onSubmit={(event) => {
            event.preventDefault();
            void submitIncident();
          }}
        >
          <fieldset className={styles.incidentReasons} disabled={incidentPending}>
            <legend>Что произошло</legend>
            {DRIVER_ORDER_INCIDENT_REASONS.filter((reason) =>
              order.status === "PREPARING"
                ? canReportDelay && reason === "ORDER_DELAYED"
                : order.paymentMethod === "CASH" || reason !== "CASH_PROBLEM",
            ).map((reason) => (
              <label className={styles.incidentReason} key={reason}>
                <input
                  type="radio"
                  name="driver-order-incident-reason"
                  value={reason}
                  checked={incidentReason === reason}
                  onChange={() => setIncidentReason(reason)}
                />
                <span>{DRIVER_ORDER_INCIDENT_REASON_LABELS[reason]}</span>
              </label>
            ))}
          </fieldset>
          <label className={styles.incidentCommentLabel} htmlFor="driver-incident-details">
            Комментарий для Direct
          </label>
          <textarea
            id="driver-incident-details"
            className={styles.incidentTextarea}
            maxLength={240}
            rows={3}
            placeholder="Опишите, что произошло"
            value={incidentDetails}
            disabled={incidentPending}
            onChange={(event) => setIncidentDetails(event.target.value)}
          />
          <span className={styles.incidentCounter} aria-live="polite">
            {incidentDetails.length} / 240
          </span>
          {incidentError ? (
            <p className={styles.error} role="alert">{incidentError}</p>
          ) : null}
          <div className={styles.incidentFormActions}>
            <button type="submit" className={styles.primaryButton} disabled={incidentPending}>
              Сообщить Direct
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={incidentPending}
              onClick={closeIncidentSheet}
            >
              Отмена
            </button>
          </div>
        </form>
      </DriverControlSheet>

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

      {/* Блок 2: актуальная точка маршрута по этапу. */}
      <RoutePoint order={order} pickedUp={pickedUp} zoneName={zoneName} />

      {/* Блок 3: детали заказа и связь с клиентом. */}
      <OrderMeta order={order} />

      {/* Блок 4: зоны версионного набора — доступны после принятия заказа. */}
      <DriverOrderZoneDetails order={order} />
    </>
  );
}

/**
 * Технические детали зон принятого заказа (после принятия): зона забора и
 * доставки, Северный, транзит через Варницу и версия набора зон. Без
 * внутренних данных GIS (OSM id, полигоны). На выплату не влияет.
 */
function DriverOrderZoneDetails({ order }: { order: Order }) {
  const view = driverOrderZoneView(order);
  return (
    <div className={styles.detailCard} data-testid="active-order-zones">
      <span className={styles.detailRowLabel}>Зоны (bender-zones-v1.1)</span>
      <span className={styles.detailRowValue}>
        Забор: {view.pickup.label} · Доставка: {view.dropoff.label}
      </span>
      {view.isSeverny ? (
        <span className={styles.detailRowValue}>Северный (анклав Zone 4)</span>
      ) : null}
      {view.requiresVarnitaTransit ? (
        <span className={styles.detailRowValue}>Требуется транзит через Варницу</span>
      ) : null}
      {view.warning ? (
        <span className={styles.detailRowValue}>{view.warning}</span>
      ) : null}
      <span className={styles.detailRowValue} style={{ color: "#888", fontSize: 12 }}>
        Набор зон: {view.releaseId} · версия данных: {view.datasetVersion}
      </span>
    </div>
  );
}

/** Актуальная точка маршрута: ресторан до получения, клиент — после. */
function RoutePoint({
  order,
  pickedUp,
  zoneName,
}: {
  order: Order;
  pickedUp: boolean;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  if (pickedUp) {
    return (
      <>
        <div className={styles.detailCard}>
          <span className={styles.detailRowLabel}>Доставить</span>
          <span className={styles.detailRowValue}>
            {formatCustomerAddress(order.address)}
          </span>
          {order.address && addressExtras(order.address) ? (
            <span className={styles.detailRowValue}>
              {addressExtras(order.address)}
            </span>
          ) : null}
          {/* Зона доставки — из snapshot (блок «Зоны»), здесь не дублируется. */}
          {order.address && order.address.comment.trim() !== "" ? (
            <span className={styles.detailRowValue}>
              Комментарий: {order.address.comment}
            </span>
          ) : null}
        </div>
        {/* Ресторан свёрнут в компактную вторичную строку. */}
        <p className={styles.secondarySummary}>
          Забрали в: {order.restaurant.name}
        </p>
      </>
    );
  }
  return (
    <>
      <div className={styles.detailCard}>
        <span className={styles.detailRowLabel}>Забрать</span>
        <span className={styles.detailRowValue}>{order.restaurant.name}</span>
        <span className={styles.detailRowValue}>{order.restaurant.address}</span>
        <span className={styles.detailRowValue}>
          {zoneName(order.restaurant.zoneId)}
        </span>
      </div>
      <p className={styles.secondarySummary}>
        Клиент: {order.address?.street ?? "—"}
      </p>
    </>
  );
}

/**
 * Наличный заказ: передача денег ресторану ведёт весь верхний блок. Сумма — из
 * cash snapshot (view.amountCents), не пересчитывается. До подтверждения
 * ресторана «Заказ получен» недоступен; передача подтверждается через
 * DriverControlSheet.
 */
function DriverCashHandoffBlock({
  driverId,
  order,
  stage,
  view,
  collectionView,
  restaurantTimeZone,
  waitingView,
  onReportDelay,
  delayIncidentTriggerRef,
}: {
  driverId: string;
  order: Order;
  stage: DriverDeliveryStage;
  view: PlatformDriverCashHandoffView;
  collectionView: PlatformDriverCustomerCashCollectionView;
  restaurantTimeZone: string;
  waitingView: RestaurantWaitingView | null;
  onReportDelay: () => void;
  delayIncidentTriggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const {
    driverArriveAtRestaurant,
    driverPickUpOrder,
    driverMarkArriving,
    driverCompleteDelivery,
    driverReportCashHandoffToRestaurant,
  } = usePrototype();
  const { pending, error, clearError, run } = useAction();
  const [reportOpen, setReportOpen] = useState(false);
  const reportTriggerRef = useRef<HTMLButtonElement>(null);
  // Подтверждение получения полной суммы от клиента (отдельный лист).
  const [collectOpen, setCollectOpen] = useState(false);
  const collectTriggerRef = useRef<HTMLButtonElement>(null);
  const amount =
    view.amountCents !== null
      ? formatMoney(view.amountCents, order.financials.currencyCode)
      : "—";
  // Полная сумма заказа к получению от клиента — только из cash snapshot.
  const customerAmount =
    collectionView.amountCents !== null
      ? formatMoney(collectionView.amountCents, order.financials.currencyCode)
      : "—";
  // Канонический waiting summary — тот же, что и в ONLINE StagePanel. Не заменяет
  // cash handoff card: показывается дополнительным верхним блоком только пока
  // заказ реально готовится (status WAITING); после READY — null.
  const waitingSummary = getRestaurantWaitingSummary(waitingView);

  const openCollect = (event: React.MouseEvent<HTMLButtonElement>) => {
    collectTriggerRef.current = event.currentTarget;
    setCollectOpen(true);
  };
  const confirmCollect = async () => {
    const result = await run(() =>
      driverCompleteDelivery(driverId, order.id, {
        cashCollectionConfirmed: true,
      }),
    );
    if (result.ok) setCollectOpen(false);
  };
  const closeCollect = () => {
    setCollectOpen(false);
    clearError();
  };

  const openReport = (event: React.MouseEvent<HTMLButtonElement>) => {
    reportTriggerRef.current = event.currentTarget;
    setReportOpen(true);
  };
  const confirmReport = async () => {
    const result = await run(() =>
      driverReportCashHandoffToRestaurant(driverId, order.id),
    );
    if (result.ok) setReportOpen(false);
  };
  const closeReport = () => {
    setReportOpen(false);
    clearError();
  };

  let card: React.ReactNode;
  if (stage === "GO_TO_RESTAURANT") {
    card = (
      <StageCard
        title="Следующий шаг"
        hint="Доберитесь до ресторана и подтвердите прибытие."
      >
        <p className={styles.cashHandoffLine}>
          Нужно передать ресторану: {amount}
        </p>
        <MainButton
          label="Я в ресторане"
          pending={pending}
          onClick={() => void run(() => driverArriveAtRestaurant(driverId, order.id))}
        />
      </StageCard>
    );
  } else if (stage === "WAITING_AT_RESTAURANT" || stage === "READY_TO_PICK_UP") {
    // Кнопка передачи наличных ресторану — одна и та же и с waiting summary, и без.
    const handoffButton = (
      <button
        type="button"
        ref={reportTriggerRef}
        className={styles.primaryButton}
        disabled={pending}
        onClick={openReport}
      >
        Я передал ресторану {amount}
      </button>
    );
    if (waitingSummary !== null && stage === "WAITING_AT_RESTAURANT") {
      // Пока идёт активное ожидание: единый блок «Вы в ресторане» = канонический
      // waiting summary сверху + текущий cash-статус/действие снизу. Cash
      // lifecycle не подменяется — кнопки и статусы остаются рабочими.
      let cashStatus: React.ReactNode;
      if (view.status === "DRIVER_ACTION_REQUIRED") {
        cashStatus = (
          <>
            <p className={styles.cashHandoffLine}>Нужно передать ресторану: {amount}</p>
            {handoffButton}
          </>
        );
      } else if (view.status === "RESTAURANT_CONFIRMATION_REQUIRED") {
        cashStatus = (
          <p className={styles.cashHandoffLine}>Ожидаем подтверждение ресторана</p>
        );
      } else if (view.status === "CONFIRMED") {
        cashStatus = (
          <p className={styles.cashHandoffLine}>
            Ресторан подтвердил получение {amount}
          </p>
        );
      } else {
        cashStatus = (
          <p className={styles.cashHandoffLine}>
            Наличная передача требует проверки Direct.
          </p>
        );
      }
      card = (
        <StageCard title="Вы в ресторане">
          <RestaurantWaitingSummary
            model={waitingSummary}
            restaurantTimeZone={restaurantTimeZone}
            onReportDelay={onReportDelay}
            triggerRef={delayIncidentTriggerRef}
            footer={cashStatus}
          />
        </StageCard>
      );
    } else if (view.status === "DRIVER_ACTION_REQUIRED") {
      card = (
        <StageCard
          title="Передайте наличные ресторану"
          hint={`Передайте ресторану ${amount} наличными и сообщите об этом.`}
        >
          {handoffButton}
        </StageCard>
      );
    } else if (view.status === "RESTAURANT_CONFIRMATION_REQUIRED") {
      card = (
        <StageCard
          title="Ожидаем подтверждение ресторана"
          hint="Ресторан подтвердит получение наличных. После этого можно забрать заказ."
        >
          {null}
        </StageCard>
      );
    } else if (view.status === "CONFIRMED" && stage === "READY_TO_PICK_UP") {
      card = (
        <StageCard
          title="Заказ готов"
          hint={`Ресторан подтвердил получение ${amount}. Заберите заказ.`}
        >
          <MainButton
            label="Заказ получен"
            pending={pending}
            onClick={() => void run(() => driverPickUpOrder(driverId, order.id))}
          />
        </StageCard>
      );
    } else if (view.status === "CONFIRMED") {
      card = (
        <StageCard
          title="Вы в ресторане"
          hint={`Ресторан подтвердил получение ${amount}. Ожидаем готовность заказа.`}
        >
          {null}
        </StageCard>
      );
    } else {
      card = (
        <div className={styles.notice} role="status">
          Наличная передача требует проверки Direct.
        </div>
      );
    }
  } else if (stage === "GO_TO_CUSTOMER") {
    card = (
      <StageCard title="Доставьте заказ клиенту">
        {/* Справочно: сколько предстоит получить. Действия получения тут нет. */}
        <p className={styles.cashHandoffLine}>
          Получить от клиента: {customerAmount}
        </p>
        <MainButton
          label="Я подъезжаю"
          pending={pending}
          onClick={() => void run(() => driverMarkArriving(driverId, order.id))}
        />
      </StageCard>
    );
  } else if (stage === "ARRIVING_TO_CUSTOMER") {
    card = (
      <StageCard
        title="Получите оплату и передайте заказ"
        hint={`Получите от клиента ${customerAmount} наличными.`}
      >
        <button
          type="button"
          ref={collectTriggerRef}
          className={styles.primaryButton}
          disabled={pending}
          onClick={openCollect}
        >
          Получил {customerAmount} и передал заказ
        </button>
      </StageCard>
    );
  } else {
    card = (
      <div className={styles.notice} role="status">
        Этап заказа требует проверки Direct.
      </div>
    );
  }

  return (
    <>
      {card}

      <DriverControlSheet
        open={reportOpen}
        title="Подтвердите передачу"
        onClose={closeReport}
        triggerRef={reportTriggerRef}
      >
        <p className={styles.cashSheetText}>
          Подтвердите, что вы уже передали ресторану {amount} наличными.
        </p>
        <div className={styles.cashConfirmActions}>
          <button
            type="button"
            className={`${styles.primaryButton} ${styles.cashConfirmPrimary}`}
            disabled={pending}
            onClick={() => void confirmReport()}
          >
            Я передал эту сумму
          </button>
          <button
            type="button"
            className={`${styles.secondaryButton} ${styles.cashConfirmSecondary}`}
            disabled={pending}
            onClick={closeReport}
          >
            Отмена
          </button>
        </div>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </DriverControlSheet>

      {/* Подтверждение получения полной суммы от клиента + передачи заказа.
          Только главная кнопка завершает заказ (атомарно в домене). */}
      <DriverControlSheet
        open={collectOpen}
        title="Подтвердите оплату и доставку"
        onClose={closeCollect}
        triggerRef={collectTriggerRef}
      >
        <p className={styles.cashSheetText}>
          Подтвердите, что вы получили от клиента {customerAmount} наличными и
          передали заказ.
        </p>
        <div className={styles.cashConfirmActions}>
          <button
            type="button"
            className={`${styles.primaryButton} ${styles.cashConfirmPrimary}`}
            disabled={pending}
            onClick={() => void confirmCollect()}
          >
            Деньги получены, заказ передан
          </button>
          <button
            type="button"
            className={`${styles.secondaryButton} ${styles.cashConfirmSecondary}`}
            disabled={pending}
            onClick={closeCollect}
          >
            Отмена
          </button>
        </div>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </DriverControlSheet>

      {error && !reportOpen && !collectOpen ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function StagePanel({
  stage,
  restaurantTimeZone,
  waitingView,
  pending,
  onArrive,
  onPickUp,
  onArriving,
  onDeliver,
  onReportDelay,
  delayIncidentTriggerRef,
}: {
  stage: DriverDeliveryStage;
  restaurantTimeZone: string;
  waitingView: RestaurantWaitingView | null;
  pending: boolean;
  onArrive: () => void;
  onPickUp: () => void;
  onArriving: () => void;
  onDeliver: () => void;
  onReportDelay: () => void;
  delayIncidentTriggerRef: React.RefObject<HTMLButtonElement | null>;
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
        <RestaurantWaitingPanel
          restaurantTimeZone={restaurantTimeZone}
          view={waitingView}
          onReportDelay={onReportDelay}
          triggerRef={delayIncidentTriggerRef}
        />
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

function formatWaitingClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * ONLINE waiting stage panel. Fail-closed: while the canonical summary is
 * unavailable (loading or a REVIEW_REQUIRED view) the driver never sees invented
 * numbers. When available, it renders the one shared RestaurantWaitingSummary —
 * the exact same block CASH reuses.
 */
function RestaurantWaitingPanel({
  restaurantTimeZone,
  view,
  onReportDelay,
  triggerRef,
}: {
  restaurantTimeZone: string;
  view: RestaurantWaitingView | null;
  onReportDelay: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const summary = getRestaurantWaitingSummary(view);
  if (summary === null) {
    return (
      <StageCard
        title="Вы в ресторане"
        hint={
          view === null
            ? "Загружаем данные ожидания…"
            : "Данные ожидания требуют проверки Direct."
        }
      />
    );
  }
  return (
    <StageCard title="Вы в ресторане">
      <RestaurantWaitingSummary
        model={summary}
        restaurantTimeZone={restaurantTimeZone}
        onReportDelay={onReportDelay}
        triggerRef={triggerRef}
      />
    </StageCard>
  );
}

/**
 * Single canonical presentation of the driver's restaurant wait, shared by
 * ONLINE and CASH. No waiting maths here — it renders the pure
 * RestaurantWaitingSummaryModel. `footer` lets CASH slot its handoff status/
 * action between the wait details and the delay-report action.
 */
function RestaurantWaitingSummary({
  model,
  restaurantTimeZone,
  onReportDelay,
  triggerRef,
  footer,
}: {
  model: RestaurantWaitingSummaryModel;
  restaurantTimeZone: string;
  onReportDelay: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  footer?: React.ReactNode;
}) {
  const expected = formatWaitingClock(model.expectedReadyAt, restaurantTimeZone);
  return (
    <>
      {!model.delayed ? (
        <p className={styles.restaurantCookingStatus}>Ресторан готовит заказ</p>
      ) : null}
      <dl className={styles.restaurantWaitingDetails} aria-live="polite">
        <div>
          <dt>Ждёте</dt>
          <dd>{formatAnalyticsDuration(model.waitingDurationMs)}</dd>
        </div>
        {model.delayed ? (
          <>
            <div><dt>Ожидалось к</dt><dd>{expected}</dd></div>
            <div className={styles.restaurantDelayRow}>
              <dt>Ресторан опаздывает</dt>
              <dd>{formatAnalyticsDuration(model.restaurantDelayMs)}</dd>
            </div>
          </>
        ) : (
          <div><dt>Ожидаемая готовность</dt><dd>{expected}</dd></div>
        )}
      </dl>
      {footer}
      {model.canReportDelay ? (
        <button
          type="button"
          className={styles.incidentReportButton}
          ref={triggerRef}
          onClick={onReportDelay}
        >
          <CircleAlert size={18} aria-hidden="true" />
          Сообщить о задержке
        </button>
      ) : null}
    </>
  );
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

/** Компактные детали заказа + связь с клиентом (одна карточка, без лишних рамок). */
function OrderMeta({ order }: { order: Order }) {
  return (
    <div className={styles.detailCard}>
      <div className={styles.metaRow}>
        <span className={styles.orderLine}>Заказ {order.publicNumber}</span>
        <span className={styles.detailRowValue}>Заказ принят</span>
      </div>
      <div className={styles.metaRow}>
        <span className={styles.detailRowValue}>
          {order.paymentMethod === "CASH" ? "Оплата: наличными" : "Оплата онлайн"}
        </span>
        <span className={styles.detailRowValue}>
          Выплата:{" "}
          {formatMoney(
            order.financials.driverPayoutCents,
            order.financials.currencyCode,
          )}
        </span>
      </div>

      <span className={styles.detailRowLabel}>Клиент</span>
      <span className={styles.detailRowValue}>{order.customer.name}</span>
      {/* Заметная touch-кнопка звонка (только tel:, без JS). */}
      <a className={styles.callButton} href={`tel:${order.customer.phone}`}>
        Позвонить клиенту
      </a>
      <span className={styles.callNumber}>{order.customer.phone}</span>
    </div>
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
