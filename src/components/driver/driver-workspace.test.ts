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
const CSS = readFileSync("src/app/driver/driver.module.css", "utf8");
const DELIVERY = readFileSync("src/prototype/driver-delivery.ts", "utf8");
const SHEET = readFileSync(
  "src/components/driver/driver-control-sheet.tsx",
  "utf8",
);

/** Тело @media-блока по его условию (первое вхождение, со сбалансированными {}). */
function mediaBlock(condition: string): string {
  const start = CSS.indexOf(`@media ${condition}`);
  assert.notEqual(start, -1, `@media ${condition} не найден`);
  const open = CSS.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < CSS.length; i += 1) {
    if (CSS[i] === "{") depth += 1;
    else if (CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) return CSS.slice(open + 1, i);
    }
  }
  throw new Error(`@media ${condition} не закрыт`);
}

/** Тело CSS-правила `selector { ... }` (первое вхождение). */
function cssRule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `CSS-правило ${selector} не найдено`);
  const open = CSS.indexOf("{", start);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close);
}

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

test("33: на странице ровно один звуковой control", () => {
  // v18 UI: единственный звуковой control — иконка в quick controls.
  assert.equal(count(WORKSPACE, "soundIconButton"), 1);
  assert.ok(!WORKSPACE.includes("DriverOfferSoundButton"));
  // Возле счётчиков «Новые/В работе» колокольчика нет.
  const barStart = WORKSPACE.indexOf("styles.workBar");
  const barEnd = WORKSPACE.indexOf("NewOffersSection", barStart);
  assert.ok(!WORKSPACE.slice(barStart, barEnd).includes("soundIconButton"));
});

test("34: профиль без слова «Водитель»", () => {
  assert.ok(WORKSPACE.includes("getDriverDisplayName(driver)"));
});

test("35: есть «Выйти из аккаунта»", () => {
  assert.ok(WORKSPACE.includes("Выйти из аккаунта"));
});

