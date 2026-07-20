import {
  computeOrderMoneyMovement,
  type OrderMoneyMovement,
  type OrderPaymentChannel,
} from "./order-money-movement";
import type { DeliveryMode } from "./pricing-engine";

// Прослойка между каноническим расчётом движения денег и финансовым снимком
// заказа. Чистая: без React, состояния прототипа и localStorage. Формулы НЕ
// дублируются — единственный расчёт здесь и в normalization выполняет
// существующий computeOrderMoneyMovement (который, в свою очередь, использует
// allocateBankFee). Модуль отвечает только за:
// - выбор канала оплаты по режиму заказа (создание снимка);
// - однократную идемпотентную фиксацию канала самовывоза при выдаче;
// - fail-closed восстановление movement для legacy-данных при normalization.

/** Статусы движения денег (дублировать models здесь нельзя — только литералы). */
type SnapshotMoneyMovementStatus =
  | "COMPLETE"
  | "PENDING_PAYMENT_CHANNEL"
  | "REVIEW_REQUIRED";

/** Суммы снимка, необходимые для канонического расчёта. */
export interface MoneyMovementSnapshotSums {
  deliveryMode: DeliveryMode;
  foodSubtotalCents: number;
  deliveryFeeCents: number;
  smallOrderFeeCents: number;
  customerTotalCents: number;
  restaurantCommissionCents: number;
}

/** Результат построения движения при СОЗДАНИИ заказа. */
export type CreationMoneyMovementResult =
  | {
      ok: true;
      moneyMovementStatus: "COMPLETE";
      moneyMovement: OrderMoneyMovement;
    }
  | { ok: true; moneyMovementStatus: "PENDING_PAYMENT_CHANNEL" }
  | { ok: false; error: string };

/** Фактический канал самовывоза по способу оплаты, зафиксированному на точке. */
export function pickupChannelForPaidWith(
  paidWith: "CASH" | "CARD",
): OrderPaymentChannel {
  return paidWith === "CARD" ? "CARD_AT_RESTAURANT" : "CASH_AT_RESTAURANT";
}

/** Заранее известный канал оплаты режима, либо null (PICKUP — неизвестен). */
function knownChannelForMode(mode: DeliveryMode): OrderPaymentChannel | null {
  if (mode === "PLATFORM_DRIVER") return "ONLINE_CARD";
  if (mode === "RESTAURANT_DELIVERY") return "CASH_TO_RESTAURANT_COURIER";
  return null;
}

/** Вызов канонической функции для известного канала. */
function computeForChannel(
  sums: MoneyMovementSnapshotSums,
  paymentChannel: OrderPaymentChannel,
):
  | { ok: true; movement: OrderMoneyMovement }
  | { ok: false; error: string } {
  const result = computeOrderMoneyMovement({
    deliveryMode: sums.deliveryMode,
    paymentChannel,
    foodSubtotalCents: sums.foodSubtotalCents,
    deliveryFeeCents: sums.deliveryFeeCents,
    smallOrderFeeCents: sums.smallOrderFeeCents,
    customerTotalCents: sums.customerTotalCents,
    restaurantCommissionCents: sums.restaurantCommissionCents,
    // Стоимость доставки водителем Direct полностью получает водитель; в
    // остальных режимах водителя Direct нет.
    driverPayoutCents:
      sums.deliveryMode === "PLATFORM_DRIVER" ? sums.deliveryFeeCents : 0,
  });
  return result.ok
    ? { ok: true, movement: result.movement }
    : { ok: false, error: result.error };
}

/**
 * Движение денег при СОЗДАНИИ заказа. PLATFORM_DRIVER (ONLINE_CARD) и
 * RESTAURANT_DELIVERY (CASH_TO_RESTAURANT_COURIER) — канал заранее известен,
 * рассчитывается сразу и фиксируется как COMPLETE; ошибка канонической
 * функции — fail-closed, заказ с правдоподобными нулями не создаётся.
 * PICKUP — канал угадывать нельзя (клиент заплатит наличными или картой на
 * точке): PENDING_PAYMENT_CHANNEL без движения.
 */
export function buildCreationMoneyMovement(
  sums: MoneyMovementSnapshotSums,
): CreationMoneyMovementResult {
  const channel = knownChannelForMode(sums.deliveryMode);
  if (channel === null) {
    return { ok: true, moneyMovementStatus: "PENDING_PAYMENT_CHANNEL" };
  }
  const computed = computeForChannel(sums, channel);
  if (!computed.ok) {
    return { ok: false, error: computed.error };
  }
  return {
    ok: true,
    moneyMovementStatus: "COMPLETE",
    moneyMovement: computed.movement,
  };
}

/** Снимок, который умеет финализировать выдача самовывоза. */
export interface PickupFinalizeSnapshot extends MoneyMovementSnapshotSums {
  moneyMovementStatus: SnapshotMoneyMovementStatus;
  moneyMovement?: OrderMoneyMovement;
}

export type PickupFinalizeResult =
  | {
      ok: true;
      moneyMovementStatus: "COMPLETE";
      moneyMovement: OrderMoneyMovement;
    }
  | { ok: false; error: string };

/**
 * Однократная фиксация фактического канала самовывоза при выдаче.
 *
 * Идемпотентность и неизменяемость истории: если движение уже COMPLETE с тем
 * же каналом — возвращается СОХРАНЁННОЕ движение без пересчёта; попытка
 * зафиксировать другой канал (CASH → CARD) отклоняется fail-closed, историю
 * не перезаписывает. Расчёт — только computeOrderMoneyMovement.
 */
