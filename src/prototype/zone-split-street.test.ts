import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState, createDefaultTariffs } from "./default-state.ts";
import {
  addCartItem,
  createOrderFromCart,
  updateCartAddress,
} from "./actions.ts";
import { calculateCartPricing } from "./selectors.ts";
import type { PrototypeState, ZoneId } from "./models.ts";
import { resolveAddressZone } from "../lib/zones/address-resolver.ts";
import { driverOrderZoneView } from "../lib/zones/driver-zone-view.ts";
import {
  allRegistryEntries,
  streetsByPrimaryZone,
} from "../lib/zones/zone-registry.ts";

/**
 * The exact resolver is the SINGLE source of the dropoff zone: pricing
 * (financials.customerZoneId) and the immutable snapshot (dropoffZoneId) must
 * agree with it, especially on split streets where the legacy per-street
 * "primary zone" differs from the exact house zone. Tariff matrix values and the
 * driver-payout formula are unchanged — only the selected cell can differ.
 */

// --- programmatically find a real split street (houses in >= 2 zones) --------
function findSplitStreet(): {
  street: string;
  lower: { zone: number; house: string };
  upper: { zone: number; house: string };
  primaryZone: number;
} {
  const byStreet = new Map<string, Map<number, string>>();
  for (const e of allRegistryEntries()) {
    if (e.settlement_ru !== "Бендеры" || e.district_ru) continue;
    const zones = byStreet.get(e.street_ru) ?? new Map<number, string>();
    if (!zones.has(e.zone_id)) zones.set(e.zone_id, e.housenumber);
    byStreet.set(e.street_ru, zones);
  }
  const primary = streetsByPrimaryZone();
  const primaryOf = (street: string): number => {
    for (const z of [1, 2, 3, 4]) if (primary[z].includes(street)) return z;
    return 0;
  };
  for (const [street, zones] of [...byStreet].sort((a, b) =>
    a[0].localeCompare(b[0], "ru"),
  )) {
    if (zones.size >= 2) {
      const sorted = [...zones.entries()].sort((a, b) => a[0] - b[0]);
      return {
        street,
        lower: { zone: sorted[0][0], house: sorted[0][1] },
        upper: { zone: sorted[sorted.length - 1][0], house: sorted[sorted.length - 1][1] },
        primaryZone: primaryOf(street),
      };
    }
  }
  throw new Error("no split street found in the verified registry");
}

const SPLIT = findSplitStreet();

function zoneId(n: number): ZoneId {
  return `zone-${n}` as ZoneId;
}

function orderToSplit(
  house: string,
  district?: string,
): {
  state: PrototypeState;
  orderId: string | null;
  error: string | null;
  pricing: ReturnType<typeof calculateCartPricing>;
} {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = updateCartAddress(s, {
    settlement: "Бендеры",
    district: district ?? null,
    street: SPLIT.street,
    house,
  });
  const pricing = calculateCartPricing(s);
  const created = createOrderFromCart(s);
  return {
    state: created.state,
    orderId: created.result.orderId,
    error: created.result.error,
    pricing,
  };
}

test("the chosen split street really has houses in two different zones", () => {
  assert.notEqual(SPLIT.lower.zone, SPLIT.upper.zone);
  assert.equal(resolveAddressZone({ street: SPLIT.street, house: SPLIT.lower.house }).zoneNumber, SPLIT.lower.zone);
  assert.equal(resolveAddressZone({ street: SPLIT.street, house: SPLIT.upper.house }).zoneNumber, SPLIT.upper.zone);
});

test("split-street house in the first zone: pricing, snapshot and matrix cell agree", () => {
  const { orderId, state } = orderToSplit(SPLIT.lower.house);
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order, "order is created");
  const expectedZone = zoneId(SPLIT.lower.zone);
  assert.equal(order.financials.customerZoneId, expectedZone);
  assert.equal(order.zoneSnapshot?.dropoffZoneId, expectedZone);
  assert.equal(order.financials.customerZoneId, order.zoneSnapshot?.dropoffZoneId);
  const cell = createDefaultTariffs()[order.financials.restaurantZoneId][expectedZone];
  assert.equal(order.financials.deliveryFeeCents, cell);
});

test("split-street house in the second zone: different exact zone and matrix cell", () => {
  const { orderId, state } = orderToSplit(SPLIT.upper.house);
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order, "order is created");
  const expectedZone = zoneId(SPLIT.upper.zone);
  assert.equal(order.financials.customerZoneId, expectedZone);
  assert.equal(order.zoneSnapshot?.dropoffZoneId, expectedZone);
  const cell = createDefaultTariffs()[order.financials.restaurantZoneId][expectedZone];
  assert.equal(order.financials.deliveryFeeCents, cell);
});

