import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDefaultState } from "../../prototype/default-state.ts";
import { PROTOTYPE_SCHEMA_VERSION } from "../../prototype/models.ts";
import { DRIVER_OFFER_DURATION_MS } from "../../prototype/driver-offers.ts";
import {
  DRIVER_SESSION_KEY,
  readAuthenticatedDriverId,
} from "./driver-session.ts";
import { DRIVER_OFFER_SOUND_KEY } from "./driver-offer-sound-logic.ts";

/**
 * Единый рабочий экран водителя на основе сессии (v18 UI). Проверяем session API
 * и вёрстку по исходникам: вход по имени/телефону, отсутствие выбора профиля,
 * навигация «Заказы / Расчёты», счётчики «Новые / В работе», один колокольчик.
 */

const PAGE = readFileSync("src/app/driver/page.tsx", "utf8");
const WORKSPACE = readFileSync(
  "src/components/driver/driver-workspace.tsx",
  "utf8",
);
const SESSION = readFileSync(
  "src/components/driver/driver-session.ts",
  "utf8",
);
const HEADER = readFileSync(
  "src/components/workspaces/driver-header.tsx",
  "utf8",
);
const OFFERS_ROUTE = readFileSync("src/app/driver/offers/page.tsx", "utf8");
const CURRENT_ROUTE = readFileSync(
  "src/app/driver/current-order/page.tsx",
  "utf8",
);
const SETTLEMENTS = readFileSync(
  "src/app/driver/settlements/page.tsx",
  "utf8",
);
const SOUND = readFileSync(
  "src/components/driver/driver-offer-sound.tsx",
  "utf8",
);

const count = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// --- Сессия -------------------------------------------------------------------

test("13: используется ключ direct-driver-session-id", () => {
  assert.equal(DRIVER_SESSION_KEY, "direct-driver-session-id");
  assert.ok(SESSION.includes('"direct-driver-session-id"'));
});

test("14: старый ключ direct-selected-driver-id не авторизует", () => {
  // Старый ключ упоминается только чтобы его очистить, а не читать как сессию.
  assert.ok(!WORKSPACE.includes("direct-selected-driver-id"));
  assert.ok(SESSION.includes('"direct-selected-driver-id"'));
  assert.ok(!SESSION.includes("useSelectedDriverId"));
});

test("15: legacy-ключ очищается функцией clearLegacySelectedDriverId", () => {
  assert.ok(SESSION.includes("clearLegacySelectedDriverId"));
  assert.ok(WORKSPACE.includes("clearLegacySelectedDriverId"));
});

test("16: нет автоматического выбора Петра", () => {
  assert.ok(!WORKSPACE.includes("driver-1"));
  assert.ok(!WORKSPACE.includes("Пётр"));
});

test("20: SSR snapshot равен null", () => {
  // Под node window нет — снимок сессии null (без расхождения гидратации).
  assert.equal(readAuthenticatedDriverId(), null);
  assert.ok(SESSION.includes("useSyncExternalStore"));
});

test("21: удалённый driverId очищает сессию", () => {
  assert.ok(WORKSPACE.includes("clearAuthenticatedDriverId"));
  assert.ok(WORKSPACE.includes("driver === null"));
});

test("22–23: logout очищает сессию и не меняет доменный статус", () => {
  assert.ok(WORKSPACE.includes("Выйти из аккаунта"));
  assert.ok(WORKSPACE.includes("clearAuthenticatedDriverId()"));
  // Logout не вызывает доменных действий смены статуса.
  const start = WORKSPACE.indexOf("function LogoutButton");
  const block = WORKSPACE.slice(start, start + 400);
  assert.ok(!block.includes("driverGoOffline"));
});

// --- Навигация ----------------------------------------------------------------

test("24–27: навигация после входа — только Заказы и Расчёты", () => {
  assert.ok(HEADER.includes('label: "Заказы"'));
  assert.ok(HEADER.includes('label: "Расчёты"'));
  for (const gone of ["Обзор", "Предложения", "Текущий заказ"]) {
    assert.ok(!HEADER.includes(`"${gone}"`), gone);
  }
  // Навигация показывается только при активной сессии.
  assert.ok(HEADER.includes("useAuthenticatedDriverId"));
  assert.ok(HEADER.includes("sessionDriverId ? driverNavigation : []"));
});

test("28–29: /driver/offers и /driver/current-order перенаправляют на /driver", () => {
  assert.ok(OFFERS_ROUTE.includes('redirect("/driver")'));
  assert.ok(CURRENT_ROUTE.includes('redirect("/driver")'));
  assert.ok(!OFFERS_ROUTE.includes("DriverOfferCard"));
});

// --- Главный экран ------------------------------------------------------------

test("30: заголовок «Заказы»", () => {
  assert.ok(PAGE.includes("Заказы"));
  assert.ok(PAGE.includes("DriverWorkspace"));
});

test("31–32: счётчики «Новые» и «В работе»", () => {
  assert.ok(WORKSPACE.includes("Новые — {newCount}"));
  assert.ok(WORKSPACE.includes("В работе — {workCount}"));
  assert.ok(WORKSPACE.includes("getOpenDriverOffersForDriver"));
  assert.ok(WORKSPACE.includes("getDriverActiveOrder"));
});

