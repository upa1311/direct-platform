import type {
  DriverDispatchWave,
  DriverDispatchWaveTrigger,
  DriverOffer,
  DriverProfile,
  Order,
  OrderHistoryEvent,
  PrototypeState,
} from "./models";
import type { ActionResult } from "./actions";
import { finalizeMutation } from "./prototype-store";
import {
  getDriverActiveOrder,
  getPlatformDriverCashSnapshot,
  getPlatformDriverCashTenderSnapshot,
} from "./selectors";

/**
 * Предложения заказов водителям по зоне ресторана (v17, наличные — v20).
 *
 * Модель предложения хранит ТОЛЬКО связь заказ↔водитель, жизненный цикл и факт
 * подтверждения денежного запаса для наличного заказа. Все отображаемые данные
 * (выплата, адрес, ресторан, клиент, сумма к ресторану) берутся из неизменяемого
 * снимка заказа. Домен здесь чистый: без React, localStorage и Date.now — момент
 * времени всегда передаётся аргументом и создаётся под общим Web Lock в provider.
 */

/** Срок жизни предложения — строго 30 секунд. Не случайный и не настраиваемый. */
export const DRIVER_OFFER_DURATION_MS = 30_000;
export const DRIVER_OFFER_WAVE_COOLDOWN_MS = 15_000;
export const DRIVER_DISPATCH_LEAD_MS = 10 * 60_000;

/** Детерминированный id предложения: одно на сочетание заказ+водитель. */
export function driverOfferId(
  orderId: string,
  driverId: string,
  waveNumber = 1,
): string {
  return `driver-offer-${orderId}-${driverId}-wave-${waveNumber}`;
}

export function driverDispatchWaveId(
  orderId: string,
  waveNumber: number,
): string {
  return `driver-dispatch-wave-${orderId}-${waveNumber}`;
}

/**
 * Ввод атомарного принятия предложения. Для наличного заказа принятие
 * невозможно без явного подтверждения денежного запаса водителем.
 */
export interface AcceptDriverOfferInput {
  cashReserveConfirmed: boolean;
}

/** Fail-closed ошибка принятия наличного заказа без подтверждения запаса. */
export const CASH_RESERVE_CONFIRMATION_REQUIRED_ERROR =
  "Перед принятием подтвердите, что у вас есть необходимая сумма наличными.";

export interface ReconcileDriverOffersResult {
  ok: boolean;
  error: string | null;
  createdCount: number;
  expiredCount: number;
  canceledCount: number;
}

export interface DriverOfferActionResult {
  ok: boolean;
  error: string | null;
  orderId: string | null;
}

export type DriverDispatchState =
  | "NOT_DUE"
  | "SEARCHING"
  | "READY_UNASSIGNED"
  | "NO_ELIGIBLE_DRIVERS"
  | "DATA_INVALID"
  | "ASSIGNED";

