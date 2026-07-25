// Build-time fail-closed verification of the vendored Bender zone release.
//
// Reads the immutable vendored files under src/vendor/bender-zones-v1.1,
// validates them STRICTLY (identity, manifest schema, required files, SHA-256 of
// every file vs manifest AND CHECKSUMS.sha256, verified_address_count, unique
// canonical keys, zone_id 1-4), and ONLY on success (re)generates the validated
// TypeScript snapshot `dataset.generated.ts`. On ANY failure it prints the
// reason, does NOT write the snapshot, and exits non-zero so `npm test` /
// `npm run build` abort before ever touching the zones.
//
// Run via `npm run verify:zones` (also wired as pretest/prebuild).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "..", "src", "vendor", "bender-zones-v1.1");
const GENERATED = join(VENDOR, "dataset.generated.ts");

const EXPECTED = {
  release_id: "bender-zones-v1.1",
  version: "1.1.0",
  decided_k: 4,
  verified_address_count: 9216,
  qa_object_count: 14013,
};

// Files embedded into the generated TS (parsed + hashed at runtime too). This is
// EVERY file declared in the manifest, so the runtime re-hashes the whole
// release rather than a subset.
const EMBED = [
  "manifest.json",
  "address-registry.json",
  "admin-qa-objects.json",
  "street-index.json",
  "zone-polygons.geojson",
  "varnita-village-no-delivery.geojson",
  "varnita-admin-reference.geojson",
  "severny-route-qa.geojson",
  "schemas/zone-release.schema.json",
];

function die(msg) {
  console.error(`verify:zones FAILED — ${msg}`);
  // Never leave a stale snapshot that could be silently consumed.
  if (existsSync(GENERATED)) rmSync(GENERATED);
  process.exit(1);
}

function readLf(rel) {
  const p = join(VENDOR, rel);
  if (!existsSync(p)) die(`required file missing on disk: ${rel}`);
  return readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
}
const sha256 = (text) => createHash("sha256").update(text, "utf-8").digest("hex");

// --- minimal JSON-schema validator (const / type / pattern / minimum / items /
//     required / minItems / maxItems) — enough for the release manifest schema.
function validateSchema(value, schema, path = "$") {
  const errs = [];
  const t = (v) =>
    Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const))
    errs.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  if (schema.type) {
    const ty = t(value);
    const ok = schema.type === "integer"
      ? ty === "number" && Number.isInteger(value)
      : ty === schema.type;
    if (!ok) errs.push(`${path}: expected type ${schema.type}, got ${ty}`);
  }
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value))
    errs.push(`${path}: does not match /${schema.pattern}/`);
  if (typeof value === "number" && "minimum" in schema && value < schema.minimum)
    errs.push(`${path}: below minimum ${schema.minimum}`);
  if (Array.isArray(value)) {
    if ("minItems" in schema && value.length < schema.minItems)
      errs.push(`${path}: fewer than ${schema.minItems} items`);
    if ("maxItems" in schema && value.length > schema.maxItems)
      errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items)
      value.forEach((v, i) => errs.push(...validateSchema(v, schema.items, `${path}[${i}]`)));
  }
  if (schema.type === "object" && value && typeof value === "object") {
    for (const req of schema.required ?? [])
      if (!(req in value)) errs.push(`${path}: missing required "${req}"`);
    for (const [k, sub] of Object.entries(schema.properties ?? {}))
      if (k in value) errs.push(...validateSchema(value[k], sub, `${path}.${k}`));
  }
  return errs;
}

// --- run ---------------------------------------------------------------------
const manifestText = readLf("manifest.json");
let manifest;
try {
  manifest = JSON.parse(manifestText);
} catch {
  die("manifest.json is not valid JSON");
}

// 1. Manifest schema.
const schema = JSON.parse(readLf("schemas/zone-release.schema.json"));
const schemaErrs = validateSchema(manifest, schema);
if (schemaErrs.length) die(`manifest fails schema:\n  ${schemaErrs.join("\n  ")}`);

// 2. Identity + hard invariants.
if (manifest.release_id !== EXPECTED.release_id) die(`release_id must be ${EXPECTED.release_id}`);
if (manifest.version !== EXPECTED.version) die(`version must be ${EXPECTED.version}`);
if (manifest.decided_k !== EXPECTED.decided_k) die("decided_k must be 4");
if (manifest.prices_included !== false) die("prices_included must be false");
if (manifest.immutable !== true) die("immutable must be true");
if (manifest.approved_for_internal_integration !== true)
  die("approved_for_internal_integration must be true");
