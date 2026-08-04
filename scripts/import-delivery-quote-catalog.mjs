import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const EXPECTED_SOURCE_SHA256 =
  "4ad9b2c731af25135c03cd9a69aecac70ff53930bd2d38ca20ba7deddc714c8f";
const EXPECTED_SOURCE_COMMIT = "576b9257da44b655a2dd374f8dfca32827942af8";
const source = resolve(
  process.argv[2]
    ?? "../bender-delivery-zones/docs/review/data/address-index.json",
);
const target = resolve(
  "src/vendor/bender-delivery-v2/address-catalog.generated.json",
);

const raw = await readFile(source);
const sourceSha256 = createHash("sha256").update(raw).digest("hex");
if (sourceSha256 !== EXPECTED_SOURCE_SHA256) {
  throw new Error(`Unexpected source checksum: ${sourceSha256}`);
}

const document = JSON.parse(raw.toString("utf8"));
const expectedSchema = [
  "uid",
  "address",
  "lon",
  "lat",
  "status",
  "route_km",
  "old_k4_zone_id",
  "internal_zone",
  "reference_price",
];
if (JSON.stringify(document.schema) !== JSON.stringify(expectedSchema)) {
  throw new Error("Unexpected address-index schema");
}
if (!Array.isArray(document.addresses) || document.addresses.length !== 9_216) {
  throw new Error("Address catalog must contain exactly 9,216 rows");
}

const addresses = document.addresses.map((row) => [
  row[0],
  row[1],
  row[2],
  row[3],
  row[4],
  row[7],
]);
const statusCounts = Object.groupBy(addresses, (row) => row[4]);
const zoneCounts = Object.groupBy(
  addresses.filter((row) => row[4] === "routed"),
  (row) => String(row[5]),
);
const actualStatusCounts = Object.fromEntries(
  Object.entries(statusCounts).map(([key, rows]) => [key, rows.length]),
);
const actualZoneCounts = Object.fromEntries(
  Object.entries(zoneCounts).map(([key, rows]) => [key, rows.length]),
);
if (JSON.stringify(actualStatusCounts) !== JSON.stringify({ routed: 9215, duplicate: 1 })) {
  throw new Error(`Unexpected status counts: ${JSON.stringify(actualStatusCounts)}`);
}
if (JSON.stringify(actualZoneCounts) !== JSON.stringify({ 1: 2729, 2: 2557, 3: 2588, 4: 1341 })) {
  throw new Error(`Unexpected zone counts: ${JSON.stringify(actualZoneCounts)}`);
}

const output = {
  source: {
    repository: "upa1311/bender-delivery-zones",
    commit: EXPECTED_SOURCE_COMMIT,
    path: "docs/review/data/address-index.json",
    sha256: sourceSha256,
  },
  schema: ["uid", "address", "lon", "lat", "status", "zone_id"],
  canonical: {
    catalog_total: 9216,
    routed: 9215,
    duplicate: 1,
    zone_counts: [2729, 2557, 2588, 1341],
  },
  addresses,
};
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(output)}\n`, "utf8");
console.log(`Wrote ${addresses.length} canonical addresses to ${target}`);
