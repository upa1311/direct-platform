import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  computeCashTenderView,
  intentForChangeFromText,
  isCashTenderIntentValidForTotal,
  tenderCentsToText,
} from "./cash-tender-checkout-view.ts";
import { getDriverCashOfferDisclosureView } from "../../prototype/selectors.ts";
import type { CashTenderIntent, Order } from "../../prototype/models.ts";

/**
 * Corrective coverage for `fix: synchronize cash tender disclosure`.
 * Blocker 1: checkout-раскрытие всегда отражает authoritative cart intent
 * (чистый computeCashTenderView / isCashTenderIntentValidForTotal). Blocker 2:
 * повреждённый наличный заказ классифицируется REVIEW_REQUIRED, а не
 * NOT_APPLICABLE. Поведенческие тесты не опираются только на source-string.
 */

const TOTAL = 1600;

// --- Blocker 1: checkout state synchronization (1–10) -------------------------

test("1: persisted EXACT → корректный checkout view", () => {
  const view = computeCashTenderView({ mode: "EXACT" }, null, TOTAL);
  assert.equal(view.selectedMode, "EXACT");
  assert.equal(view.showChangeInput, false);
  assert.equal(view.changeAmountText, "");
  assert.equal(view.error, null);
  assert.equal(view.intentValidForTotal, true);
});

test("2: persisted CHANGE_FROM → input содержит фактический tender", () => {
  const view = computeCashTenderView(
    { mode: "CHANGE_FROM", tenderCents: 2000 },
    null,
    TOTAL,
  );
  assert.equal(view.selectedMode, "CHANGE_FROM");
  assert.equal(view.changeAmountText, "20.00");
  assert.equal(view.previewChangeCents, 400);
  assert.equal(view.intentValidForTotal, true);
});

test("3: reload не создаёт скрытый tender с пустым обязательным input", () => {
  const view = computeCashTenderView(
    { mode: "CHANGE_FROM", tenderCents: 2000 },
    null,
    TOTAL,
  );
  // Валидный CHANGE_FROM intent НИКОГДА не отображается с пустым полем.
  assert.notEqual(view.changeAmountText, "");
  assert.equal(view.showChangeInput, true);
});

test("4: CASH→ONLINE→CASH — очищенный intent даёт пустой выбор", () => {
  // Домен очищает intent при уходе с CASH; при возврате intent = null.
  const view = computeCashTenderView(null, null, TOTAL);
  assert.equal(view.selectedMode, null);
  assert.equal(view.showChangeInput, false);
  assert.equal(view.intentValidForTotal, false);
});

test("5: внешний intent null очищает UI", () => {
  const view = computeCashTenderView(null, null, TOTAL);
  assert.equal(view.selectedMode, null);
  assert.equal(view.changeAmountText, "");
});

test("6: внешний CHANGE_FROM обновляет mode и amount", () => {
  const view = computeCashTenderView(
    { mode: "CHANGE_FROM", tenderCents: 2500 },
    null,
    TOTAL,
  );
  assert.equal(view.selectedMode, "CHANGE_FROM");
  assert.equal(view.changeAmountText, "25.00");
});

test("7: UI и submitted intent используют одну сумму (round-trip)", () => {
  const intent: CashTenderIntent = { mode: "CHANGE_FROM", tenderCents: 2000 };
  const view = computeCashTenderView(intent, null, TOTAL);
  // Показанный текст, разобранный обратно, даёт тот же tender, что и intent.
  assert.deepEqual(
    intentForChangeFromText(view.changeAmountText, TOTAL),
    intent,
  );
});

test("8: cart total вырос выше tender → submit disabled немедленно", () => {
  const intent: CashTenderIntent = { mode: "CHANGE_FROM", tenderCents: 2000 };
  const grownTotal = 2500;
  assert.equal(isCashTenderIntentValidForTotal(intent, grownTotal), false);
  const view = computeCashTenderView(intent, null, grownTotal);
  assert.notEqual(view.error, null);
  assert.equal(view.intentValidForTotal, false);
});

test("9: EXACT после изменения total остаётся валидным для нового итога", () => {
  assert.equal(isCashTenderIntentValidForTotal({ mode: "EXACT" }, 2500), true);
  assert.equal(isCashTenderIntentValidForTotal({ mode: "EXACT" }, 999), true);
  // Некорректный итог всё равно fail-closed.
  assert.equal(isCashTenderIntentValidForTotal({ mode: "EXACT" }, null), false);
  assert.equal(isCashTenderIntentValidForTotal({ mode: "EXACT" }, 0), false);
});

test("10: failed intent mutation не показывает ложный saved state", () => {
  // При провале сохранения authoritative intent не меняется (остаётся null);
  // submit-гейт и «сохранённый» вид зависят только от него.
  assert.equal(isCashTenderIntentValidForTotal(null, TOTAL), false);
  assert.equal(computeCashTenderView(null, null, TOTAL).selectedMode, null);
  // Сохранение намерения идёт через общий mutation-ack/error path.
  const page = readFileSync("src/app/client/cart/page.tsx", "utf8");
  assert.ok(page.includes("runCartMutation(() => setCashTenderIntentAck"));
});

test("draft: активный ввод невалидной суммы держит CHANGE_FROM выбранным", () => {
  // Пользователь выбрал «нужна сдача» и вводит незаконченную сумму: radio не
  // слетает, ошибка показана, intent не сохраняется (submit заблокирован).
  const view = computeCashTenderView(
    null,
    { activeChangeFromText: "5" },
    TOTAL,
  );
  assert.equal(view.selectedMode, "CHANGE_FROM");
  assert.equal(view.changeAmountText, "5");
  assert.notEqual(view.error, null);
  assert.equal(view.intentValidForTotal, false);
});

