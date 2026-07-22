import type { PrototypeState, Restaurant } from "./models";
import { addChecked, isSafeCents, subtractChecked } from "./bank-fee";
import {
  buildRestaurantFinanceReadModel,
  type FinanceNetDirection,
  type RestaurantFinanceOrderRow,
} from "./restaurant-finance-read-model";

/**
 * Read-only расшифровка ТЕКУЩЕЙ открытой позиции ресторана.
 *
 * Чистый модуль: без React, состояния прототипа и localStorage. Новых
 * бухгалтерских обязательств не создаёт и существующие не меняет — у заказа
 * по-прежнему максимум одна RestaurantAccountingEntry. Расшифровка лишь
 * объясняет, ИЗ ЧЕГО сложилась уже посчитанная сумма этой записи, опираясь
 * только на сохранённые снимки заказа.
 *
 * Единственный источник открытой позиции — канонический
 * buildRestaurantFinanceReadModel: второй формулы баланса и второго validator
 * бухгалтерии здесь нет. Ошибка read-model возвращается как есть.
 *
 * Старые заказы НЕ пересчитываются по текущим ставкам, тарифам, режиму сбора
 * платежей и настройкам доставки; различия объясняются по снимку конкретного
 * заказа, а не по идентификатору ресторана.
 */

/** Как компонент влияет на сумму обязательства. */
export type RestaurantBalanceBreakdownEffect = "ADD" | "SUBTRACT" | "INFO_ONLY";

/** Категории расшифровки (сырой enum наружу не показывается). */
export type RestaurantBalanceBreakdownCode =
  | "DIRECT_DELIVERY_COMMISSION"
  | "RESTAURANT_DELIVERY_COMMISSION"
  | "PICKUP_COMMISSION"
  | "SMALL_ORDER_FEE"
  | "DIRECT_DRIVER_DELIVERY_TRANSIT"
  | "FOOD_PAYOUT_BASE"
  | "COMMISSION_DEDUCTION"
  | "RESTAURANT_BANK_FEE_DEDUCTION"
  | "DIRECT_DRIVER_DELIVERY_INFO"
  | "RESTAURANT_DELIVERY_RETAINED"
  | "SMALL_ORDER_FEE_RETAINED_BY_DIRECT"
  | "BANK_FEE_INFO"
  | "LEGACY_UNCLASSIFIED";

export interface RestaurantBalanceBreakdownOrder {
  orderId: string;
  publicNumber: string;
  recognizedAt: string;
  amountCents: number;
}

export interface RestaurantBalanceBreakdownLine {
  code: RestaurantBalanceBreakdownCode;
  effect: RestaurantBalanceBreakdownEffect;
  amountCents: number;
  orderCount: number;
  orders: RestaurantBalanceBreakdownOrder[];
}

export interface RestaurantBalanceBreakdownSection {
  totalCents: number;
  lines: RestaurantBalanceBreakdownLine[];
}

export interface RestaurantBalanceBreakdown {
  restaurantId: string;
  currencyCode: "USD";
  restaurantOwesDirect: RestaurantBalanceBreakdownSection;
  directOwesRestaurant: RestaurantBalanceBreakdownSection;
  /** Строки «не входит во взаиморасчёт»: в сверку сумм НЕ включаются. */
  informationalLines: RestaurantBalanceBreakdownLine[];
  netDirection: FinanceNetDirection;
  netAmountCents: number;
  reviewRequiredOrderCount: number;
  pendingPaymentChannelOrderCount: number;
}

export type RestaurantBalanceBreakdownResult =
  | { ok: true; breakdown: RestaurantBalanceBreakdown }
  | { ok: false; error: string };

/** Единый текст отказа: правдоподобная расшифровка хуже честного отказа. */
export const BREAKDOWN_FAILED_ERROR =
  "Не удалось безопасно объяснить состав текущего баланса.";

/**
 * Фиксированный бизнес-порядок категорий: сначала обязательства ресторана
 * (комиссии, затем доплаты и транзит), потом формула выплаты Direct, затем
 * информационные строки.
 */
