import type { Order } from "@/prototype/models";

import { resolveAddressZone } from "./address-resolver";
import { zoneColor } from "./zone-registry";
import type { ZoneResolution } from "./types";

/**
 * Read-only zone view for the driver. Shows which zone an order's delivery
 * address falls in and a clear Varnița no-delivery warning. No money, no price.
 */

export interface DriverZoneView {
  zoneNumber: number | null;
  zoneId: string | null;
  color: string | null;
  isNoDelivery: boolean;
  warning: string | null;
  label: string;
  resolution: ZoneResolution;
}

export function driverOrderZoneView(order: Order): DriverZoneView {
  const resolution = order.address
    ? resolveAddressZone({
        street: order.address.street,
        house: order.address.house,
      })
    : {
        status: "no_address" as const,
        zoneId: null,
        zoneNumber: null,
        zones: [],
        serviceStatus: null,
        matched: null,
      };

  const isNoDelivery = resolution.status === "no_delivery";
  let warning: string | null = null;
  if (isNoDelivery) {
    warning =
      "Варница — зона без доставки. Разрешён только транзит через Варницу; " +
      "заказ по этому адресу не выполняется.";
  } else if (
    resolution.status === "ambiguous_street" ||
    resolution.status === "ambiguous_district"
  ) {
    warning = "Зона не определена однозначно — уточните дом у оператора.";
  } else if (resolution.status === "not_found") {
    warning = "Улица не найдена в наборе зон — уточните адрес.";
  }

  const label =
    resolution.zoneNumber != null
      ? `Zone ${resolution.zoneNumber}`
      : isNoDelivery
        ? "Без доставки"
        : "Зона не определена";

  return {
    zoneNumber: resolution.zoneNumber,
    zoneId: resolution.zoneId,
    color: resolution.zoneNumber != null ? zoneColor(resolution.zoneNumber) : null,
    isNoDelivery,
    warning,
    label,
    resolution,
  };
}
