import type { ZoneId } from "@/prototype/models";

import { validateVendoredRelease } from "./release-validation";
import type {
  AddressRegistryEntry,
  AdminQaObject,
  ZoneDataset,
  ZonePolygonFeature,
} from "./types";

/**
 * Independent Zone Registry over the versioned, fail-closed release. It exposes
 * read-only lookups keyed by the EXACT verified address. It is deliberately
 * decoupled from tariffs and any financial code: it knows zones, not money. If
 * the vendored release fails validation the registry is "invalid" and every
 * resolution returns DATASET_INVALID.
 */

/** NFKC + trim + collapse whitespace + lowercase — mirrors the zones repo. */
export function normalizeName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** settlement|district|street|house — identical to the release's canonical key. */
export function canonicalAddressKey(
  settlement: string | null | undefined,
  district: string | null | undefined,
  street: string | null | undefined,
  house: string | null | undefined,
): string {
  return [
    normalizeName(settlement),
    normalizeName(district),
    normalizeName(street),
    normalizeName(house),
  ].join("|");
}

interface RegistryIndex {
  valid: boolean;
  reason: string | null;
  dataset: ZoneDataset | null;
  byCanonical: Map<string, AddressRegistryEntry>;
  // settlement|street|house, district-agnostic → entries (ambiguity detection)
  bySettlementStreetHouse: Map<string, AddressRegistryEntry[]>;
  // settlement|street → verified houses (admin display)
  byStreet: Map<string, AddressRegistryEntry[]>;
  // QA objects that carry a canonical key → object (disputed / no_delivery / …)
  qaByCanonical: Map<string, AdminQaObject>;
  qaObjects: AdminQaObject[];
}

function streetKey(settlement: string, street: string): string {
  return `${normalizeName(settlement)}|${normalizeName(street)}`;
}
function shhKey(settlement: string, street: string, house: string): string {
  return `${normalizeName(settlement)}|${normalizeName(street)}|${normalizeName(house)}`;
}

function buildIndex(): RegistryIndex {
  const empty: RegistryIndex = {
    valid: false,
    reason: null,
    dataset: null,
    byCanonical: new Map(),
    bySettlementStreetHouse: new Map(),
    byStreet: new Map(),
    qaByCanonical: new Map(),
    qaObjects: [],
  };

  const validation = validateVendoredRelease();
  if (!validation.ok) return { ...empty, reason: validation.reason };

  const dataset = validation.dataset;
  const byCanonical = new Map<string, AddressRegistryEntry>();
  const bySettlementStreetHouse = new Map<string, AddressRegistryEntry[]>();
  const byStreet = new Map<string, AddressRegistryEntry[]>();
  const push = (map: Map<string, AddressRegistryEntry[]>, key: string, e: AddressRegistryEntry) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(e);
    else map.set(key, [e]);
  };
  for (const e of dataset.registry) {
    byCanonical.set(e.canonical_address_key, e);
    push(bySettlementStreetHouse, shhKey(e.settlement_ru, e.street_ru, e.housenumber), e);
    push(byStreet, streetKey(e.settlement_ru, e.street_ru), e);
  }

  const qaByCanonical = new Map<string, AdminQaObject>();
  for (const o of dataset.qaObjects) {
    if (o.canonical_address_key) qaByCanonical.set(o.canonical_address_key, o);
  }

  return {
    valid: true,
    reason: null,
    dataset,
    byCanonical,
    bySettlementStreetHouse,
    byStreet,
    qaByCanonical,
    qaObjects: dataset.qaObjects,
  };
}

let index: RegistryIndex | null = null;
function idx(): RegistryIndex {
  if (index === null) index = buildIndex();
  return index;
}

/** Test-only: rebuild the registry (after mutating the vendored data). */
export function __resetRegistryIndex(): void {
  index = null;
}

export function isDatasetValid(): boolean {
  return idx().valid;
}
export function datasetInvalidReason(): string | null {
  return idx().reason;
}

export function zoneDatasetVersion(): string {
  return idx().dataset?.sourceDatasetVersion ?? "invalid";
}
export function zoneReleaseId(): string {
  return idx().dataset?.releaseId ?? "invalid";
}
export function zoneRelease(): string {
  const d = idx().dataset;
  return d ? `${d.releaseId}@${d.version}` : "invalid";
}
export function zoneEdgesKm(): number[] {
  return [...(idx().dataset?.zoneEdgesKm ?? [])];
}
export function verifiedAddressCount(): number {
  return idx().byCanonical.size;
}
export function manifest() {
  return idx().dataset?.manifest ?? null;
}

export function zoneColor(zoneNumber: number): string | null {
  return idx().dataset?.zoneColors[String(zoneNumber)] ?? null;
}
export function toZoneId(zoneNumber: number): ZoneId {
  return `zone-${zoneNumber}` as ZoneId;
}
export function fromZoneId(zoneId: ZoneId): number {
  return Number.parseInt(zoneId.replace("zone-", ""), 10);
}

/** The exact verified house for a canonical key, or null. The only zone source. */
export function registryByCanonical(key: string): AddressRegistryEntry | null {
  return idx().byCanonical.get(key) ?? null;
}

/** Verified houses matching settlement+street+house across districts. */
export function registryBySettlementStreetHouse(
  settlement: string,
  street: string,
  house: string,
): AddressRegistryEntry[] {
  return idx().bySettlementStreetHouse.get(shhKey(settlement, street, house)) ?? [];
}

