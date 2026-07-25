import type { Order } from "@/prototype/models";

import { resolveAddressZone } from "./address-resolver";
import { orderZoneSnapshotOrLegacy } from "./order-zone-snapshot";
import { fromZoneId, zoneColor } from "./zone-registry";
import type { ZoneResolution } from "./types";

/**
 * Read-only zone view for the driver, for the offer card and the accepted
 * order. Shows the pickup zone (restaurant) and the dropoff zone (delivery
 * address), a Северный marker and a Varnița-transit note. It exposes NO GIS
 * internals (no OSM ids, polygons or dataset paths) and NO money.
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
  /** Shown only in the technical details AFTER acceptance. */
  datasetVersion: string;
  releaseId: string;
  resolution: ZoneResolution | null;
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

export function driverOrderZoneView(order: Order): DriverZoneView {
  const snapshot = orderZoneSnapshotOrLegacy(order);
  const resolution: ZoneResolution | null = order.address
    ? resolveAddressZone({
        settlement: order.address.settlement,
        district: order.address.district,
        street: order.address.street,
        house: order.address.house,
      })
    : null;

  const pickupNumber = fromZoneId(snapshot.pickupZoneId);
  const dropoffNumber =
    snapshot.dropoffZoneId != null
      ? fromZoneId(snapshot.dropoffZoneId)
      : (resolution?.zoneNumber ?? null);

  const isSeverny =
    (order.address ? resolution?.matched?.district_ru : null) === "Северный";
  const requiresVarnitaTransit =
    snapshot.routeFlags.requires_varnita_transit ||
    resolution?.routeFlags?.requires_varnita_transit === true;
  const isNoDelivery = resolution?.status === "NO_DELIVERY";

  let warning: string | null = null;
  if (isNoDelivery) {
    warning =
      "Варница — зона без доставки. Разрешён только транзит через Варницу; " +
      "заказ по этому адресу не выполняется.";
  } else if (resolution && resolution.status === "DISPUTED") {
    warning = "Адрес спорный — уточните у оператора перед выездом.";
  } else if (resolution && resolution.status === "UNVERIFIED_ADDRESS") {
    warning = isSeverny
      ? "Северный: адрес не в подтверждённом каталоге — уточните у оператора."
      : "Адрес не подтверждён в каталоге — уточните у оператора.";
  } else if (resolution && resolution.status === "AMBIGUOUS") {
    warning = "Зона не определена однозначно — уточните дом у оператора.";
  } else if (resolution && resolution.status === "NOT_FOUND") {
    warning = "Адрес не найден в наборе зон — уточните у оператора.";
  } else if (resolution && resolution.status === "DATASET_INVALID") {
    warning = "Набор зон недоступен — зоны показать нельзя.";
  }

  return {
    pickup: cell(pickupNumber, "Зона не определена"),
    dropoff: order.address
      ? cell(dropoffNumber, isNoDelivery ? "Без доставки" : "Зона не определена")
      : cell(null, "Самовывоз"),
    isSeverny,
    requiresVarnitaTransit,
    isNoDelivery,
    warning,
    datasetVersion: snapshot.zoneDatasetVersion,
    releaseId: snapshot.zoneReleaseId,
    resolution,
  };
}
