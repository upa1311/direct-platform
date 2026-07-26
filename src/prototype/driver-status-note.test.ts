import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import { parseStoredState } from "./prototype-store.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "./models.ts";
import type { PrototypeState } from "./models.ts";
import { updateDriverStatusNote, goDriverOnline } from "./actions.ts";

/**
 * Driver payouts v1 — split №2: добровольная заметка водителя (schema 27) и
 * пользовательский интерфейс выплат. Доменные проверки заметки + строковые
 * проверки новых UI-файлов (без рендера).
 */

const DRIVER = "driver-1";
const NOW = "2026-07-23T10:00:00.000Z";
const driverOf = (s: PrototypeState, id: string) =>
  s.drivers.find((d) => d.id === id)!;

// --- §27 driver note domain ---------------------------------------------------

test("1/2/3: схема 27, дефолтная заметка null, schema26 получает null", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 27);
  for (const d of createDefaultState().drivers) {
    assert.equal(d.statusNote, null);
    assert.equal(d.statusNoteUpdatedAt, null);
  }
  const parsed = parseStoredState(
    JSON.stringify({ ...createDefaultState(), schemaVersion: 26 }),
  );
  assert.ok(parsed);
  assert.equal(parsed.schemaVersion, 27);
  for (const d of parsed.drivers) assert.equal(d.statusNote, null);
});

test("4/9: сохраняет обрезанную заметку и статус времени; один рост ревизии", () => {
  const state = createDefaultState();
  const r = updateDriverStatusNote(state, DRIVER, "  Жду заказ  ", NOW);
  assert.equal(r.result.ok, true, r.result.error ?? "");
  assert.equal(driverOf(r.state, DRIVER).statusNote, "Жду заказ");
  assert.equal(driverOf(r.state, DRIVER).statusNoteUpdatedAt, NOW);
  assert.equal(r.state.revision, state.revision + 1);
});

test("5: пустая строка очищает оба поля", () => {
  const withNote = updateDriverStatusNote(createDefaultState(), DRIVER, "Тест", NOW).state;
  const cleared = updateDriverStatusNote(withNote, DRIVER, "   ", "2026-07-23T11:00:00.000Z");
  assert.equal(cleared.result.ok, true);
  assert.equal(driverOf(cleared.state, DRIVER).statusNote, null);
  assert.equal(driverOf(cleared.state, DRIVER).statusNoteUpdatedAt, null);
});

test("6/7/8: >120, неизвестный водитель, невалидный nowIso → fail same-state", () => {
  const state = createDefaultState();
  const long = updateDriverStatusNote(state, DRIVER, "a".repeat(121), NOW);
  assert.equal(long.result.ok, false);
  assert.equal(long.state, state);
  assert.equal(updateDriverStatusNote(state, "нет", "x", NOW).result.ok, false);
  assert.equal(updateDriverStatusNote(state, DRIVER, "x", "не-дата").result.ok, false);
  assert.equal(updateDriverStatusNote(state, DRIVER, "x", "не-дата").state, state);
});

test("10: повтор идентичной заметки — success no-op без роста ревизии", () => {
  const first = updateDriverStatusNote(createDefaultState(), DRIVER, "Одно и то же", NOW);
  const again = updateDriverStatusNote(first.state, DRIVER, "Одно и то же", "2026-07-23T12:00:00.000Z");
  assert.equal(again.result.ok, true);
  assert.equal(again.state, first.state);
  assert.equal(again.state.revision, first.state.revision);
});

test("11: заметка не меняет заказы/предложения/заработок/выплаты", () => {
  const online = goDriverOnline(createDefaultState(), DRIVER, "zone-2").state;
  const r = updateDriverStatusNote(online, DRIVER, "Заметка", NOW);
  assert.equal(r.state.orders, online.orders);
  assert.equal(r.state.driverOffers, online.driverOffers);
  assert.equal(r.state.driverEarningEntries, online.driverEarningEntries);
  assert.equal(r.state.driverPayoutBatches, online.driverPayoutBatches);
  assert.equal(r.state.driverPayoutReceiptEvents, online.driverPayoutReceiptEvents);
});

// --- источники UI (без рендера) -----------------------------------------------

const SETTLEMENTS = readFileSync("src/app/driver/settlements/page.tsx", "utf8");
const ADMIN_PAYOUTS = readFileSync("src/app/admin/driver-payouts/page.tsx", "utf8");
const WORKSPACE = readFileSync(
  "src/components/driver/driver-workspace.tsx",
  "utf8",
);
const ADMIN_NAV = readFileSync(
  "src/components/workspaces/admin-navigation.ts",
  "utf8",
);
const ADMIN_DRIVERS = readFileSync("src/app/admin/drivers/page.tsx", "utf8");

// --- §28/§29 settlements summary + payout UI ----------------------------------

