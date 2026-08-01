import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ledgerStorageKeyFor,
  readMigratedLedger,
  type LedgerStorage,
} from "./notification-ledger-storage.ts";

/**
 * Storage-key migration adapter, tested over a REAL two-key store (not just the
 * pure value parser): the old shared kitchen key
 * `direct-notification-ledger:kitchen:<restaurantId>` migrates into the new
 * role-scoped key `…:kitchen:<restaurantId>:<workspaceRole>` without deleting the
 * old key, so both COMBINED and OPERATOR can migrate independently.
 */

const REST = "restaurant-2";
const COMBINED_SCOPE = `kitchen:${REST}:COMBINED`;
const OPERATOR_SCOPE = `kitchen:${REST}:OPERATOR`;
const DRIVER_SCOPE = "driver:driver-1";
const LEGACY_SCOPE = `kitchen:${REST}`;

const NEW_COMBINED = ledgerStorageKeyFor(COMBINED_SCOPE);
const NEW_OPERATOR = ledgerStorageKeyFor(OPERATOR_SCOPE);
const LEGACY_KEY = ledgerStorageKeyFor(LEGACY_SCOPE);
const DRIVER_KEY = ledgerStorageKeyFor(DRIVER_SCOPE);

/** Fake localStorage-like store with per-key read/write failure injection. */
class FakeStorage implements LedgerStorage {
  map = new Map<string, string>();
  readFail = new Set<string>();
  writeFail = new Set<string>();
  reads: string[] = [];
  writes: string[] = [];

  read(storageKey: string): { ok: true; raw: string | null } | { ok: false } {
    this.reads.push(storageKey);
    if (this.readFail.has(storageKey)) return { ok: false };
    return { ok: true, raw: this.map.has(storageKey) ? this.map.get(storageKey)! : null };
  }
  write(storageKey: string, value: string): boolean {
    this.writes.push(storageKey);
    if (this.writeFail.has(storageKey)) return false;
    this.map.set(storageKey, value);
    return true;
  }
}

const LEGACY_TAG = `kitchen-actionable:${REST}:evt-1`;

// --- 1-4: old shared key → new role-scoped key, both roles independent ---------

test("1: old shared kitchen key migrates into the new COMBINED key", () => {
  const store = new FakeStorage();
  store.map.set(LEGACY_KEY, JSON.stringify([LEGACY_TAG]));
  const result = readMigratedLedger(store, COMBINED_SCOPE);
  assert.ok(result.ok);
  assert.deepEqual(result.value, [
    { key: `kitchen-actionable:${REST}:COMBINED:evt-1`, tag: LEGACY_TAG, state: "DELIVERED" },
  ]);
  // Durably written to the NEW key.
  assert.ok(store.map.has(NEW_COMBINED));
  assert.deepEqual(JSON.parse(store.map.get(NEW_COMBINED)!), result.value);
});

test("2: old shared kitchen key migrates into the new OPERATOR key", () => {
  const store = new FakeStorage();
  store.map.set(LEGACY_KEY, JSON.stringify([LEGACY_TAG]));
  const result = readMigratedLedger(store, OPERATOR_SCOPE);
  assert.ok(result.ok);
  assert.deepEqual(result.value, [
    { key: `kitchen-actionable:${REST}:OPERATOR:evt-1`, tag: LEGACY_TAG, state: "DELIVERED" },
  ]);
  assert.ok(store.map.has(NEW_OPERATOR));
});

test("3: migration does not delete the shared key before/after writing the new key", () => {
  const store = new FakeStorage();
  store.map.set(LEGACY_KEY, JSON.stringify([LEGACY_TAG]));
  readMigratedLedger(store, COMBINED_SCOPE);
  assert.ok(store.map.has(LEGACY_KEY)); // legacy key retained
});

test("4: COMBINED migration does not stop OPERATOR from migrating", () => {
  const store = new FakeStorage();
  store.map.set(LEGACY_KEY, JSON.stringify([LEGACY_TAG]));
  readMigratedLedger(store, COMBINED_SCOPE);
  const operator = readMigratedLedger(store, OPERATOR_SCOPE);
  assert.ok(operator.ok);
  assert.ok(store.map.has(NEW_COMBINED));
  assert.ok(store.map.has(NEW_OPERATOR));
  assert.ok(store.map.has(LEGACY_KEY)); // still there for whoever migrates last
});

// --- 5-6: new key wins; corrupt new key never falls back -----------------------

test("5: when the new key exists, the old key is neither read nor mixed in", () => {
  const store = new FakeStorage();
  const newEntries = [
    { key: `kitchen-actionable:${REST}:COMBINED:evt-1`, tag: `kitchen-actionable:${REST}:COMBINED:evt-1`, state: "DELIVERED" },
  ];
  store.map.set(NEW_COMBINED, JSON.stringify(newEntries));
  store.map.set(LEGACY_KEY, JSON.stringify(["kitchen-actionable:" + REST + ":other"]));
  const result = readMigratedLedger(store, COMBINED_SCOPE);
  assert.ok(result.ok);
  assert.deepEqual(result.value, newEntries);
  assert.ok(!store.reads.includes(LEGACY_KEY)); // legacy key never consulted
});