test("36: есть компактная верхняя панель статуса и зоны", () => {
  // v18 UI: одна строка «статус · зона · звук», действия — в компактных меню.
  assert.ok(WORKSPACE.includes("DriverQuickControls"));
  assert.ok(WORKSPACE.includes("quickControls"));
  for (const label of [
    "Выйти онлайн",
    "Онлайн",
    "Пауза",
    "Возобновить",
    "Поставить на паузу",
    "Выйти из сети",
  ]) {
    assert.ok(WORKSPACE.includes(label), label);
  }
  // Отдельной большой карточки со статусом и «Изменить зону» больше нет.
  assert.ok(!WORKSPACE.includes("Изменить зону"));
  assert.ok(!WORKSPACE.includes("StatusZoneControl"));
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
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 24);
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

// --- Мобильный polish (v18) ---------------------------------------------------

test("quick: BUSY_DIRECT — кнопка статуса disabled, без меню", () => {
  const block = WORKSPACE.slice(WORKSPACE.indexOf('if (status === "BUSY_DIRECT")'));
  const card = block.slice(0, block.indexOf('if (status === "ZONE_CONFIRMATION_REQUIRED")'));
  assert.ok(card.includes("disabled"));
  assert.ok(card.includes("В работе"));
});

test("quick: OFFLINE «Выйти онлайн» использует zoneDraft", () => {
  assert.ok(WORKSPACE.includes("driverGoOnline(driver.id, zoneDraft)"));
});

test("quick: выбор зоны онлайн вызывает driverChangeZone", () => {
  assert.ok(WORKSPACE.includes("driverChangeZone(driver.id, zoneId)"));
});

test("logout: OFFLINE очищает сессию сразу", () => {
  const block = WORKSPACE.slice(
    WORKSPACE.indexOf("const logout = async"),
    WORKSPACE.indexOf("const logout = async") + 900,
  );
  assert.ok(block.includes('driver.status === "OFFLINE"'));
  assert.ok(block.includes("clearAuthenticatedDriverId();"));
});

test("logout: AVAILABLE/PAUSED сначала driverGoOffline, при ошибке сессия сохраняется", () => {
  const block = WORKSPACE.slice(
    WORKSPACE.indexOf("const logout = async"),
    WORKSPACE.indexOf("const logout = async") + 900,
  );
  assert.ok(block.includes("await driverGoOffline(driver.id)"));
  // При ошибке — ранний выход до очистки сессии.
  assert.ok(block.includes("if (!result.ok)"));
  const failIdx = block.indexOf("if (!result.ok)");
  const clearIdx = block.lastIndexOf("clearAuthenticatedDriverId()");
  assert.ok(failIdx < clearIdx, "очистка сессии после проверки ошибки");
});

test("logout: BUSY_DIRECT запрещён (disabled пункт)", () => {
  assert.ok(WORKSPACE.includes("Сначала завершите текущий заказ"));
});

test("прогресс на телефоне — сетка 2×2", () => {
  const rule = cssRule(".progress");
  assert.ok(rule.includes("display: grid"));
  assert.ok(rule.includes("grid-template-columns: 1fr 1fr"));
});

test("lifecycle-кнопка на мобиле — full width и min-height 52", () => {
  const rule = cssRule(".stageCard .primaryButton");
  assert.ok(rule.includes("width: 100%"));
  assert.ok(rule.includes("min-height: 52px"));
  assert.ok(rule.includes("font-size: 16px"));
});

test("input формы входа — min-height не менее 48px", () => {
  const rule = cssRule(".textInput");
  assert.ok(rule.includes("min-height: 48px"));
});

test("safe-area — нижний отступ рабочего экрана", () => {
  const rule = cssRule(".container");
  assert.ok(rule.includes("env(safe-area-inset-bottom)"));
});

test("кнопка «Позвонить клиенту» — tel href", () => {
  assert.ok(WORKSPACE.includes("Позвонить клиенту"));
  assert.ok(WORKSPACE.includes("href={`tel:${order.customer.phone}`}"));
  assert.ok(WORKSPACE.includes("styles.callButton"));
});

test("активный заказ: до получения ресторан первым, после — клиент первым", () => {
  const rp = WORKSPACE.slice(
    WORKSPACE.indexOf("function RoutePoint"),
    WORKSPACE.indexOf("function OrderMeta"),
  );
  const pickedBranch = rp.indexOf("if (pickedUp)");
  const dostavit = rp.indexOf("Доставить");
  const zabrat = rp.indexOf("Забрать");
  assert.ok(pickedBranch !== -1 && dostavit !== -1 && zabrat !== -1);
  // В pickedUp-ветке (идёт первой) «Доставить» появляется раньше «Забрать».
  assert.ok(dostavit < zabrat, "Доставить раньше Забрать в pickedUp-ветке");
});

test("history-сообщения доставки без префикса «Водитель»", () => {
  // Домен строит историю из driver.name (уже «Водитель Пётр») без добавления.
  assert.ok(DELIVERY.includes("`${guard.driver.name} прибыл в ресторан.`"));
  assert.ok(!DELIVERY.includes("Водитель ${guard.driver.name}"));
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

// --- Устойчивая мобильная верхняя панель (harden) -----------------------------

test("h1: статусная кнопка оборачивает подпись в span", () => {
  // Голого текста внутри статусной кнопки нет — подпись в span.
  assert.ok(WORKSPACE.includes("styles.quickButtonText"));
  const idx = WORKSPACE.indexOf('? "Сейчас онлайн" : "Сейчас на паузе"');
  assert.notEqual(idx, -1);
  const before = WORKSPACE.slice(idx - 140, idx);
  assert.ok(before.includes("quickButtonStatusText"), "подпись статуса в span");
});

test("h2: OFFLINE — короткая подпись «В сеть»", () => {
  assert.ok(WORKSPACE.includes(">В сеть</span>"));
});

test("h3: OFFLINE сохраняет полный aria-label «Выйти онлайн»", () => {
  assert.ok(WORKSPACE.includes('aria-label="Выйти онлайн"'));
  assert.ok(WORKSPACE.includes(">Выйти онлайн</span>"));
});

test("h4: ZONE_CONFIRMATION_REQUIRED — короткая подпись «Подтвердить»", () => {
  assert.ok(WORKSPACE.includes(">Подтвердить</span>"));
});

test("h5: подтверждение зоны — полный aria-label «Подтвердить текущую зону»", () => {
  assert.ok(WORKSPACE.includes('aria-label="Подтвердить текущую зону"'));
});

test("h6: телефонный @media — статус по контенту, зона ужимается, 44px звук", () => {
  // Порог 440px покрывает границы 390 и 430px без обрезания подписей.
  const block = mediaBlock("(max-width: 440px)");
  assert.ok(block.includes("auto minmax(0, 1fr) 44px"), "auto-статус, remainder-зона, 44px звук");
});

test("h7: телефонный @media — padding кнопок не больше 8px", () => {
  const block = mediaBlock("(max-width: 440px)");
  assert.ok(block.includes("padding-inline: 8px"));
  assert.ok(block.includes("font-size: 14px"));
  // Короткая подпись включается, полная скрывается.
  assert.ok(block.includes(".mobileControlLabel"));
  assert.ok(block.includes(".regularControlLabel"));
});

test("h8: статусное меню — overlay-лист, а не flow-блок", () => {
  // Старый flow-класс quickMenu удалён; статус открывает DriverControlSheet.
  assert.ok(!WORKSPACE.includes("styles.quickMenu"));
  assert.ok(!CSS.includes(".quickMenu"));
  assert.ok(WORKSPACE.includes("DriverControlSheet"));
  assert.ok(WORKSPACE.includes('open={openMenu === "status"}'));
});

test("h9: control sheet использует position fixed", () => {
  assert.ok(cssRule(".controlSheet").includes("position: fixed"));
  assert.ok(SHEET.includes("position: fixed") === false, "позиция задаётся в CSS");
});

test("h10: control sheet использует safe-area снизу", () => {
  assert.ok(cssRule(".controlSheet").includes("env(safe-area-inset-bottom)"));
});

test("h11: присутствует backdrop поверх контента", () => {
  const rule = cssRule(".sheetBackdrop");
  assert.ok(rule.includes("position: fixed"));
  assert.ok(rule.includes("inset: 0"));
  assert.ok(SHEET.includes("styles.sheetBackdrop"));
  assert.ok(SHEET.includes("onClick={onClose}"));
});

test("h12: Escape закрывает лист", () => {
  assert.ok(SHEET.includes('"Escape"'));
  assert.ok(SHEET.includes("onClose()"));
});

test("h13: фокус возвращается на кнопку-триггер", () => {
  assert.ok(SHEET.includes("triggerRef.current?.focus()"));
  // aria-modal на мобильном dialog.
  assert.ok(SHEET.includes('aria-modal="true"'));
  assert.ok(SHEET.includes('role="dialog"'));
});

test("h14: единый zone picker для обоих сценариев (без дублирования списка)", () => {
  assert.ok(WORKSPACE.includes("function ZoneOptions"));
  assert.ok(WORKSPACE.includes("<ZoneOptions"));
  // Список зон строится ровно один раз — в общем ZoneOptions.
  assert.equal(count(WORKSPACE, "zones.map("), 1);
});

test("h15: выбор зоны в OFFLINE меняет только zoneDraft", () => {
  const cz = WORKSPACE.slice(
    WORKSPACE.indexOf("const chooseZone"),
    WORKSPACE.indexOf("const chooseZone") + 700,
  );
  assert.ok(cz.includes('status === "OFFLINE"'));
  const draft = cz.indexOf("setZoneDraft(zoneId)");
  const change = cz.indexOf("driverChangeZone");
  assert.ok(draft !== -1 && change !== -1);
  assert.ok(draft < change, "OFFLINE-ветка (только черновик) раньше смены зоны");
});

test("h16: AVAILABLE/PAUSED выбор зоны вызывает driverChangeZone", () => {
  assert.ok(WORKSPACE.includes("driverChangeZone(driver.id, zoneId)"));
  assert.ok(WORKSPACE.includes("runAndCloseSheet"));
});

test("h17: при ошибке лист не закрывается (закрытие только при ok)", () => {
  assert.ok(WORKSPACE.includes("if (result.ok) setOpenMenu(null)"));
});

test("h18: zoneConfirmActions — одна колонка", () => {
  assert.ok(cssRule(".zoneConfirmActions").includes("grid-template-columns: 1fr"));
});

test("h19: кнопки подтверждения зоны — width 100%", () => {
  const rule = cssRule(".zoneConfirmButton");
  assert.ok(rule.includes("width: 100%"));
  assert.ok(rule.includes("white-space: normal"));
});

test("h20: главная кнопка подтверждения зоны — min-height 52px", () => {
  const rule = cssRule(".zoneConfirmPrimary");
  assert.ok(rule.includes("min-height: 52px"));
  assert.ok(rule.includes("font-size: 16px"));
});

test("h21: «Выбрать другую зону» открывает лист, а не inline-список", () => {
  assert.ok(WORKSPACE.includes("Выбрана: "));
  assert.ok(WORKSPACE.includes('onClick={() => setOpenMenu("zone")}'));
});

test("h22: ровно один колокольчик в quick controls", () => {
  assert.equal(count(WORKSPACE, "soundIconButton"), 1);
});

test("h23: lifecycle-кнопки и прогресс 2×2 не ухудшены", () => {
  const life = cssRule(".stageCard .primaryButton");
  assert.ok(life.includes("width: 100%"));
  assert.ok(life.includes("min-height: 52px"));
  const prog = cssRule(".progress");
  assert.ok(prog.includes("grid-template-columns: 1fr 1fr"));
});

test("h24: schema остаётся 18; наличные выключены", () => {
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 24);
  assert.equal(
    createDefaultState().platformSettings.platformDriverCashEnabled,
    false,
  );
});

test("h25: нет двойного слова «Водитель Водитель»", () => {
  assert.ok(!WORKSPACE.includes("Водитель Водитель"));
  assert.ok(!SHEET.includes("Водитель Водитель"));
});

// --- Полные подписи текущего состояния (продуктовое уточнение) ----------------

/** Тело функции statusButton (подпись и поведение кнопки статуса). */
function statusButtonBody(): string {
  const start = WORKSPACE.indexOf("const statusButton = ()");
  assert.notEqual(start, -1, "statusButton не найден");
  // До начала следующего объявления (shownZone) — тело хелпера целиком.
  const end = WORKSPACE.indexOf("const shownZone", start);
  assert.notEqual(end, -1);
  return WORKSPACE.slice(start, end);
}

test("s1: AVAILABLE — видимая подпись «Сейчас онлайн»", () => {
  assert.ok(WORKSPACE.includes("Сейчас онлайн"));
  assert.ok(statusButtonBody().includes('"Сейчас онлайн"'));
});

test("s2: PAUSED — видимая подпись «Сейчас на паузе»", () => {
  assert.ok(WORKSPACE.includes("Сейчас на паузе"));
  assert.ok(statusButtonBody().includes('"Сейчас на паузе"'));
});

test("s3: в status trigger нет одиночных подписей «Онлайн» / «Пауза»", () => {
  const body = statusButtonBody();
  // Точные строковые литералы «Онлайн» и «Пауза» как подпись кнопки — исчезли.
  assert.ok(!body.includes('"Онлайн"'), 'нет литерала "Онлайн" в статус-кнопке');
  assert.ok(!body.includes('"Пауза"'), 'нет литерала "Пауза" в статус-кнопке');
  // Подпись показывается спец-классом без ellipsis.
  assert.ok(body.includes("quickButtonStatusText"));
});

test("s4: статус-подпись без ellipsis, зона может ужиматься", () => {
  const rule = cssRule(".quickButtonStatusText");
  assert.ok(rule.includes("white-space: nowrap"));
  assert.ok(!rule.includes("text-overflow: ellipsis"), "статус не обрезается");
  // Зона — обычный quickButtonText с ellipsis (её сокращать разрешено).
  assert.ok(cssRule(".quickButtonText").includes("text-overflow: ellipsis"));
});

test("s5: мобильная сетка — статус по контенту (без обрезки), зона гибкая", () => {
  const block = mediaBlock("(max-width: 440px)");
  // Статус-колонка `auto` = по контенту → подпись целиком; зона = remainder.
  assert.ok(block.includes("grid-template-columns: auto minmax(0, 1fr) 44px"));
});

test("s6: меню PAUSED — «Возобновить поиск заказов»", () => {
  assert.ok(WORKSPACE.includes("Возобновить поиск заказов"));
});

test("s7: меню статуса — пауза/возобновление и общий выход из сети", () => {
  assert.ok(WORKSPACE.includes("Поставить на паузу"));
  assert.ok(WORKSPACE.includes("Возобновить поиск заказов"));
  // «Выйти из сети» — один общий пункт листа для обоих статусов.
  assert.ok(WORKSPACE.includes("Выйти из сети"));
});

// --- Наличное подтверждение: мобильные размеры листа (v20) --------------------

test("cash-49: главная кнопка подтверждения наличных — min-height 52px", () => {
  const primary = cssRule(".cashConfirmPrimary");
  assert.ok(primary.includes("min-height: 52px"));
  assert.ok(primary.includes("width: 100%"));
  const secondary = cssRule(".cashConfirmSecondary");
  assert.ok(secondary.includes("min-height: 44px"));
});
