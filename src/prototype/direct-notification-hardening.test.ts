import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  normalizeLedgerEntries,
  notificationAudienceScope,
  reconcileNotificationDelivery,
  resolveDirectNotificationCapability,
  upsertLedgerEntry,
  NOTIFICATION_LEDGER_MAX,
  type BrowserStorageReadResult,
  type DirectSystemNotificationIntent,
  type NotificationDeliveryPorts,
  type NotificationLedgerEntry,
  type NotificationLockResult,
} from "./direct-notifications.ts";

/**
 * Durable two-phase (PENDING → DELIVERED) delivery ledger, driven through the
 * pure reconciler with a fake async worker (SHOW/CLOSE ACK booleans), a SHARED
 * entry ledger and a serializing lock — including concurrent two-tab runs. Order
 * of operations (write:PENDING → show → ack → write:DELIVERED) and every failure
 * path are asserted; the ACK protocol itself is tested in
 * direct-notification-ack.test.ts and is intentionally not re-implemented here.
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

/** Shared fake entry-ledger simulating one browser profile's localStorage. */
class FakeLedgerStore {
  entries: NotificationLedgerEntry[] = [];
  readMode: "ok" | "unavailable" | "invalid" = "ok";
  private writeQueue: boolean[] | null = null;
  writes = 0;

  setWriteResults(results: boolean[]): void {
    this.writeQueue = [...results];
  }
  read(): BrowserStorageReadResult<NotificationLedgerEntry[]> {
    if (this.readMode === "unavailable") return { ok: false, error: "UNAVAILABLE" };
    if (this.readMode === "invalid") return { ok: false, error: "INVALID_DATA" };
    return { ok: true, value: this.entries.map((e) => ({ ...e })) };
  }
  write(next: NotificationLedgerEntry[]): boolean {
    this.writes += 1;
    const ok = this.writeQueue ? this.writeQueue.shift() ?? true : true;
    if (ok) this.entries = next.map((e) => ({ ...e }));
    return ok;
  }
  states(): string[] {
    return this.entries.map((e) => `${e.key}:${e.state}`);
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
      return { ok: true, value: await fn() };
    } finally {
      release();
    }
  }
}

interface Counters {
  shown: number;
  closed: string[];
  sequence: string[];
}
const newCounters = (): Counters => ({ shown: 0, closed: [], sequence: [] });

function ports(
  store: FakeLedgerStore,
  lock: FakeLock,
  counters: Counters,
  showAck: (i: DirectSystemNotificationIntent) => boolean | Promise<boolean> = () => true,
  closeAck: (tag: string) => boolean = () => true,
): NotificationDeliveryPorts {
  return {
    readLedger: () => store.read(),
    writeLedger: (entries) => {
      const ok = store.write(entries);
      counters.sequence.push(
        `write:${entries.map((e) => e.state).join(",") || "empty"}`,
      );
      return ok;
    },
    show: async (i) => {
      counters.sequence.push("show");
      const ack = await showAck(i);
      counters.sequence.push(ack ? "ack" : "nack");
      if (ack) counters.shown += 1;
      return ack;
    },
    close: async (tag) => {
      counters.closed.push(tag);
      return closeAck(tag);
    },
    runExclusive: (fn) => lock.run(fn),
  };
}

// --- 1-3: migration / empty / corrupt ------------------------------------------

test("1: legacy string[] ledger migrates to DELIVERED entries", () => {
  assert.deepEqual(normalizeLedgerEntries(["driver-offer:a", "driver-offer:b"]), [
    { key: "driver-offer:a", tag: "driver-offer:a", state: "DELIVERED" },
    { key: "driver-offer:b", tag: "driver-offer:b", state: "DELIVERED" },
  ]);
  // Mixed structured + legacy + junk: keep valid, drop junk, de-dupe by key.
  assert.deepEqual(
    normalizeLedgerEntries([
      "k1",
      { key: "k2", tag: "t2", state: "PENDING" },
      { key: "k1", tag: "k1", state: "DELIVERED" },
      { nope: true },
      42,
    ]),
    [
      { key: "k1", tag: "k1", state: "DELIVERED" },
      { key: "k2", tag: "t2", state: "PENDING" },
    ],
  );
});

test("2-3: empty ledger reads as []; corrupt ledger degrades (not empty)", async () => {
  assert.deepEqual(normalizeLedgerEntries([]), []);
  for (const mode of ["unavailable", "invalid"] as const) {
    const store = new FakeLedgerStore();
    store.readMode = mode;
    const counters = newCounters();
    const outcome = await reconcileNotificationDelivery(
      [intent("a")],
      new Set(),
      ports(store, new FakeLock(), counters),
    );
    assert.equal(outcome.status, "DEGRADED");
    assert.equal(counters.shown, 0);
  }
});