test("6: a corrupt new key is INVALID_DATA with no fallback to the old key", () => {
  const store = new FakeStorage();
  store.map.set(NEW_COMBINED, "{ not json");
  store.map.set(LEGACY_KEY, JSON.stringify([LEGACY_TAG])); // valid, must be ignored
  const result = readMigratedLedger(store, COMBINED_SCOPE);
  assert.deepEqual(result, { ok: false, error: "INVALID_DATA" });
  assert.ok(!store.reads.includes(LEGACY_KEY));
});

// --- 7-8: corrupt/failed migration -------------------------------------------

test("7: a corrupt old key is INVALID_DATA (never a silent empty ledger)", () => {
  const store = new FakeStorage();
  store.map.set(LEGACY_KEY, JSON.stringify([{ nope: true }]));
  assert.deepEqual(readMigratedLedger(store, COMBINED_SCOPE), {
    ok: false,
    error: "INVALID_DATA",
  });
});

test("8: a failed write of the new key does not persist the migration", () => {
  const store = new FakeStorage();
  store.map.set(LEGACY_KEY, JSON.stringify([LEGACY_TAG]));
  store.writeFail.add(NEW_COMBINED);
  const result = readMigratedLedger(store, COMBINED_SCOPE);
  assert.ok(result.ok); // read still yields migrated entries in-memory
  assert.ok(!store.map.has(NEW_COMBINED)); // but the new key was NOT persisted
  assert.ok(store.map.has(LEGACY_KEY)); // legacy retained for a later retry
});

// --- 9-11: migrated identity (key for dedupe, tag for close) -------------------

test("9-11: migrated entry has role-scoped key, legacy tag, colon-safe evidence", () => {
  const evidence = "o-rev:2026-07-31T10:00:00.000Z";
  const legacy = `kitchen-actionable:${REST}:${evidence}`;
  const store = new FakeStorage();
  store.map.set(LEGACY_KEY, JSON.stringify([legacy]));
  const result = readMigratedLedger(store, COMBINED_SCOPE);
  assert.ok(result.ok);
  assert.deepEqual(result.value, [
    {
      key: `kitchen-actionable:${REST}:COMBINED:${evidence}`, // dedupe by key
      tag: legacy, // close the old OS notification by its original tag
      state: "DELIVERED",
    },
  ]);
});

// --- 12-14: driver / unavailable / other-audience -----------------------------

test("12: legacy driver string[] value migrates in place (unchanged key/tag)", () => {
  const store = new FakeStorage();
  store.map.set(DRIVER_KEY, JSON.stringify(["driver-offer:a"]));
  const result = readMigratedLedger(store, DRIVER_SCOPE);
  assert.ok(result.ok);
  assert.deepEqual(result.value, [
    { key: "driver-offer:a", tag: "driver-offer:a", state: "DELIVERED" },
  ]);
  // Driver scope never had a role-less variant → no second (legacy) key is read.
  assert.deepEqual(store.reads, [DRIVER_KEY]);
});

test("13: arbitrary driver string is INVALID_DATA", () => {
  const store = new FakeStorage();
  store.map.set(DRIVER_KEY, JSON.stringify(["whatever"]));
  assert.deepEqual(readMigratedLedger(store, DRIVER_SCOPE), {
    ok: false,
    error: "INVALID_DATA",
  });
});

test("14: a structured entry from another audience is INVALID_DATA", () => {
  const store = new FakeStorage();
  store.map.set(
    NEW_COMBINED,
    JSON.stringify([{ key: "driver-offer:a", tag: "driver-offer:a", state: "DELIVERED" }]),
  );
  assert.deepEqual(readMigratedLedger(store, COMBINED_SCOPE), {
    ok: false,
    error: "INVALID_DATA",
  });
});

test("empty stores read as valid empty ledgers", () => {
  const store = new FakeStorage();
  assert.deepEqual(readMigratedLedger(store, COMBINED_SCOPE), { ok: true, value: [] });
  assert.deepEqual(readMigratedLedger(store, DRIVER_SCOPE), { ok: true, value: [] });
});

test("an unreadable store is UNAVAILABLE (new or legacy key)", () => {
  const primaryFail = new FakeStorage();
  primaryFail.readFail.add(NEW_COMBINED);
  assert.deepEqual(readMigratedLedger(primaryFail, COMBINED_SCOPE), {
    ok: false,
    error: "UNAVAILABLE",
  });
  const legacyFail = new FakeStorage();
  legacyFail.readFail.add(LEGACY_KEY); // new key absent → legacy read fails
  assert.deepEqual(readMigratedLedger(legacyFail, COMBINED_SCOPE), {
    ok: false,
    error: "UNAVAILABLE",
  });
});