const CODE_ORDER: readonly RestaurantBalanceBreakdownCode[] = [
  "DIRECT_DELIVERY_COMMISSION",
  "RESTAURANT_DELIVERY_COMMISSION",
  "PICKUP_COMMISSION",
  "SMALL_ORDER_FEE",
  "DIRECT_DRIVER_DELIVERY_TRANSIT",
  "FOOD_PAYOUT_BASE",
  "COMMISSION_DEDUCTION",
  "RESTAURANT_BANK_FEE_DEDUCTION",
  "LEGACY_UNCLASSIFIED",
  "RESTAURANT_DELIVERY_RETAINED",
  "SMALL_ORDER_FEE_RETAINED_BY_DIRECT",
  "DIRECT_DRIVER_DELIVERY_INFO",
  "BANK_FEE_INFO",
];

function fail(error: string): RestaurantBalanceBreakdownResult {
  return { ok: false, error };
}

/** Один компонент одного заказа до агрегации. */
interface BreakdownContribution {
  code: RestaurantBalanceBreakdownCode;
  effect: RestaurantBalanceBreakdownEffect;
  amountCents: number;
  order: RestaurantBalanceBreakdownOrder;
}

function contribution(
  code: RestaurantBalanceBreakdownCode,
  effect: RestaurantBalanceBreakdownEffect,
  amountCents: number,
  row: RestaurantFinanceOrderRow,
): BreakdownContribution {
  return {
    code,
    effect,
    amountCents,
    order: {
      orderId: row.orderId,
      publicNumber: row.publicNumber,
      recognizedAt: row.recognizedAt,
      amountCents,
    },
  };
}

/**
 * Разбор ОДНОГО открытого обязательства на компоненты.
 *
 * Различия определяются сохранёнными признаками самого заказа (способ
 * получения, направление и основание обязательства, компоненты снимка), а не
 * идентификатором ресторана и не его текущими настройками.
 */
