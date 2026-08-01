import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  notificationAudienceScope,
  reconcileNotificationDelivery,
  resolveDirectNotificationCapability,
  type BrowserStorageReadResult,
  type DirectSystemNotificationIntent,
  type NotificationDeliveryPorts,
  type NotificationLockResult,
} from "./direct-notifications.ts";

/**
 * Corrective microbatch: harden notification dedupe & capability. These tests
 * drive the pure fail-closed reconciler with controllable fake lock/storage
 * adapters (including concurrent two-tab runs), and the extended capability
 * model. No unsynchronised fallback and no silent storage failure may leak a
 * duplicate or a false ENABLED.
 */

const DRIVER = "driver-1";
const REST = "restaurant-2";

function intent(id: string): DirectSystemNotificationIntent {
  return {
    key: `driver-offer:${id}`,
    tag: `driver-offer:${id}`,
    audience: { type: "DRIVER", driverId: DRIVER },
    kind: "DRIVER_NEW_OFFER",
    entityKind: "DRIVER_OFFER",
    entityId: id,
    title: "Новый заказ Direct",
    body: "Откройте Direct.",
    targetUrl: "/driver",
  };
}

/** Shared fake ledger store simulating one browser profile's localStorage. */
class FakeLedgerStore {
  private keys: string[] = [];
  readMode: "ok" | "unavailable" | "invalid" = "ok";
  writeOk = true;
  writes = 0;

  read(): BrowserStorageReadResult<string[]> {
    if (this.readMode === "unavailable") return { ok: false, error: "UNAVAILABLE" };
    if (this.readMode === "invalid") return { ok: false, error: "INVALID_DATA" };
    return { ok: true, value: [...this.keys] };
  }
  write(keys: string[]): boolean {
    this.writes += 1;
    if (!this.writeOk) return false;
    this.keys = [...keys];
    return true;
  }
  snapshot(): string[] {
    return [...this.keys];
  }
}

/** Serializing fake Web Lock: true mutual exclusion across concurrent runs. */
class FakeLock {
  available = true;
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<NotificationLockResult<T>> {
    if (!this.available) return { ok: false, reason: "LOCK_UNAVAILABLE" };
    let release = () => {};
    const previous = this.chain;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const value = await fn();
      return { ok: true, value };
    } finally {
      release();
    }
  }
}

function ports(
  store: FakeLedgerStore,
  lock: FakeLock,
  counters: { shown: number; closed: string[] },
  showResult: (intent: DirectSystemNotificationIntent) => boolean = () => true,
  closeResult: (tag: string) => boolean = () => true,
): NotificationDeliveryPorts {
  return {
    readLedger: () => store.read(),
    writeLedger: (keys) => store.write(keys),
    show: async (i) => {
      const ok = showResult(i);
      if (ok) counters.shown += 1;
      return ok;
    },
    // Confirmed close (ACK) by default; a stale key is dropped only on a true ACK.
    close: async (tag) => {
      counters.closed.push(tag);
      return closeResult(tag);
    },
    runExclusive: (fn) => lock.run(fn),
  };
}

// --- 1-2: capability degrades on storage failure (never false ENABLED) ---------

test("1-2: storage/lock readiness gate ENABLED; any gap → DEGRADED", () => {
  const base = {
    supported: true,
    permission: "granted" as const,
    preferenceEnabled: true,
    workerReady: true,
    preferenceStorageReady: true,
    ledgerStorageReady: true,
    lockReady: true,
    deliveryFailed: false,
  };
  assert.equal(resolveDirectNotificationCapability(base).status, "ENABLED");
  assert.equal(
    resolveDirectNotificationCapability({ ...base, preferenceStorageReady: false }).status,
    "DEGRADED",
  );
  assert.equal(
    resolveDirectNotificationCapability({ ...base, ledgerStorageReady: false }).status,
    "DEGRADED",
  );
  assert.equal(
    resolveDirectNotificationCapability({ ...base, lockReady: false }).status,
    "DEGRADED",
  );
  assert.equal(
    resolveDirectNotificationCapability({ ...base, deliveryFailed: true }).status,
    "DEGRADED",
  );
  // A disabled preference is still DISABLED, not ENABLED.
  assert.equal(
    resolveDirectNotificationCapability({ ...base, preferenceEnabled: false }).status,
    "DISABLED",
  );
});