// --- 4-8: PENDING → SHOW → ACK → DELIVERED ordering -----------------------------

test("4/6/7/8: exact order write:PENDING → show → ack → write:DELIVERED", async () => {
  const store = new FakeLedgerStore();
  const counters = newCounters();
  let statesAtShow: string[] = [];
  const outcome = await reconcileNotificationDelivery(
    [intent("a")],
    new Set(),
    ports(store, new FakeLock(), counters, () => {
      statesAtShow = store.states(); // PENDING is durable before show returns
      return true;
    }),
  );
  assert.equal(outcome.status, "OK");
  assert.deepEqual(counters.sequence, [
    "write:PENDING",
    "show",
    "ack",
    "write:DELIVERED",
  ]);
  assert.deepEqual(statesAtShow, ["driver-offer:a:PENDING"]);
  assert.deepEqual(store.states(), ["driver-offer:a:DELIVERED"]);
});

test("5: a failed PENDING write shows nothing", async () => {
  const store = new FakeLedgerStore();
  store.setWriteResults([false]); // PENDING write fails
  const counters = newCounters();
  const outcome = await reconcileNotificationDelivery(
    [intent("a")],
    new Set(),
    ports(store, new FakeLock(), counters),
  );
  assert.equal(counters.shown, 0);
  assert.equal(outcome.status, "DEGRADED");
  assert.deepEqual(store.states(), []);
  assert.deepEqual(counters.sequence, ["write:PENDING"]); // no show attempted
});

test("8b: DELIVERED is never written before an ACK", async () => {
  const store = new FakeLedgerStore();
  const outcome = await reconcileNotificationDelivery(
    [intent("a")],
    new Set(),
    ports(store, new FakeLock(), newCounters(), () => false),
  );
  assert.equal(outcome.status, "DEGRADED");
  assert.ok(!store.states().includes("driver-offer:a:DELIVERED"));
});

// --- 9-10: ACK failure removes PENDING; failed cleanup keeps it -----------------

test("9: no ACK with a successful cleanup removes PENDING (retryable)", async () => {
  const store = new FakeLedgerStore();
  const outcome = await reconcileNotificationDelivery(
    [intent("a")],
    new Set(),
    ports(store, new FakeLock(), newCounters(), () => false),
  );
  assert.equal(outcome.status, "DEGRADED");
  assert.deepEqual(store.states(), []); // PENDING cleaned up → retryable
});

test("10: no ACK with a failed cleanup keeps PENDING as a fail-closed block", async () => {
  const store = new FakeLedgerStore();
  store.setWriteResults([true, false]); // PENDING ok, cleanup fails
  const quarantine = new Set<string>();
  const outcome = await reconcileNotificationDelivery(
    [intent("a")],
    quarantine,
    ports(store, new FakeLock(), newCounters(), () => false),
  );
  assert.equal(outcome.status, "DEGRADED");
  assert.deepEqual(store.states(), ["driver-offer:a:PENDING"]);
  assert.ok(quarantine.has("driver-offer:a"));
  // A later run still sees the durable PENDING and does not re-show.
  const c2 = newCounters();
  await reconcileNotificationDelivery([intent("a")], new Set(), ports(store, new FakeLock(), c2));
  assert.equal(c2.shown, 0);
});

// --- 11-15: failed final write / cross-tab exactly-once ------------------------

test("11-12: failed final write keeps durable PENDING and closes the shown tag", async () => {
  const store = new FakeLedgerStore();
  store.setWriteResults([true, false]); // PENDING ok, DELIVERED fails
  const q = new Set<string>();
  const counters = newCounters();
  const outcome = await reconcileNotificationDelivery(
    [intent("x")],
    q,
    ports(store, new FakeLock(), counters),
  );
  assert.equal(outcome.status, "DEGRADED");
  assert.equal(counters.shown, 1);
  assert.deepEqual(counters.closed, ["driver-offer:x"]); // CLOSE attempted + awaited
  assert.deepEqual(store.states(), ["driver-offer:x:PENDING"]); // durable PENDING kept
  assert.ok(q.has("driver-offer:x"));
});

test("13/15: a second tab / reload sees durable PENDING and does not re-show", async () => {
  const store = new FakeLedgerStore();
  store.entries = [{ key: "driver-offer:x", tag: "driver-offer:x", state: "PENDING" }];
  const counters = newCounters();
  await reconcileNotificationDelivery(
    [intent("x")],
    new Set(),
    ports(store, new FakeLock(), counters),
  );
  assert.equal(counters.shown, 0);
});

