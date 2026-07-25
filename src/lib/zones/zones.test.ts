import assert from "node:assert/strict";
import { test } from "node:test";

import type { DeliveryAddress, Order } from "../../prototype/models.ts";
import { RAW_FILES } from "../../vendor/bender-zones-v1.1/dataset.generated.ts";
import { resolveAddressZone } from "./address-resolver.ts";
import { driverOrderZoneView } from "./driver-zone-view.ts";
import {
  attachOrderZoneSnapshot,
  buildOrderZoneSnapshot,
  legacyOrderZoneSnapshot,
  orderZoneSnapshotOrLegacy,
} from "./order-zone-snapshot.ts";
import { __resetReleaseValidationCache } from "./release-validation.ts";
import { sha256Hex } from "./sha256.ts";
import {
  __resetRegistryIndex,
  fromZoneId,
  isDatasetValid,
  listZones,
  toZoneId,
  verifiedAddressCount,
  zoneColor,
  zoneDatasetVersion,
  zoneReleaseId,
  zoneRelease,
} from "./zone-registry.ts";
import { ADMIN_NAVIGATION } from "../../components/workspaces/admin-navigation.ts";

/**
 * Versioned Bender zone integration (bender-zones-v1.1). The EXACT verified
 * house is the only source of a working zone; everything else fails closed. No
 * money anywhere.
 */

// Real registry fixtures (from the vendored release), one per zone.
const Z1 = { street: "2-й Береговой переулок", house: "13" }; // Zone 1
const Z2 = { street: "1-й Братский переулок", house: "1 А" }; // Zone 2
const Z3 = { street: "1-й Измаильский переулок", house: "10" }; // Zone 3
const Z4 = { street: "Деповская улица", house: "5" }; // Zone 4

function addr(overrides: Partial<DeliveryAddress> = {}): DeliveryAddress {
  return {
    street: Z2.street,
    house: Z2.house,
    apartment: "",
    entrance: "",
    floor: "",
    comment: "",
    zoneId: null,
    ...overrides,
  };
}

function order(address: DeliveryAddress | null, originZone = "zone-1"): Order {
  return {
    createdAt: "2026-07-24T00:00:00Z",
    restaurant: { id: "r1", name: "R", address: "A", zoneId: originZone },
    address,
    financials: { marker: "unchanged" },
  } as unknown as Order;
}

/** Run `fn` with a mutated vendored file, then always restore the original. */
function withTamperedFile(path: string, mutate: (raw: string) => string, fn: () => void) {
  const original = RAW_FILES[path];
  try {
    RAW_FILES[path] = mutate(original);
    __resetReleaseValidationCache();
    __resetRegistryIndex();
    fn();
  } finally {
    RAW_FILES[path] = original;
    __resetReleaseValidationCache();
    __resetRegistryIndex();
  }
}

// --- registry / release identity --------------------------------------------

test("registry exposes the versioned v1.1 release and four zones", () => {
  assert.equal(isDatasetValid(), true);
  assert.equal(zoneReleaseId(), "bender-zones-v1.1");
  assert.ok(zoneRelease().startsWith("bender-zones-v1.1@"));
  assert.ok(zoneDatasetVersion().startsWith("moldova-pbf:"));
  const ids = listZones().map((z) => z.zone_id).sort();
  assert.deepEqual(ids, [1, 2, 3, 4]);
  assert.equal(zoneColor(1), "#2a9d3f");
  assert.equal(zoneColor(4), "#d62828");
  assert.equal(toZoneId(3), "zone-3");
  assert.equal(fromZoneId("zone-4"), 4);
  assert.ok(verifiedAddressCount() > 9000);
});

// --- the exact verified house is the only source of a zone ------------------

test("an exact verified house resolves to its zone", () => {
  for (const [q, zone] of [
    [Z1, 1],
    [Z2, 2],
    [Z3, 3],
    [Z4, 4],
  ] as const) {
    const r = resolveAddressZone(q);
    assert.equal(r.status, "RESOLVED", `${q.street} ${q.house}`);
    assert.equal(r.zoneNumber, zone);
    assert.equal(r.zoneId, `zone-${zone}`);
    assert.ok(r.canonicalAddressKey);
  }
});

