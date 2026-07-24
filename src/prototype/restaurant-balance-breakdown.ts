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
    // v24: наличные водителю Direct. Ресторан получил наличные от водителя и
    // должен Direct ТОЛЬКО комиссию + small-order fee: стоимость доставки
    // водитель уже удержал из наличных, поэтому она INFO_ONLY, не часть долга.
    const isCashToDriver = row.paymentChannel === "CASH_TO_PLATFORM_DRIVER";
    const debtBase = isCashToDriver
      ? restaurantCommissionCents
      : addChecked(restaurantCommissionCents, deliveryFeeCents);
    const expected = addChecked(debtBase, smallOrderFeeCents);
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
      // ONLINE_CARD_TO_RESTAURANT: доставка транзитом в долге (ADD).
      // CASH_TO_PLATFORM_DRIVER: доставка уже у водителя (INFO_ONLY).
      parts.push(
        contribution(
          isCashToDriver
            ? "DIRECT_DRIVER_DELIVERY_INFO"
            : "DIRECT_DRIVER_DELIVERY_TRANSIT",
          isCashToDriver ? "INFO_ONLY" : "ADD",
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
 * Ставка комиссии из базисных пунктов в человекочитаемый процент БЕЗ
 * округления и без лишних нулей: 700 → «7%», 1250 → «12.5%», 1 → «0.01%».
 *
 * Форматирование целочисленное (целая часть и остаток bps), поэтому ошибок
 * плавающей арифметики не возникает. Повреждённое runtime-значение не
 * превращается в выдуманную ставку и не бросает исключение — возвращается
 * null, и строка про ставку просто не показывается.
 */
export function formatCommissionRateBps(rateBps: number): string | null {
  if (
    typeof rateBps !== "number" ||
    !Number.isFinite(rateBps) ||
    !Number.isInteger(rateBps) ||
    !Number.isSafeInteger(rateBps) ||
    rateBps < 0
  ) {
    return null;
  }
  const whole = Math.floor(rateBps / 100);
  const fraction = String(rateBps % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}%` : `${whole}%`;
}

/**
 * Как устроен расчёт именно у этого ресторана СЕЙЧАС.
 *
 * Определяется только его конфигурацией: способы получения заказа, режим сбора
 * платежей, самовывоз и текущие ставки — никаких идентификаторов ресторанов.
 * Получатель денег при доставке водителем Direct уже определён полем
 * financialCollectionMode, поэтому расплывчатое «деньги могут собирать Direct
 * или ресторан» не показывается: объяснение однозначное.
 *
 * Текущая конфигурация служит ТОЛЬКО объяснением сегодняшней работы: она не
 * пересчитывает расшифровку, исторические заказы, обязательства и расчёты.
 */
export function describeRestaurantSettlementModel(
  restaurant: Restaurant,
): RestaurantSettlementModelPresentation {
  const modes = restaurant.deliveryModes ?? [];
  const hasDirectDelivery = modes.includes("PLATFORM_DRIVER");
  const hasOwnDelivery = modes.includes("RESTAURANT_DELIVERY");
  const mode = restaurant.financialCollectionMode;
  const directCollectsPayment = mode === "MIXED_COLLECTION";
  const restaurantCollectsPayment = mode === "RESTAURANT_COLLECTS_ALL";
  const notes: string[] = [];

  if (hasDirectDelivery) {
    if (directCollectsPayment) {
      notes.push(
        "При доставке водителем Direct оплату клиента принимает Direct.",
      );
      notes.push(
        "Direct перечисляет ресторану стоимость еды за вычетом комиссии Direct и банковской доли ресторана.",
      );
      notes.push("Стоимость доставки предназначена водителю Direct.");
      notes.push("Доплата за маленький заказ остаётся у Direct.");
    } else if (restaurantCollectsPayment) {
      notes.push(
        "При доставке водителем Direct оплату клиента принимает ресторан.",
      );
      notes.push(
        "После завершения заказа ресторан перечисляет Direct комиссию с еды, стоимость доставки водителю Direct и доплату за маленький заказ.",
      );
      notes.push("Стоимость доставки предназначена водителю Direct.");
      notes.push("Доплата за маленький заказ относится к Direct.");
    } else {
      // Импортированное состояние может быть повреждено: ложную схему не
      // показываем и MIXED_COLLECTION по умолчанию не подставляем.
      notes.push(
        "Текущий способ сбора оплаты для доставки Direct не определён. Требуется проверка настроек ресторана.",
      );
    }
  }
  if (hasOwnDelivery) {
    // Собственная доставка не зависит от режима сбора платежей доставки Direct.
    notes.push("При собственной доставке оплату клиента принимает ресторан.");
    notes.push("Стоимость собственной доставки остаётся ресторану.");
    notes.push("В расчёт с Direct входит комиссия с еды.");
    notes.push(
      "Доплата за маленький заказ к собственной доставке не применяется.",
    );
  }
  if (restaurant.pickupEnabled) {
    notes.push(
      "При самовывозе оплату принимает ресторан и перечисляет Direct комиссию с еды.",
    );
  }

  // Показываются только применимые ставки: неактивный режим не упоминается.
  if (hasDirectDelivery || hasOwnDelivery) {
    const deliveryRate = formatCommissionRateBps(restaurant.commissionRateBps);
    if (deliveryRate !== null) {
      notes.push(`Текущая комиссия с еды для доставки: ${deliveryRate}.`);
    }
  }
  if (restaurant.pickupEnabled) {
    const pickupRate = formatCommissionRateBps(
      restaurant.pickupCommissionRateBps,
    );
    if (pickupRate !== null) {
      notes.push(`Текущая комиссия с еды для самовывоза: ${pickupRate}.`);
    }
  }
  notes.push(
    "Это текущие условия. Уже завершённые заказы рассчитаны по сохранённым условиям каждого заказа.",
  );

  const directTitle = directCollectsPayment
    ? "Доставка Direct · оплату принимает Direct"
    : restaurantCollectsPayment
      ? "Доставка Direct · оплату принимает ресторан"
      : "Доставка Direct · способ сбора оплаты не определён";
  const title =
    hasDirectDelivery && hasOwnDelivery
      ? `${directTitle} и собственная доставка`
      : hasOwnDelivery
        ? "Собственная доставка ресторана"
        : hasDirectDelivery
          ? directTitle
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
