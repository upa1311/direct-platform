import type { Order } from "@/prototype/models";

import { orderZoneSnapshotOrLegacy } from "./order-zone-snapshot";
import { fromZoneId, zoneColor } from "./zone-registry";
import type { OrderZoneSnapshot } from "./types";

/**
 * Read-only zone view for the driver (offer card + accepted order). Its SINGLE
 * source is the order's immutable `zoneSnapshot` — it never re-resolves the
 * address, so the pickup/dropoff zones, release/version and route flags a driver
 * sees always match what was frozen on the order. It exposes NO GIS internals
 * (no OSM ids, canonical keys, polygons or dataset paths) and NO money. A legacy
 * order without a snapshot is shown fail-closed as "zones unavailable".
 */

export interface DriverZoneCell {
  zoneNumber: number | null;
  zoneId: string | null;
  color: string | null;
  label: string;
}

export interface DriverZoneView {
  pickup: DriverZoneCell;
  dropoff: DriverZoneCell;
  isSeverny: boolean;
  requiresVarnitaTransit: boolean;
  isNoDelivery: boolean;
  warning: string | null;
  /** True when the order predates the versioned integration (no real snapshot). */
  legacy: boolean;
  /** Shown only in the technical details AFTER acceptance. */
  datasetVersion: string;
  releaseId: string;
}

function cell(zoneNumber: number | null, fallbackLabel: string): DriverZoneCell {
  if (zoneNumber == null) {
    return { zoneNumber: null, zoneId: null, color: null, label: fallbackLabel };
  }
  return {
    zoneNumber,
    zoneId: `zone-${zoneNumber}`,
    color: zoneColor(zoneNumber),
    label: `Zone ${zoneNumber}`,
  };
}

function warningFor(snapshot: OrderZoneSnapshot): string | null {
  if (snapshot.legacyPrototype) {
    return "Заказ создан до версионных зон — данные зон недоступны.";
  }
  switch (snapshot.dropoffStatus) {
    case "NO_DELIVERY":
      return (
        "Варница — зона без доставки. Разрешён только транзит через Варницу; " +
        "заказ по этому адресу не выполняется."
      );
    case "DISPUTED":
      return "Адрес спорный — уточните у оператора перед выездом.";
    case "UNVERIFIED_ADDRESS":
      return "Адрес не подтверждён в каталоге — уточните у оператора.";
    case "AMBIGUOUS":
      return "Зона не определена однозначно — уточните район у оператора.";
    case "NOT_FOUND":
      return "Адрес не найден в наборе зон — уточните у оператора.";
    case "DATASET_INVALID":
      return "Набор зон недоступен — зоны показать нельзя.";
    default:
      return null;
  }
}

export function driverOrderZoneView(order: Order): DriverZoneView {
  const snapshot = orderZoneSnapshotOrLegacy(order);
  const legacy = snapshot.legacyPrototype;

  const pickupNumber = fromZoneId(snapshot.pickupZoneId);
  const dropoffNumber =
    snapshot.dropoffZoneId != null ? fromZoneId(snapshot.dropoffZoneId) : null;

  // Северный is derived from the frozen canonical key — no re-resolution.
  const isSeverny =
    !legacy && (snapshot.dropoffCanonicalAddressKey ?? "").includes("|северный|");
  const isNoDelivery = !legacy && snapshot.dropoffStatus === "NO_DELIVERY";

  return {
    pickup: cell(pickupNumber, "Зона не определена"),
    dropoff:
      order.address == null
        ? cell(null, "Самовывоз")
        : legacy
          ? cell(null, "Зоны недоступны (устаревший заказ)")
          : cell(dropoffNumber, isNoDelivery ? "Без доставки" : "Зона не определена"),
    isSeverny,
    requiresVarnitaTransit: snapshot.routeFlags.requires_varnita_transit,
    isNoDelivery,
    warning: warningFor(snapshot),
    legacy,
    datasetVersion: snapshot.zoneDatasetVersion,
    releaseId: snapshot.zoneReleaseId,
  };
}
