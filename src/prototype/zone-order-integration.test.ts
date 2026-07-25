import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState, createDefaultTariffs } from "./default-state.ts";
import {
  addCartItem,
  createOrderFromCart,
  setCartFulfillmentChoice,
  updateCartAddress,
} from "./actions.ts";
import { calculateCartPricing } from "./selectors.ts";
import {
  registryHouses,
  registrySettlements,
  registryStreets,
} from "../lib/zones/zone-registry.ts";
import type { PrototypeState } from "./models.ts";

/**
 * Client order flow wired to the versioned Bender zone registry
 * (bender-zones-v1.1). A PLATFORM_DRIVER order can only be created for an EXACT
 * verified house; PICKUP needs no address; every new order carries an immutable
 * zone snapshot. None of this touches prices, payouts or the tariff matrix.
 */

// Real verified Zone-1 house from the vendored registry (Садовый переулок).
const VERIFIED = { street: "Садовый переулок", house: "1" };

function cartWithItems(): PrototypeState {
  let s = createDefaultState();
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  s = addCartItem(s, "restaurant-2-item-1", "size-standard").state;
  return s;
}

test("PLATFORM_DRIVER order to a verified house is created with a mandatory zone snapshot", () => {
  let s = cartWithItems();
  s = updateCartAddress(s, VERIFIED);
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const order = created.state.orders.find((o) => o.id === created.result.orderId);
  assert.ok(order);
  assert.equal(order.deliveryMode, "PLATFORM_DRIVER");
  // Snapshot is auto-created and mandatory for PLATFORM_DRIVER.
  assert.ok(order.zoneSnapshot, "new PLATFORM_DRIVER order must carry a zone snapshot");
  assert.equal(order.zoneSnapshot.zoneReleaseId, "bender-zones-v1.1");
  assert.equal(order.zoneSnapshot.dropoffZoneId, "zone-1");
  assert.equal(order.zoneSnapshot.dropoffResolutionBasis, "verified_registry_house");
  assert.equal(order.zoneSnapshot.dropoffStatus, "RESOLVED");
  assert.ok(order.zoneSnapshot.dropoffCanonicalAddressKey);
  assert.equal(order.zoneSnapshot.legacyPrototype, false);
});

test("the auto-created zone snapshot is immutable", () => {
  let s = cartWithItems();
  s = updateCartAddress(s, VERIFIED);
  const created = createOrderFromCart(s);
  const order = created.state.orders.find((o) => o.id === created.result.orderId);
  assert.ok(order?.zoneSnapshot);
  assert.ok(Object.isFrozen(order.zoneSnapshot));
  assert.throws(() => {
    // @ts-expect-error immutable
    order.zoneSnapshot.dropoffZoneId = "zone-4";
  });
});

test("a PLATFORM_DRIVER order to an unknown house on a known street is refused", () => {
  let s = cartWithItems();
  // Street is known to the legacy zone model, but the house is not in the
  // verified registry -> fail closed, no order.
  s = updateCartAddress(s, { street: "Садовый переулок", house: "999999Ж" });
  const created = createOrderFromCart(s);
  assert.equal(created.result.orderId, null);
  assert.ok(created.result.error);
  assert.equal(created.state.orders.length, 0, "no order is created");
});

test("a Varnița address is refused (NO_DELIVERY) even on a known street", () => {
  let s = cartWithItems();
  // Known street (so the legacy address gate passes), but settlement Варница ->
  // the registry resolver returns NO_DELIVERY and the order is refused.
  s = updateCartAddress(s, { settlement: "Варница", street: "Садовый переулок", house: "1" });
  const created = createOrderFromCart(s);
  assert.equal(created.result.orderId, null);
  assert.equal(created.state.orders.length, 0);
});

test("a Северный address is not orderable yet (catalog incomplete)", () => {
  let s = cartWithItems();
  s = updateCartAddress(s, {
    settlement: "Бендеры",
    district: "Северный",
    street: "Strada Tighina",
    house: "31/2",
  });
  const created = createOrderFromCart(s);
  assert.equal(created.result.orderId, null);
  assert.equal(created.state.orders.length, 0);
});

test("the client picker offers only verified registry data", () => {
  const settlements = registrySettlements();
  assert.ok(settlements.includes("Бендеры"));
  const streets = registryStreets("Бендеры", null);
  assert.ok(streets.includes("Садовый переулок"));
  const houses = registryHouses("Бендеры", "Садовый переулок", null);
  assert.ok(houses.includes("1"), "house 1 is a verified house of Садовый переулок");
  // A street that lives only in admin QA (Северный) is NOT offered to clients.
  assert.ok(!streets.includes("Strada Tighina"));
});

test("PICKUP works with no delivery address and needs no verified zone", () => {
  let s = cartWithItems();
  s = setCartFulfillmentChoice(s, "PICKUP");
  const created = createOrderFromCart(s);
  assert.equal(created.result.error, null);
  const order = created.state.orders.find((o) => o.id === created.result.orderId);
  assert.ok(order);
  assert.equal(order.deliveryMode, "PICKUP");
  assert.equal(order.address, null);
  // A snapshot is still taken (dropoff null, pickup = restaurant zone).
  assert.ok(order.zoneSnapshot);
  assert.equal(order.zoneSnapshot.dropoffZoneId, null);
  assert.equal(order.zoneSnapshot.dropoffResolutionBasis, "no_address_pickup");
});

test("zones do not change prices, payouts or the tariff matrix", () => {
  let s = cartWithItems();
  s = updateCartAddress(s, VERIFIED);
  const pricing = calculateCartPricing(s);
  const created = createOrderFromCart(s);
  const order = created.state.orders.find((o) => o.id === created.result.orderId);
  assert.ok(order);
  // The financial snapshot is identical to the pre-zone pricing: the zone gate
  // and snapshot are additive and money-free.
  assert.equal(order.financials.customerTotalCents, pricing.customerTotalCents);
  assert.equal(order.financials.driverPayoutCents, pricing.driverPayoutCents);
  assert.equal(order.financials.deliveryFeeCents, pricing.deliveryFeeCents);
  // Legacy pricing zone is unchanged (still zone-1), independent of the registry.
  assert.equal(order.financials.customerZoneId, "zone-1");
  // The snapshot carries no monetary field.
  const keys = Object.keys(order.zoneSnapshot ?? {}).join(" ").toLowerCase();
  for (const money of ["fee", "payout", "price", "cents", "amount", "currency"]) {
    assert.ok(!keys.includes(money), `snapshot must not carry ${money}`);
  }
  // The tariff matrix itself is intact (4x4, positive integer fees).
  const tariffs = createDefaultTariffs();
  const zoneIds = ["zone-1", "zone-2", "zone-3", "zone-4"] as const;
  for (const from of zoneIds) {
    for (const to of zoneIds) {
      assert.equal(Number.isInteger(tariffs[from][to]), true);
    }
  }
});
