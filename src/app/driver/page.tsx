"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import kds from "@/components/kitchen/kitchen.module.css";
import { usePrototype } from "@/prototype/prototype-provider";
import { driverStatusLabels, getDriverActiveOrder } from "@/prototype/selectors";
import type { DriverProfile, ZoneId } from "@/prototype/models";
import styles from "./driver.module.css";

/**
 * Рабочее место водителя Direct. Экран сразу показывает управление
 * доступностью: дублировать верхнюю навигацию карточками разделов не нужно.
 *
 * Зона НИКОГДА не определяется автоматически — ни по адресу, ни по последнему
 * заказу. Система может лишь предложить зону завершённого заказа; подтверждает
 * её водитель. Всё состояние меняется доменными действиями через provider.
 */

/** Ключ UI-предпочтения: какой демо-водитель открыт в этом браузере. */
const SELECTED_DRIVER_KEY = "direct-selected-driver-id";

function readSelectedDriverId(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_DRIVER_KEY);
  } catch {
    return null;
  }
}

function writeSelectedDriverId(driverId: string | null): void {
  try {
    if (driverId === null) {
      window.localStorage.removeItem(SELECTED_DRIVER_KEY);
    } else {
      window.localStorage.setItem(SELECTED_DRIVER_KEY, driverId);
    }
  } catch {
    // Отсутствие localStorage не должно ломать рабочий экран.
  }
}

export default function DriverPage() {
  const { state, isHydrated } = usePrototype();
  // Первый вход — водитель не выбран: Пётр автоматически не подставляется.
  // Предпочтение читается лениво и только в браузере; до isHydrated экран
  // одинаков на сервере и клиенте, поэтому расхождения гидратации нет.
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readSelectedDriverId(),
  );

  const driver = useMemo(
    () => state.drivers.find((d) => d.id === selectedDriverId) ?? null,
    [state.drivers, selectedDriverId],
  );

  // Сохранённого водителя больше нет — устаревшее предпочтение стирается.
  // Эффект только синхронизирует внешнее хранилище: состояние React здесь не
  // меняется, а экран и так показывает выбор водителя (driver === null).
  useEffect(() => {
    if (isHydrated && selectedDriverId !== null && driver === null) {
      writeSelectedDriverId(null);
    }
  }, [isHydrated, selectedDriverId, driver]);

  const selectDriver = (driverId: string) => {
    writeSelectedDriverId(driverId);
    setSelectedDriverId(driverId);
  };

  const clearDriver = () => {
    writeSelectedDriverId(null);
    setSelectedDriverId(null);
  };

  return (
    <div className={kds.screen}>
      <div className={styles.container}>
        {!isHydrated ? (
          <div className={styles.empty}>Загружаем данные водителя…</div>
        ) : driver === null ? (
          <DriverPicker drivers={state.drivers} onSelect={selectDriver} />
        ) : (
          // key по предложенной зоне: новая подсказка после доставки заново
          // инициализирует черновик выбора без синхронизации через эффект.
          <DriverWorkspace
            key={`${driver.id}:${driver.suggestedZoneId ?? ""}`}
            driver={driver}
            onChangeDriver={clearDriver}
          />
        )}
      </div>
    </div>
  );
}