// --- 3: ledger read failure is not an empty ledger -----------------------------

test("3: unreadable ledger degrades and shows nothing (not treated as empty)", async () => {
  const store = new FakeLedgerStore();
  store.readMode = "unavailable";
  const lock = new FakeLock();
  const counters = { shown: 0, closed: [] as string[] };
  const outcome = await reconcileNotificationDelivery(
    [intent("a")],
    new Set(),
    ports(store, lock, counters),
  );
  assert.equal(outcome.status, "DEGRADED");
  assert.equal(counters.shown, 0);
  const invalid = new FakeLedgerStore();
  invalid.readMode = "invalid";
  const c2 = { shown: 0, closed: [] as string[] };
  const o2 = await reconcileNotificationDelivery(
    [intent("a")],
    new Set(),
    ports(invalid, new FakeLock(), c2),
  );
  assert.equal(o2.status, "DEGRADED");
  assert.equal(c2.shown, 0);
});

// --- 4-6: ledger write failure after show → quarantine, stop, no repeat --------

test("4-6: write failure after show quarantines, stops, and never re-shows", async () => {
  const store = new FakeLedgerStore();
  store.writeOk = false;
  const quarantine = new Set<string>();
  const counters = { shown: 0, closed: [] as string[] };
  const first = await reconcileNotificationDelivery(
    [intent("a"), intent("b")],
    quarantine,
    ports(store, new FakeLock(), counters),
  );
  assert.equal(first.status, "DEGRADED");
  // Only the first intent was shown; the second was NOT processed after failure.
  assert.equal(counters.shown, 1);
  assert.deepEqual(counters.closed, ["driver-offer:a"]); // just-shown tag closed
  assert.ok(quarantine.has("driver-offer:a"));
  // Next reconcile (even if storage still failing): the quarantined intent is
  // never re-shown — no infinite 3s spam.
  const c2 = { shown: 0, closed: [] as string[] };
  const second = await reconcileNotificationDelivery(
    [intent("a")],
    quarantine,
    ports(store, new FakeLock(), c2),
  );
  assert.equal(c2.shown, 0);
  assert.equal(second.status, "OK");
});

// --- 7-9: no lock → no delivery, DEGRADED --------------------------------------

test("7-9: missing or failed lock runs no critical section and degrades", async () => {
  const store = new FakeLedgerStore();
  const counters = { shown: 0, closed: [] as string[] };
  const unavailable = await reconcileNotificationDelivery([intent("a")], new Set(), {
    ...ports(store, new FakeLock(), counters),
    runExclusive: async () => ({ ok: false, reason: "LOCK_UNAVAILABLE" }),
  });
  assert.equal(unavailable.status, "DEGRADED");
  assert.equal(counters.shown, 0);
  const c2 = { shown: 0, closed: [] as string[] };
  const failed = await reconcileNotificationDelivery([intent("a")], new Set(), {
    ...ports(store, new FakeLock(), c2),
    runExclusive: async () => ({ ok: false, reason: "LOCK_FAILED" }),
  });
  assert.equal(failed.status, "DEGRADED");
  assert.equal(c2.shown, 0);
  assert.deepEqual(store.snapshot(), []); // nothing persisted
});

// --- 10-11: concurrency — one show with lock, zero without ---------------------

test("10: two concurrent tabs with a working lock show exactly one", async () => {
  const store = new FakeLedgerStore();
  const lock = new FakeLock();
  const c1 = { shown: 0, closed: [] as string[] };
  const c2 = { shown: 0, closed: [] as string[] };
  await Promise.all([
    reconcileNotificationDelivery([intent("x")], new Set(), ports(store, lock, c1)),
    reconcileNotificationDelivery([intent("x")], new Set(), ports(store, lock, c2)),
  ]);
  assert.equal(c1.shown + c2.shown, 1);
  assert.deepEqual(store.snapshot(), ["driver-offer:x"]);
});

test("11: two tabs with no lock available show zero (not two)", async () => {
  const store = new FakeLedgerStore();
  const lock = new FakeLock();
  lock.available = false;
  const c1 = { shown: 0, closed: [] as string[] };
  const c2 = { shown: 0, closed: [] as string[] };
  const outcomes = await Promise.all([
    reconcileNotificationDelivery([intent("x")], new Set(), ports(store, lock, c1)),
    reconcileNotificationDelivery([intent("x")], new Set(), ports(store, lock, c2)),
  ]);
  assert.equal(c1.shown + c2.shown, 0);
  assert.ok(outcomes.every((o) => o.status === "DEGRADED"));
});