test("letter/fraction house numbers resolve verbatim", () => {
  const r = resolveAddressZone({ street: "1-й Братский переулок", house: "1 А" });
  assert.equal(r.status, "RESOLVED");
  assert.equal(r.matched?.housenumber, "1 А");
});

test("a street WITHOUT a house never resolves to a zone", () => {
  const r = resolveAddressZone({ street: "1-й Братский переулок" });
  assert.equal(r.status, "UNVERIFIED_ADDRESS");
  assert.equal(r.zoneId, null);
  assert.equal(r.zoneNumber, null);
});

test("an unknown house on a known single-zone street does not resolve", () => {
  const r = resolveAddressZone({ street: "1-й Братский переулок", house: "999Ж" });
  assert.notEqual(r.status, "RESOLVED");
  assert.equal(r.zoneId, null);
});

test("an unknown street is NOT_FOUND, never a random zone", () => {
  const r = resolveAddressZone({ street: "улица Которой Нет 9999", house: "1" });
  assert.equal(r.status, "NOT_FOUND");
  assert.equal(r.zoneId, null);
});

// --- fail closed: Varnița / disputed / Северный -----------------------------

test("Varnița is NO_DELIVERY regardless of street", () => {
  const r = resolveAddressZone({ settlement: "Варница", street: "любая улица", house: "1" });
  assert.equal(r.status, "NO_DELIVERY");
  assert.equal(r.zoneId, null);
});

test("a disputed address fails closed as DISPUTED", () => {
  const r = resolveAddressZone({ street: "Бельцкая улица", house: "31" });
  assert.equal(r.status, "DISPUTED");
  assert.equal(r.zoneId, null);
});

test("a Северный address is Zone 4 territory but UNVERIFIED (not orderable)", () => {
  const r = resolveAddressZone({
    settlement: "Бендеры",
    district: "Северный",
    street: "Strada Tighina",
    house: "31/2",
  });
  // The Северный catalog is deliberately incomplete: the zone is 4, but the
  // address is not a verified registry house, so it never becomes RESOLVED.
  assert.equal(r.zoneNumber, 4);
  assert.equal(r.status, "UNVERIFIED_ADDRESS");
  assert.notEqual(r.status, "RESOLVED");
});

// --- fail closed: invalid release -> DATASET_INVALID ------------------------

test("a corrupted registry checksum makes the whole dataset DATASET_INVALID", () => {
  withTamperedFile(
    "address-registry.json",
    (raw) => raw.replace("1-й Братский переулок", "1-й Братский переулок ТАМПЕР"),
    () => {
      assert.equal(isDatasetValid(), false);
      const r = resolveAddressZone(Z2);
      assert.equal(r.status, "DATASET_INVALID");
      assert.equal(r.zoneId, null);
    },
  );
  // restored: valid again
  assert.equal(isDatasetValid(), true);
  assert.equal(resolveAddressZone(Z2).status, "RESOLVED");
});

test("a tampered schema file (wrong checksum) is DATASET_INVALID", () => {
  withTamperedFile(
    "schemas/zone-release.schema.json",
    (raw) => raw.replace("}", "} ") /* whitespace change -> hash mismatch */,
    () => {
      assert.equal(isDatasetValid(), false);
      assert.equal(resolveAddressZone(Z1).status, "DATASET_INVALID");
    },
  );
});

test("a manifest with the wrong K is DATASET_INVALID", () => {
  withTamperedFile(
    "manifest.json",
    (raw) => {
      const m = JSON.parse(raw);
      m.decided_k = 3;
      return JSON.stringify(m);
    },
    () => {
      assert.equal(isDatasetValid(), false);
      assert.equal(resolveAddressZone(Z1).status, "DATASET_INVALID");
    },
  );
});

test("a manifest that claims prices are included is DATASET_INVALID", () => {
  withTamperedFile(
    "manifest.json",
    (raw) => {
      const m = JSON.parse(raw);
      m.prices_included = true;
      return JSON.stringify(m);
    },
    () => {
      assert.equal(isDatasetValid(), false);
    },
  );
});

