import type { ZoneId } from "@/prototype/models";

import {
  findStreets,
  normalizeName,
  toZoneId,
} from "./zone-registry";
import type { ZoneResolution, ZoneStreet } from "./types";

/**
 * Real address -> zone resolver over the versioned dataset. The HOUSE is the
 * source of truth: a street-only lookup on a split street is ambiguous, never a
 * single guessed zone. Carries no money. Varnița is always no_delivery.
 */

export interface AddressQuery {
  settlement?: string | null;
  district?: string | null;
  street: string;
  house?: string | null;
}

const DEFAULT_SETTLEMENT = "Бендеры";

function empty(status: ZoneResolution["status"]): ZoneResolution {
  return {
    status,
    zoneId: null,
    zoneNumber: null,
    zones: [],
    serviceStatus: null,
    matched: null,
  };
}

function isVarnita(settlement: string | null | undefined): boolean {
  return normalizeName(settlement).startsWith("варниц");
}

function houseZone(entry: ZoneStreet, house: string): number | null {
  const wanted = normalizeName(house);
  for (const hz of entry.houses_by_zone) {
    for (const h of hz.houses) {
      if (normalizeName(h) === wanted) return hz.zone_id;
    }
  }
  return null;
}

function resolved(
  entry: ZoneStreet,
  zoneNumber: number,
  house: string | null,
  status: ZoneResolution["status"],
): ZoneResolution {
  return {
    status,
    zoneId: toZoneId(zoneNumber) as ZoneId,
    zoneNumber,
    zones: entry.zones,
    serviceStatus: entry.service_status,
    matched: {
      settlement_ru: entry.settlement_ru,
      district_ru: entry.district_ru,
      street_ru: entry.street_ru,
      housenumber: house,
    },
  };
}

export function resolveAddressZone(query: AddressQuery): ZoneResolution {
  const settlement = (query.settlement ?? "").trim() || DEFAULT_SETTLEMENT;
  const street = (query.street ?? "").trim();
  const house = (query.house ?? "").trim() || null;
  if (!street) return empty("not_found");

  // Varnița is never served, whatever the street resolves to.
  if (isVarnita(settlement)) {
    const nd = empty("no_delivery");
    nd.serviceStatus = "no_delivery";
    return nd;
  }

  const matches = findStreets(settlement, street, query.district);
  if (matches.length === 0) return empty("not_found");
  if (matches.length > 1) {
    const amb = empty("ambiguous_district");
    amb.zones = [...new Set(matches.flatMap((m) => m.zones))].sort((a, b) => a - b);
    return amb;
  }

  const entry = matches[0];
  if (entry.service_status === "no_delivery") {
    const nd = empty("no_delivery");
    nd.serviceStatus = "no_delivery";
    nd.matched = {
      settlement_ru: entry.settlement_ru,
      district_ru: entry.district_ru,
      street_ru: entry.street_ru,
      housenumber: house,
    };
    return nd;
  }

  if (house) {
    const z = houseZone(entry, house);
    if (z != null) return resolved(entry, z, house, "resolved");
    // House not in the confirmed list: fall back only if the street is a single
    // zone; a split street with an unknown house stays ambiguous.
    if (entry.zones.length === 1) {
      return resolved(entry, entry.zones[0], house, "resolved_by_street");
    }
    const amb = empty("ambiguous_street");
    amb.zones = entry.zones;
    amb.matched = {
      settlement_ru: entry.settlement_ru,
      district_ru: entry.district_ru,
      street_ru: entry.street_ru,
      housenumber: house,
    };
    return amb;
  }

  if (entry.zones.length === 1) {
    return resolved(entry, entry.zones[0], null, "resolved_by_street");
  }
  const amb = empty("ambiguous_street");
  amb.zones = entry.zones;
  amb.matched = {
    settlement_ru: entry.settlement_ru,
    district_ru: entry.district_ru,
    street_ru: entry.street_ru,
    housenumber: null,
  };
  return amb;
}
