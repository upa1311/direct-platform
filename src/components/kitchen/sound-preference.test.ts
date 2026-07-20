import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  isSoundPreferred,
  resolveSoundState,
  SOUND_ACTIVATION_MESSAGE,
} from "./sound-preference.ts";

/**
 * Настройка звука ресторанного кабинета: предпочтение переживает SPA-переходы,
 * но включённым звук показывается только при реально работающем AudioContext.
 * Разметка и эффекты хука проверяются контрактно по исходникам — JSX в node:test
 * не исполняется.
 */

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

const HOOK = readSource("./new-order-sound.tsx");
const KITCHEN_PAGE = readSource("../../app/restaurant/kitchen/page.tsx");
const OPERATOR_PAGE = readSource("../../app/restaurant/operator/page.tsx");

// 1 — предпочтение --------------------------------------------------------------

test("предпочтение читается только из «1»", () => {
  assert.equal(isSoundPreferred("1"), true);
  assert.equal(isSoundPreferred("0"), false);
  assert.equal(isSoundPreferred(null), false);
  assert.equal(isSoundPreferred(""), false);
  assert.equal(isSoundPreferred("true"), false);
});

// 1/2/3/7 — разрешение состояния ------------------------------------------------

test("нет предпочтения — звук выключен и активация не требуется", () => {
  assert.deepEqual(resolveSoundState(false, false), {
    soundEnabled: false,
    activationRequired: false,
  });
  // Даже если контекст готов: пользователь звук не просил.
  assert.deepEqual(resolveSoundState(false, true), {
    soundEnabled: false,
    activationRequired: false,
  });
});

test("SPA-remount: предпочтение «1» и живой контекст → звук восстановлен", () => {
  assert.deepEqual(resolveSoundState(true, true), {
    soundEnabled: true,
    activationRequired: false,
  });
});

// 8 — новая вкладка или полная перезагрузка --------------------------------------

test("предпочтение «1», но контекст не готов → активация, без ложного включения", () => {
  const state = resolveSoundState(true, false);
  assert.equal(state.soundEnabled, false, "не врём про работающий звук");
  assert.equal(state.activationRequired, true);
});

test("точный текст просьбы про один клик", () => {
  assert.equal(
    SOUND_ACTIVATION_MESSAGE,
    "Звук сохранён. Нажмите колокольчик один раз для этой вкладки.",
  );
});

// Контракт хука ------------------------------------------------------------------

test("состояние читается как внешнее: снимок и серверный снимок", () => {
  assert.ok(HOOK.includes("useSyncExternalStore"));
  assert.ok(HOOK.includes("getServerSoundStatus"), "есть серверный снимок");
  // Готовность берётся у контроллера звука, а не из localStorage.
  assert.ok(HOOK.includes("isKitchenSoundReady()"));
  assert.ok(HOOK.includes("resolveSoundState("));
});

test("11: размонтирование не выключает звук и не пишет «0»", () => {
  // Единственная запись «0» — в явном disableSound.
  const zeroWrites = HOOK.split('KITCHEN_SOUND_KEY, "0"').length - 1;
  assert.equal(zeroWrites, 1, "«0» записывается только при явном выключении");
  const disableStart = HOOK.indexOf("const disableSound");
  const disableEnd = HOOK.indexOf("};", disableStart);
  assert.ok(
    HOOK.slice(disableStart, disableEnd).includes('KITCHEN_SOUND_KEY, "0"'),
    "«0» пишет именно disableSound",
  );
  // В cleanup-возвратах эффектов выключения звука нет.
  assert.ok(
    !/return \(\) => \{[^}]*disableKitchenSound/s.test(HOOK),
    "cleanup не выключает звук",
  );
});

test("9/10: storage слушается только по своему ключу и не пишет обратно", () => {
  assert.ok(HOOK.includes('event.key === KITCHEN_SOUND_KEY'));
  const subStart = HOOK.indexOf("function subscribeToSoundStatus");
  const subEnd = HOOK.indexOf("\n}", subStart);
  const subscribeBody = HOOK.slice(subStart, subEnd);
  assert.ok(
    !subscribeBody.includes("setItem"),
    "обработчик storage ничего не записывает",
  );
});

test("выключение в другой вкладке освобождает AudioContext", () => {
  assert.ok(HOOK.includes('soundStatus === "OFF" && isKitchenSoundReady()'));
  assert.ok(HOOK.includes("disableKitchenSound()"));
});

test("оба рабочих экрана показывают просьбу об одном клике", () => {
  for (const page of [KITCHEN_PAGE, OPERATOR_PAGE]) {
    assert.ok(page.includes("activationRequired"));
    assert.ok(page.includes("SOUND_ACTIVATION_MESSAGE"));
    // Ложного включения при заблокированном звуке не показываем.
    assert.ok(page.includes("activationRequired && !soundBlocked"));
  }
});

test("13: распределение сигналов и интервал повтора не тронуты", () => {
  // Кухня озвучивает новый заказ только в COMBINED, оператор — в SPLIT.
  assert.ok(KITCHEN_PAGE.includes("enabled: !isSplit"));
  assert.ok(OPERATOR_PAGE.includes("useNewOrderSound"));
  // Расписание нового заказа по-прежнему общее isKitchenBeepDue без своего интервала.
  assert.ok(HOOK.includes("isKitchenBeepDue("));
  assert.ok(!HOOK.includes("intervalMs"), "хук не задаёт свой интервал");
});
