import assert from "node:assert/strict";
import { test } from "node:test";

import type { DeliveryAddress, Order } from "../../prototype/models.ts";
import { resolveAddressZone } from "./address-resolver.ts";
import { driverOrderZoneView } from "./driver-zone-view.ts";
import {
  attachOrderZoneSnapshot,
  buildOrderZoneSnapshot,
} from "./order-zone-snapshot.ts";
import {
  fromZoneId,
  listZones,
  streetCount,
  toZoneId,
  zoneColor,
  zoneDatasetVersion,
  zoneRelease,
} from "./zone-registry.ts";

/**
 * Integration of the versioned Bender zone dataset. Read-only, no money. The
 * house is the source of truth; Varnița is always no_delivery.
 */

function addr(overrides: Partial<DeliveryAddress> = {}): DeliveryAddress {
  return {
    street: "1-й Братский переулок",
    house: "1 А",
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
    restaurant: { id: "r1", name: "R", address: "A", zoneId: originZone },
    address,
    financials: { marker: "unchanged" },
  } as unknown as Order;
}

// --- registry ---------------------------------------------------------------

test("registry exposes the versioned release and four zones", () => {
  assert.ok(zoneRelease().startsWith("bender-zones-v1@"));
  assert.ok(zoneDatasetVersion().startsWith("moldova-pbf:"));
  const ids = listZones().map((z) => z.zone_id).sort();
  assert.deepEqual(ids, [1, 2, 3, 4]);
  assert.equal(zoneColor(1), "#2a9d3f");
  assert.equal(zoneColor(4), "#d62828");
  assert.ok(streetCount() > 100);
  assert.equal(toZoneId(3), "zone-3");
  assert.equal(fromZoneId("zone-4"), 4);
});

// --- resolver: the house is the source of truth -----------------------------

test("a house on a split street resolves to its own zone", () => {
  const z3 = resolveAddressZone({ street: "Безымянный переулок", house: "23" });
  assert.equal(z3.status, "resolved");
  assert.equal(z3.zoneNumber, 3);
  const z4 = resolveAddressZone({ street: "Безымянный переулок", house: "63" });
  assert.equal(z4.status, "resolved");
  assert.equal(z4.zoneNumber, 4);
});

test("a split street without a house is ambiguous, not a guessed zone", () => {
  const r = resolveAddressZone({ street: "Безымянный переулок" });
  assert.equal(r.status, "ambiguous_street");
  assert.equal(r.zoneId, null);
  assert.deepEqual(r.zones.sort(), [3, 4]);
});

test("a single-zone street resolves by street even without the exact house", () => {
  const r = resolveAddressZone({ street: "1-й Братский переулок" });
  assert.equal(r.status, "resolved_by_street");
  assert.equal(r.zoneNumber, 2);
});

test("letter/fraction house numbers resolve verbatim", () => {
  const r = resolveAddressZone({ street: "1-й Братский переулок", house: "1 А" });
  assert.equal(r.status, "resolved");
  assert.equal(r.matched?.housenumber, "1 А");
});

test("an unknown street is not_found, never a random zone", () => {
  const r = resolveAddressZone({ street: "улица Которой Нет 9999" });
  assert.equal(r.status, "not_found");
  assert.equal(r.zoneId, null);
});

// --- Varnița is always no_delivery ------------------------------------------

test("Varnița is no_delivery regardless of street", () => {
  const r = resolveAddressZone({ settlement: "Варница", street: "любая улица", house: "1" });
  assert.equal(r.status, "no_delivery");
  assert.equal(r.zoneId, null);
});

// --- same street name in different settlements is not merged -----------------

test("улица Ленина stays distinct per settlement", () => {
  const giska = resolveAddressZone({ settlement: "Гиска", street: "улица Ленина" });
  const parkany = resolveAddressZone({ settlement: "Парканы", street: "улица Ленина" });
  assert.equal(giska.matched?.settlement_ru, "Гиска");
  assert.equal(parkany.matched?.settlement_ru, "Парканы");
});

// --- Северный enclave is Zone 4 ---------------------------------------------

test("Северный addresses resolve to Zone 4", () => {
  const r = resolveAddressZone({
    settlement: "Бендеры",
    district: "Северный",
    street: "Strada Tighina",
    house: "31/2",
  });
  assert.equal(r.zoneNumber, 4);
  assert.equal(r.matched?.district_ru, "Северный");
});

// --- order zone snapshot: immutable, no money -------------------------------

test("order zone snapshot is frozen and money-free", () => {
  const snap = buildOrderZoneSnapshot({
    originZoneId: "zone-1",
    address: addr(),
    resolvedAt: "2026-07-24T00:00:00Z",
  });
  assert.ok(Object.isFrozen(snap));
  assert.equal(snap.origin_zone_id, "zone-1");
  assert.equal(snap.destination_zone_id, "zone-2");
  assert.equal(snap.zone_release, zoneRelease());
  const keys = Object.keys(snap).join(" ").toLowerCase();
  for (const money of ["fee", "payout", "price", "cents", "amount", "currency"]) {
    assert.ok(!keys.includes(money), `snapshot must not carry ${money}`);
  }
});

test("later dataset reads never rewrite an existing snapshot", () => {
  const snap = buildOrderZoneSnapshot({
    originZoneId: "zone-1",
    address: addr(),
    resolvedAt: "2026-07-24T00:00:00Z",
  });
  const version = snap.zone_dataset_version;
  // resolving more addresses does not change the taken snapshot
  resolveAddressZone({ street: "Безымянный переулок", house: "23" });
  assert.equal(snap.zone_dataset_version, version);
  assert.throws(() => {
    // @ts-expect-error immutable
    snap.destination_zone_id = "zone-4";
  });
});

test("attaching a snapshot does not mutate the order or touch money", () => {
  const o = order(addr());
  const financialsBefore = o.financials;
  const withSnap = attachOrderZoneSnapshot(o, "2026-07-24T00:00:00Z");
  assert.equal(o.zoneSnapshot, undefined, "original order not mutated");
  assert.ok(withSnap.zoneSnapshot);
  assert.equal(withSnap.zoneSnapshot.destination_zone_id, "zone-2");
  // financials object is carried by reference, unchanged
  assert.equal(withSnap.financials, financialsBefore);
});

// --- driver view ------------------------------------------------------------

test("driver view shows the destination zone with its colour", () => {
  const view = driverOrderZoneView(order(addr()));
  assert.equal(view.zoneNumber, 2);
  assert.equal(view.color, zoneColor(2));
  assert.equal(view.isNoDelivery, false);
  assert.equal(view.label, "Zone 2");
});

test("driver view warns when the street is unknown", () => {
  const view = driverOrderZoneView(order(addr({ street: "улица Которой Нет 9999" })));
  assert.equal(view.zoneNumber, null);
  assert.ok(view.warning);
});

test("driver view handles a pickup order with no address", () => {
  const view = driverOrderZoneView(order(null));
  assert.equal(view.resolution.status, "no_address");
  assert.equal(view.zoneNumber, null);
});
