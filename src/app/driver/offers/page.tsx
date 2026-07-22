"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import kds from "@/components/kitchen/kitchen.module.css";
import { usePrototype } from "@/prototype/prototype-provider";
import { formatMoney } from "@/prototype/selectors";
import {
  getOpenDriverOffersForDriver,
  getOrderForOffer,
} from "@/prototype/driver-offers";
import { useNowMs } from "@/components/util/use-now";
import type { DriverProfile, Order, PrototypeState, ZoneId } from "@/prototype/models";
import { useSelectedDriverId } from "@/components/driver/driver-session";
import { DriverOfferSoundButton } from "@/components/driver/driver-offer-sound";
import styles from "../driver.module.css";

/**
 * Новые предложения на доставку. Клиентская страница: выбранный демо-водитель,
 * PrototypeState, селектор открытых предложений и provider-действия. Countdown
 * тикает локально; сохранять состояние каждую секунду нельзя.
 *
 * Приватность до принятия: показываем только улицу и зону клиента. Точный адрес
 * (дом, квартира, подъезд, этаж), телефон, имя и комментарий клиента скрыты, а
 * выплата берётся строго из снимка заказа.
 */
export default function DriverOffersPage() {
  const { state, isHydrated } = usePrototype();
  const selectedDriverId = useSelectedDriverId();
  const nowMs = useNowMs();

  const driver =
    selectedDriverId !== null
      ? state.drivers.find((d) => d.id === selectedDriverId) ?? null
      : null;

  const zoneName = (zoneId: ZoneId | null): string =>
    state.zones.find((z) => z.id === zoneId)?.name ?? "—";

  if (!isHydrated || nowMs === 0) {
    return (
      <div className={kds.screen}>
        <div className={styles.container}>
          <div className={styles.empty}>Загружаем предложения…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={kds.screen}>
      <div className={styles.container}>
        <h2 className={styles.sectionTitle}>Предложения</h2>

        {driver === null ? (
          <NoDriver />
        ) : driver.status === "OFFLINE" ? (
          <Notice>
            Вы не в сети. Выйдите онлайн и выберите текущую зону, чтобы получать
            предложения.
          </Notice>
        ) : driver.status === "PAUSED" ? (
          <Notice>
            Сейчас включена пауза. Предложения временно не поступают.
          </Notice>
        ) : driver.status === "BUSY_DIRECT" ? (
          <>
            <Notice>
              Вы уже выполняете заказ Direct. Новые предложения не поступают до
              завершения текущего заказа.
            </Notice>
            <Link className={styles.orderLink} href="/driver/current-order">
              Открыть текущий заказ
            </Link>
          </>
        ) : driver.status === "ZONE_CONFIRMATION_REQUIRED" ? (
          <>
            <Notice>
              Подтвердите текущую зону. До подтверждения предложения не поступают.
            </Notice>
            <Link className={styles.orderLink} href="/driver">
              Перейти к подтверждению зоны
            </Link>
          </>
        ) : (
          <AvailableOffers driver={driver} nowMs={nowMs} zoneName={zoneName} />
        )}
      </div>
    </div>
  );
}

function NoDriver() {
  return (
    <>
      <Notice>Сначала выберите водителя на странице «Обзор».</Notice>
      <Link className={styles.orderLink} href="/driver">
        Перейти к выбору водителя
      </Link>
    </>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.notice} role="status">
      {children}
    </div>
  );
}

function AvailableOffers({
  driver,
  nowMs,
  zoneName,
}: {
  driver: DriverProfile;
  nowMs: number;
  zoneName: (zoneId: ZoneId | null) => string;
}) {
  const { state, driverAcceptOffer, driverDeclineOffer } = usePrototype();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const offers = getOpenDriverOffersForDriver(state, driver.id, nowMs);

  const accept = async (offerId: string) => {
    setPending(true);
    setError(null);
    const result = await driverAcceptOffer(driver.id, offerId);
    setPending(false);
    if (result.ok) {
      router.push("/driver/current-order");
    } else {
      setError(result.error);
    }
  };

  const decline = async (offerId: string) => {
    setPending(true);
    setError(null);
    const result = await driverDeclineOffer(driver.id, offerId);
    setPending(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <>
      <DriverOfferSoundButton />

      {offers.length === 0 ? (
        <div className={styles.notice} role="status">
          Предложений пока нет. Текущая зона: {zoneName(driver.currentZoneId)}.
          При новом предложении прозвучит сигнал.
        </div>
      ) : (
        <ul className={styles.offerList}>
          {offers.map((offer) => {
            const order = getOrderForOffer(state, offer);
            if (order === null) return null;
            return (
              <li key={offer.id}>
                <OfferCard
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
      )}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Таймзона ресторана заказа (для форматирования готовности), с fallback. */
function restaurantTimeZoneOf(state: PrototypeState, order: Order): string {
  return (
    state.restaurants.find((r) => r.id === order.restaurant.id)?.timeZone ??
    "Europe/Chisinau"
  );
}

function OfferCard({
  order,
  remainingMs,
  zoneName,
  restaurantTimeZone,
  disabled,
  onAccept,
  onDecline,
}: {
  order: Order;
  remainingMs: number;
  zoneName: (zoneId: ZoneId | null) => string;
  restaurantTimeZone: string;
  disabled: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const readiness =
    order.status === "READY"
      ? "Готовность: Готов"
      : order.expectedReadyAt !== null
        ? `Ожидаемая готовность: ${formatTime(order.expectedReadyAt, restaurantTimeZone)}`
        : "Готовится";

  return (
    <div className={styles.offerCard}>
      <div className={styles.offerHead}>
        <span className={styles.offerNumber}>Заказ {order.publicNumber}</span>
        <span className={styles.offerPayout}>
          Ваша выплата:{" "}
          {formatMoney(
            order.financials.driverPayoutCents,
            order.financials.currencyCode,
          )}
        </span>
      </div>

      <div className={styles.offerSection}>
        <span className={styles.offerSectionLabel}>Забрать</span>
        <span className={styles.offerSectionValue}>{order.restaurant.name}</span>
        <span className={styles.offerSectionValue}>
          {order.restaurant.address}
        </span>
        <span className={styles.offerSectionValue}>
          {zoneName(order.restaurant.zoneId)}
        </span>
      </div>

      <div className={styles.offerSection}>
        <span className={styles.offerSectionLabel}>Доставить</span>
        {/* До принятия — только улица и зона клиента, без точного адреса. */}
        <span className={styles.offerSectionValue}>
          {order.address?.street ?? "—"}
        </span>
        <span className={styles.offerSectionValue}>
          {zoneName(order.financials.customerZoneId)}
        </span>
      </div>

      <div className={styles.offerSection}>
        <span className={styles.offerSectionValue}>{readiness}</span>
        <span className={styles.offerSectionValue}>Оплата онлайн</span>
      </div>

      <div className={styles.offerMetaRow}>
        <span>Осталось:</span>
        <span className={styles.offerCountdown}>
          {formatCountdown(remainingMs)}
        </span>
      </div>

      <div className={styles.offerActions}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={disabled}
          onClick={onAccept}
        >
          Принять заказ
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={disabled}
          onClick={onDecline}
        >
          Отказаться
        </button>
      </div>
    </div>
  );
}

/** Оставшееся время как MM:SS (не меньше 00:00). */
function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Время готовности HH:MM в поясе ресторана. */
function formatTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timeZone || "Europe/Chisinau",
    }).format(new Date(iso));
  } catch {
    return "—";
  }
}