test("the street's primary zone never overrides a concrete house's exact zone", () => {
  // The non-primary house must resolve to ITS zone, not the street's primary.
  const nonPrimary =
    SPLIT.lower.zone === SPLIT.primaryZone ? SPLIT.upper : SPLIT.lower;
  assert.notEqual(nonPrimary.zone, SPLIT.primaryZone);
  const r = resolveAddressZone({ street: SPLIT.street, house: nonPrimary.house });
  assert.equal(r.zoneNumber, nonPrimary.zone);
  const { orderId, state } = orderToSplit(nonPrimary.house);
  const order = state.orders.find((o) => o.id === orderId);
  assert.equal(order?.financials.customerZoneId, zoneId(nonPrimary.zone));
});

test("an unknown house on a split street blocks order creation", () => {
  const { orderId, state } = orderToSplit("999999Ж");
  assert.equal(orderId, null);
  assert.equal(state.orders.length, 0);
});

test("driver offer and current order show the same snapshot dropoff zone", () => {
  const { orderId, state } = orderToSplit(SPLIT.upper.house);
  const order = state.orders.find((o) => o.id === orderId);
  assert.ok(order);
  const view = driverOrderZoneView(order);
  // Single source = snapshot. Same view drives the offer card and the accepted
  // order, so both show the identical dropoff zone.
  assert.equal(view.dropoff.zoneNumber, SPLIT.upper.zone);
  assert.equal(view.dropoff.zoneId, order.zoneSnapshot?.dropoffZoneId);
  assert.equal(view.legacy, false);
});

test("financials.customerZoneId === zoneSnapshot.dropoffZoneId for every split-street order", () => {
  for (const house of [SPLIT.lower.house, SPLIT.upper.house]) {
    const { orderId, state } = orderToSplit(house);
    const order = state.orders.find((o) => o.id === orderId);
    assert.ok(order);
    assert.equal(order.financials.customerZoneId, order.zoneSnapshot?.dropoffZoneId);
  }
});

test("same street+house in two districts is AMBIGUOUS without a district", () => {
  // улица Титова 3 exists in both (no district) and Липканы.
  const r = resolveAddressZone({
    settlement: "Бендеры",
    street: "улица Титова",
    house: "3",
  });
  assert.equal(r.status, "AMBIGUOUS");
  assert.equal(r.zoneId, null);
  const { orderId } = (() => {
    let s = createDefaultState();
    s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
    s = updateCartAddress(s, { settlement: "Бендеры", street: "улица Титова", house: "3" });
    return createOrderFromCart(s).result;
  })();
  assert.equal(orderId, null, "an ambiguous address cannot create an order");
});

test("the same address WITH an explicit district resolves", () => {
  const r = resolveAddressZone({
    settlement: "Бендеры",
    district: "Липканы",
    street: "улица Титова",
    house: "3",
  });
  assert.equal(r.status, "RESOLVED");
  assert.ok(r.zoneNumber && r.zoneNumber >= 1 && r.zoneNumber <= 4);
});

test("tariff matrix values are unchanged, and the order never mutates them", () => {
  assert.deepEqual(createDefaultTariffs(), {
    "zone-1": { "zone-1": 200, "zone-2": 300, "zone-3": 400, "zone-4": 500 },
    "zone-2": { "zone-1": 300, "zone-2": 200, "zone-3": 300, "zone-4": 400 },
    "zone-3": { "zone-1": 400, "zone-2": 300, "zone-3": 200, "zone-4": 300 },
    "zone-4": { "zone-1": 500, "zone-2": 400, "zone-3": 300, "zone-4": 200 },
  });
  const { state } = orderToSplit(SPLIT.upper.house);
  assert.deepEqual(state.tariffs, createDefaultTariffs());
});

test("driver payout is unchanged by the zone logic (still equals the fee formula)", () => {
  for (const house of [SPLIT.lower.house, SPLIT.upper.house]) {
    const { orderId, state, pricing } = orderToSplit(house);
    const order = state.orders.find((o) => o.id === orderId);
    assert.ok(order);
    // The existing formula (driverPayout = fee for PLATFORM_DRIVER) is untouched;
    // the zone logic only selects the cell, it does not post-process the payout.
    assert.equal(order.financials.driverPayoutCents, order.financials.deliveryFeeCents);
    assert.equal(order.financials.driverPayoutCents, pricing.driverPayoutCents);
  }
});
