import {
  RAW_FILES,
  VENDORED_RELEASE_ID,
  VENDORED_VERSION,
} from "../../vendor/bender-zones-v1.1/dataset.generated";
import { sha256Hex } from "./sha256";
import type {
  AddressRegistryEntry,
  AdminQaObject,
  ZoneDataset,
  ZonePolygonFeature,
  ZoneReleaseManifest,
} from "./types";

/**
 * Fail-closed validation of the vendored zone release. Nothing here trusts the
 * data blindly (no `as unknown as ZoneDataset`): the manifest is checked field
 * by field, every embedded file is re-hashed against the manifest AND the
 * shipped CHECKSUMS.sha256, and the release id/version/K/prices flag must match
 * exactly. On ANY failure this returns { ok: false, reason } and callers treat
 * the whole dataset as DATASET_INVALID — no delivery order can be created.
 */

const EXPECTED_RELEASE_ID = "bender-zones-v1.1";
const EXPECTED_VERSION = "1.1.0";
const EXPECTED_K = 4;

// Files the resolver/admin actually consume — must be embedded AND hash-verified.
const HASH_VERIFIED_FILES = [
  "address-registry.json",
  "admin-qa-objects.json",
  "street-index.json",
  "zone-polygons.geojson",
  "varnita-village-no-delivery.geojson",
  "varnita-admin-reference.geojson",
  "schemas/zone-release.schema.json",
];

export type ReleaseValidation =
  | { ok: true; dataset: ZoneDataset }
  | { ok: false; reason: string };

function fail(reason: string): ReleaseValidation {
  return { ok: false, reason };
}

function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const sep = trimmed.indexOf("  ");
    if (sep < 0) continue;
    map.set(trimmed.slice(sep + 2), trimmed.slice(0, sep));
  }
  return map;
}

function isRegistryEntry(a: unknown): a is AddressRegistryEntry {
  const e = a as AddressRegistryEntry;
  return (
    !!e &&
    typeof e.uid === "string" &&
    typeof e.settlement_ru === "string" &&
    typeof e.street_ru === "string" &&
    typeof e.housenumber === "string" &&
    e.housenumber.length > 0 &&
    typeof e.canonical_address_key === "string" &&
    e.canonical_address_key.length > 0 &&
    typeof e.zone_id === "number" &&
    e.zone_id >= 1 &&
    e.zone_id <= 4 &&
    typeof e.service_status === "string" &&
    !!e.route_flags &&
    typeof e.route_flags.requires_varnita_transit === "boolean"
  );
}