if (manifest.approved_for_customer_address_catalog !== true)
  die("approved_for_customer_address_catalog must be true");
if (manifest.approved_for_internal_integration !== true)
  die("approved_for_internal_integration must be true");
if (manifest.approved_for_customer_address_catalog !== true)
  die("approved_for_customer_address_catalog must be true");
if (manifest.verified_address_count !== EXPECTED.verified_address_count)
  die(`verified_address_count must be ${EXPECTED.verified_address_count}`);
if (manifest.qa_object_count !== EXPECTED.qa_object_count)
  die(`qa_object_count must be ${EXPECTED.qa_object_count}`);

// 3. Required files declared + present, checksums agree (manifest vs CHECKSUMS).
const checksums = new Map();
for (const line of readLf("CHECKSUMS.sha256").split("\n")) {
  const i = line.indexOf("  ");
  if (i > 0) checksums.set(line.slice(i + 2).trim(), line.slice(0, i).trim());
}
const declared = new Map(manifest.files.map((f) => [f.path, f.sha256]));
for (const req of manifest.required_files ?? []) {
  if (["manifest.json", "CHECKSUMS.sha256", "IMMUTABLE"].includes(req)) continue;
  if (!declared.has(req)) die(`required file not declared in manifest: ${req}`);
}
for (const f of manifest.files) {
  const actual = sha256(readLf(f.path));
  if (actual !== f.sha256) die(`SHA-256 mismatch for ${f.path} (manifest)`);
  if (checksums.get(f.path) !== f.sha256) die(`CHECKSUMS.sha256 disagrees for ${f.path}`);
}

// 4. Registry invariants: count, unique canonical, zone_id 1-4.
const registry = JSON.parse(readLf("address-registry.json"));
if (!Array.isArray(registry.addresses)) die("address-registry has no addresses[]");
if (registry.addresses.length !== EXPECTED.verified_address_count)
  die(`registry length ${registry.addresses.length} != ${EXPECTED.verified_address_count}`);
if (registry.prices_included !== false) die("registry prices_included must be false");
const seen = new Set();
for (const a of registry.addresses) {
  if (!(a.zone_id >= 1 && a.zone_id <= 4)) die(`registry has zone_id ${a.zone_id} (only 1-4 allowed)`);
  if (!a.housenumber) die(`registry entry ${a.uid} has no housenumber`);
  if (!a.canonical_address_key) die(`registry entry ${a.uid} has no canonical_address_key`);
  if (seen.has(a.canonical_address_key)) die(`duplicate canonical key: ${a.canonical_address_key}`);
  seen.add(a.canonical_address_key);
}

// 5. QA objects count matches the manifest.
const qa = JSON.parse(readLf("admin-qa-objects.json"));
if (!Array.isArray(qa.objects)) die("admin-qa-objects has no objects[]");
if (qa.objects.length !== manifest.qa_object_count)
  die(`qa objects ${qa.objects.length} != manifest ${manifest.qa_object_count}`);

// --- success: generate the validated snapshot --------------------------------
const embed = {};
for (const rel of EMBED) embed[rel] = readLf(rel);
embed["CHECKSUMS.sha256"] = readLf("CHECKSUMS.sha256");

const lines = [
  "// GENERATED by scripts/verify-zone-release.mjs — do not edit by hand.",
  "// This file exists ONLY because verify:zones validated the vendored release",
  `// ${manifest.release_id} (${manifest.version}) fail-closed. Regenerate with`,
  "// `npm run verify:zones`. Raw file texts are embedded verbatim so the runtime",
  "// validator can re-hash them.",
  "",
  `export const VENDORED_RELEASE_ID = ${JSON.stringify(manifest.release_id)};`,
  `export const VENDORED_VERSION = ${JSON.stringify(manifest.version)};`,
  "",
  "/** Raw file text keyed by release-relative path, exactly as checksummed. */",
  "export const RAW_FILES: Record<string, string> = {",
  ...Object.entries(embed).map(([rel, text]) => `  ${JSON.stringify(rel)}: ${JSON.stringify(text)},`),
  "};",
  "",
];
writeFileSync(GENERATED, lines.join("\n") + "\n", { encoding: "utf-8" });

console.log(
  `verify:zones OK — ${manifest.release_id} ${manifest.version}: ` +
    `verified_address_count=${registry.addresses.length}, ` +
    `qa_object_count=${qa.objects.length}, unique canonical keys=${seen.size}. ` +
    "Snapshot regenerated.",
);