/** Валиден ли ISO-момент. */
function parseIso(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Общие для обоих каналов проверки снимка заказа (адрес, зона, выплата). */
function orderShapeEligible(order: Order): boolean {
  if (order.status !== "PREPARING" && order.status !== "READY") return false;
  if (order.assignedDriverId !== null) return false;
  if (order.address === null) return false;
  if (typeof order.address.street !== "string" || order.address.street.trim() === "") {
    return false;
  }
  if (order.financials.customerZoneId === null) return false;
  const payout = order.financials.driverPayoutCents;
  if (!Number.isInteger(payout) || payout <= 0) return false;
  return true;
}

/**
 * Онлайн-заказ, подходящий для предложения: PLATFORM_DRIVER, ONLINE, PAID,
 * на этапе готовки/готов, не назначен, с валидным адресом, зоной клиента и
 * положительной выплатой. Наличные и cashEnabled на онлайн-канал не влияют.
 */
function isOnlineOrderEligible(order: Order): boolean {
  if (order.deliveryMode !== "PLATFORM_DRIVER") return false;
  if (order.paymentMethod !== "ONLINE") return false;
  if (order.paymentStatus !== "PAID") return false;
  return orderShapeEligible(order);
}

/**
 * Наличный заказ, подходящий для предложения. Требует включённого глобального
 * флага наличных и валидного неизменяемого cash snapshot. Отсутствие или
 * повреждение снимка делает заказ неeligible (fail-closed). Суммы не считаются
 * заново — источник только order.financials.platformDriverCash.
 */
function isCashOrderEligible(state: PrototypeState, order: Order): boolean {
  if (!state.platformSettings.platformDriverCashEnabled) return false;
  if (order.deliveryMode !== "PLATFORM_DRIVER") return false;
  if (order.paymentMethod !== "CASH") return false;
  if (order.paymentStatus !== "CASH_ON_DELIVERY") return false;
  if (!orderShapeEligible(order)) return false;
  if (getPlatformDriverCashSnapshot(order) === null) return false;
  // v31: наличное предложение требует валидного снимка сдачи. Его отсутствие или
  // повреждение (в т.ч. legacy CASH без tender) делает заказ неeligible —
  // водителю нельзя предложить наличный заказ без полного раскрытия сдачи (F-5).
  // Существующие OPEN-предложения на такой заказ отменит reconciliation.
  if (getPlatformDriverCashTenderSnapshot(order) === null) return false;
  return true;
}

/** Является ли заказ наличным предложением (PLATFORM_DRIVER + CASH). */
function isCashOfferOrder(order: Order): boolean {
  return order.deliveryMode === "PLATFORM_DRIVER" && order.paymentMethod === "CASH";
}

/**
 * Может ли заказ вообще стать предложением водителю. Онлайн-канал не изменён;
 * наличный добавлен строго за флагом и валидным cash snapshot. Требует state:
 * допуск наличных зависит от platformSettings, а не от глобальных данных.
 */
export function isOrderEligibleForDriverOffers(
  state: PrototypeState,
  order: Order,
): boolean {
  return isOnlineOrderEligible(order) || isCashOrderEligible(state, order);
}

function orderWorkflowIsValidForDispatch(
  state: PrototypeState,
  order: Order,
): boolean {
  if (order.status === "READY") return true;
  if (order.status !== "PREPARING") return false;
  const restaurant = state.restaurants.find(
    (candidate) => candidate.id === order.restaurant.id,
  );
  if (!restaurant) return false;
  const kitchenStartedAt = order.kitchenStartedAt
    ? parseIso(order.kitchenStartedAt)
    : null;
  const expectedReadyAt = order.expectedReadyAt
    ? parseIso(order.expectedReadyAt)
    : null;
  if (kitchenStartedAt === null || expectedReadyAt === null) return false;
  return expectedReadyAt >= kitchenStartedAt;
}

function dispatchAtMs(
  state: PrototypeState,
  order: Order,
): number | null {
  if (order.status === "READY") return 0;
  if (!orderWorkflowIsValidForDispatch(state, order)) return null;
  const expectedReadyAt = parseIso(order.expectedReadyAt as string);
  if (expectedReadyAt === null) return null;
  return (
    expectedReadyAt -
    state.platformSettings.driverDispatchLeadMinutes * 60_000
  );
}

function isOrderDueForDispatch(
  state: PrototypeState,
  order: Order,
  nowMs: number,
): boolean {
  if (!isOrderEligibleForDriverOffers(state, order)) return false;
  if (order.status === "READY") return true;
  const dueAt = dispatchAtMs(state, order);
  return dueAt !== null && nowMs >= dueAt;
}

function isPreparingOrderNotYetDue(
  state: PrototypeState,
  order: Order,
  nowMs: number,
): boolean {
  if (!isOrderEligibleForDriverOffers(state, order)) return false;
  if (order.status !== "PREPARING") return false;
  const dueAt = dispatchAtMs(state, order);
  return dueAt !== null && nowMs < dueAt;
}

function wavesForOrder(
  state: PrototypeState,
  orderId: string,
): DriverDispatchWave[] {
  return state.driverDispatchWaves
    .filter((wave) => wave.orderId === orderId)
    .sort((a, b) => a.waveNumber - b.waveNumber);
}

function latestWaveForOrder(
  state: PrototypeState,
  orderId: string,
): DriverDispatchWave | null {
  return wavesForOrder(state, orderId).at(-1) ?? null;
}

function hasDeclinedOrder(
  state: PrototypeState,
  orderId: string,
  driverId: string,
): boolean {
  return state.driverOffers.some(
    (offer) =>
      offer.orderId === orderId &&
      offer.driverId === driverId &&
      offer.status === "DECLINED",
  );
}

function waveWasCanceledBecauseOrderWasNotDue(
  state: PrototypeState,
  wave: DriverDispatchWave,
): boolean {
  const offers = state.driverOffers.filter((offer) => offer.waveId === wave.id);
  return (
    offers.length > 0 &&
    offers.some(
      (offer) => offer.systemCancellationReason === "ORDER_NOT_DUE",
    ) &&
    offers.every(
      (offer) =>
        offer.status === "DECLINED" ||
        offer.status === "CANCELED",
    )
  );
}

/**
 * Подходит ли водитель для предложения ЭТОГО заказа. Зона сравнивается с зоной
 * ресторана из снимка заказа. Дополнительно: наличный заказ доступен только
 * водителю с cashEnabled === true; на онлайн-заказ cashEnabled не влияет.
 */
export function isDriverEligibleForOffer(
  state: PrototypeState,
  driver: DriverProfile,
  order: Order,
): boolean {
  if (driver.status !== "AVAILABLE") return false;
  if (driver.currentZoneId === null) return false;
  if (driver.currentZoneId !== order.restaurant.zoneId) return false;
  if (getDriverActiveOrder(state, driver.id) !== null) return false;
  if (isCashOfferOrder(order) && !driver.cashEnabled) return false;
  return true;
}

/** Все подходящие водители для заказа (в зоне ресторана, свободные). */
export function getEligibleDriversForOrder(
  state: PrototypeState,
  order: Order,
): DriverProfile[] {
  if (!isOrderEligibleForDriverOffers(state, order)) return [];
  return state.drivers.filter((driver) =>
    isDriverEligibleForOffer(state, driver, order),
  );
}

export function getDriverDispatchState(
  state: PrototypeState,
  order: Order,
  nowMs: number,
): DriverDispatchState {
  if (order.assignedDriverId !== null) return "ASSIGNED";
  if (!isOrderEligibleForDriverOffers(state, order)) return "DATA_INVALID";
  if (!orderWorkflowIsValidForDispatch(state, order)) return "DATA_INVALID";
  const dueAt = dispatchAtMs(state, order);
  if (dueAt === null) return "DATA_INVALID";
  if (order.status !== "READY" && nowMs < dueAt) return "NOT_DUE";
  const latest = latestWaveForOrder(state, order.id);
  if (
    latest !== null &&
    nowMs < Date.parse(latest.offerExpiresAt) &&
    state.driverOffers.some(
      (offer) => offer.waveId === latest.id && offer.status === "OPEN",
    )
  ) {
    return "SEARCHING";
  }
  const eligible = getEligibleDriversForOrder(state, order).filter(
    (driver) => !hasDeclinedOrder(state, order.id, driver.id),
  );
  if (eligible.length === 0) return "NO_ELIGIBLE_DRIVERS";
  return order.status === "READY" ? "READY_UNASSIGNED" : "SEARCHING";
}

/** Nearest domain transition needed by the provider scheduler. */
export function getNextDriverOfferReconciliationAt(
  state: PrototypeState,
  nowMs: number,
): number | null {
  const due: number[] = [];
  for (const offer of state.driverOffers) {
    if (offer.status === "OPEN" && Date.parse(offer.expiresAt) > nowMs) {
      due.push(Date.parse(offer.expiresAt));
    }
  }
  for (const order of state.orders) {
    if (!isOrderEligibleForDriverOffers(state, order)) continue;
    const dispatchAt = dispatchAtMs(state, order);
    if (dispatchAt !== null && dispatchAt > nowMs) due.push(dispatchAt);
    const latest = latestWaveForOrder(state, order.id);
    if (latest) {
      const retryAt =
        Date.parse(latest.offerExpiresAt) +
        state.platformSettings.driverOfferWaveCooldownSeconds * 1_000;
      if (retryAt > nowMs) due.push(retryAt);
    }
  }
  return due.length === 0 ? null : Math.min(...due);
}

/**
 * Заказ, к которому относится предложение, либо null. Без non-null assertion:
 * если заказ исчез, UI предложение не показывает, а reconciliation его отменяет.
 */
export function getOrderForOffer(
  state: PrototypeState,
  offer: DriverOffer,
): Order | null {
  return state.orders.find((order) => order.id === offer.orderId) ?? null;
}

/**
 * Открытые неистёкшие предложения водителя, отсортированные по близости
 * истечения, затем offeredAt, затем orderId. Только для чтения.
 */
export function getOpenDriverOffersForDriver(
  state: PrototypeState,
  driverId: string,
  nowMs: number,
): DriverOffer[] {
  return state.driverOffers
    .filter(
      (offer) =>
        offer.driverId === driverId &&
        offer.status === "OPEN" &&
        Date.parse(offer.expiresAt) > nowMs,
    )
    .sort((a, b) => {
      const byExpiry = Date.parse(a.expiresAt) - Date.parse(b.expiresAt);
      if (byExpiry !== 0) return byExpiry;
      const byOffered = Date.parse(a.offeredAt) - Date.parse(b.offeredAt);
      if (byOffered !== 0) return byOffered;
      return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
    });
}

/**
 * Единая мутация актуализации предложений:
 *  1) OPEN → EXPIRED, если срок вышел;
 *  2) OPEN → CANCELED, если заказ больше не подходит/назначен, водитель сменил
 *     доступность/зону/получил другой заказ, ЛИБО (для наличного заказа)
 *     выключили глобальный флаг, снимок стал невалидным или водитель потерял
 *     cashEnabled — всё это проверяет isOrderEligibleForDriverOffers/
 *     isDriverEligibleForOffer под свежим state;
 *  3) создаёт OPEN-предложения всем подходящим водителям всех подходящих
 *     заказов — по одному на сочетание заказ+водитель за весь lifecycle заказа.
 *
 * Уже отвечавший (DECLINED/EXPIRED/CANCELED) тот же заказ повторно не получает.
 * Новые OPEN-предложения создаются с cashReserveConfirmedAt: null. ONLINE-канал
 * не изменён. Reconciliation без изменений возвращает исходный state.
 */
export function reconcileDriverOffers(
  state: PrototypeState,
  nowIso: string,
): ActionResult<ReconcileDriverOffersResult> {
  const fail = (
    error: string,
  ): ActionResult<ReconcileDriverOffersResult> => ({
    state,
    result: { ok: false, error, createdCount: 0, expiredCount: 0, canceledCount: 0 },
  });

  const nowMs = parseIso(nowIso);
  if (nowMs === null) return fail("Некорректное время.");

  let expiredCount = 0;
  let canceledCount = 0;
  let createdCount = 0;
  const nextOffers: DriverOffer[] = state.driverOffers.map((offer) => {
    if (offer.status !== "OPEN") return offer;
    if (Date.parse(offer.expiresAt) <= nowMs) {
      expiredCount += 1;
      return { ...offer, status: "EXPIRED", resolvedAt: nowIso };
    }
    const order = state.orders.find((o) => o.id === offer.orderId) ?? null;
    const driver = state.drivers.find((d) => d.id === offer.driverId) ?? null;
    const orderIsDue =
      order !== null && isOrderDueForDispatch(state, order, nowMs);
    const stillValid =
      orderIsDue &&
      order !== null &&
      driver !== null &&
      isDriverEligibleForOffer(state, driver, order);
    if (!stillValid) {
      canceledCount += 1;
      return {
        ...offer,
        status: "CANCELED",
        resolvedAt: nowIso,
        ...(order !== null && isPreparingOrderNotYetDue(state, order, nowMs)
          ? { systemCancellationReason: "ORDER_NOT_DUE" as const }
          : {}),
      };
    }
    return offer;
  });

  const workingState: PrototypeState = {
    ...state,
    driverOffers: nextOffers,
  };
  const nextWaves = [...state.driverDispatchWaves];

  for (const order of state.orders) {
    if (!isOrderDueForDispatch(workingState, order, nowMs)) continue;
    const orderWaves = nextWaves
      .filter((wave) => wave.orderId === order.id)
      .sort((a, b) => a.waveNumber - b.waveNumber);
    const latest = orderWaves.at(-1) ?? null;
    const recoversCanceledEtaWave =
      latest !== null &&
      waveWasCanceledBecauseOrderWasNotDue(workingState, latest);
    if (
      latest &&
      nowMs < Date.parse(latest.offerExpiresAt) &&
      !recoversCanceledEtaWave
    ) {
      continue;
    }

    const cooldownMs =
      state.platformSettings.driverOfferWaveCooldownSeconds * 1_000;
    const inCooldown =
      latest !== null &&
      nowMs < Date.parse(latest.offerExpiresAt) + cooldownMs;
    const hasReadyUrgentWave = orderWaves.some(
      (wave) => wave.trigger === "READY_URGENT",
    );
    const canBypassCooldown =
      order.status === "READY" && inCooldown && !hasReadyUrgentWave;
    if (inCooldown && !canBypassCooldown && !recoversCanceledEtaWave) continue;

    const waveNumber = (latest?.waveNumber ?? 0) + 1;
    const trigger: DriverDispatchWaveTrigger =
      latest === null
        ? order.status === "READY"
          ? "READY_URGENT"
          : "ETA_WINDOW"
        : recoversCanceledEtaWave
          ? "ETA_WINDOW"
          : canBypassCooldown
          ? "READY_URGENT"
          : "RETRY";
    const waveId = driverDispatchWaveId(order.id, waveNumber);
    const offerExpiresAt = new Date(
      nowMs + state.platformSettings.driverOfferDurationSeconds * 1_000,
    ).toISOString();
    nextWaves.push({
      id: waveId,
      orderId: order.id,
      waveNumber,
      startedAt: nowIso,
      offerExpiresAt,
      trigger,
    });

    for (const driver of getEligibleDriversForOrder(workingState, order)) {
      if (hasDeclinedOrder(workingState, order.id, driver.id)) continue;
      nextOffers.push({
        id: driverOfferId(order.id, driver.id, waveNumber),
        waveId,
        waveNumber,
        orderId: order.id,
        driverId: driver.id,
        status: "OPEN",
        offeredAt: nowIso,
        expiresAt: offerExpiresAt,
        resolvedAt: null,
        cashReserveConfirmedAt: null,
      });
      createdCount += 1;
    }
  }

  if (
    expiredCount === 0 &&
    canceledCount === 0 &&
    createdCount === 0 &&
    nextWaves.length === state.driverDispatchWaves.length
  ) {
    return {
      state,
      result: { ok: true, error: null, createdCount: 0, expiredCount: 0, canceledCount: 0 },
    };
  }

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      driverOffers: nextOffers,
      driverDispatchWaves: nextWaves,
    },
    nowIso,
  );
  return {
    state: nextState,
    result: { ok: true, error: null, createdCount, expiredCount, canceledCount },
  };
}