test("tenderCentsToText форматирует целые центы в доллары", () => {
  assert.equal(tenderCentsToText(2000), "20.00");
  assert.equal(tenderCentsToText(2050), "20.50");
});

// --- Blocker 2: disclosure classification (11–18) ----------------------------

const CASH = {
  currencyCode: "USD" as const,
  customerTotalCents: 1000,
  restaurantPayoutBeforeBankFeeCents: 600,
  driverPayoutCents: 300,
  platformGrossRevenueCents: 100,
};
const CASH_SNAPSHOT = {
  customerCollectionCents: 1000,
  restaurantHandoffCents: 700,
  driverEarningCents: 300,
  restaurantOwesDirectCents: 100,
};
const EXACT_TENDER = { mode: "EXACT" as const, tenderCents: 1000, changeDueCents: 0 };
const CHANGE_TENDER = {
  mode: "CHANGE_FROM" as const,
  tenderCents: 1500,
  changeDueCents: 500,
};

function order(over: {
  deliveryMode?: Order["deliveryMode"];
  paymentMethod?: Order["paymentMethod"];
  snapshot?: unknown;
  tender?: unknown;
}): Order {
  return {
    deliveryMode: over.deliveryMode ?? "PLATFORM_DRIVER",
    paymentMethod: over.paymentMethod ?? "CASH",
    financials: {
      ...CASH,
      platformDriverCash:
        over.snapshot === undefined ? CASH_SNAPSHOT : over.snapshot,
      platformDriverCashTender:
        over.tender === undefined ? EXACT_TENDER : over.tender,
    },
  } as unknown as Order;
}

test("11: non-CASH заказ → NOT_APPLICABLE", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(order({ paymentMethod: "ONLINE" })).status,
    "NOT_APPLICABLE",
  );
  assert.equal(
    getDriverCashOfferDisclosureView(order({ deliveryMode: "PICKUP" })).status,
    "NOT_APPLICABLE",
  );
});

test("12: CASH без основного snapshot → REVIEW_REQUIRED", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(order({ snapshot: null })).status,
    "REVIEW_REQUIRED",
  );
});

test("13: CASH с повреждённым основным snapshot → REVIEW_REQUIRED", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(
      order({ snapshot: { ...CASH_SNAPSHOT, restaurantHandoffCents: 599 } }),
    ).status,
    "REVIEW_REQUIRED",
  );
});

test("14: CASH без tender snapshot → REVIEW_REQUIRED", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(order({ tender: null })).status,
    "REVIEW_REQUIRED",
  );
});

test("15: CASH с повреждённым tender → REVIEW_REQUIRED", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(
      order({ tender: { mode: "CHANGE_FROM", tenderCents: 1500, changeDueCents: 1 } }),
    ).status,
    "REVIEW_REQUIRED",
  );
  assert.equal(
    getDriverCashOfferDisclosureView(
      order({ tender: { mode: "WHAT", tenderCents: 1500, changeDueCents: 500 } }),
    ).status,
    "REVIEW_REQUIRED",
  );
});

test("16: валидные EXACT / CHANGE_FROM → READY", () => {
  assert.equal(getDriverCashOfferDisclosureView(order({})).status, "READY");
  const cf = getDriverCashOfferDisclosureView(order({ tender: CHANGE_TENDER }));
  assert.equal(cf.status, "READY");
  if (cf.status === "READY") {
    assert.equal(cf.changeRequired, true);
    assert.equal(cf.changeDueCents, 500);
  }
});

const OFFER_CARD = readFileSync(
  "src/components/driver/driver-offer-card.tsx",
  "utf8",
);
const WORKSPACE = readFileSync(
  "src/components/driver/driver-workspace.tsx",
  "utf8",
);

test("17: REVIEW_REQUIRED карточка не вызывает accept mutation", () => {
  // Классификация повреждённого наличного заказа — REVIEW_REQUIRED (поведенческое).
  assert.equal(
    getDriverCashOfferDisclosureView(order({ tender: null })).status,
    "REVIEW_REQUIRED",
  );
  // Кнопка принятия заблокирована для REVIEW_REQUIRED, и handleAccept не
  // проводит такой заказ через online one-tap (accept только для READY).
  assert.ok(
    OFFER_CARD.includes('cashDisclosure.status === "REVIEW_REQUIRED"'),
  );
  assert.ok(WORKSPACE.includes('disclosure.status === "READY"'));
  assert.ok(WORKSPACE.includes('disclosure.status === "NOT_APPLICABLE"'));
});

test("18: CASH REVIEW_REQUIRED не подписывается как «Оплата онлайн»", () => {
  // Раскрытие остаётся наличным (status !== NOT_APPLICABLE) → карточка покажет
  // «Оплата наличными», а не «онлайн»; ярлык управляется этим флагом.
  assert.notEqual(
    getDriverCashOfferDisclosureView(order({ tender: null })).status,
    "NOT_APPLICABLE",
  );
  assert.ok(
    OFFER_CARD.includes('cashDisclosure.status !== "NOT_APPLICABLE"'),
  );
  assert.ok(OFFER_CARD.includes("Оплата наличными"));
});

test("19: валидный наличный заказ остаётся READY (регрессии eligibility не задеты)", () => {
  assert.equal(getDriverCashOfferDisclosureView(order({})).status, "READY");
});

test("20: audit report не изменён (маркеры на месте)", () => {
  const audit = readFileSync("docs/driver-v1-final-audit.md", "utf8");
  assert.ok(audit.includes("SHIP-OK: NO"));
  assert.ok(audit.includes("F-5"));
});