// --- 12-15: role-scoped ledgers ------------------------------------------------

test("12-15: driver by id; kitchen by restaurant+role; roles never share ledgers", () => {
  assert.equal(
    notificationAudienceScope({ type: "DRIVER", driverId: DRIVER }),
    `driver:${DRIVER}`,
  );
  const combined = notificationAudienceScope({
    type: "KITCHEN",
    restaurantId: REST,
    workspaceRole: "COMBINED",
  });
  const operator = notificationAudienceScope({
    type: "KITCHEN",
    restaurantId: REST,
    workspaceRole: "OPERATOR",
  });
  const kitchen = notificationAudienceScope({
    type: "KITCHEN",
    restaurantId: REST,
    workspaceRole: "KITCHEN",
  });
  assert.equal(combined, `kitchen:${REST}:COMBINED`);
  assert.equal(operator, `kitchen:${REST}:OPERATOR`);
  // All three roles are distinct scopes → separate ledgers, no cross-absorb.
  assert.equal(new Set([combined, operator, kitchen]).size, 3);
});

test("14-15: COMBINED and OPERATOR reconcile on independent ledgers", async () => {
  // Same restaurant, two roles, two separate stores (distinct scopes).
  const combinedStore = new FakeLedgerStore();
  const operatorStore = new FakeLedgerStore();
  const cc = { shown: 0, closed: [] as string[] };
  const oc = { shown: 0, closed: [] as string[] };
  const kInt = (role: string): DirectSystemNotificationIntent => ({
    key: `kitchen-actionable:${REST}:e1`,
    tag: `kitchen-actionable:${REST}:e1`,
    audience: { type: "KITCHEN", restaurantId: REST, workspaceRole: role as "COMBINED" },
    kind: "KITCHEN_NEW_ACTIONABLE_ORDER",
    entityKind: "KITCHEN_ORDER",
    entityId: "o1",
    title: "Новый заказ для кухни",
    body: "Заказ R-1 готов к работе.",
    targetUrl: "/restaurant/kitchen",
  });
  // COMBINED delivers; its store records the key.
  await reconcileNotificationDelivery([kInt("COMBINED")], new Set(), ports(combinedStore, new FakeLock(), cc));
  // OPERATOR has an EMPTY, independent ledger → it does NOT treat COMBINED's key
  // as delivered, and does NOT close it as stale on the combined ledger.
  await reconcileNotificationDelivery([], new Set(), ports(operatorStore, new FakeLock(), oc));
  assert.deepEqual(combinedStore.snapshot(), [`kitchen-actionable:${REST}:e1`]);
  assert.deepEqual(operatorStore.snapshot(), []);
  assert.deepEqual(oc.closed, []); // operator did not close combined's tag
});

// --- 18: recovery — a new intent is delivered exactly once ---------------------

test("18: after readiness recovers, a new intent is delivered once", async () => {
  const store = new FakeLedgerStore();
  const quarantine = new Set<string>();
  // Failing phase: intent A shown but write fails → quarantined.
  store.writeOk = false;
  const c1 = { shown: 0, closed: [] as string[] };
  await reconcileNotificationDelivery([intent("a")], quarantine, ports(store, new FakeLock(), c1));
  assert.ok(quarantine.has("driver-offer:a"));
  // Recovery: storage healthy again; a NEW intent B is delivered exactly once,
  // and the quarantined A is not re-shown.
  store.writeOk = true;
  const c2 = { shown: 0, closed: [] as string[] };
  const outcome = await reconcileNotificationDelivery(
    [intent("a"), intent("b")],
    quarantine,
    ports(store, new FakeLock(), c2),
  );
  assert.equal(outcome.status, "OK");
  assert.equal(c2.shown, 1);
  assert.deepEqual(store.snapshot(), ["driver-offer:b"]);
});

// --- 32-33: delivered key recorded only after a successful show ----------------