export function qaByCanonical(key: string): AdminQaObject | null {
  return idx().qaByCanonical.get(key) ?? null;
}

// --- admin-facing read models ----------------------------------------------

export function allRegistryEntries(): AddressRegistryEntry[] {
  return idx().dataset?.registry ?? [];
}
export function allQaObjects(): AdminQaObject[] {
  return idx().qaObjects;
}
export function verifiedHousesForStreet(
  settlement: string,
  street: string,
): AddressRegistryEntry[] {
  return idx().byStreet.get(streetKey(settlement, street)) ?? [];
}
export function streetCount(): number {
  return idx().byStreet.size;
}

// --- client address picker selectors (verified registry only) ---------------

/** Distinct settlements that have at least one verified deliverable address. */
export function registrySettlements(): string[] {
  const set = new Set<string>();
  for (const e of allRegistryEntries()) set.add(e.settlement_ru);
  return [...set].sort((a, b) => a.localeCompare(b, "ru"));
}

/** Districts (non-null) with verified addresses in a settlement. */
export function registryDistrictsForSettlement(settlement: string): string[] {
  const want = normalizeName(settlement);
  const set = new Set<string>();
  for (const e of allRegistryEntries()) {
    if (normalizeName(e.settlement_ru) === want && e.district_ru) set.add(e.district_ru);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ru"));
}

/** Verified streets in a settlement (optionally a district), for suggestions. */
export function registryStreets(
  settlement: string,
  district?: string | null,
): string[] {
  const wantS = normalizeName(settlement);
  const wantD = district ? normalizeName(district) : null;
  const set = new Set<string>();
  for (const e of allRegistryEntries()) {
    if (normalizeName(e.settlement_ru) !== wantS) continue;
    if (wantD !== null && normalizeName(e.district_ru) !== wantD) continue;
    set.add(e.street_ru);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ru"));
}

/** Verified house numbers for an exact street (optionally a district). */
export function registryHouses(
  settlement: string,
  street: string,
  district?: string | null,
): string[] {
  const wantD = district ? normalizeName(district) : null;
  const houses = verifiedHousesForStreet(settlement, street).filter((e) =>
    wantD === null ? true : normalizeName(e.district_ru) === wantD,
  );
  return houses
    .map((e) => e.housenumber)
    .sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
}

/** Each verified street mapped to its primary (most common) zone, 1..4. */
export function streetsByPrimaryZone(): Record<number, string[]> {
  const perStreet = new Map<string, Map<number, number>>();
  for (const e of allRegistryEntries()) {
    const counts = perStreet.get(e.street_ru) ?? new Map<number, number>();
    counts.set(e.zone_id, (counts.get(e.zone_id) ?? 0) + 1);
    perStreet.set(e.street_ru, counts);
  }
  const out: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const [street, counts] of perStreet) {
    let bestZone = 1;
    let bestCount = -1;
    for (const [zone, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        bestZone = zone;
      }
    }
    out[bestZone].push(street);
  }
  for (const z of [1, 2, 3, 4]) out[z].sort((a, b) => a.localeCompare(b, "ru"));
  return out;
}

export interface ZoneSummary {
  zone_id: number;
  zone_name: string;
  color: string | null;
}

/** The four zones for UI chips, derived from the validated release. */
export function listZones(): ZoneSummary[] {
  const colors = idx().dataset?.zoneColors ?? {};
  return [1, 2, 3, 4].map((n) => ({
    zone_id: n,
    zone_name: `Zone ${n}`,
    color: colors[String(n)] ?? null,
  }));
}

export interface QaCounts {
  disputed: number;
  no_delivery: number;
  unaddressed: number;
  excluded: number;
  ownerReview: number;
  severny: number;
}

/** Admin readiness counts over the QA objects (never serviceable). */
export function qaCounts(): QaCounts {
  const c: QaCounts = {
    disputed: 0,
    no_delivery: 0,
    unaddressed: 0,
    excluded: 0,
    ownerReview: 0,
    severny: 0,
  };
  for (const o of idx().qaObjects) {
    if (o.service_status === "disputed") c.disputed++;
    if (o.service_status === "no_delivery") c.no_delivery++;
    if (o.service_status === "excluded" || o.address_status === "excluded") c.excluded++;
    if (o.address_status === "unaddressed_delivery_unit") c.unaddressed++;
    if (o.owner_review_required) c.ownerReview++;
    if (o.district_ru === "Северный") c.severny++;
  }
  return c;
}

/** True when the release is approved for the customer address catalog. */
export function isSevernyCatalogComplete(): boolean {
  return idx().dataset?.manifest.severny_address_catalog_complete ?? false;
}

/** Zone polygons for the admin map (from the hash-verified geojson). */
export function zonePolygons(): ZonePolygonFeature[] {
  return idx().dataset?.zonePolygons ?? [];
}

/** Varnița village no-delivery area rings for the admin map. */
export function varnitaVillageRings(): [number, number][][] {
  return idx().dataset?.varnitaVillageRings ?? [];
}

/** Varnița administrative border reference lines (dashed) for the admin map. */
export function varnitaAdminLines(): [number, number][][] {
  return idx().dataset?.varnitaAdminLines ?? [];
}
