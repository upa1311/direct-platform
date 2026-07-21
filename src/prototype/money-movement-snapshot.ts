import {
  computeOrderMoneyMovement,
  type OrderMoneyMovement,
  type OrderPaymentChannel,
} from "./order-money-movement";
import type { DeliveryMode } from "./pricing-engine";
import {
  validateFinancialRuleSnapshot,
  type FinancialRuleSnapshot,
} from "./financial-rule";
import type { RestaurantFinancialCollectionMode } from "./models";

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

/** Суммы заказа со снимками его финансового правила и режима сбора денег. */
export interface MoneyMovementSnapshotInput extends MoneyMovementSnapshotSums {
  financialRule: FinancialRuleSnapshot;
  financialCollectionMode: RestaurantFinancialCollectionMode;
}

/** Известен ли финансовый режим (fallback и подстановки запрещены). */
function isKnownCollectionMode(
  value: unknown,
): value is RestaurantFinancialCollectionMode {
  return value === "MIXED_COLLECTION" || value === "RESTAURANT_COLLECTS_ALL";
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

/**
 * Заранее известный канал оплаты, либо null (PICKUP — станет известен только
 * при выдаче). Для доставки водителем Direct канал зависит от финансового
 * режима: платёж получает Direct (ONLINE_CARD) либо ресторан
 * (ONLINE_CARD_TO_RESTAURANT).
 */
function knownChannelForMode(
  mode: DeliveryMode,
  collectionMode: RestaurantFinancialCollectionMode,
): OrderPaymentChannel | null {
  if (mode === "PLATFORM_DRIVER") {
    return collectionMode === "RESTAURANT_COLLECTS_ALL"
      ? "ONLINE_CARD_TO_RESTAURANT"
      : "ONLINE_CARD";
  }
  if (mode === "RESTAURANT_DELIVERY") return "CASH_TO_RESTAURANT_COURIER";
  return null;
}

/** Вызов канонической функции для известного канала по правилу ЗАКАЗА. */
function computeForChannel(
  input: MoneyMovementSnapshotInput,
  paymentChannel: OrderPaymentChannel,
):
  | { ok: true; movement: OrderMoneyMovement }
  | { ok: false; error: string } {
  const result = computeOrderMoneyMovement({
    deliveryMode: input.deliveryMode,
    paymentChannel,
    foodSubtotalCents: input.foodSubtotalCents,
    deliveryFeeCents: input.deliveryFeeCents,
    smallOrderFeeCents: input.smallOrderFeeCents,
    customerTotalCents: input.customerTotalCents,
    restaurantCommissionCents: input.restaurantCommissionCents,
    // Стоимость доставки водителем Direct полностью получает водитель; в
    // остальных режимах водителя Direct нет.
    driverPayoutCents:
      input.deliveryMode === "PLATFORM_DRIVER" ? input.deliveryFeeCents : 0,
    financialRule: input.financialRule,
    financialCollectionMode: input.financialCollectionMode,
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
  input: MoneyMovementSnapshotInput,
): CreationMoneyMovementResult {
  // Новый заказ обязан иметь валидное правило — даже самовывоз, у которого
  // канал ещё неизвестен: правило фиксируется в момент создания заказа.
  const ruleResult = validateFinancialRuleSnapshot(input.financialRule);
  if (!ruleResult.ok) {
    return { ok: false, error: ruleResult.error };
  }
  if (!isKnownCollectionMode(input.financialCollectionMode)) {
    return { ok: false, error: "Неизвестный финансовый режим ресторана." };
  }
  const channel = knownChannelForMode(
    input.deliveryMode,
    input.financialCollectionMode,
  );
  if (channel === null) {
    return { ok: true, moneyMovementStatus: "PENDING_PAYMENT_CHANNEL" };
  }
  const computed = computeForChannel(input, channel);
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
  /** Правило, сохранённое при СОЗДАНИИ заказа (не активное на момент выдачи). */
  financialRule?: FinancialRuleSnapshot;
  /** Финансовый режим заказа; текущая настройка ресторана не читается. */
  financialCollectionMode?: RestaurantFinancialCollectionMode;
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
 * не перезаписывает. Расчёт — только computeOrderMoneyMovement и ТОЛЬКО по
 * правилу, сохранённому в самом заказе: активное правило на момент выдачи не
 * используется, поэтому его смена не меняет комиссию уже созданного заказа.
 * Заказ без валидного правила финализировать нельзя — fail-closed.
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
  // Правило и режим берутся из ЗАКАЗА; текущая настройка ресторана не
  // читается. Legacy-заказ без них финализировать нельзя.
  const ruleResult = validateFinancialRuleSnapshot(snapshot.financialRule);
  if (!ruleResult.ok) {
    return { ok: false, error: ruleResult.error };
  }
  if (!isKnownCollectionMode(snapshot.financialCollectionMode)) {
    return { ok: false, error: "Неизвестный финансовый режим ресторана." };
  }
  const computed = computeForChannel(
    {
      ...snapshot,
      financialRule: ruleResult.rule,
      financialCollectionMode: snapshot.financialCollectionMode,
    },
    channel,
  );
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
  "ONLINE_CARD_TO_RESTAURANT",
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

/**
 * ПОДТВЕРЖДЁННЫЕ снимок-суммы из ИСХОДНЫХ legacy-данных — до любых
 * fallback-нулей. Каждое обязательное поле должно реально присутствовать в
 * исходном снимке и быть конечным целым неотрицательным числом; для
 * PLATFORM_DRIVER дополнительно требуется исходный driverPayoutCents, равный
 * deliveryFeeCents. Отсутствие поля НЕ является доказанным нулём: без
 * подтверждённых сумм восстановление движения запрещено (null).
 */
export function readConfirmedSnapshotSums(
  rawFinancials: unknown,
  deliveryMode: DeliveryMode,
): MoneyMovementSnapshotSums | null {
  if (!rawFinancials || typeof rawFinancials !== "object") return null;
  const raw = rawFinancials as Record<string, unknown>;
  const required = [
    raw.foodSubtotalCents,
    raw.deliveryFeeCents,
    raw.smallOrderFeeCents,
    raw.customerTotalCents,
    raw.restaurantCommissionCents,
  ];
  if (!required.every(isCents)) return null;
  if (deliveryMode === "PLATFORM_DRIVER") {
    if (!isCents(raw.driverPayoutCents)) return null;
    if (raw.driverPayoutCents !== raw.deliveryFeeCents) return null;
  }
  return {
    deliveryMode,
    foodSubtotalCents: raw.foodSubtotalCents as number,
    deliveryFeeCents: raw.deliveryFeeCents as number,
    smallOrderFeeCents: raw.smallOrderFeeCents as number,
    customerTotalCents: raw.customerTotalCents as number,
    restaurantCommissionCents: raw.restaurantCommissionCents as number,
  };
}

/** Ожидаемый канал по режиму и (для самовывоза) фактическому способу оплаты. */
function expectedChannel(
  deliveryMode: DeliveryMode,
  collectionMode: RestaurantFinancialCollectionMode,
  context: MoneyMovementRecoveryContext,
): OrderPaymentChannel | null {
  if (deliveryMode === "PICKUP") {
    return context.pickupPaidWith !== null
      ? pickupChannelForPaidWith(context.pickupPaidWith)
      : null;
  }
  return knownChannelForMode(deliveryMode, collectionMode);
}

/**
 * Семантическая проверка сохранённого COMPLETE-движения: структура и простые
 * инварианты недостаточны — канал, получатель и КАЖДАЯ сумма обязаны совпасть
 * с результатом канонической функции от подтверждённых снимок-сумм
 * (формулы не копируются — только computeOrderMoneyMovement). Пересчёт идёт по
 * правилу ЗАКАЗА: активная версия для исторического заказа не используется,
 * поэтому будущая смена ставки не «ломает» валидный старый COMPLETE. При
 * полном совпадении возвращается ИСХОДНЫЙ объект движения (без замены и
 * пересчёта); любое расхождение или неизвестный канал завершённого самовывоза
 * — null, повреждённое движение молча не исправляется.
 */
export function verifyStoredCompleteMovement(
  stored: unknown,
  input: MoneyMovementSnapshotInput,
  context: MoneyMovementRecoveryContext,
): OrderMoneyMovement | null {
  if (!isValidStoredMoneyMovement(stored)) return null;
  const channel = expectedChannel(
    input.deliveryMode,
    input.financialCollectionMode,
    context,
  );
  if (channel === null) return null;
  const canonical = computeForChannel(input, channel);
  if (!canonical.ok) return null;
  const expected = canonical.movement;
  const matches =
    stored.customerMoneyRecipient === expected.customerMoneyRecipient &&
    stored.paymentChannel === expected.paymentChannel &&
    stored.totalBankFeeCents === expected.totalBankFeeCents &&
    stored.restaurantBankFeeCents === expected.restaurantBankFeeCents &&
    stored.directBankFeeCents === expected.directBankFeeCents &&
    stored.restaurantOwesDirectCents === expected.restaurantOwesDirectCents &&
    stored.directOwesRestaurantCents === expected.directOwesRestaurantCents &&
    stored.restaurantNetCents === expected.restaurantNetCents &&
    stored.directNetRevenueCents === expected.directNetRevenueCents;
  return matches ? stored : null;
}

/**
 * Полная fail-closed нормализация движения денег legacy-снимка. Порядок:
 * 1) подтверждение правила заказа (provenance) и исходных сумм (fallback-нули
 *    существуют только для совместимости прочих UI-полей и финансовыми данными
 *    НЕ являются);
 * 2) сохранённый COMPLETE проверяется структурно И семантически ПО ПРАВИЛУ
 *    ЗАКАЗА — валидный принимается исходным объектом, повреждённый уходит в
 *    REVIEW_REQUIRED;
 * 3) сохранённый REVIEW_REQUIRED сохраняется (идемпотентность);
 * 4) законный PENDING_PAYMENT_CHANNEL незавершённого самовывоза сохраняется;
 * 5) recovery разрешён ТОЛЬКО при подтверждённых суммах И валидном правиле;
 *    иначе — REVIEW_REQUIRED либо законный PENDING незавершённого самовывоза.
 *
 * Ключевая политика v12/v13: заказ БЕЗ валидного снимка правила ИЛИ без
 * снимка финансового режима не восстанавливается и не подтверждается — ни
 * текущая ставка, ни текущий режим ресторана задним числом не подставляются,
 * даже если все прежние суммы на месте и структурно выглядят корректно.
 */
export function normalizeStoredMoneyMovement(
  rawFinancials: unknown,
  deliveryMode: DeliveryMode,
  context: MoneyMovementRecoveryContext,
): RecoveredMoneyMovement {
  const raw =
    rawFinancials && typeof rawFinancials === "object"
      ? (rawFinancials as Record<string, unknown>)
      : {};
  const sums = readConfirmedSnapshotSums(rawFinancials, deliveryMode);
  const ruleResult = validateFinancialRuleSnapshot(raw.financialRule);
  const collectionMode = raw.financialCollectionMode;
  // Суммы, правило И финансовый режим вместе — единственное основание
  // что-либо считать. Текущая настройка ресторана здесь недоступна намеренно:
  // она могла измениться после оформления заказа.
  const confirmed: MoneyMovementSnapshotInput | null =
    sums && ruleResult.ok && isKnownCollectionMode(collectionMode)
      ? {
          ...sums,
          financialRule: ruleResult.rule,
          financialCollectionMode: collectionMode,
        }
      : null;
  const pendingAllowed =
    deliveryMode === "PICKUP" &&
    context.pickupPaidWith === null &&
    !context.pickupSettled;

  if (raw.moneyMovementStatus === "COMPLETE") {
    const verified = confirmed
      ? verifyStoredCompleteMovement(raw.moneyMovement, confirmed, context)
      : null;
    return verified
      ? { moneyMovementStatus: "COMPLETE", moneyMovement: verified }
      : { moneyMovementStatus: "REVIEW_REQUIRED" };
  }
  if (raw.moneyMovementStatus === "REVIEW_REQUIRED") {
    return { moneyMovementStatus: "REVIEW_REQUIRED" };
  }
  if (raw.moneyMovementStatus === "PENDING_PAYMENT_CHANNEL" && pendingAllowed) {
    return { moneyMovementStatus: "PENDING_PAYMENT_CHANNEL" };
  }
  if (confirmed === null) {
    // Нет подтверждённого правила или сумм: нулевой «успех» запрещён.
    return pendingAllowed
      ? { moneyMovementStatus: "PENDING_PAYMENT_CHANNEL" }
      : { moneyMovementStatus: "REVIEW_REQUIRED" };
  }
  return recoverMoneyMovement(confirmed, context);
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
 *
 * v12: расчёт возможен только при подтверждённом снимке правила заказа —
 * вызывающий обязан передать его вместе с суммами.
 */
export function recoverMoneyMovement(
  sums: MoneyMovementSnapshotInput,
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
    channel = knownChannelForMode(
      sums.deliveryMode,
      sums.financialCollectionMode,
    );
  }
  if (channel === null) {
    return { moneyMovementStatus: "REVIEW_REQUIRED" };
  }
  const computed = computeForChannel(sums, channel);
  return computed.ok
    ? { moneyMovementStatus: "COMPLETE", moneyMovement: computed.movement }
    : { moneyMovementStatus: "REVIEW_REQUIRED" };
}