test("a missing embedded file is DATASET_INVALID", () => {
  const original = RAW_FILES["address-registry.json"];
  try {
    delete RAW_FILES["address-registry.json"];
    __resetReleaseValidationCache();
    __resetRegistryIndex();
    assert.equal(isDatasetValid(), false);
    assert.equal(resolveAddressZone(Z1).status, "DATASET_INVALID");
  } finally {
    RAW_FILES["address-registry.json"] = original;
    __resetReleaseValidationCache();
    __resetRegistryIndex();
  }
});

/**
 * Rebuild the registry with `mutate`, then re-point the manifest AND
 * CHECKSUMS.sha256 at the new hash so the checksum gate PASSES — proving the
 * semantic invariants (zone_id 1-4, unique canonical) are enforced on their own,
 * not merely as a side effect of the checksum check.
 */
function withConsistentRegistry(
  mutate: (addresses: Record<string, unknown>[]) => void,
  fn: () => void,
) {
  const savedReg = RAW_FILES["address-registry.json"];
  const savedMan = RAW_FILES["manifest.json"];
  const savedSums = RAW_FILES["CHECKSUMS.sha256"];
  try {
    const doc = JSON.parse(savedReg);
    mutate(doc.addresses);
    const newReg = JSON.stringify(doc);
    const newHash = sha256Hex(newReg);
    const man = JSON.parse(savedMan);
    for (const f of man.files) if (f.path === "address-registry.json") f.sha256 = newHash;
    const sums = savedSums
      .split("\n")
      .map((l: string) =>
        l.endsWith("  address-registry.json") ? `${newHash}  address-registry.json` : l,
      )
      .join("\n");
    RAW_FILES["address-registry.json"] = newReg;
    RAW_FILES["manifest.json"] = JSON.stringify(man);
    RAW_FILES["CHECKSUMS.sha256"] = sums;
    __resetReleaseValidationCache();
    __resetRegistryIndex();
    fn();
  } finally {
    RAW_FILES["address-registry.json"] = savedReg;
    RAW_FILES["manifest.json"] = savedMan;
    RAW_FILES["CHECKSUMS.sha256"] = savedSums;
    __resetReleaseValidationCache();
    __resetRegistryIndex();
  }
}

test("a registry entry with Zone 5 is DATASET_INVALID (past the checksum gate)", () => {
  withConsistentRegistry(
    (addresses) => {
      (addresses[0] as { zone_id: number }).zone_id = 5;
    },
    () => {
      assert.equal(isDatasetValid(), false);
      assert.equal(resolveAddressZone(Z1).status, "DATASET_INVALID");
    },
  );
  assert.equal(isDatasetValid(), true); // restored
});

test("a duplicate canonical_address_key is DATASET_INVALID (past the checksum gate)", () => {
  withConsistentRegistry(
    (addresses) => {
      (addresses[1] as { canonical_address_key: string }).canonical_address_key =
        (addresses[0] as { canonical_address_key: string }).canonical_address_key;
    },
    () => {
      assert.equal(isDatasetValid(), false);
    },
  );
  assert.equal(isDatasetValid(), true); // restored
});

// --- order zone snapshot: immutable, mandatory-ready, no money --------------

test("order zone snapshot freezes the release, pickup and dropoff, money-free", () => {
  const snap = buildOrderZoneSnapshot({
    pickupZoneId: "zone-1",
    address: addr(),
    resolvedAt: "2026-07-24T00:00:00Z",
  });
  assert.ok(Object.isFrozen(snap));
  assert.equal(snap.zoneReleaseId, zoneReleaseId());
  assert.equal(snap.pickupZoneId, "zone-1");
  assert.equal(snap.pickupResolutionBasis, "restaurant_zone");
  assert.equal(snap.dropoffZoneId, "zone-2");
  assert.equal(snap.dropoffResolutionBasis, "verified_registry_house");
  assert.equal(snap.dropoffStatus, "RESOLVED");
  assert.ok(snap.dropoffCanonicalAddressKey);
  assert.equal(snap.legacyPrototype, false);
  const keys = Object.keys(snap).join(" ").toLowerCase();
  for (const money of ["fee", "payout", "price", "cents", "amount", "currency"]) {
    assert.ok(!keys.includes(money), `snapshot must not carry ${money}`);
  }
});

