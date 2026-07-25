import type { ZoneId } from "@/prototype/models";

import {
  canonicalAddressKey,
  isDatasetValid,
  normalizeName,
  qaByCanonical,
  registryByCanonical,
  registryBySettlementStreetHouse,
  toZoneId,
} from "./zone-registry";
import type {
  AddressRegistryEntry,
  ZoneResolution,
  ZoneResolutionStatus,
  ZoneServiceStatus,
} from "./types";

/**
 * Real address -> zone resolver over the versioned release. The EXACT VERIFIED
 * HOUSE is the only source of a working zone: this resolver reads ONLY the
 * address registry. A street without a house, an unknown house on a known
 * street, or a house absent from the registry never yields a zone. There is no
 * `resolved_by_street` — that guess has been removed entirely. Carries no money.
 */

export interface AddressQuery {
  settlement?: string | null;
  district?: string | null;
  street: string;
  house?: string | null;
}

const DEFAULT_SETTLEMENT = "Бендеры";

function empty(status: ZoneResolutionStatus): ZoneResolution {
  return {
    status,
    zoneId: null,
    zoneNumber: null,
    serviceStatus: null,
    canonicalAddressKey: null,
    routeFlags: null,
    matched: null,
  };
}

function isVarnita(settlement: string | null | undefined): boolean {
  return normalizeName(settlement).startsWith("варниц");
}

function resolvedFrom(entry: AddressRegistryEntry): ZoneResolution {
  return {
    status: "RESOLVED",
    zoneId: toZoneId(entry.zone_id) as ZoneId,
    zoneNumber: entry.zone_id,
    serviceStatus: entry.service_status,
    canonicalAddressKey: entry.canonical_address_key,
    routeFlags: entry.route_flags,
    matched: {
      settlement_ru: entry.settlement_ru,
      district_ru: entry.district_ru,
      street_ru: entry.street_ru,
      housenumber: entry.housenumber,
    },
  };
}

/** Map a QA object's service status to a fail-closed resolution status. */
function qaStatus(serviceStatus: ZoneServiceStatus): ZoneResolutionStatus {
  if (serviceStatus === "no_delivery") return "NO_DELIVERY";
  if (serviceStatus === "disputed") return "DISPUTED";
  return "UNVERIFIED_ADDRESS";
}

export function resolveAddressZone(query: AddressQuery): ZoneResolution {
  // Fail closed: an invalid vendored release resolves nothing.
  if (!isDatasetValid()) return empty("DATASET_INVALID");

  const settlement = (query.settlement ?? "").trim() || DEFAULT_SETTLEMENT;
  const district = (query.district ?? "").trim() || null;
  const street = (query.street ?? "").trim();
  const house = (query.house ?? "").trim() || null;

  // Varnița village is never served (transit only).
  if (isVarnita(settlement)) {
    const nd = empty("NO_DELIVERY");
    nd.serviceStatus = "no_delivery";
    return nd;
  }

  // A street without a confirmed house can never resolve to a zone.
  if (!house) return empty("UNVERIFIED_ADDRESS");

  const districtProvided = district !== null;
  if (districtProvided) {
    // District explicitly given: exact canonical (settlement|district|street|house).
    // A district that does not match a verified house is NOT silently retried
    // against other districts — it falls through to QA / NOT_FOUND below.
    const exact = registryByCanonical(
      canonicalAddressKey(settlement, district, street, house),
    );
    if (exact) return resolvedFrom(exact);
  } else {
    // No district given: resolve by settlement+street+house across districts.
    // Exactly one verified house -> RESOLVED. More than one (the same street +
    // house in different districts) -> AMBIGUOUS even if the zones coincide;
    // the client must pick a district. Different districts are never merged.
    const candidates = registryBySettlementStreetHouse(settlement, street, house);
    if (candidates.length === 1) return resolvedFrom(candidates[0]);
    if (candidates.length > 1) {
      const amb = empty("AMBIGUOUS");
      amb.matched = {
        settlement_ru: candidates[0].settlement_ru,
        district_ru: null,
        street_ru: candidates[0].street_ru,
        housenumber: house,
      };
      return amb;
    }
  }

  // Not in the registry: is it a known admin/QA object? (disputed / no_delivery
  // / unaddressed / excluded / owner-review, including every Северный address —
  // the Северный catalog is deliberately incomplete, so those stay owner-review
  // and are NOT orderable). Fail closed with its reason. The QA zone number is
  // surfaced for admin/driver display only; it never makes the address RESOLVED.
  const qa = qaByCanonical(canonicalAddressKey(settlement, district, street, house));
  if (qa) {
    const st = empty(qaStatus(qa.service_status));
    st.serviceStatus = qa.service_status;
    st.canonicalAddressKey = qa.canonical_address_key;
    if (qa.zone_id != null && qa.zone_id >= 1 && qa.zone_id <= 4) {
      st.zoneNumber = qa.zone_id;
      st.zoneId = toZoneId(qa.zone_id) as ZoneId;
    }
    st.matched = {
      settlement_ru: qa.settlement_ru,
      district_ru: qa.district_ru,
      street_ru: qa.street_ru,
      housenumber: qa.housenumber,
    };
    return st;
  }

  // 4. Genuinely unknown address.
  return empty("NOT_FOUND");
}
