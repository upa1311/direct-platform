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
 * ресторан / Direct / заработок водителя». Bank fee, комиссии эквайринга,
 * карточные аллокации и timestamps передачи денег сюда не входят.
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
 * Строит cash-снимок из канонических сумм. Fail-closed:
 * - customer/restaurant/driver суммы: целые, безопасные, > 0;
 * - platform gross revenue: целое, безопасное, >= 0;
 * - обязательное равенство customerTotal === restaurantPayout + driverPayout
 *   + platformGrossRevenue.
 * Ничего не округляет, не исправляет и не обнуляет; input не мутирует.
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
    return { ok: false, error: "Некорректная сумма передачи ресторану." };
  }
  if (!isPositiveCents(driverPayoutCents)) {
    return { ok: false, error: "Некорректный заработок водителя." };
  }
  if (!isSafeCents(platformGrossRevenueCents)) {
    return { ok: false, error: "Некорректная сумма к получению Direct." };
  }

  // Reconciliation: наличный поток должен сходиться до цента. Не исправляем —
  // при расхождении снимок не создаётся.
  const distributed =
    restaurantPayoutBeforeBankFeeCents +
    driverPayoutCents +
    platformGrossRevenueCents;
  if (customerTotalCents !== distributed) {
    return {
      ok: false,
      error:
        "Наличный поток не сходится: сумма клиента не равна ресторану + водителю + Direct.",
    };
  }

  return {
    ok: true,
    snapshot: {
      customerCollectionCents: customerTotalCents,
      restaurantHandoffCents: restaurantPayoutBeforeBankFeeCents,
      driverEarningCents: driverPayoutCents,
      directReceivableFromDriverCents: platformGrossRevenueCents,
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
    c.directReceivableFromDriverCents ===
      canonical.directReceivableFromDriverCents
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
