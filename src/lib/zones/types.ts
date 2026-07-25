import type { ZoneId } from "@/prototype/models";

/**
 * Versioned Bender zone dataset (vendored from
 * upa1311/bender-delivery-zones releases/bender-zones-v1.1). Zones only — this
 * dataset carries NO money. Prices live in Direct's own tariff matrix; see
 * ZONE_PRICING_SEPARATION.md in the zones repo.
 *
 * The working resolver reads ONLY the exact-address registry: a zone comes from
 * a confirmed house, never from a street guess. Everything else (disputed,
 * no_delivery, unaddressed, Северный without a number) lives in the admin-only
 * QA objects and never yields a serviceable zone.
 */

export type ZoneServiceStatus =
  | "standard"
  | "low_density"
  | "no_delivery"
  | "disputed"
  | "excluded";

export interface ZoneRouteFlags {
  requires_varnita_transit: boolean;
}

/** One exact, verified, export-eligible, zoned house. The only zone source. */
export interface AddressRegistryEntry {
  uid: string;
  settlement_ru: string;
  district_ru: string | null;
  street_ru: string;
  housenumber: string;
  canonical_address_key: string;
  zone_id: number;
  service_status: ZoneServiceStatus;
  source_dataset_version: string;
  route_flags: ZoneRouteFlags;
}

/** An admin-only QA object: never a working delivery zone. */
export interface AdminQaObject {
  uid: string;
  osm_type: string;
  osm_id: number;
  settlement_ru: string;
  district_ru: string | null;
  street_ru: string;
  housenumber: string | null;
  canonical_address_key: string | null;
  zone_id: number | null;
  service_status: ZoneServiceStatus;
  address_status: string;
  owner_review_required: boolean;
  severny: boolean;
}

export interface ZoneReleaseFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

/** Shape of the vendored release manifest we validate fail-closed. */
export interface ZoneReleaseManifest {
  release_id: string;
  version: string;
  immutable: boolean;
  decided_k: number;
  scenario: string;
  prices_included: boolean;
  source_dataset_version: string;
  approved_for_internal_integration: boolean;
  approved_for_customer_address_catalog: boolean;
  severny_address_catalog_complete: boolean;
  verified_address_count: number;
  qa_object_count: number;
  zone_edges_km: number[];
  zone_colors: Record<string, string>;
  required_files: string[];
  files: ZoneReleaseFileEntry[];
}

/**
 * The validated, in-memory dataset. Only built when the vendored release passes
 * every fail-closed check; otherwise the registry is DATASET_INVALID and no
 * delivery order can be created.
 */
/** A zone polygon feature (GeoJSON) for the admin map. No money. */
export interface ZonePolygonFeature {
  zoneNumber: number | null;
  /** Rings of [lng, lat] pairs (Polygon and MultiPolygon flattened to rings). */
  rings: [number, number][][];
}

export interface ZoneDataset {
  manifest: ZoneReleaseManifest;
  releaseId: string;
  version: string;
  sourceDatasetVersion: string;
  zoneColors: Record<string, string>;
  zoneEdgesKm: number[];
  registry: AddressRegistryEntry[];
  qaObjects: AdminQaObject[];
  zonePolygons: ZonePolygonFeature[];
  /** Varnița village no-delivery area (polygon rings, [lng,lat]). */
  varnitaVillageRings: [number, number][][];
  /** Varnița administrative border reference (dashed line, [lng,lat]). */
  varnitaAdminLines: [number, number][][];
}

/**
 * Outcome of resolving an address to a zone. Never carries a price.
 *
 * RESOLVED           — exact verified house found in the registry; has a zone.
 * NOT_FOUND          — no such settlement/street/house in the release.
 * NO_DELIVERY        — Varnița village / a no_delivery QA object.
 * DISPUTED           — a disputed QA object (owner review); not serviceable.
 * UNVERIFIED_ADDRESS — known to QA as unaddressed / excluded / owner-review, or
 *                      a street/house without a confirmed registry entry.
 * AMBIGUOUS          — the query matched more than one registry entry.
 * DATASET_INVALID    — the vendored release failed fail-closed validation.
 */
export type ZoneResolutionStatus =
  | "RESOLVED"
  | "NOT_FOUND"
  | "NO_DELIVERY"
  | "DISPUTED"
  | "UNVERIFIED_ADDRESS"
  | "AMBIGUOUS"
  | "DATASET_INVALID";

export interface ZoneResolution {
  status: ZoneResolutionStatus;
  zoneId: ZoneId | null;
  zoneNumber: number | null;
  serviceStatus: ZoneServiceStatus | null;
  canonicalAddressKey: string | null;
  routeFlags: ZoneRouteFlags | null;
  matched: {
    settlement_ru: string;
    district_ru: string | null;
    street_ru: string;
    housenumber: string | null;
  } | null;
}

export type ZoneResolutionBasis =
  | "verified_registry_house"
  | "restaurant_zone"
  | "no_address_pickup"
  | "unresolved";

/**
 * Immutable zone snapshot stored on an order at creation. A later zone or tariff
 * change must never rewrite it. Contains NO monetary amount. Mandatory for a new
 * PLATFORM_DRIVER order; PICKUP has no delivery address, so its dropoff is null.
 */
export interface OrderZoneSnapshot {
  readonly zoneReleaseId: string;
  readonly zoneDatasetVersion: string;
  readonly pickupZoneId: ZoneId;
  readonly pickupResolutionBasis: ZoneResolutionBasis;
  readonly dropoffZoneId: ZoneId | null;
  readonly dropoffResolutionBasis: ZoneResolutionBasis;
  readonly dropoffCanonicalAddressKey: string | null;
  readonly dropoffStatus: ZoneResolutionStatus;
  readonly routeFlags: ZoneRouteFlags;
  readonly resolvedAt: string;
  /** Old orders that predate the versioned integration are marked here. */
  readonly legacyPrototype: boolean;
}
