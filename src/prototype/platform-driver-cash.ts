import { isSafeCents } from "./bank-fee";
import type {
  DeliveryMode,
  PaymentMethod,
  PlatformDriverCashSnapshot,
} from "./models";

/**
 * Неизменяемый финансовый снимок будущего наличного заказа PLATFORM_DRIVER.
 *
 * Этот модуль НИЧЕГО не считает заново: комиссия, доставка, small-order fee,
 * цены, скидки, restaurant payout и driver payout приходят уже рассчитанными
 * каноническими суммами. Builder только (1) валидирует их единым денежным
 * validator'ом isSafeCents, (2) фиксирует под понятными cash-названиями,
 * (3) проверяет reconciliation. Никакого округления, исправления сумм или
 * подстановки нулей — при любом расхождении fail-closed.
 *
 * Снимок описывает ТОЛЬКО физический наличный поток «клиент → водитель →
 * ресторан». Водитель оставляет только свою доставку; долга водителя перед
 * Direct не существует. Bank fee, комиссии эквайринга, карточные аллокации и
 * timestamps передачи денег сюда не входят.
 */

/** Уже рассчитанные канонические суммы заказа — вход builder'а. */
export interface PlatformDriverCashAmountsInput {
  customerTotalCents: number;
  restaurantPayoutBeforeBankFeeCents: number;
  driverPayoutCents: number;
  platformGrossRevenueCents: number;
}

export type PlatformDriverCashSnapshotResult =
  | {
      ok: true;
      snapshot: PlatformDriverCashSnapshot;
    }
  | {
      ok: false;
      error: string;
    };

/** Целое, безопасное, строго больше нуля. */
function isPositiveCents(value: number): boolean {
  return isSafeCents(value) && value > 0;
}

/**
 * Строит cash-снимок из канонических сумм (v24). Fail-closed проверяет ВСЕ
 * инварианты корректной наличной экономики:
 *   customerCollection === customerTotal
 *   driverEarning     === driverPayout
 *   restaurantOwesDirect === platformGrossRevenue
 *   restaurantHandoff === customerCollection - driverEarning
 *   restaurantHandoff === restaurantPayoutBeforeBankFee + restaurantOwesDirect
 *
 * Водитель оставляет себе только доставку и передаёт ресторану весь остаток;
 * долга водителя перед Direct не существует. Ничего не округляет, не исправляет
 * и не пересчитывает — только проверяет и фиксирует.
 */
export function buildPlatformDriverCashSnapshot(
  input: PlatformDriverCashAmountsInput,
): PlatformDriverCashSnapshotResult {
  const {
    customerTotalCents,
    restaurantPayoutBeforeBankFeeCents,
    driverPayoutCents,
    platformGrossRevenueCents,
  } = input;

  if (!isPositiveCents(customerTotalCents)) {
    return { ok: false, error: "Некорректная сумма к получению от клиента." };
  }
  if (!isPositiveCents(restaurantPayoutBeforeBankFeeCents)) {
    return { ok: false, error: "Некорректная чистая доля ресторана." };
  }
  if (!isPositiveCents(driverPayoutCents)) {
    return { ok: false, error: "Некорректный заработок водителя." };
  }
  if (!isSafeCents(platformGrossRevenueCents)) {
    return { ok: false, error: "Некорректная сумма к перечислению Direct." };
  }

  // Водитель передаёт ресторану весь остаток после удержания своей доставки.
  const restaurantHandoffCents = customerTotalCents - driverPayoutCents;
  if (!isPositiveCents(restaurantHandoffCents)) {
    return {
      ok: false,
      error: "Некорректная сумма передачи ресторану.",
    };
  }
  // Передаваемая ресторану сумма обязана состоять ровно из его чистой доли и
  // будущего долга перед Direct — иначе данные заказа противоречивы.
  if (
    restaurantHandoffCents !==
    restaurantPayoutBeforeBankFeeCents + platformGrossRevenueCents
  ) {
    return {
      ok: false,
      error:
        "Наличный поток не сходится: передача ресторану не равна его доле плюс долгу Direct.",
    };
  }
  // Полный поток клиента: передача ресторану + заработок водителя.
  if (customerTotalCents !== restaurantHandoffCents + driverPayoutCents) {
    return {
      ok: false,
      error:
        "Наличный поток не сходится: сумма клиента не равна передаче ресторану плюс заработку водителя.",
    };
  }

  return {
    ok: true,
    snapshot: {
      customerCollectionCents: customerTotalCents,
      restaurantHandoffCents,
      driverEarningCents: driverPayoutCents,
      restaurantOwesDirectCents: platformGrossRevenueCents,
    },
  };
}

/** Совпадает ли кандидат-снимок поле-в-поле с канонической проекцией. */
function snapshotMatches(
  candidate: unknown,
  canonical: PlatformDriverCashSnapshot,
): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const c = candidate as Record<string, unknown>;
  return (
    c.customerCollectionCents === canonical.customerCollectionCents &&
    c.restaurantHandoffCents === canonical.restaurantHandoffCents &&
    c.driverEarningCents === canonical.driverEarningCents &&
    c.restaurantOwesDirectCents === canonical.restaurantOwesDirectCents
  );
}

/**
 * Строгое разрешение cash-снимка заказа (для нормализации и селекторов).
 *
 * Возвращает валидный снимок ТОЛЬКО если:
 * - deliveryMode === "PLATFORM_DRIVER";
 * - paymentMethod === "CASH";
 * - канонические суммы заказа проходят builder;
 * - сохранённый кандидат совпадает поле-в-поле с канонической проекцией.
 *
 * Иначе — null. Ничего не реконструирует и не ремонтирует: несоответствие
 * сохранённого объекта неизменяемым financials заказа — это null, а не «почти
 * правильный» снимок. Пустой/отсутствующий кандидат — тоже null.
 */
export function resolvePlatformDriverCashSnapshot(input: {
  deliveryMode: DeliveryMode;
  paymentMethod: PaymentMethod;
  amounts: PlatformDriverCashAmountsInput;
  candidate: unknown;
}): PlatformDriverCashSnapshot | null {
  if (input.deliveryMode !== "PLATFORM_DRIVER") return null;
  if (input.paymentMethod !== "CASH") return null;

  const built = buildPlatformDriverCashSnapshot(input.amounts);
  if (!built.ok) return null;

  return snapshotMatches(input.candidate, built.snapshot) ? built.snapshot : null;
}