/** Выбор демо-водителя. Автоматического выбора нет — решает пользователь. */
function DriverPicker({
  drivers,
  onSelect,
}: {
  drivers: DriverProfile[];
  onSelect: (driverId: string) => void;
}) {
  return (
    <>
      <h2 className={styles.sectionTitle}>Выберите водителя</h2>
      {drivers.length === 0 ? (
        <div className={styles.empty}>Водители не найдены.</div>
      ) : (
        <ul className={styles.driverList}>
          {drivers.map((driver) => (
            <li key={driver.id}>
              <button
                type="button"
                className={styles.driverPick}
                onClick={() => onSelect(driver.id)}
              >
                <span className={styles.driverPickName}>{driver.name}</span>
                <span className={styles.driverPickMeta}>
                  {driverStatusLabels[driver.status]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function DriverWorkspace({
  driver,
  onChangeDriver,
}: {
  driver: DriverProfile;
  onChangeDriver: () => void;
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
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const zones = state.zones;
  const zoneName = (zoneId: ZoneId | null): string =>
    zones.find((z) => z.id === zoneId)?.name ?? "—";

  // Активный заказ берётся из order.assignedDriverId — отдельного поля у
  // водителя нет, поэтому рассинхронизации быть не может.
  const activeOrder = getDriverActiveOrder(state, driver.id);

  // Черновик выбора зоны: для подтверждения предзаполняется предложенной зоной,
  // но авторитетной она становится только после явного подтверждения водителем.
  // При новой подсказке компонент перемонтируется по key — синхронизировать
  // черновик эффектом не нужно.
  const [zoneDraft, setZoneDraft] = useState<ZoneId>(
    driver.suggestedZoneId ?? driver.currentZoneId ?? zones[0]?.id ?? "zone-1",
  );

  const run = async (
    action: () => Promise<{ ok: boolean; error: string | null }>,
  ) => {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (!result.ok) setError(result.error);
  };

  const status = driver.status;

  return (
    <>
      <button type="button" className={styles.linkButton} onClick={onChangeDriver}>
        ← Сменить водителя
      </button>

      <section className={styles.statusCard} aria-label="Состояние водителя">
        <span className={styles.driverName}>{driver.name}</span>
        <span className={styles.statusValue}>{driverStatusLabels[status]}</span>

        {status === "OFFLINE" ? (
          <span className={styles.statusHint}>
            Выберите текущую зону, чтобы начать получать предложения.
          </span>
        ) : null}
        {status === "PAUSED" ? (
          <span className={styles.statusHint}>
            Предложения временно не поступают.
          </span>
        ) : null}

        {status === "AVAILABLE" || status === "PAUSED" ? (
          <span className={styles.metaLine}>
            Текущая зона: {zoneName(driver.currentZoneId)}
          </span>
        ) : null}

        {/* Допуск к наличным — состояние, а не действие. */}
        <span className={styles.cashLine}>
          {driver.cashEnabled
            ? "Наличные заказы разрешены"
            : "Наличные заказы недоступны"}
        </span>
      </section>

      {status === "ZONE_CONFIRMATION_REQUIRED" &&
      driver.suggestedZoneId !== null ? (
        <div className={styles.notice} role="status">
          Заказ был завершён в зоне: {zoneName(driver.suggestedZoneId)}
        </div>
      ) : null}

      {status === "BUSY_DIRECT" ? (
        <section className={styles.statusCard} aria-label="Текущий заказ">
          {activeOrder ? (
            <>
              <span className={styles.orderLine}>
                Заказ {activeOrder.publicNumber}
              </span>
              <Link className={styles.orderLink} href="/driver/current-order">
                Открыть текущий заказ
              </Link>
            </>
          ) : (
            <span className={styles.statusHint}>
              Данные о текущем заказе обновляются.
            </span>
          )}
        </section>
      ) : null}

      {/* Выбор зоны нужен там, где водитель её задаёт или подтверждает. */}
      {status === "OFFLINE" ||
      status === "AVAILABLE" ||
      status === "PAUSED" ||
      status === "ZONE_CONFIRMATION_REQUIRED" ? (
        <label className={styles.zoneField}>
          <span>Текущая зона</span>
          <select
            className={styles.zoneSelect}
            value={zoneDraft}
            disabled={pending}
            onChange={(event) => setZoneDraft(event.target.value as ZoneId)}
          >
            {zones.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {zone.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className={styles.actions}>
        {status === "OFFLINE" ? (
          <button
            type="button"
            className={styles.primaryButton}
            disabled={pending}
            onClick={() => run(() => driverGoOnline(driver.id, zoneDraft))}
          >
            Выйти онлайн
          </button>
        ) : null}

        {status === "AVAILABLE" ? (
          <>
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
          </>
        ) : null}

        {status === "PAUSED" ? (
          <>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={pending}
              onClick={() => run(() => driverResume(driver.id))}
            >
              Возобновить поиск заказов
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
          </>
        ) : null}

        {status === "ZONE_CONFIRMATION_REQUIRED" ? (
          <>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={pending}
              onClick={() =>
                run(() => driverConfirmZone(driver.id, zoneDraft, "AVAILABLE"))
              }
            >
              Подтвердить зону и искать заказы
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending}
              onClick={() =>
                run(() => driverConfirmZone(driver.id, zoneDraft, "PAUSED"))
              }
            >
              Подтвердить зону и остаться на паузе
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending}
              onClick={() => run(() => driverGoOffline(driver.id))}
            >
              Выйти из сети
            </button>
          </>
        ) : null}
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