test("settlements: точный новый description и метки сводки", () => {
  assert.ok(SETTLEMENTS.includes("Заработок, наличные и выплаты Direct."));
  for (const label of [
    "Заработано сегодня",
    "Заработано за месяц",
    "Получено из наличных заказов",
    "Direct должен вам",
    "Direct отправил — ждёт подтверждения",
    "Получено от Direct",
    "Завершённых доставок",
  ]) {
    assert.ok(SETTLEMENTS.includes(label), label);
  }
  assert.ok(!SETTLEMENTS.includes("К выплате Direct"));
  assert.ok(SETTLEMENTS.includes("getDriverPayoutsView"));
  assert.ok(SETTLEMENTS.includes("getDriverSettlementPeriodView"));
  assert.ok(SETTLEMENTS.includes("Europe/Chisinau"));
});

test("settlements: подтверждение получения — только authenticated driver", () => {
  assert.ok(SETTLEMENTS.includes("useAuthenticatedDriverId"));
  assert.ok(SETTLEMENTS.includes("confirmDriverPayoutReceipt"));
  assert.ok(SETTLEMENTS.includes("Да, деньги получил"));
  assert.ok(SETTLEMENTS.includes("Да, наличные получил"));
  // driverId не из URL/query.
  assert.ok(!SETTLEMENTS.includes("useSearchParams"));
  assert.ok(!SETTLEMENTS.includes("useParams"));
  // Итог недоступен → «—», а не $0.00.
  assert.ok(SETTLEMENTS.includes("Итог недоступен и требует проверки Direct"));
});

// --- §28 admin payout page ----------------------------------------------------

test("admin payouts: страница, навигация, submit-метки, без ручной суммы", () => {
  assert.ok(ADMIN_NAV.includes('label: "Выплаты водителям"'));
  assert.ok(ADMIN_NAV.includes('href: "/admin/driver-payouts"'));
  assert.ok(ADMIN_PAYOUTS.includes("getAdminDriverPayoutsView"));
  assert.ok(ADMIN_PAYOUTS.includes("createDriverPayoutBatch"));
  assert.ok(ADMIN_PAYOUTS.includes("Выплата отправлена"));
  assert.ok(ADMIN_PAYOUTS.includes("Наличные переданы водителю"));
  assert.ok(ADMIN_PAYOUTS.includes("Сегодня"));
  assert.ok(ADMIN_PAYOUTS.includes("Последние 3 дня"));
  assert.ok(ADMIN_PAYOUTS.includes("Все невыплаченные"));
  assert.ok(ADMIN_PAYOUTS.includes("Данные выплат водителя требуют проверки Direct."));
  // Домен сам считает сумму: UI не передаёт amountCents в action.
  assert.ok(!ADMIN_PAYOUTS.includes("amountCents:"));
  // Админ не подтверждает получение за водителя.
  assert.ok(!ADMIN_PAYOUTS.includes("confirmDriverPayoutReceipt"));
  assert.ok(!ADMIN_PAYOUTS.includes("adminConfirmDriverReceipt"));
});

test("admin: заметка водителя видна read-only в списке и на payout page", () => {
  assert.ok(ADMIN_DRIVERS.includes("statusNote"));
  assert.ok(ADMIN_PAYOUTS.includes("statusNote"));
  // Админ не редактирует заметку.
  assert.ok(!ADMIN_DRIVERS.includes("updateDriverStatusNote"));
  assert.ok(!ADMIN_PAYOUTS.includes("updateDriverStatusNote"));
});

// --- §30 driver header / badges / note / zones --------------------------------

test("workspace: убрана строка «Онлайн · Зона», имя с оранжевым акцентом", () => {
  assert.ok(!WORKSPACE.includes("Онлайн · "));
  assert.ok(!WORKSPACE.includes("statusZoneSummary"));
  assert.ok(WORKSPACE.includes("driverName"));
  assert.ok(WORKSPACE.includes("driverNameIcon"));
});

test("workspace: cash badge, заметка и её редактор", () => {
  assert.ok(WORKSPACE.includes("Доступны наличные заказы"));
  assert.ok(WORKSPACE.includes("Только безналичные заказы"));
  assert.ok(WORKSPACE.includes("Моя заметка"));
  assert.ok(WORKSPACE.includes("Заметка для Direct"));
  assert.ok(WORKSPACE.includes("statusNote"));
  assert.ok(WORKSPACE.includes("updateDriverStatusNote"));
  assert.ok(WORKSPACE.includes("maxLength={NOTE_MAX}"));
  assert.ok(WORKSPACE.includes("120"));
});

test("workspace: цвет зоны из registry, без ручной таблицы zone-1/zone-2", () => {
  // Цвет берётся через общий presentation helper (он и читает registry).
  assert.ok(WORKSPACE.includes("getZoneButtonPresentation"));
  const PRESENTATION = readFileSync(
    "src/lib/zones/zone-presentation.ts",
    "utf8",
  );
  assert.ok(PRESENTATION.includes("zoneColor"));
  assert.ok(PRESENTATION.includes("fromZoneId"));
  // Никакой ручной таблицы цветов по номеру зоны.
  assert.ok(!/["']zone-1["']\s*:\s*["']#/.test(WORKSPACE));
  assert.ok(!/zone-1.*(green|yellow|red)/i.test(WORKSPACE));
  assert.ok(!/["']zone-1["']\s*:\s*["']#/.test(PRESENTATION));
});