function explainRow(
  row: RestaurantFinanceOrderRow,
): { ok: true; parts: BreakdownContribution[] } | { ok: false; error: string } {
  // Архивное обязательство: состав неизвестен и не восстанавливается.
  if (row.dataStatus === "LEGACY") {
    return {
      ok: true,
      parts: [
        contribution("LEGACY_UNCLASSIFIED", "ADD", row.amountCents, row),
      ],
    };
  }
  // Повреждённая современная строка архивной не притворяется.
  if (row.dataStatus !== "COMPLETE") {
    return { ok: false, error: BREAKDOWN_FAILED_ERROR };
  }

  const {
    foodSubtotalCents,
    restaurantCommissionCents,
    deliveryFeeCents,
    smallOrderFeeCents,
    restaurantBankFeeCents,
  } = row;
  if (
    !isSafeCents(foodSubtotalCents) ||
    !isSafeCents(restaurantCommissionCents) ||
    !isSafeCents(deliveryFeeCents) ||
    !isSafeCents(smallOrderFeeCents) ||
    !isSafeCents(restaurantBankFeeCents)
  ) {
    return { ok: false, error: BREAKDOWN_FAILED_ERROR };
  }

  // 1. Доставка водителем Direct, платёж принял Direct → Direct должен
  //    ресторану еду за вычетом комиссии и банковской доли ресторана.
  if (
    row.deliveryMode === "PLATFORM_DRIVER" &&
    row.direction === "DIRECT_OWES_RESTAURANT" &&
    row.accountingType === "RESTAURANT_PAYOUT"
  ) {
    const afterCommission = subtractChecked(
      foodSubtotalCents,
      restaurantCommissionCents,
    );
    const expected = subtractChecked(afterCommission, restaurantBankFeeCents);
    if (expected === null || expected !== row.amountCents) {
      return { ok: false, error: BREAKDOWN_FAILED_ERROR };
    }
    const parts: BreakdownContribution[] = [
      contribution("FOOD_PAYOUT_BASE", "ADD", foodSubtotalCents, row),
      contribution(
        "COMMISSION_DEDUCTION",
        "SUBTRACT",
        restaurantCommissionCents,
        row,
      ),
      contribution(
        "RESTAURANT_BANK_FEE_DEDUCTION",
        "SUBTRACT",
        restaurantBankFeeCents,
        row,
      ),
    ];
    // Доплата за маленький заказ осталась у Direct — она НЕ уменьшает выплату.
    if (smallOrderFeeCents > 0) {
      parts.push(
        contribution(
          "SMALL_ORDER_FEE_RETAINED_BY_DIRECT",
          "INFO_ONLY",
          smallOrderFeeCents,
          row,
        ),
      );
    }
    // Стоимость доставки предназначена водителю Direct.
    if (deliveryFeeCents > 0) {
      parts.push(
        contribution(
          "DIRECT_DRIVER_DELIVERY_INFO",
          "INFO_ONLY",
          deliveryFeeCents,
          row,
        ),
      );
    }
    return { ok: true, parts };
  }

  // 2. Доставка водителем Direct, платёж принял ресторан → перечисление:
  //    комиссия + стоимость доставки водителю + доплата за маленький заказ.
  if (
    row.deliveryMode === "PLATFORM_DRIVER" &&
    row.direction === "RESTAURANT_OWES_DIRECT" &&
    row.accountingType === "RESTAURANT_REMITTANCE"
  ) {
    const withDelivery = addChecked(restaurantCommissionCents, deliveryFeeCents);
    const expected = addChecked(withDelivery, smallOrderFeeCents);
    if (expected === null || expected !== row.amountCents) {
      return { ok: false, error: BREAKDOWN_FAILED_ERROR };
    }
    const parts: BreakdownContribution[] = [
      contribution(
        "DIRECT_DELIVERY_COMMISSION",
        "ADD",
        restaurantCommissionCents,
        row,
      ),
    ];
    if (deliveryFeeCents > 0) {
      parts.push(
        contribution(
          "DIRECT_DRIVER_DELIVERY_TRANSIT",
          "ADD",
          deliveryFeeCents,
          row,
        ),
      );
    }
    // Доплата за маленький заказ — ОТДЕЛЬНАЯ видимая строка, не часть комиссии.
    if (smallOrderFeeCents > 0) {
      parts.push(
        contribution("SMALL_ORDER_FEE", "ADD", smallOrderFeeCents, row),
      );
    }
    if (restaurantBankFeeCents > 0) {
      parts.push(
        contribution("BANK_FEE_INFO", "INFO_ONLY", restaurantBankFeeCents, row),
      );
    }
    return { ok: true, parts };
  }

  // 3. Собственная доставка ресторана → в долг входит только комиссия с еды.
  if (
    row.deliveryMode === "RESTAURANT_DELIVERY" &&
    row.direction === "RESTAURANT_OWES_DIRECT" &&
    row.accountingType === "PLATFORM_COMMISSION"
  ) {
    // Доплата за маленький заказ к собственной доставке не применяется:
    // ненулевое значение — повреждённые данные, а не редкий случай.
    if (smallOrderFeeCents !== 0) {
      return { ok: false, error: BREAKDOWN_FAILED_ERROR };
    }
    if (restaurantCommissionCents !== row.amountCents) {
      return { ok: false, error: BREAKDOWN_FAILED_ERROR };
    }
    const parts: BreakdownContribution[] = [
      contribution(
        "RESTAURANT_DELIVERY_COMMISSION",
        "ADD",
        restaurantCommissionCents,
        row,
      ),
    ];
    if (deliveryFeeCents > 0) {
      parts.push(
        contribution(
          "RESTAURANT_DELIVERY_RETAINED",
          "INFO_ONLY",
          deliveryFeeCents,
          row,
        ),
      );
    }
    return { ok: true, parts };
  }

  // 4. Самовывоз → комиссия самовывоза, отдельная категория.
  if (
    row.deliveryMode === "PICKUP" &&
    row.direction === "RESTAURANT_OWES_DIRECT" &&
    row.accountingType === "PLATFORM_COMMISSION"
  ) {
    if (restaurantCommissionCents !== row.amountCents) {
      return { ok: false, error: BREAKDOWN_FAILED_ERROR };
    }
    const parts: BreakdownContribution[] = [
      contribution("PICKUP_COMMISSION", "ADD", restaurantCommissionCents, row),
    ];
    // Банковская комиссия карты — отдельная сторона, долг она не увеличивает.
    if (restaurantBankFeeCents > 0) {
      parts.push(
        contribution("BANK_FEE_INFO", "INFO_ONLY", restaurantBankFeeCents, row),
      );
    }
    return { ok: true, parts };
  }

  // Любая другая комбинация сохранённых признаков — несогласованные данные.
  return { ok: false, error: BREAKDOWN_FAILED_ERROR };
}

