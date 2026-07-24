import type { ZoneId } from "@/prototype/models";
import { zoneDataset as datasetJson } from "../../vendor/bender-zones-v1/zone-dataset.generated";

import type { ZoneDataset, ZoneDatasetZone, ZoneStreet } from "./types";

/**
 * Independent Zone Registry. Reads the vendored, versioned zone dataset and
 * exposes read-only lookups. It is deliberately decoupled from tariffs and any
 * financial code: it knows zones, not money.
 */

const dataset = datasetJson as unknown as ZoneDataset;

/** NFKC + trim + collapse whitespace + lowercase — mirrors the zones repo. */
export function normalizeName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function streetKey(settlement: string, street: string): string {
  return `${normalizeName(settlement)}|${normalizeName(street)}`;
}

// settlement|street -> entries (>1 means the street repeats across districts).
const streetIndex: Map<string, ZoneStreet[]> = (() => {
  const index = new Map<string, ZoneStreet[]>();
  for (const s of dataset.resolution_index.streets) {
    const key = streetKey(s.settlement_ru, s.street_ru);
    const bucket = index.get(key);
    if (bucket) bucket.push(s);
    else index.set(key, [s]);
  }
  return index;
})();

const zonesById: Map<number, ZoneDatasetZone> = new Map(
  dataset.zones.map((z) => [z.zone_id, z] as const),
);

export function zoneDatasetVersion(): string {
  return dataset.source_dataset_version;
}

export function zoneRelease(): string {
  return `${dataset.release}@${dataset.version}`;
}

export function zoneEdgesKm(): number[] {
  return [...dataset.zone_edges_km];
}

/** Distinct zones (Zone 1..4). The Северный enclave is a Zone-4 component. */
export function listZones(): ZoneDatasetZone[] {
  const seen = new Set<number>();
  const out: ZoneDatasetZone[] = [];
  for (const z of dataset.zones) {
    if (!seen.has(z.zone_id)) {
      seen.add(z.zone_id);
      out.push(z);
    }
  }
  return out.sort((a, b) => a.zone_id - b.zone_id);
}

export function zoneComponents(): ZoneDatasetZone[] {
  return [...dataset.zones];
}

export function zoneColor(zoneNumber: number): string | null {
  return dataset.zone_colors[String(zoneNumber)] ?? null;
}

export function toZoneId(zoneNumber: number): ZoneId {
  return `zone-${zoneNumber}` as ZoneId;
}

export function fromZoneId(zoneId: ZoneId): number {
  return Number.parseInt(zoneId.replace("zone-", ""), 10);
}

/**
 * Street entries for a (settlement, street). Optionally filtered by district.
 * Returns every match so the caller can detect a district-ambiguous street
 * (same street name in two districts of one settlement).
 */
export function findStreets(
  settlement: string,
  street: string,
  district?: string | null,
): ZoneStreet[] {
  const bucket = streetIndex.get(streetKey(settlement, street)) ?? [];
  if (district == null || district === "") return bucket;
  const wanted = normalizeName(district);
  const filtered = bucket.filter((s) => normalizeName(s.district_ru) === wanted);
  return filtered.length > 0 ? filtered : bucket;
}

export function streetCount(): number {
  return dataset.resolution_index.streets.length;
}

export function allStreets(): ZoneStreet[] {
  return dataset.resolution_index.streets;
}

export function zoneById(zoneNumber: number): ZoneDatasetZone | null {
  return zonesById.get(zoneNumber) ?? null;
}
