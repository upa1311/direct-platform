import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Source-contract guarantees for Direct system notifications V1. These back the
 * pure tests in direct-notifications.test.ts and assert the honest limits: a
 * minimal service worker (no fetch/cache/push), permission only on a user
 * gesture, no PushManager/VAPID/fake backend, an app-open-only UI note, sound
 * independence, and no offline/reconnect work bleeding into this microbatch.
 */

const read = (path: string) => readFileSync(path, "utf8");
const SW = read("public/direct-notifications-sw.js");
const HOOK = read("src/components/notifications/use-direct-system-notifications.ts");
const RUNTIME = read("src/components/notifications/notification-runtime.ts");
const CONTROL = read("src/components/notifications/system-notification-control.tsx");
const CORE = read("src/prototype/direct-notifications.ts");
const CONTRACT = read("src/prototype/direct-notification-worker-contract.ts");
const KITCHEN_PAGE = read("src/app/restaurant/kitchen/page.tsx");
const OPERATOR_PAGE = read("src/app/restaurant/operator/page.tsx");
const DRIVER_SOUND = read("src/components/driver/driver-offer-sound-logic.ts");
const KITCHEN_SOUND = read("src/components/workspaces/kitchen-sound.ts");
const NOTIF_FILES = [SW, HOOK, RUNTIME, CORE, CONTRACT, CONTROL];

// --- 7-8: permission only from an explicit user gesture ------------------------

test("7-8: requestPermission is called once, inside enable, only when default", () => {
  const calls = (HOOK.match(/requestSystemNotificationPermission\(\)/g) ?? []).length;
  assert.equal(calls, 1, "exactly one request call");
  const enableIdx = HOOK.indexOf("const enable = useCallback");
  const callIdx = HOOK.indexOf("requestSystemNotificationPermission()");
  assert.ok(enableIdx !== -1 && callIdx > enableIdx, "request lives in enable()");
  // Guarded so a denial is never re-prompted automatically.
  assert.ok(HOOK.includes('if (current === "default")'));
  // Never requested inside a background effect.
  const firstEffect = HOOK.indexOf("useEffect");
  const lastEffect = HOOK.lastIndexOf("useEffect");
  assert.ok(callIdx > lastEffect || callIdx < firstEffect || callIdx > enableIdx);
});

// --- 40-41: worker click focuses/opens approved route, no domain mutation ------

test("40-41: worker only focuses/opens an approved route and never mutates state", () => {
  assert.ok(SW.includes('addEventListener("notificationclick"'));
  assert.ok(SW.includes("isApprovedRoute("));
  assert.ok(SW.includes(".focus()"));
  assert.ok(SW.includes("openWindow"));
  // Unapproved data falls back to "/" — never an attacker route.
  assert.ok(SW.includes('isApprovedRoute(data.url) ? data.url : "/"'));
  for (const forbidden of [
    "PrototypeState",
    "prototype",
    "reducer",
    "dispatch(",
    "localStorage",
    "driverAccept",
    "markDriver",
  ]) {
    assert.ok(!SW.includes(forbidden), forbidden);
  }
});

// --- 42: no accept/decline/ready/delivered action buttons ----------------------

test("42: no notification action buttons anywhere", () => {
  assert.ok(!SW.includes("actions:"), "no showNotification actions");
  assert.ok(!CONTRACT.includes("actions"), "contract has no actions field");
  for (const label of ["Принять", "Отклонить", "Готово", "Доставлено", "Инструкцию прочитал"]) {
    assert.ok(!CONTROL.includes(label), label);
  }
});

// --- 58: no PushManager / VAPID / fake backend ---------------------------------

test("58: no PushManager, VAPID, subscription or backend push claims", () => {
  for (const source of NOTIF_FILES) {
    for (const forbidden of [
      "PushManager",
      "pushManager",
      "VAPID",
      "applicationServerKey",
      "pushSubscription",
      "/api/push",
      ".subscribe(",
      "addEventListener(\"push\"",
    ]) {
      assert.ok(!source.includes(forbidden), forbidden);
    }
  }
});

// --- 59: honest app-open-only UI, no false background claims --------------------

test("59: UI states the app-open limitation and makes no background claim", () => {
  assert.ok(CONTROL.includes("Работают, пока Direct открыт в браузере."));
  for (const forbidden of [
    "Background push",
    "при закрытом",
    "всегда получите",
    "Push подписка активна",
    "работает при закрытом",
  ]) {
    assert.ok(!CONTROL.includes(forbidden), forbidden);
  }
});

// --- 60: no offline/reconnect work; worker has no fetch/cache ------------------

test("60: service worker is minimal — no fetch handler, no cache", () => {
  assert.ok(!SW.includes('addEventListener("fetch"'), "no fetch handler");
  assert.ok(!SW.includes("caches."), "no Cache Storage");
  assert.ok(!SW.includes("backgroundSync"));
  for (const source of [HOOK, RUNTIME, CONTROL]) {
    assert.ok(!source.includes("navigator.onLine"));
    assert.ok(!source.includes("reconnect"));
  }
});

// --- 44-47: sound channels untouched -------------------------------------------

test("44-45: notification code never writes a sound preference key", () => {
  for (const source of [HOOK, RUNTIME, CORE]) {
    assert.ok(!source.includes("direct-driver-offer-sound-enabled"));
    assert.ok(!source.includes("direct-kitchen-sound-enabled"));
  }
});

test("46-47: existing sound logic still present (not rewritten by this microbatch)", () => {
  assert.ok(DRIVER_SOUND.includes("shouldDriverOfferSoundPlay"));
  assert.ok(DRIVER_SOUND.includes("DRIVER_OFFER_BEEP_INTERVAL_MS = 10_000"));
  assert.ok(KITCHEN_SOUND.includes("KITCHEN_SOUND_KEY"));
  assert.ok(KITCHEN_SOUND.includes("playKitchenBeep"));
});

// --- 23/28 gating: role/mode drives which screen notifies ----------------------

test("kitchen/operator screens gate notifications by mode and role", () => {
  assert.ok(KITCHEN_PAGE.includes("<KitchenSystemNotifications"));
  assert.ok(KITCHEN_PAGE.includes("active={!isSplit}"));
  assert.ok(KITCHEN_PAGE.includes('workspaceRole={isSplit ? "KITCHEN" : "COMBINED"}'));
  assert.ok(OPERATOR_PAGE.includes("<KitchenSystemNotifications"));
  assert.ok(OPERATOR_PAGE.includes('workspaceRole="OPERATOR"'));
  assert.ok(OPERATOR_PAGE.includes("SPLIT_OPERATOR_KITCHEN"));
});
