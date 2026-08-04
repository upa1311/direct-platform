import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  cashTenderIntentKey,
  isCashTenderIntentValidForTotal,
  tenderCentsToText,
} from "./cash-tender-checkout-view.ts";
import { getDriverCashOfferDisclosureView } from "../../prototype/selectors.ts";
import type { Order } from "../../prototype/models.ts";

/**
 * Общие примитивы наличной сдачи + классификация раскрытия водителю (Blocker 2).
 * Поведенческие проверки, не source-string.
 */

// --- shared helpers -----------------------------------------------------------

test("tenderCentsToText форматирует целые центы в доллары", () => {
  assert.equal(tenderCentsToText(2000), "20.00");
  assert.equal(tenderCentsToText(2050), "20.50");
});

test("cashTenderIntentKey — отпечаток intent", () => {
  assert.equal(cashTenderIntentKey(null), "NULL");
  assert.equal(cashTenderIntentKey({ mode: "EXACT" }), "EXACT");
  assert.equal(
    cashTenderIntentKey({ mode: "CHANGE_FROM", tenderCents: 2500 }),
    "CHANGE_FROM:2500",
  );
  // Разные суммы различимы.
  assert.notEqual(
    cashTenderIntentKey({ mode: "CHANGE_FROM", tenderCents: 2000 }),
    cashTenderIntentKey({ mode: "CHANGE_FROM", tenderCents: 2500 }),
  );
});

test("isCashTenderIntentValidForTotal: EXACT/CHANGE_FROM/итог", () => {
  assert.equal(isCashTenderIntentValidForTotal({ mode: "EXACT" }, 2500), true);
  assert.equal(isCashTenderIntentValidForTotal({ mode: "EXACT" }, null), false);
  assert.equal(isCashTenderIntentValidForTotal({ mode: "EXACT" }, 0), false);
  assert.equal(
    isCashTenderIntentValidForTotal({ mode: "CHANGE_FROM", tenderCents: 2000 }, 1600),
    true,
  );
  // Устаревший tender, не покрывающий вырос­ший итог → невалиден.
  assert.equal(
    isCashTenderIntentValidForTotal({ mode: "CHANGE_FROM", tenderCents: 2000 }, 2500),
    false,
  );
  assert.equal(
    isCashTenderIntentValidForTotal({ mode: "CHANGE_FROM", tenderCents: 2000 }, 2000),
    false,
  );
  assert.equal(isCashTenderIntentValidForTotal(null, 1600), false);
});

// --- Blocker 2: disclosure classification (audit item 21) --------------------

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

test("disclosure-11: non-CASH заказ → NOT_APPLICABLE", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(order({ paymentMethod: "ONLINE" })).status,
    "NOT_APPLICABLE",
  );
  assert.equal(
    getDriverCashOfferDisclosureView(order({ deliveryMode: "PICKUP" })).status,
    "NOT_APPLICABLE",
  );
});

test("disclosure-12: CASH без основного snapshot → REVIEW_REQUIRED", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(order({ snapshot: null })).status,
    "REVIEW_REQUIRED",
  );
});

test("disclosure-13: CASH с повреждённым основным snapshot → REVIEW_REQUIRED", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(
      order({ snapshot: { ...CASH_SNAPSHOT, restaurantHandoffCents: 599 } }),
    ).status,
    "REVIEW_REQUIRED",
  );
});

test("disclosure-14: CASH без tender snapshot → REVIEW_REQUIRED", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(order({ tender: null })).status,
    "REVIEW_REQUIRED",
  );
});

test("disclosure-15: CASH с повреждённым tender → REVIEW_REQUIRED", () => {
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

test("disclosure-16: валидные EXACT / CHANGE_FROM → READY", () => {
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

test("disclosure-17: REVIEW_REQUIRED карточка не проводит accept", () => {
  assert.equal(
    getDriverCashOfferDisclosureView(order({ tender: null })).status,
    "REVIEW_REQUIRED",
  );
  assert.ok(OFFER_CARD.includes('cashDisclosure.status === "REVIEW_REQUIRED"'));
  assert.ok(WORKSPACE.includes('disclosure.status === "READY"'));
  assert.ok(WORKSPACE.includes('disclosure.status === "NOT_APPLICABLE"'));
});

test("disclosure-18: CASH REVIEW_REQUIRED не подписывается как «Оплата онлайн»", () => {
  assert.notEqual(
    getDriverCashOfferDisclosureView(order({ tender: null })).status,
    "NOT_APPLICABLE",
  );
  assert.ok(OFFER_CARD.includes('cashDisclosure.status !== "NOT_APPLICABLE"'));
  assert.ok(OFFER_CARD.includes("Оплата наличными"));
});

test("audit report сохраняет принятый итог targeted F-5 re-audit", () => {
  const audit = readFileSync("docs/driver-v1-final-audit.md", "utf8");
  assert.ok(audit.includes("SHIP-OK: YES"));
  assert.ok(audit.includes("F-5 status:** RESOLVED"));
});