/** Стабильный порядок заказов внутри категории: старые сверху. */
function compareOrders(
  a: RestaurantBalanceBreakdownOrder,
  b: RestaurantBalanceBreakdownOrder,
): number {
  const ta = Date.parse(a.recognizedAt);
  const tb = Date.parse(b.recognizedAt);
  const aValid = !Number.isNaN(ta);
  const bValid = !Number.isNaN(tb);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && bValid && ta !== tb) return ta - tb;
  if (a.publicNumber !== b.publicNumber) {
    return a.publicNumber < b.publicNumber ? -1 : 1;
  }
  return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
}

/** Агрегация одинаковых категорий в фиксированном бизнес-порядке. */
function aggregate(
  contributions: readonly BreakdownContribution[],
): RestaurantBalanceBreakdownLine[] | null {
  const byCode = new Map<
    RestaurantBalanceBreakdownCode,
    RestaurantBalanceBreakdownLine
  >();
  for (const part of contributions) {
    if (!isSafeCents(part.amountCents)) return null;
    const existing = byCode.get(part.code);
    if (!existing) {
      byCode.set(part.code, {
        code: part.code,
        effect: part.effect,
        amountCents: part.amountCents,
        orderCount: 1,
        orders: [part.order],
      });
      continue;
    }
    const sum = addChecked(existing.amountCents, part.amountCents);
    if (sum === null) return null;
    existing.amountCents = sum;
    existing.orderCount += 1;
    existing.orders.push(part.order);
  }
  const lines: RestaurantBalanceBreakdownLine[] = [];
  for (const code of CODE_ORDER) {
    const line = byCode.get(code);
    // Нулевые строки в расшифровке не показываются.
    if (!line || line.amountCents === 0) continue;
    line.orders.sort(compareOrders);
    lines.push(line);
  }
  return lines;
}

/** Итог секции: сумма ADD минус сумма SUBTRACT, только checked-арифметикой. */
function sectionTotal(
  lines: readonly RestaurantBalanceBreakdownLine[],
): number | null {
  let added = 0;
  let subtracted = 0;
  for (const line of lines) {
    if (line.effect === "ADD") {
      const next = addChecked(added, line.amountCents);
      if (next === null) return null;
      added = next;
    } else if (line.effect === "SUBTRACT") {
      const next = addChecked(subtracted, line.amountCents);
      if (next === null) return null;
      subtracted = next;
    }
  }
  return subtractChecked(added, subtracted);
}

/**
 * Расшифровка текущей открытой позиции ресторана.
 *
 * Сверка обязательна: сумма компонентов каждой стороны обязана в точности
 * совпасть с соответствующей суммой канонического finance read-model, иначе
 * расшифровка отклоняется целиком. Информационные строки в сверке не
 * участвуют — они ничего не должны и никому не начисляются.
 */
export function buildRestaurantOpenBalanceBreakdown(
  state: PrototypeState,
  restaurantId: string,
): RestaurantBalanceBreakdownResult {
  const financeResult = buildRestaurantFinanceReadModel(state, restaurantId);
  if (!financeResult.ok) {
    return fail(financeResult.error);
  }
  const model = financeResult.model;

  const restaurantOwes: BreakdownContribution[] = [];
  const directOwes: BreakdownContribution[] = [];
  const informational: BreakdownContribution[] = [];

  for (const row of model.openOrders) {
    const explained = explainRow(row);
    if (!explained.ok) {
      return fail(explained.error);
    }
    for (const part of explained.parts) {
      if (part.effect === "INFO_ONLY") {
        informational.push(part);
      } else if (row.direction === "RESTAURANT_OWES_DIRECT") {
        restaurantOwes.push(part);
      } else {
        directOwes.push(part);
      }
    }
  }

  const restaurantLines = aggregate(restaurantOwes);
  const directLines = aggregate(directOwes);
  const infoLines = aggregate(informational);
  if (restaurantLines === null || directLines === null || infoLines === null) {
    return fail(BREAKDOWN_FAILED_ERROR);
  }

  const restaurantTotal = sectionTotal(restaurantLines);
  const directTotal = sectionTotal(directLines);
  if (restaurantTotal === null || directTotal === null) {
    return fail(BREAKDOWN_FAILED_ERROR);
  }
  // Сверка с каноническим балансом: расшифровка обязана объяснить ровно ту
  // сумму, которую показывает read-model, — ни больше, ни меньше.
  if (
    restaurantTotal !== model.restaurantOwesDirectCents ||
    directTotal !== model.directOwesRestaurantCents
  ) {
    return fail(BREAKDOWN_FAILED_ERROR);
  }

  return {
    ok: true,
    breakdown: {
      restaurantId,
      currencyCode: "USD",
      restaurantOwesDirect: {
        totalCents: restaurantTotal,
        lines: restaurantLines,
      },
      directOwesRestaurant: { totalCents: directTotal, lines: directLines },
      informationalLines: infoLines,
      // Направление и итог берутся у канонической модели: второй формулы нет.
      netDirection: model.netDirection,
      netAmountCents: model.netAmountCents,
      reviewRequiredOrderCount: model.reviewRequiredOrderCount,
      pendingPaymentChannelOrderCount: model.pendingPaymentChannelOrderCount,
    },
  };
}

