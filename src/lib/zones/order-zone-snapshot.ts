import type { DeliveryAddress, Order, ZoneId } from "@/prototype/models";

import { resolveAddressZone } from "./address-resolver";
import { zoneDatasetVersion, zoneRelease } from "./zone-registry";
import type { OrderZoneSnapshot } from "./types";

/**
 * Immutable zone snapshot for an order. Freezes the zone dataset version and the
 * origin/destination zones at calculation time, so a later zone or tariff change
 * never rewrites a finished order. Pure and money-free: it reads the address and
 * the restaurant's zone, and touches no price, payout or cash amount.
 */

export interface ZoneSnapshotInput {
  originZoneId: ZoneId;
  address: DeliveryAddress | null;
  resolvedAt: string;
}

export function buildOrderZoneSnapshot(input: ZoneSnapshotInput): OrderZoneSnapshot {
  const destination = input.address
    ? resolveAddressZone({
        street: input.address.street,
        house: input.address.house,
      })
    : null;

  return Object.freeze({
    zone_dataset_version: zoneDatasetVersion(),
    zone_release: zoneRelease(),
    origin_zone_id: input.originZoneId,
    destination_zone_id: destination ? destination.zoneId : null,
    destination_status: destination ? destination.status : "no_address",
    resolved_at: input.resolvedAt,
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
    originZoneId: order.restaurant.zoneId,
    address: order.address,
    resolvedAt,
  });
  return { ...order, zoneSnapshot: snapshot };
}