test("33: колокольчик показан один раз", () => {
  assert.equal(count(WORKSPACE, "<DriverOfferSoundButton"), 1);
});

test("34: профиль без слова «Водитель»", () => {
  assert.ok(WORKSPACE.includes("getDriverDisplayName(driver)"));
});

test("35: есть «Выйти из аккаунта»", () => {
  assert.ok(WORKSPACE.includes("Выйти из аккаунта"));
});

test("36: есть управление статусом и зоной", () => {
  for (const label of ["Выйти онлайн", "Пауза", "Изменить зону", "Выйти из сети", "Возобновить"]) {
    assert.ok(WORKSPACE.includes(label), label);
  }
});

test("37: нет большой route-card навигации", () => {
  assert.ok(!WORKSPACE.includes("RouteCards"));
  assert.ok(!PAGE.includes("RouteCards"));
});

test("38: нет строки допуска к наличным", () => {
  assert.ok(!WORKSPACE.includes("Наличные заказы разрешены"));
  assert.ok(!WORKSPACE.includes("Наличные заказы недоступны"));
});

test("39–40: нет «Выберите водителя» и «Сменить водителя»", () => {
  for (const gone of ["Выберите водителя", "Сменить водителя"]) {
    assert.ok(!WORKSPACE.includes(gone), gone);
    assert.ok(!PAGE.includes(gone), gone);
  }
});

// --- Новые заказы -------------------------------------------------------------

test("41: open offers показываются внутри /driver", () => {
  assert.ok(WORKSPACE.includes("DriverOfferCard"));
  assert.ok(WORKSPACE.includes("NewOffersSection"));
});

test("47: после принятия нет redirect на отдельный маршрут", () => {
  assert.ok(!WORKSPACE.includes("/driver/current-order"));
  assert.ok(!WORKSPACE.includes("router.push"));
  assert.ok(!WORKSPACE.includes("useRouter"));
});

test("49–50: занятый водитель — своё пустое состояние; звук по сессии", () => {
  assert.ok(WORKSPACE.includes("Во время выполнения заказа новые предложения не поступают."));
  assert.ok(SOUND.includes("useAuthenticatedDriverId"));
  assert.ok(!SOUND.includes("useSelectedDriverId"));
});

// --- В работе -----------------------------------------------------------------

test("52: приватность — заказ только назначенному водителю", () => {
  assert.ok(WORKSPACE.includes("order.assignedDriverId === driver.id"));
});

test("54–55: телефон tel: и выплата из снимка", () => {
  assert.ok(WORKSPACE.includes("tel:"));
  assert.ok(WORKSPACE.includes("order.financials.driverPayoutCents"));
});

test("57: BUSY_DIRECT без заказа — fail-closed сообщение", () => {
  assert.ok(WORKSPACE.includes("Данные активного заказа требуют проверки Direct."));
});

// --- Подтверждение зоны -------------------------------------------------------

test("58–62: подтверждение зоны на странице заказов, без автоподтверждения", () => {
  assert.ok(WORKSPACE.includes("Да, я в "));
  assert.ok(WORKSPACE.includes("Выбрать другую зону"));
  assert.ok(WORKSPACE.includes("Поставить Direct на паузу"));
  assert.ok(WORKSPACE.includes("Подтвердить и искать заказы"));
  // Подтверждение — только по кнопке (driverConfirmZone внутри onClick).
  assert.ok(WORKSPACE.includes("driverConfirmZone"));
});

// --- Расчёты ------------------------------------------------------------------

test("Расчёты доступны только при сессии, без выдуманных сумм", () => {
  assert.ok(SETTLEMENTS.includes("useAuthenticatedDriverId"));
  assert.ok(
    SETTLEMENTS.includes(
      "Войдите в систему под своим именем и номером телефона",
    ),
  );
  assert.ok(!/\$\s?\d/.test(SETTLEMENTS));
  assert.ok(!SETTLEMENTS.includes("Выберите водителя"));
});

// --- Regression ---------------------------------------------------------------

test("63: schema остаётся 18 (не понижается этим UI-микробатчем)", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 18);
});

test("64–65: driver offers домен и срок 30 секунд не изменены", () => {
  assert.equal(DRIVER_OFFER_DURATION_MS, 30_000);
});

test("67: звук предложений использует отдельный ключ", () => {
  assert.equal(DRIVER_OFFER_SOUND_KEY, "direct-driver-offer-sound-enabled");
  assert.ok(SOUND.includes("DRIVER_OFFER_SOUND_KEY"));
});

test("68: platformDriverCashEnabled === false", () => {
  assert.equal(createDefaultState().platformSettings.platformDriverCashEnabled, false);
});

// --- Accessibility ------------------------------------------------------------

test("форма входа доступна: label, autocomplete, tel, role=alert, submit", () => {
  assert.ok(WORKSPACE.includes('autoComplete="name"'));
  assert.ok(WORKSPACE.includes('autoComplete="tel"'));
  assert.ok(WORKSPACE.includes('inputMode="tel"'));
  assert.ok(WORKSPACE.includes('role="alert"'));
  assert.ok(WORKSPACE.includes('type="submit"'));
  assert.ok(WORKSPACE.includes("onSubmit={submit}"));
});
