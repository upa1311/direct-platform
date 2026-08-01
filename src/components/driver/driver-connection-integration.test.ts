import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PROTOTYPE_SCHEMA_VERSION } from "../../prototype/models.ts";
import { getDriverConnectionView } from "../../prototype/driver-connection.ts";

/**
 * Driver connection recovery — integration/scope guarantees. The pure model is
 * covered in driver-connection.test.ts; here we confirm the single action gate,
 * offline active-order/offer behaviour, cross-tab reuse and that nothing outside
 * scope changed. Core connection logic is NOT tested by source strings alone —
 * it is exercised as a real state machine in the pure suite.
 */

const WORKSPACE = readFileSync(
  "src/components/driver/driver-workspace.tsx",
  "utf8",
);
const PROVIDER = readFileSync("src/prototype/prototype-provider.tsx", "utf8");
const CONNECTION = readFileSync("src/prototype/driver-connection.ts", "utf8");
const HOOK = readFileSync(
  "src/components/driver/use-driver-connection.ts",
  "utf8",
);
const SW = readFileSync("public/direct-notifications-sw.js", "utf8");
const KITCHEN_SOUND = readFileSync(
  "src/components/workspaces/kitchen-sound.ts",
  "utf8",
);

// --- action gate (canMutate only ONLINE) ---------------------------------------

test("28-31: only ONLINE allows mutations; a single gate wraps useAction.run", () => {
  for (const status of ["INITIALIZING", "OFFLINE", "RECOVERING", "DEGRADED"] as const) {
    assert.equal(getDriverConnectionView({ ...view0, status }).canMutate, false);
  }
  assert.equal(getDriverConnectionView({ ...view0, status: "ONLINE" }).canMutate, true);
  // The gate lives in useAction.run and returns early without running/queuing.
  const run = WORKSPACE.slice(
    WORKSPACE.indexOf("const run = async"),
    WORKSPACE.indexOf("return { pending, error, blocked"),
  );
  assert.ok(run.includes("if (blocked)"));
  assert.ok(run.includes("DRIVER_CONNECTION_BLOCKED_MESSAGE"));
  // The early return happens before pending/action are touched.
  assert.ok(run.indexOf("if (blocked)") < run.indexOf("setPending(true)"));
});

const view0 = {
  status: "INITIALIZING" as const,
  lastKnownRevision: null,
  lastStateUpdatedAt: null,
  message: "",
  canMutate: false,
};

test("note-gate: Save/Delete go through the shared gate — blocked → no mutation", () => {
  const nf = WORKSPACE.slice(
    WORKSPACE.indexOf("function NoteForm"),
    WORKSPACE.indexOf("// --- Управление статусом"),
  );
  assert.ok(nf.length > 0);
  assert.ok(nf.includes("const blocked = useDriverActionsBlocked()"));
  const saveBody = nf.slice(
    nf.indexOf("const save = async"),
    nf.indexOf("return ("),
  );
  // The gate blocks BEFORE the provider mutation and shows the shared message.
  assert.ok(
    saveBody.indexOf("if (blocked)") < saveBody.indexOf("updateDriverStatusNote"),
  );
  assert.ok(saveBody.includes("DRIVER_CONNECTION_BLOCKED_MESSAGE"));
  // Both buttons are disabled while blocked; typed text is not discarded here.
  assert.equal((nf.match(/disabled=\{pending \|\| blocked\}/g) ?? []).length, 2);
});

test("logout: uses the shared gate; blocked non-offline status runs no driverGoOffline", () => {
  const pm = WORKSPACE.slice(
    WORKSPACE.indexOf("function ProfileMenu"),
    WORKSPACE.indexOf("function NoteForm"),
  );
  assert.ok(pm.length > 0);
  // Shared connection view — not a direct navigator.onLine read inside the menu.
  assert.ok(pm.includes("useDriverActionsBlocked()"));
  assert.ok(!pm.includes("navigator.onLine"));
  const logoutBody = pm.slice(
    pm.indexOf("const logout = async"),
    pm.indexOf("return ("),
  );
  const goOfflineCall = logoutBody.indexOf("await driverGoOffline(driver.id)");
  assert.ok(goOfflineCall !== -1);
  // OFFLINE driver status: pure local logout (clear session), no mutation.
  assert.ok(logoutBody.indexOf('driver.status === "OFFLINE"') < goOfflineCall);
  // Blocked connection: return with the logout-blocked message BEFORE the mutation.
  assert.ok(logoutBody.indexOf("if (blocked)") < goOfflineCall);
  assert.ok(logoutBody.includes("DRIVER_LOGOUT_BLOCKED_MESSAGE"));
  assert.ok(pm.includes("Сначала завершите текущий заказ"));
});