function runValidation(): ReleaseValidation {
  // 1. Manifest parses.
  let manifest: ZoneReleaseManifest;
  try {
    manifest = JSON.parse(RAW_FILES["manifest.json"]) as ZoneReleaseManifest;
  } catch {
    return fail("manifest is not valid JSON");
  }

  // 2. Identity and hard invariants match exactly.
  if (manifest.release_id !== EXPECTED_RELEASE_ID)
    return fail(`unexpected release_id ${manifest.release_id}`);
  if (VENDORED_RELEASE_ID !== EXPECTED_RELEASE_ID)
    return fail("vendored release id drifted from manifest");
  if (manifest.version !== EXPECTED_VERSION || VENDORED_VERSION !== EXPECTED_VERSION)
    return fail(`unexpected version ${manifest.version}`);
  if (manifest.immutable !== true) return fail("release is not marked immutable");
  if (manifest.decided_k !== EXPECTED_K) return fail(`decided_k must be ${EXPECTED_K}`);
  if (manifest.prices_included !== false)
    return fail("release must not include prices");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0)
    return fail("manifest has no files");
  if (!Array.isArray(manifest.required_files) || manifest.required_files.length === 0)
    return fail("manifest has no required_files");
  if (
    typeof manifest.verified_address_count !== "number" ||
    manifest.verified_address_count <= 0
  )
    return fail("verified_address_count missing");

  // 3. CHECKSUMS.sha256 must agree with the manifest for every declared file.
  const checksums = parseChecksums(RAW_FILES["CHECKSUMS.sha256"] ?? "");
  for (const f of manifest.files) {
    const fromList = checksums.get(f.path);
    if (!fromList) return fail(`CHECKSUMS.sha256 missing ${f.path}`);
    if (fromList !== f.sha256)
      return fail(`CHECKSUMS.sha256 disagrees with manifest for ${f.path}`);
  }

  // 4. Every required file is declared in the manifest.
  const declared = new Set(manifest.files.map((f) => f.path));
  for (const req of manifest.required_files) {
    if (req === "manifest.json" || req === "CHECKSUMS.sha256" || req === "IMMUTABLE")
      continue;
    if (!declared.has(req)) return fail(`required file not declared: ${req}`);
  }

  // 5. Re-hash every consumed file against the manifest. This is the real
  //    fail-closed gate: a single tampered byte -> DATASET_INVALID.
  const byPath = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  for (const path of HASH_VERIFIED_FILES) {
    const raw = RAW_FILES[path];
    if (raw === undefined) return fail(`embedded file missing: ${path}`);
    const want = byPath.get(path);
    if (!want) return fail(`file not in manifest: ${path}`);
    if (sha256Hex(raw) !== want) return fail(`checksum mismatch: ${path}`);
  }

  // 6. Parse the registry + QA objects and validate their shape.
  let registryDoc: { addresses: unknown[]; verified_address_count: number };
  let qaDoc: { objects: unknown[]; qa_object_count: number };
  try {
    registryDoc = JSON.parse(RAW_FILES["address-registry.json"]);
    qaDoc = JSON.parse(RAW_FILES["admin-qa-objects.json"]);
  } catch {
    return fail("registry or QA objects are not valid JSON");
  }
  if (!Array.isArray(registryDoc.addresses))
    return fail("registry has no addresses array");
  if (registryDoc.addresses.length !== manifest.verified_address_count)
    return fail("registry count disagrees with manifest");
  if (!registryDoc.addresses.every(isRegistryEntry))
    return fail("registry contains a malformed or unzoned entry");

  const registry = registryDoc.addresses as AddressRegistryEntry[];
  // canonical_address_key must be unique — a duplicate key means an ambiguous
  // address and is rejected fail-closed.
  const seenKeys = new Set<string>();
  for (const e of registry) {
    if (seenKeys.has(e.canonical_address_key))
      return fail(`duplicate canonical key: ${e.canonical_address_key}`);
    seenKeys.add(e.canonical_address_key);
  }

  const qaObjects = (qaDoc.objects ?? []) as AdminQaObject[];

  // 7. Parse the (already hash-verified) GeoJSON overlays for the admin map.
  const zonePolygons = parsePolygons(RAW_FILES["zone-polygons.geojson"]);
  const varnitaVillageRings = parsePolygons(
    RAW_FILES["varnita-village-no-delivery.geojson"],
  ).flatMap((f) => f.rings);
  const varnitaAdminLines = parseLines(RAW_FILES["varnita-admin-reference.geojson"]);

  return {
    ok: true,
    dataset: {
      manifest,
      releaseId: manifest.release_id,
      version: manifest.version,
      sourceDatasetVersion: manifest.source_dataset_version,
      zoneColors: manifest.zone_colors,
      zoneEdgesKm: manifest.zone_edges_km,
      registry,
      qaObjects,
      zonePolygons,
      varnitaVillageRings,
      varnitaAdminLines,
    },
  };
}

function parseLines(raw: string | undefined): [number, number][][] {
  if (!raw) return [];
  let doc: { features?: unknown[] };
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: [number, number][][] = [];
  for (const f of doc.features ?? []) {
    const geom = (f as { geometry?: { type?: string; coordinates?: unknown } }).geometry;
    if (!geom) continue;
    if (geom.type === "LineString") out.push(geom.coordinates as [number, number][]);
    else if (geom.type === "MultiLineString")
      for (const line of geom.coordinates as [number, number][][]) out.push(line);
  }
  return out;
}

function parsePolygons(raw: string | undefined): ZonePolygonFeature[] {
  if (!raw) return [];
  let doc: { features?: unknown[] };
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: ZonePolygonFeature[] = [];
  for (const f of doc.features ?? []) {
    const feat = f as {
      geometry?: { type?: string; coordinates?: unknown };
      properties?: { zone_id?: number };
    };
    const zoneNumber = feat.properties?.zone_id ?? null;
    const geom = feat.geometry;
    if (!geom) continue;
    const rings: [number, number][][] = [];
    if (geom.type === "Polygon") {
      for (const ring of geom.coordinates as [number, number][][]) rings.push(ring);
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates as [number, number][][][]) {
        for (const ring of poly) rings.push(ring);
      }
    }
    out.push({ zoneNumber, rings });
  }
  return out;
}

let cached: ReleaseValidation | null = null;

/** Validate once and cache. Deterministic over immutable embedded data. */
export function validateVendoredRelease(): ReleaseValidation {
  if (cached === null) cached = runValidation();
  return cached;
}

/** Test-only: force a re-run (e.g. after mutating RAW_FILES in a test). */
export function __resetReleaseValidationCache(): void {
  cached = null;
}