/**
 * Отказ водителя от своего открытого предложения. Причина не спрашивается, не
 * принимается и не сохраняется. Водитель остаётся AVAILABLE; предложения других
 * водителей на этот заказ не трогаются.
 */
export function declineDriverOffer(
  state: PrototypeState,
  driverId: string,
  offerId: string,
  nowIso: string,
): ActionResult<DriverOfferActionResult> {
  const fail = (error: string): ActionResult<DriverOfferActionResult> => ({
    state,
    result: { ok: false, error, orderId: null },
  });

  const nowMs = parseIso(nowIso);
  if (nowMs === null) return fail("Некорректное время.");

  const driver = state.drivers.find((d) => d.id === driverId);
  if (!driver) return fail("Водитель не найден.");

  const offer = state.driverOffers.find((o) => o.id === offerId);
  if (!offer) return fail("Предложение не найдено.");
  if (offer.driverId !== driverId) {
    return fail("Это предложение адресовано другому водителю.");
  }
  if (offer.status !== "OPEN" || Date.parse(offer.expiresAt) <= nowMs) {
    return fail("Предложение уже недоступно.");
  }
  const latestWave = latestWaveForOrder(state, offer.orderId);
  if (
    latestWave === null ||
    latestWave.id !== offer.waveId ||
    latestWave.waveNumber !== offer.waveNumber ||
    nowMs >= Date.parse(latestWave.offerExpiresAt)
  ) {
    return fail("Предложение уже недоступно.");
  }

  const nextOffers = state.driverOffers.map((o) =>
    o.id === offerId
      ? { ...o, status: "DECLINED" as const, resolvedAt: nowIso }
      : o,
  );
  const nextState = finalizeMutation(
    state,
    { ...state, driverOffers: nextOffers },
    nowIso,
  );
  return {
    state: nextState,
    result: { ok: true, error: null, orderId: offer.orderId },
  };
}

