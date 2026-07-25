# Zoning integration (versioned Bender zones)

Read-only integration of the owner-approved Bender delivery zones (K=4, Scenario
A) from the external repo `upa1311/bender-delivery-zones`. **Zones only — this
integration assigns no money and changes no tariff, price, payout or cash
amount.** Pricing stays in the existing tariff editor at `/admin/zones`.

- **Active release: `bender-zones-v1.1` (version `1.1.0`).**
- **Exact-address only.** A working zone comes only from a confirmed house in the
  verified address registry. There is **no street fallback** and no
  polygon-only guess.
- **Северный is admin-QA only for now.** All 57 Северный objects live in admin
  QA; clients cannot order to Северный until a confirmed address registry ships.
- **Zones are separate from pricing.** No fee, payout, cash or tariff amount was
  changed by this integration.

## Vendored release — `src/vendor/bender-zones-v1.1/`

Holds the immutable release verbatim: `manifest.json`, `CHECKSUMS.sha256`,
`IMMUTABLE`, `address-registry.json`, `street-index.json`,
`admin-qa-objects.json`, `zone-polygons.geojson`,
`varnita-village-no-delivery.geojson`, `varnita-admin-reference.geojson`,
`severny-route-qa.geojson`, and `schemas/zone-release.schema.json`. These files
are never edited in place; a new release is a new vendored folder.

`dataset.generated.ts` is **generated, not committed** (git-ignored). It is
produced ONLY by `npm run verify:zones` after the release passes fail-closed
validation, and it embeds each file's exact bytes so the runtime can re-hash
them.

## Build-time verification — `scripts/verify-zone-release.mjs`

`npm run verify:zones` (wired as `pretest`, `prelint` and `prebuild`) validates
the vendored release fail-closed and regenerates the snapshot only on success.
It checks:

- `release_id = bender-zones-v1.1`, `version = 1.1.0`, `decided_k = 4`,
  `prices_included = false`, `immutable = true`,
  `approved_for_internal_integration = true`,
  `approved_for_customer_address_catalog = true`;
- the manifest against `schemas/zone-release.schema.json`;
- every required file present, and the SHA-256 of every file against both the
  manifest and `CHECKSUMS.sha256`;
- `verified_address_count = 9216`, unique `canonical_address_key`, `zone_id` only
  1–4, and `qa_object_count` matching the manifest (14 013).

On any failure it prints the reason, deletes any stale snapshot and exits
non-zero, so `test`/`lint`/`build` abort before touching the zones.

## Runtime fail-closed check — `src/lib/zones/release-validation.ts`

Independently re-validates the embedded release at load (identity, manifest
fields, per-file SHA-256 via a portable pure-JS `sha256.ts`, registry shape,
zone range, unique canonical keys). No `as unknown as ZoneDataset`. On any
failure the Zone Registry is **DATASET_INVALID** and no delivery order can be
created.

## Exact-address resolver — `src/lib/zones/address-resolver.ts`

Reads **only** `address-registry.json`, keyed by the canonical
`settlement|district|street|house`. There is no `resolved_by_street`. Results:

| Result | When |
|---|---|
| `RESOLVED` | exact verified house in the registry |
| `NO_DELIVERY` | Varnița village, or a `no_delivery` QA object |
| `DISPUTED` | a `disputed` QA object |
| `UNVERIFIED_ADDRESS` | owner-review / unaddressed / Северный, or a street without a house |
| `NOT_FOUND` | unknown exact address |
| `AMBIGUOUS` | same house in two districts with different zones |
| `DATASET_INVALID` | the release failed validation |

## Client address selection

The client cart and catalog now pick addresses from the verified registry only
(`src/components/client/client-address-picker.tsx`): settlement → district →
street → house, with suggestions drawn from `address-registry.json`, duplicate
streets split by district, and a live zone/verification indicator. For
PLATFORM_DRIVER the resolver must return `RESOLVED` or the order is refused;
PICKUP still works without an address.

## Order zone snapshot — `src/lib/zones/order-zone-snapshot.ts`

A new PLATFORM_DRIVER order gets a **mandatory, immutable** snapshot in the same
mutation that creates the order: `pickupZoneId`, `dropoffZoneId`,
`zoneDatasetVersion`, `zoneReleaseId`, `pickupResolutionBasis`,
`dropoffResolutionBasis`, `dropoffCanonicalAddressKey`, `routeFlags`. PICKUP has
`dropoffZoneId = null`. Old orders keep their original `zoneId` and are
normalized as `legacy-prototype`. The snapshot carries no money.

## Guarantees

- No vendored file contains a price/fee/payout amount; the verifier refuses to
  generate a snapshot if a money token appears.
- The integration modules never modify `financials`, `order-money-movement`,
  tariffs, driver earnings or cash ledgers. Existing tariff amounts and
  `driverPayoutCents` are unchanged.
- The Zone Registry is DATASET_INVALID → order creation is blocked, and the app
  never silently falls back to the old test street list.

## Upgrade procedure (future release)

1. In `bender-delivery-zones`, publish a new immutable release (e.g.
   `bender-zones-v1.2`) with its manifest + `CHECKSUMS.sha256`.
2. Copy it to `src/vendor/bender-zones-v1.2/` (never edit the old folder).
3. Update the expected `release_id`/`version` constants in
   `scripts/verify-zone-release.mjs` and `src/lib/zones/release-validation.ts`,
   and point the generated-snapshot import at the new folder.
4. Run `npm run verify:zones` — it must pass fail-closed — then `npm test`,
   `npm run lint`, `npm run build`.
5. Zones only: never add a fee, payout or tariff to a zone release.
