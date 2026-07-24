import type { ZoneId } from "@/prototype/models";

/**
 * Versioned Bender zone dataset (vendored from
 * upa1311/bender-delivery-zones releases/bender-zones-v1). Zones only — this
 * dataset carries NO money. Prices live in Direct's own tariff matrix; see
 * ZONE_PRICING_SEPARATION.md in the zones repo.
 */

export type ZoneServiceStatus =
  | "standard"
  | "low_density"
  | "no_delivery"
  | "disputed";

export interface ZoneDatasetZone {
  zone_id: number;
  zone_name: string;
  color: string;
  component: "bender_main" | "severny_enclave";
}

export interface ZoneStreetHouses {
  zone_id: number;
  houses: string[];
}

export interface ZoneStreet {
  settlement_ru: string;
  district_ru: string | null;
  street_ru: string;
  zones: number[];
  split_street: boolean;
  service_status: ZoneServiceStatus;
  houses_by_zone: ZoneStreetHouses[];
}

export interface ZoneDataset {
  release: string;
  version: string;
  immutable: true;
  decided_k: number;
  scenario: string;
  zone_edges_km: number[];
  zone_colors: Record<string, string>;
  source_dataset_version: string;
  prices_included: false;
  zones: ZoneDatasetZone[];
  resolution_index: { streets: ZoneStreet[] };
}

/** Outcome of resolving an address to a zone. Never carries a price. */
export type ZoneResolutionStatus =
  | "resolved"
  | "resolved_by_street"
  | "ambiguous_street"
  | "ambiguous_district"
  | "no_delivery"
  | "not_found"
  | "no_address";

export interface ZoneResolution {
  status: ZoneResolutionStatus;
  zoneId: ZoneId | null;
  zoneNumber: number | null;
  zones: number[];
  serviceStatus: ZoneServiceStatus | null;
  matched: {
    settlement_ru: string;
    district_ru: string | null;
    street_ru: string;
    housenumber: string | null;
  } | null;
}

/**
 * Immutable zone snapshot stored on a completed order. A later zone or tariff
 * change must never rewrite it. Contains NO monetary amount.
 */
export interface OrderZoneSnapshot {
  readonly zone_dataset_version: string;
  readonly zone_release: string;
  readonly origin_zone_id: ZoneId;
  readonly destination_zone_id: ZoneId | null;
  readonly destination_status: ZoneResolutionStatus;
  readonly resolved_at: string;
}