/**
 * Атомарное принятие предложения. Все проверки повторяются над свежим state под
 * Web Lock. Для наличного заказа дополнительно: включён глобальный флаг, у
 * водителя cashEnabled, снимок валиден и запас подтверждён (cashReserveConfirmed
 * === true). Успех одновременно: помечает предложение ACCEPTED, ставит
 * cashReserveConfirmedAt (nowIso для наличного, null для онлайн), назначает
 * заказ, переводит водителя в BUSY_DIRECT и отменяет прочие открытые предложения.
 * Подтверждение и назначение — единая мутация; отдельного «подтвердил сумму»
 * действия нет. Гонку двух водителей разрешает сериализация.
 */
export function acceptDriverOffer(
  state: PrototypeState,
  driverId: string,
  offerId: string,
  nowIso: string,
  input: AcceptDriverOfferInput,
): ActionResult<DriverOfferActionResult> {
  const fail = (error: string): ActionResult<DriverOfferActionResult> => ({
    state,
    result: { ok: false, error, orderId: null },
  });

  const nowMs = parseIso(nowIso);
  if (nowMs === null) return fail("Некорректное время.");

  const driver = state.drivers.find((d) => d.id === driverId);
  if (!driver) return fail("Водитель не найден.");

  const offer = state.driverOffers.find((o) => o.id === offerId);
  if (!offer) return fail("Предложение не найдено.");
  if (offer.driverId !== driverId) {
    return fail("Это предложение адресовано другому водителю.");
  }
  if (offer.status !== "OPEN" || Date.parse(offer.expiresAt) <= nowMs) {
    return fail("Предложение уже недоступно.");
  }
  const latestWave = latestWaveForOrder(state, offer.orderId);
  if (
    latestWave === null ||
    latestWave.id !== offer.waveId ||
    latestWave.waveNumber !== offer.waveNumber ||
    nowMs >= Date.parse(latestWave.offerExpiresAt)
  ) {
    return fail("Предложение уже недоступно.");
  }
  if (driver.status !== "AVAILABLE") {
    return fail("Сейчас нельзя принять предложение.");
  }
  if (driver.currentZoneId === null) {
    return fail("Сначала выберите текущую зону.");
  }
  if (getDriverActiveOrder(state, driverId) !== null) {
    return fail("У вас уже есть активный заказ.");
  }

  const order = state.orders.find((o) => o.id === offer.orderId) ?? null;
  if (
    order === null ||
    !isOrderDueForDispatch(state, order, nowMs) ||
    driver.currentZoneId !== order.restaurant.zoneId
  ) {
    return fail("Предложение уже недоступно.");
  }

  // Наличный заказ: повторная проверка допуска водителя и обязательное
  // подтверждение денежного запаса. Без подтверждения — fail-closed, state не
  // меняется (offer OPEN, order не назначен, revision не растёт).
  const isCash = isCashOfferOrder(order);
  if (isCash) {
    if (!driver.cashEnabled) {
      return fail("Предложение уже недоступно.");
    }
    // v31: явная повторная проверка обоих наличных снимков на свежем state.
    // (isOrderDueForDispatch уже включает их через isCashOrderEligible; здесь —
    // fail-closed на случай будущих изменений, чтобы принять наличный заказ без
    // валидной суммы/сдачи было невозможно.)
    if (
      getPlatformDriverCashSnapshot(order) === null ||
      getPlatformDriverCashTenderSnapshot(order) === null
    ) {
      return fail("Предложение уже недоступно.");
    }
    if (!input.cashReserveConfirmed) {
      return fail(CASH_RESERVE_CONFIRMATION_REQUIRED_ERROR);
    }
  }
  const cashReserveConfirmedAt = isCash ? nowIso : null;

  // Нейтральное событие: источником точного аудита остаётся сам DriverOffer.
  const historyEvent: OrderHistoryEvent = {
    id: `${order.id}-history-${order.history.length + 1}`,
    occurredAt: nowIso,
    actor: "SYSTEM",
    type: "STATUS",
    fromStatus: order.status,
    toStatus: order.status,
    message: `${driver.name} принял предложение Direct.`,
  };

  const nextOffers = state.driverOffers.map((o) => {
    if (o.id === offerId) {
      return {
        ...o,
        status: "ACCEPTED" as const,
        resolvedAt: nowIso,
        cashReserveConfirmedAt,
      };
    }
    // Прочие открытые предложения этого заказа ИЛИ этого водителя закрываются.
    if (
      o.status === "OPEN" &&
      (o.orderId === order.id || o.driverId === driverId)
    ) {
      return { ...o, status: "CANCELED" as const, resolvedAt: nowIso };
    }
    return o;
  });

  const nextState = finalizeMutation(
    state,
    {
      ...state,
      driverOffers: nextOffers,
      orders: state.orders.map((o) =>
        o.id === order.id
          ? {
              ...o,
              assignedDriverId: driverId,
              driverAssignedAt: nowIso,
              history: [...o.history, historyEvent],
            }
          : o,
      ),
      drivers: state.drivers.map((d) =>
        d.id === driverId ? { ...d, status: "BUSY_DIRECT" as const } : d,
      ),
    },
    nowIso,
  );
  return {
    state: nextState,
    result: { ok: true, error: null, orderId: order.id },
  };
}