test("14: two tabs with a failed final write show at most once", async () => {
  const store = new FakeLedgerStore();
  store.setWriteResults([true, false]); // first tab: PENDING ok, DELIVERED fails
  const lock = new FakeLock();
  const c1 = newCounters();
  const c2 = newCounters();
  await Promise.all([
    reconcileNotificationDelivery([intent("x")], new Set(), ports(store, lock, c1)),
    reconcileNotificationDelivery([intent("x")], new Set(), ports(store, lock, c2)),
  ]);
  assert.equal(c1.shown + c2.shown, 1);
  assert.deepEqual(store.states(), ["driver-offer:x:PENDING"]);
});

// --- 16, 23: dedupe of DELIVERED and same-role two-tab -------------------------

test("16/23: a DELIVERED key is never re-shown; two same-role tabs show once", async () => {
  const store = new FakeLedgerStore();
  const lock = new FakeLock();
  const c1 = newCounters();
  const c2 = newCounters();
  await Promise.all([
    reconcileNotificationDelivery([intent("x")], new Set(), ports(store, lock, c1)),
    reconcileNotificationDelivery([intent("x")], new Set(), ports(store, lock, c2)),
  ]);
  assert.equal(c1.shown + c2.shown, 1);
  assert.deepEqual(store.states(), ["driver-offer:x:DELIVERED"]);
  // A third pass never re-shows the DELIVERED key.
  const c3 = newCounters();
  await reconcileNotificationDelivery([intent("x")], new Set(), ports(store, new FakeLock(), c3));
  assert.equal(c3.shown, 0);
});

// --- 17-18: stale DELIVERED removed only after a confirmed CLOSE_ACK -----------

test("17: a stale DELIVERED entry is removed only after a confirmed CLOSE_ACK", async () => {
  const store = new FakeLedgerStore();
  store.entries = [{ key: "driver-offer:a", tag: "driver-offer:a", state: "DELIVERED" }];
  const counters = newCounters();
  const outcome = await reconcileNotificationDelivery(
    [], // no active intents → stale
    new Set(),
    ports(store, new FakeLock(), counters, () => true, () => true),
  );
  assert.equal(outcome.status, "OK");
  assert.deepEqual(counters.closed, ["driver-offer:a"]);
  assert.deepEqual(store.states(), []); // ACKed → removed
});

test("18: a failed CLOSE_ACK keeps the DELIVERED entry (retry later)", async () => {
  const store = new FakeLedgerStore();
  store.entries = [{ key: "driver-offer:a", tag: "driver-offer:a", state: "DELIVERED" }];
  const counters = newCounters();
  const outcome = await reconcileNotificationDelivery(
    [],
    new Set(),
    ports(store, new FakeLock(), counters, () => true, () => false), // close not ACKed
  );
  assert.equal(outcome.status, "OK");
  assert.deepEqual(counters.closed, ["driver-offer:a"]);
  assert.deepEqual(store.states(), ["driver-offer:a:DELIVERED"]); // retained
});

// --- 19: bounded + deterministic prune -----------------------------------------

test("19: ledger stays bounded (migration + upsert prune oldest)", () => {
  const raw = Array.from({ length: NOTIFICATION_LEDGER_MAX + 5 }, (_, i) => `k${i}`);
  const migrated = normalizeLedgerEntries(raw);
  assert.equal(migrated.length, NOTIFICATION_LEDGER_MAX);
  assert.equal(migrated[0].key, "k5");
  let entries: NotificationLedgerEntry[] = [];
  for (let i = 0; i < NOTIFICATION_LEDGER_MAX + 3; i += 1) {
    entries = upsertLedgerEntry(entries, { key: `u${i}`, tag: `u${i}`, state: "DELIVERED" });
  }
  assert.equal(entries.length, NOTIFICATION_LEDGER_MAX);
  assert.equal(entries[0].key, "u3");
});

// --- 20-22: role-scoped tags + ledger isolation --------------------------------

function kitchenIntent(role: "COMBINED" | "OPERATOR"): DirectSystemNotificationIntent {
  const tag = `kitchen-actionable:${REST}:${role}:e1`;
  return {
    key: tag,
    tag,
    audience: { type: "KITCHEN", restaurantId: REST, workspaceRole: role },
    kind: "KITCHEN_NEW_ACTIONABLE_ORDER",
    entityKind: "KITCHEN_ORDER",
    entityId: "o1",
    title: "Новый заказ для кухни",
    body: "Заказ R-1 готов к работе.",
    targetUrl: role === "OPERATOR" ? "/restaurant/operator" : "/restaurant/kitchen",
  };
}