test("32-33: no hidden queue, no automatic replay, no polling", () => {
  for (const source of [CONNECTION, HOOK]) {
    assert.ok(!source.toLowerCase().includes("queue"));
    assert.ok(!source.toLowerCase().includes("replay"));
    assert.ok(!source.includes("setInterval"));
  }
});

// --- 26-27: refresh is a read, not a mutation ----------------------------------

test("26-27: refreshFromPersistedState reads/accepts only — no persist/broadcast/mutation", () => {
  const fn = PROVIDER.slice(
    PROVIDER.indexOf("const refreshFromPersistedState = useCallback"),
    PROVIDER.indexOf("}, [replaceState]);", PROVIDER.indexOf("refreshFromPersistedState")) + 20,
  );
  assert.ok(fn.includes("resolvePrototypeRefresh"));
  assert.ok(fn.includes("safeReadStoredState"));
  assert.ok(fn.includes("replaceState"));
  // Never persists, broadcasts or runs a serialized mutation.
  assert.ok(!fn.includes("persistState"));
  assert.ok(!fn.includes("broadcastState"));
  assert.ok(!fn.includes("runSerializedMutation"));
  assert.ok(!fn.includes("executeSerializedPrototypeMutation"));
});

// --- 36-41: active order / offers / no state change offline --------------------

test("36-39: active order & offers render regardless of connection; offer buttons gated", () => {
  // The active order section and connection block are siblings under the provider
  // — the active order is never hidden or cleared by connection status.
  const gateOpen = WORKSPACE.indexOf("<DriverConnectionContext.Provider");
  const activeSection = WORKSPACE.indexOf("<ActiveOrderSection");
  const gateClose = WORKSPACE.indexOf("</DriverConnectionContext.Provider>");
  assert.ok(gateOpen !== -1 && activeSection > gateOpen && gateClose > activeSection);
  // Active order rendering is not conditioned on the connection view.
  assert.ok(!WORKSPACE.includes("connectionView.status ===")); // no hide-by-status
  // Offer accept/decline are disabled when blocked.
  assert.ok(WORKSPACE.includes("disabled={pending || blocked}"));
});

test("40-41: connection state is tab-local — never written to PrototypeState", () => {
  // The connection module holds no PrototypeState mutation and no persistence.
  assert.ok(!CONNECTION.includes("localStorage"));
  assert.ok(!CONNECTION.includes("PROTOTYPE_STORAGE_KEY"));
  assert.ok(!CONNECTION.includes("setState"));
  // PrototypeState schema carries no connection field.
  const models = readFileSync("src/prototype/models.ts", "utf8");
  assert.ok(!/connectionStatus|driverConnection\b/.test(models));
});

// --- 42-45: cross-tab reuse ----------------------------------------------------

test("42-45: existing cross-tab sync is reused; reconnect re-reads persisted state", () => {
  // Existing mechanisms remain in the provider.
  assert.ok(PROVIDER.includes('addEventListener("storage"'));
  assert.ok(PROVIDER.includes("openPrototypeChannel"));
  assert.ok(PROVIDER.includes("isNewerState"));
  // Reconnect reads the authoritative persisted state (not just stale memory).
  assert.ok(HOOK.includes("refreshFromPersistedState"));
  // Connection status is never broadcast (broadcast only carries state).
  assert.ok(!CONNECTION.includes("BroadcastChannel"));
  assert.ok(!CONNECTION.includes("postMessage"));
});

// --- 46-50: scope preservation -------------------------------------------------

test("46-50: notifications/sound/schema/domain untouched by connection recovery", () => {
  // Notification worker still has no fetch handler / cache.
  assert.ok(!SW.includes('addEventListener("fetch"'));
  assert.ok(!SW.includes("caches."));
  // Sound preference key unchanged.
  assert.ok(KITCHEN_SOUND.includes("KITCHEN_SOUND_KEY"));
  // Schema version unchanged.
  assert.equal(PROTOTYPE_SCHEMA_VERSION, 30);
  // The connection module does not touch domain actions/lifecycle/finance.
  for (const forbidden of [
    "driverGoOnline",
    "driverAcceptOffer",
    "driverCompleteDelivery",
    "driverPickUpOrder",
    "earnings",
    "settlements",
  ]) {
    assert.ok(!CONNECTION.includes(forbidden), forbidden);
  }
});