// --- Объяснение модели работы конкретного ресторана ---------------------------

export interface RestaurantSettlementModelPresentation {
  title: string;
  notes: string[];
}

/**
 * Как устроен расчёт именно у этого ресторана. Определяется его КОНФИГУРАЦИЕЙ
 * (способы получения заказа, самовывоз, текущие ставки), а не идентификатором.
 * Текущие ставки показываются только как справка о текущих условиях: уже
 * завершённые заказы рассчитаны по сохранённым условиям каждого заказа.
 */
export function describeRestaurantSettlementModel(
  restaurant: Restaurant,
): RestaurantSettlementModelPresentation {
  const modes = restaurant.deliveryModes ?? [];
  const hasDirectDelivery = modes.includes("PLATFORM_DRIVER");
  const hasOwnDelivery = modes.includes("RESTAURANT_DELIVERY");
  const notes: string[] = [];

  if (hasDirectDelivery) {
    notes.push(
      "При доставке Direct деньги за заказ могут собирать Direct или ресторан — от этого зависит направление расчёта.",
    );
    notes.push("Стоимость доставки предназначена водителю Direct.");
    notes.push("Доплата за маленький заказ относится к Direct.");
  }
  if (hasOwnDelivery) {
    notes.push("Ресторан получает оплату клиента и стоимость доставки.");
    notes.push("В расчёт с Direct входит комиссия с еды.");
    notes.push(
      "Доплата за маленький заказ к собственной доставке не применяется.",
    );
  }
  if (restaurant.pickupEnabled) {
    notes.push(
      "При самовывозе ресторан принимает оплату и перечисляет Direct комиссию.",
    );
  }

  notes.push(
    `Текущие условия: доставка ${(restaurant.commissionRateBps / 100).toFixed(0)}%, самовывоз ${(restaurant.pickupCommissionRateBps / 100).toFixed(0)}%.`,
  );
  notes.push(
    "Это текущие условия. Уже завершённые заказы рассчитаны по сохранённым условиям каждого заказа.",
  );

  const title =
    hasDirectDelivery && hasOwnDelivery
      ? "Доставка Direct и собственная доставка"
      : hasOwnDelivery
        ? "Собственная доставка ресторана"
        : hasDirectDelivery
          ? "Доставка Direct"
          : "Самовывоз";

  return { title, notes };
}

/** Русские подписи категорий (сырой enum наружу не выводится). */
export const BREAKDOWN_CODE_LABELS: Record<
  RestaurantBalanceBreakdownCode,
  string
> = {
  DIRECT_DELIVERY_COMMISSION: "Комиссия Direct за доставку водителем Direct",
  RESTAURANT_DELIVERY_COMMISSION: "Комиссия Direct за доставку ресторана",
  PICKUP_COMMISSION: "Комиссия Direct за самовывоз",
  SMALL_ORDER_FEE: "Доплаты за маленькие заказы",
  DIRECT_DRIVER_DELIVERY_TRANSIT: "Доставка водителям Direct",
  FOOD_PAYOUT_BASE: "Стоимость еды после скидок",
  COMMISSION_DEDUCTION: "Комиссия Direct",
  RESTAURANT_BANK_FEE_DEDUCTION: "Банковская комиссия ресторана",
  DIRECT_DRIVER_DELIVERY_INFO: "Доставка предназначена водителям Direct",
  RESTAURANT_DELIVERY_RETAINED: "Собственная доставка остаётся ресторану",
  SMALL_ORDER_FEE_RETAINED_BY_DIRECT:
    "Доплаты за маленькие заказы уже удержаны Direct",
  BANK_FEE_INFO: "Банковская комиссия ресторана (не входит в расчёт)",
  LEGACY_UNCLASSIFIED: "Архивное обязательство без детализации",
};
