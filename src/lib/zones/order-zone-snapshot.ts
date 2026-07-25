import type { DeliveryAddress, Order, ZoneId } from "@/prototype/models";

import { resolveAddressZone } from "./address-resolver";
import { zoneDatasetVersion, zoneReleaseId } from "./zone-registry";
import type {
  OrderZoneSnapshot,
  ZoneResolution,
  ZoneResolutionBasis,
} from "./types";

/**
 * Immutable zone snapshot for an order, taken at creation. It freezes the zone
 * release id + dataset version and the pickup/dropoff zones, so a later zone or
 * tariff change never rewrites a finished order. Pure and money-free: it reads
 * the restaurant's zone and the delivery address, and touches no price, payout
 * or cash amount. Mandatory for a new PLATFORM_DRIVER order; PICKUP has no
 * dropoff address.
 */

const NO_ROUTE_FLAGS = { requires_varnita_transit: false } as const;

export interface ZoneSnapshotInput {
  pickupZoneId: ZoneId;
  address: DeliveryAddress | null;
  resolvedAt: string;
  /**
   * Pre-computed exact resolution for this address. Pass it so the order, its
   * pricing and this snapshot all use ONE resolution result (no independent
   * re-computation). Omit to resolve here.
   */
  resolution?: ZoneResolution | null;
}

function dropoffBasis(resolution: ZoneResolution | null): ZoneResolutionBasis {
  if (!resolution) return "no_address_pickup";
  return resolution.status === "RESOLVED" ? "verified_registry_house" : "unresolved";
}

export function buildOrderZoneSnapshot(input: ZoneSnapshotInput): OrderZoneSnapshot {
  const resolution: ZoneResolution | null =
    input.resolution !== undefined
      ? input.resolution
      : input.address
        ? resolveAddressZone({
            settlement: input.address.settlement,
            district: input.address.district,
            street: input.address.street,
            house: input.address.house,
          })
        : null;

  const dropoffZoneId =
    resolution && resolution.status === "RESOLVED" ? resolution.zoneId : null;

  return Object.freeze({
    zoneReleaseId: zoneReleaseId(),
    zoneDatasetVersion: zoneDatasetVersion(),
    pickupZoneId: input.pickupZoneId,
    pickupResolutionBasis: "restaurant_zone" as ZoneResolutionBasis,
    dropoffZoneId,
    dropoffResolutionBasis: dropoffBasis(resolution),
    dropoffCanonicalAddressKey: resolution?.canonicalAddressKey ?? null,
    dropoffStatus: resolution ? resolution.status : "NOT_FOUND",
    routeFlags: resolution?.routeFlags ?? NO_ROUTE_FLAGS,
    resolvedAt: input.resolvedAt,
    legacyPrototype: false,
  });
}

/**
 * Return a NEW order carrying the zone snapshot. The input order is not mutated,
 * and no monetary field is read or written.
 */
export function attachOrderZoneSnapshot(
  order: Order,
  resolvedAt: string,
): Order & { zoneSnapshot: OrderZoneSnapshot } {
  const snapshot = buildOrderZoneSnapshot({
    pickupZoneId: order.restaurant.zoneId,
    address: order.address,
    resolvedAt,
  });
  return { ...order, zoneSnapshot: snapshot };
}

/**
 * Normalize an order that predates the versioned integration. It keeps the old
 * order's zoneId verbatim (never re-resolves or rewrites it) and marks the
 * snapshot as a legacy prototype so the UI can label it accordingly. Money is
 * untouched.
 */
export function legacyOrderZoneSnapshot(order: Order): OrderZoneSnapshot {
  return Object.freeze({
    zoneReleaseId: "legacy-prototype",
    zoneDatasetVersion: "legacy-prototype",
    pickupZoneId: order.restaurant.zoneId,
    pickupResolutionBasis: "restaurant_zone" as ZoneResolutionBasis,
    dropoffZoneId: order.address?.zoneId ?? null,
    dropoffResolutionBasis: "unresolved" as ZoneResolutionBasis,
    dropoffCanonicalAddressKey: null,
    dropoffStatus: order.address ? "UNVERIFIED_ADDRESS" : "NOT_FOUND",
    routeFlags: NO_ROUTE_FLAGS,
    resolvedAt: order.createdAt,
    legacyPrototype: true,
  });
}

/** The snapshot for any order: its own if present, else a legacy normalization. */
export function orderZoneSnapshotOrLegacy(order: Order): OrderZoneSnapshot {
  return order.zoneSnapshot ?? legacyOrderZoneSnapshot(order);
}