export function finalizePickupMoneyMovement(
  snapshot: PickupFinalizeSnapshot,
  paidWith: "CASH" | "CARD",
): PickupFinalizeResult {
  if (snapshot.deliveryMode !== "PICKUP") {
    return {
      ok: false,
      error: "Фиксация канала самовывоза доступна только заказу самовывоза.",
    };
  }
  const channel = pickupChannelForPaidWith(paidWith);
  if (snapshot.moneyMovementStatus === "COMPLETE") {
    if (!snapshot.moneyMovement) {
      return {
        ok: false,
        error: "Снимок повреждён: движение денег отмечено, но отсутствует.",
      };
    }
    if (snapshot.moneyMovement.paymentChannel !== channel) {
      return {
        ok: false,
        error:
          "Канал оплаты уже зафиксирован и не может быть изменён.",
      };
    }
    // Повтор того же канала: сохранённый результат, без пересчёта.
    return {
      ok: true,
      moneyMovementStatus: "COMPLETE",
      moneyMovement: snapshot.moneyMovement,
    };
  }
  const computed = computeForChannel(snapshot, channel);
  if (!computed.ok) {
    return { ok: false, error: computed.error };
  }
  return {
    ok: true,
    moneyMovementStatus: "COMPLETE",
    moneyMovement: computed.movement,
  };
}

// --- Normalization (legacy-заказы) ---------------------------------------------

const PAYMENT_CHANNELS: readonly OrderPaymentChannel[] = [
  "ONLINE_CARD",
  "CARD_AT_RESTAURANT",
  "CASH_AT_RESTAURANT",
  "CASH_TO_RESTAURANT_COURIER",
];

function isCents(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

/**
 * Структурная проверка СОХРАНЁННОГО движения денег: все суммы — целые
 * неотрицательные центы, канал и получатель — известные значения, банковский
 * инвариант сходится, встречных обязательств нет. Валидное сохранённое
 * движение принимается normalization как есть — без пересчёта, чтобы
 * зафиксированная финансовая история не менялась.
 */
export function isValidStoredMoneyMovement(
  value: unknown,
): value is OrderMoneyMovement {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  if (raw.customerMoneyRecipient !== "DIRECT" && raw.customerMoneyRecipient !== "RESTAURANT") {
    return false;
  }
  if (!PAYMENT_CHANNELS.includes(raw.paymentChannel as OrderPaymentChannel)) {
    return false;
  }
  const sums = [
    raw.totalBankFeeCents,
    raw.restaurantBankFeeCents,
    raw.directBankFeeCents,
    raw.restaurantOwesDirectCents,
    raw.directOwesRestaurantCents,
    raw.restaurantNetCents,
    raw.directNetRevenueCents,
  ];
  if (!sums.every(isCents)) return false;
  if (
    (raw.restaurantBankFeeCents as number) + (raw.directBankFeeCents as number) !==
    (raw.totalBankFeeCents as number)
  ) {
    return false;
  }
  if (
    (raw.restaurantOwesDirectCents as number) > 0 &&
    (raw.directOwesRestaurantCents as number) > 0
  ) {
    return false;
  }
  return true;
}

/** Контекст заказа, нужный normalization для восстановления движения. */
export interface MoneyMovementRecoveryContext {
  /** Фактический способ оплаты самовывоза, если он был сохранён. */
  pickupPaidWith: "CASH" | "CARD" | null;
  /** Самовывоз фактически оплачен/выдан (клиент уже платил). */
  pickupSettled: boolean;
}

export interface RecoveredMoneyMovement {
  moneyMovementStatus: SnapshotMoneyMovementStatus;
  moneyMovement?: OrderMoneyMovement;
}

/**
 * Fail-closed восстановление движения денег для legacy-снимка (v10 migration).
 *
 * COMPLETE восстанавливается ТОЛЬКО через computeOrderMoneyMovement и только
 * при однозначно известном канале: PLATFORM_DRIVER → ONLINE_CARD,
 * RESTAURANT_DELIVERY → CASH_TO_RESTAURANT_COURIER, PICKUP → только при
 * сохранённом фактическом pickupPaidWith. Незавершённый самовывоз без оплаты —
 * PENDING_PAYMENT_CHANNEL (канал закономерно неизвестен). Всё остальное —
 * REVIEW_REQUIRED: завершённый самовывоз без способа оплаты, несходящиеся или
 * повреждённые суммы, любая ошибка канонической функции. Отсутствующие
 * банковские суммы НЕ превращаются в нули без доказательств.
 */
export function recoverMoneyMovement(
  sums: MoneyMovementSnapshotSums,
  context: MoneyMovementRecoveryContext,
): RecoveredMoneyMovement {
  let channel: OrderPaymentChannel | null;
  if (sums.deliveryMode === "PICKUP") {
    if (context.pickupPaidWith !== null) {
      channel = pickupChannelForPaidWith(context.pickupPaidWith);
    } else if (context.pickupSettled) {
      // Клиент уже платил, но чем — неизвестно: восстановить нельзя.
      return { moneyMovementStatus: "REVIEW_REQUIRED" };
    } else {
      return { moneyMovementStatus: "PENDING_PAYMENT_CHANNEL" };
    }
  } else {
    channel = knownChannelForMode(sums.deliveryMode);
  }
  if (channel === null) {
    return { moneyMovementStatus: "REVIEW_REQUIRED" };
  }
  const computed = computeForChannel(sums, channel);
  return computed.ok
    ? { moneyMovementStatus: "COMPLETE", moneyMovement: computed.movement }
    : { moneyMovementStatus: "REVIEW_REQUIRED" };
}