test("20-22: COMBINED and OPERATOR use different tags/scopes and independent ledgers", async () => {
  assert.notEqual(kitchenIntent("COMBINED").tag, kitchenIntent("OPERATOR").tag);
  assert.notEqual(
    notificationAudienceScope({ type: "KITCHEN", restaurantId: REST, workspaceRole: "COMBINED" }),
    notificationAudienceScope({ type: "KITCHEN", restaurantId: REST, workspaceRole: "OPERATOR" }),
  );
  const combinedStore = new FakeLedgerStore();
  const operatorStore = new FakeLedgerStore();
  const cc = newCounters();
  const oc = newCounters();
  await reconcileNotificationDelivery([kitchenIntent("COMBINED")], new Set(), ports(combinedStore, new FakeLock(), cc));
  // OPERATOR reconciles its own empty ledger with only its own intent active: it
  // neither absorbs nor closes COMBINED's entry.
  await reconcileNotificationDelivery([kitchenIntent("OPERATOR")], new Set(), ports(operatorStore, new FakeLock(), oc));
  assert.deepEqual(combinedStore.states(), [`kitchen-actionable:${REST}:COMBINED:e1:DELIVERED`]);
  assert.deepEqual(operatorStore.states(), [`kitchen-actionable:${REST}:OPERATOR:e1:DELIVERED`]);
  assert.deepEqual(cc.closed, []);
  assert.deepEqual(oc.closed, []);
});

// --- lock fail-closed (no unsynchronised fallback) -----------------------------

test("lock: missing/failed lock runs no critical section and degrades", async () => {
  const store = new FakeLedgerStore();
  for (const reason of ["LOCK_UNAVAILABLE", "LOCK_FAILED"] as const) {
    const counters = newCounters();
    const outcome = await reconcileNotificationDelivery([intent("a")], new Set(), {
      ...ports(store, new FakeLock(), counters),
      runExclusive: async () => ({ ok: false, reason }),
    });
    assert.equal(outcome.status, "DEGRADED");
    assert.equal(counters.shown, 0);
  }
  assert.deepEqual(store.states(), []);
});

// --- capability still fail-closed ----------------------------------------------

test("capability: ENABLED only when every readiness input holds", () => {
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
  for (const gap of [
    { ledgerStorageReady: false },
    { preferenceStorageReady: false },
    { lockReady: false },
    { deliveryFailed: true },
    { workerReady: false },
  ]) {
    assert.equal(
      resolveDirectNotificationCapability({ ...base, ...gap }).status,
      "DEGRADED",
      JSON.stringify(gap),
    );
  }
  assert.equal(
    resolveDirectNotificationCapability({ ...base, preferenceEnabled: false }).status,
    "DISABLED",
  );
});

// --- 24-32 (source): unchanged accepted areas ----------------------------------

const HOOK = readFileSync("src/components/notifications/use-direct-system-notifications.ts", "utf8");
const RUNTIME = readFileSync("src/components/notifications/notification-runtime.ts", "utf8");
const SW = readFileSync("public/direct-notifications-sw.js", "utf8");
const CORE = readFileSync("src/prototype/direct-notifications.ts", "utf8");

test("28-30 (source): enable needs a durable write; no sound/state writes; ledger migrates", () => {
  assert.ok(HOOK.includes("writeNotificationPreference(preferenceKey, true)"));
  assert.ok(HOOK.includes("setPreferenceEnabled(durable)"));
  assert.ok(RUNTIME.includes("normalizeLedgerEntries"));
  for (const forbidden of [
    "direct-driver-offer-sound-enabled",
    "direct-kitchen-sound-enabled",
    "PrototypeState",
    "dispatch(",
  ]) {
    assert.ok(!HOOK.includes(forbidden), forbidden);
  }
});

test("31-32 (source): ACK protocol kept; no push/VAPID/backend/offline", () => {
  // The accepted MessageChannel ACK is reused, not replaced.
  assert.ok(RUNTIME.includes("requestWorkerAck"));
  assert.ok(SW.includes("event.ports"));
  assert.ok(CORE.includes("kitchen-actionable:${restaurantId}:${workspaceRole}:${evidenceId}"));
  assert.ok(!SW.includes('addEventListener("fetch"'));
  assert.ok(!SW.includes("caches."));
  for (const source of [HOOK, RUNTIME, SW]) {
    for (const forbidden of ["PushManager", "VAPID", "navigator.onLine", "reconnect"]) {
      assert.ok(!source.includes(forbidden), forbidden);
    }
  }
});
