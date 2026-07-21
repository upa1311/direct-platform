import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  describeFinanceNet,
  FINANCE_CHANNEL_LABELS,
  FINANCE_DATA_STATUS_LABELS,
  FINANCE_DIRECTION_LABELS,
} from "./overview-presentation.ts";

/**
 * Главный канонический обзор «Расчёты с Direct»: чистая презентация и
 * контракты страницы (JSX в node:test не исполняется — разметка проверяется
 * по исходнику, как в остальных страничных тестах проекта).
 */

const PAGE = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

// --- describeFinanceNet ---------------------------------------------------------

test("describeFinanceNet: тексты и сумма берутся из готового направления", () => {
  const payable = describeFinanceNet({
    netDirection: "DIRECT_OWES_RESTAURANT",
    netAmountCents: 4300,
  });
  assert.equal(payable.title, "Direct должен ресторану");
  assert.equal(payable.amountCents, 4300);
  assert.equal(payable.note, "Итог после взаимозачёта открытых заказов");

  const receivable = describeFinanceNet({
    netDirection: "RESTAURANT_OWES_DIRECT",
    netAmountCents: 800,
  });
  assert.equal(receivable.title, "Ресторан должен Direct");
  assert.equal(receivable.amountCents, 800);

  const balanced = describeFinanceNet({
    netDirection: "BALANCED",
    netAmountCents: 0,
  });
  assert.equal(balanced.title, "Взаиморасчёты закрыты");
  assert.equal(balanced.amountCents, 0);
  assert.equal(balanced.note, "Открытых обязательств сейчас нет");
});

test("подписи направлений, каналов и статусов данных", () => {
  assert.equal(FINANCE_DIRECTION_LABELS.DIRECT_OWES_RESTAURANT, "Direct должен вам");
  assert.equal(FINANCE_DIRECTION_LABELS.RESTAURANT_OWES_DIRECT, "Вы должны Direct");
  // v13: онлайн-карта различается по получателю платежа.
  assert.equal(
    FINANCE_CHANNEL_LABELS.ONLINE_CARD,
    "Онлайн-карта · получает Direct",
  );
  assert.equal(
    FINANCE_CHANNEL_LABELS.ONLINE_CARD_TO_RESTAURANT,
    "Онлайн-карта · получает ресторан",
  );
  assert.equal(FINANCE_CHANNEL_LABELS.LEGACY_UNKNOWN, "Архивные данные");
  assert.equal(FINANCE_DATA_STATUS_LABELS.LEGACY, "Архивные данные");
  assert.equal(FINANCE_DATA_STATUS_LABELS.REVIEW_REQUIRED, "Требует проверки");
});

// --- Контракты страницы ---------------------------------------------------------

test("страница по умолчанию открывает OVERVIEW и использует канонический read-model", () => {
  assert.ok(PAGE.includes('useState<SettlementView>("OVERVIEW")'));
  assert.ok(PAGE.includes("buildRestaurantFinanceReadModel(state, selectedRestaurantId)"));
  // Главная сумма и gross-разбивка — готовые значения model, без арифметики.
  assert.ok(PAGE.includes("money(net.amountCents)"));
  assert.ok(PAGE.includes("money(model.directOwesRestaurantCents)"));
  assert.ok(PAGE.includes("money(model.restaurantOwesDirectCents)"));
  assert.ok(!PAGE.includes("directOwesRestaurantCents -"));
  assert.ok(!PAGE.includes("restaurantOwesDirectCents -"));
});

test("ошибка read-model — fail-closed без fallback и без правдоподобного баланса", () => {
  assert.ok(PAGE.includes("Данные требуют проверки"));
  assert.ok(PAGE.includes("Сейчас невозможно безопасно рассчитать баланс ресторана."));
  // Старый отчёт рассчитывается только для подробных режимов, а не для OVERVIEW.
  assert.ok(PAGE.includes('(view !== "ORDERS" && view !== "DAILY")'));
  assert.ok(PAGE.includes('view !== "OBLIGATIONS"'));
});

test("пустое состояние, предупреждения и переходы к отчётам", () => {
  assert.ok(PAGE.includes("Открытых заказов для расчёта нет"));
  assert.ok(PAGE.includes("Есть заказы, требующие проверки данных"));
  assert.ok(PAGE.includes("Есть самовывозы, ожидающие подтверждения способа оплаты"));
  assert.ok(PAGE.includes(">Все заказы<") || PAGE.includes("Все заказы\n"));
  assert.ok(PAGE.includes("История расчётов"));
  assert.ok(PAGE.includes("← К расчётам"));
  assert.ok(PAGE.includes('setView("ORDERS")'));
  assert.ok(PAGE.includes('setView("STATEMENT")'));
  assert.ok(PAGE.includes('setView("OVERVIEW")'));
});

test("старые режимы, CSV и печать сохранены", () => {
  for (const label of ["По заказам", "По дням", "Обязательства", "Выписка"]) {
    assert.ok(PAGE.includes(label), label);
  }
  assert.ok(PAGE.includes("Скачать CSV"));
  assert.ok(PAGE.includes("Печать / PDF"));
});