test("32-33: a failed show records nothing and is retried; a success records once", async () => {
  const store = new FakeLedgerStore();
  const counters = { shown: 0, closed: [] as string[] };
  // show fails → nothing persisted, retried later.
  await reconcileNotificationDelivery(
    [intent("a")],
    new Set(),
    ports(store, new FakeLock(), counters, () => false),
  );
  assert.equal(counters.shown, 0);
  assert.deepEqual(store.snapshot(), []);
  // show succeeds → persisted exactly once; a second run dedupes.
  const c2 = { shown: 0, closed: [] as string[] };
  await reconcileNotificationDelivery([intent("a")], new Set(), ports(store, new FakeLock(), c2));
  const c3 = { shown: 0, closed: [] as string[] };
  await reconcileNotificationDelivery([intent("a")], new Set(), ports(store, new FakeLock(), c3));
  assert.equal(c2.shown, 1);
  assert.equal(c3.shown, 0);
  assert.deepEqual(store.snapshot(), ["driver-offer:a"]);
});

// --- 16-17, 19-22: scope/purity source guarantees ------------------------------

const HOOK = readFileSync(
  "src/components/notifications/use-direct-system-notifications.ts",
  "utf8",
);
const RUNTIME = readFileSync(
  "src/components/notifications/notification-runtime.ts",
  "utf8",
);
const SW = readFileSync("public/direct-notifications-sw.js", "utf8");

test("1/16/17: enable only turns preference on after a durable write; no sound/state writes", () => {
  // Preference is set from the durable write result, not unconditionally.
  assert.ok(HOOK.includes("writeNotificationPreference(preferenceKey, true)"));
  assert.ok(HOOK.includes("setPreferenceEnabled(durable)"));
  assert.ok(!HOOK.includes('localStorage.setItem(preferenceKey, "1")'));
  // Degradation path never writes a sound preference or PrototypeState.
  for (const forbidden of [
    "direct-driver-offer-sound-enabled",
    "direct-kitchen-sound-enabled",
    "PrototypeState",
    "dispatch(",
  ]) {
    assert.ok(!HOOK.includes(forbidden), forbidden);
  }
});

test("7-8 (source): runtime lock has no unsynchronised fallback", () => {
  assert.ok(RUNTIME.includes("runWithNotificationLock"));
  assert.ok(RUNTIME.includes('reason: "LOCK_UNAVAILABLE"'));
  assert.ok(RUNTIME.includes('reason: "LOCK_FAILED"'));
  // The old "return fn()" fallback is gone.
  assert.ok(!RUNTIME.includes("if (!manager) return fn()"));
  assert.ok(!RUNTIME.includes("catch {\n    return fn();"));
});

test("20-22: service worker routes unchanged; no push/offline regressions", () => {
  for (const route of ["/driver", "/restaurant/kitchen", "/restaurant/operator"]) {
    assert.ok(SW.includes(route), route);
  }
  assert.ok(!SW.includes('addEventListener("fetch"'));
  assert.ok(!SW.includes("caches."));
  for (const source of [HOOK, RUNTIME, SW]) {
    for (const forbidden of ["PushManager", "VAPID", "navigator.onLine", "reconnect"]) {
      assert.ok(!source.includes(forbidden), forbidden);
    }
  }
});

// --- 23-24: CLOSE key removed only after a confirmed ACK ------------------------

test("23: a stale key is dropped only after its close is ACKed", async () => {
  const store = new FakeLedgerStore();
  store.write(["driver-offer:a"]); // previously delivered
  const counters = { shown: 0, closed: [] as string[] };
  const outcome = await reconcileNotificationDelivery(
    [], // no active intents → the delivered key is stale
    new Set<string>(),
    ports(store, new FakeLock(), counters, () => true, () => true),
  );
  assert.equal(outcome.status, "OK");
  assert.deepEqual(counters.closed, ["driver-offer:a"]); // close attempted
  assert.deepEqual(store.snapshot(), []); // ACKed → key removed
});

test("24: an un-ACKed close keeps the key for a later retry (fail-closed)", async () => {
  const store = new FakeLedgerStore();
  store.write(["driver-offer:a"]);
  const counters = { shown: 0, closed: [] as string[] };
  const outcome = await reconcileNotificationDelivery(
    [],
    new Set<string>(),
    ports(store, new FakeLock(), counters, () => true, () => false), // close not ACKed
  );
  assert.equal(outcome.status, "OK");
  assert.deepEqual(counters.closed, ["driver-offer:a"]); // close was attempted
  assert.deepEqual(store.snapshot(), ["driver-offer:a"]); // NOT ACKed → key retained
});