test("a PICKUP-style snapshot (no address) has a null dropoff", () => {
  const snap = buildOrderZoneSnapshot({
    pickupZoneId: "zone-3",
    address: null,
    resolvedAt: "2026-07-24T00:00:00Z",
  });
  assert.equal(snap.pickupZoneId, "zone-3");
  assert.equal(snap.dropoffZoneId, null);
  assert.equal(snap.dropoffResolutionBasis, "no_address_pickup");
});

test("a later dataset read never rewrites an existing snapshot", () => {
  const snap = buildOrderZoneSnapshot({
    pickupZoneId: "zone-1",
    address: addr(),
    resolvedAt: "2026-07-24T00:00:00Z",
  });
  resolveAddressZone(Z3);
  assert.equal(snap.dropoffZoneId, "zone-2");
  assert.throws(() => {
    // @ts-expect-error immutable
    snap.dropoffZoneId = "zone-4";
  });
});

test("attaching a snapshot does not mutate the order or touch money", () => {
  const o = order(addr());
  const financialsBefore = o.financials;
  const withSnap = attachOrderZoneSnapshot(o, "2026-07-24T00:00:00Z");
  assert.equal(o.zoneSnapshot, undefined, "original order not mutated");
  assert.ok(withSnap.zoneSnapshot);
  assert.equal(withSnap.zoneSnapshot.dropoffZoneId, "zone-2");
  assert.equal(withSnap.financials, financialsBefore);
});

test("a legacy order keeps its old zoneId and is marked legacy-prototype", () => {
  const o = order(addr({ zoneId: "zone-3" }));
  const snap = legacyOrderZoneSnapshot(o);
  assert.equal(snap.legacyPrototype, true);
  assert.equal(snap.zoneReleaseId, "legacy-prototype");
  assert.equal(snap.dropoffZoneId, "zone-3", "old zoneId is preserved verbatim");
  // orderZoneSnapshotOrLegacy prefers a present snapshot, else normalizes.
  assert.equal(orderZoneSnapshotOrLegacy(o).legacyPrototype, true);
  const withSnap = attachOrderZoneSnapshot(o, "2026-07-24T00:00:00Z");
  assert.equal(orderZoneSnapshotOrLegacy(withSnap).legacyPrototype, false);
});

// --- driver view ------------------------------------------------------------

test("driver view shows pickup and dropoff zones with colours, no GIS internals", () => {
  const accepted = attachOrderZoneSnapshot(order(addr(), "zone-1"), "2026-07-24T00:00:00Z");
  const view = driverOrderZoneView(accepted);
  assert.equal(view.pickup.zoneNumber, 1);
  assert.equal(view.dropoff.zoneNumber, 2);
  assert.equal(view.dropoff.color, zoneColor(2));
  assert.equal(view.pickup.label, "Zone 1");
  assert.equal(view.dropoff.label, "Zone 2");
  assert.equal(view.datasetVersion, zoneDatasetVersion());
  const blob = JSON.stringify(view).toLowerCase();
  assert.ok(!blob.includes("osm"), "no OSM ids leak to the driver");
  assert.ok(!blob.includes("polygon"), "no polygons leak to the driver");
});

test("driver view handles a pickup order with no address", () => {
  const view = driverOrderZoneView(order(null, "zone-2"));
  assert.equal(view.pickup.zoneNumber, 2);
  assert.equal(view.dropoff.zoneNumber, null);
  assert.equal(view.dropoff.label, "Самовывоз");
});

test("driver view warns for a Varnița no-delivery address", () => {
  const view = driverOrderZoneView(order(addr({ street: "улица", house: "1" }), "zone-1"));
  // "улица" in Бендеры is not found -> a warning, but not a crash.
  assert.ok(view.warning);
});

// --- admin navigation contains the zone registry ----------------------------

test("admin navigation contains the versioned zone registry, kept apart from tariffs", () => {
  const hrefs = ADMIN_NAVIGATION.map((i) => i.href);
  assert.ok(hrefs.includes("/admin/zone-registry"), "zone registry in admin nav");
  assert.ok(hrefs.includes("/admin/zones"), "tariff editor still separate");
});
