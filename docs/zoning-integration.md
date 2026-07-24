# Zoning integration (versioned Bender zones)

Read-only integration of the owner-approved Bender delivery zones (K=4, Scenario
A) from the external repo `upa1311/bender-delivery-zones`. **Zones only — this
integration assigns no money and changes no tariff, price, payout or cash
amount.** Pricing stays in the existing tariff editor at `/admin/zones`.

## What was added

### Vendored release
`src/vendor/bender-zones-v1/` holds the immutable release
`bender-zones-v1@1.0.0`: `manifest.json`, `CHECKSUMS.sha256`, `IMMUTABLE`, the
compact `zone-dataset.json` (zones + address→zone resolution index,
`prices_included: false`) and a generated `zone-dataset.generated.ts` wrapper so
the dataset loads under both the Next build and `node --test`. Re-releasing zones
means vendoring a new versioned folder; this one is never edited in place.

### Independent Zone Registry — `src/lib/zones/zone-registry.ts`
Loads the vendored dataset and exposes read-only lookups (`listZones`,
`zoneColor`, `findStreets`, `zoneDatasetVersion`, `zoneRelease`). It is decoupled
from tariffs and all financial code.

### Real address resolver — `src/lib/zones/address-resolver.ts`
`resolveAddressZone({ settlement, district, street, house })` → zone. The **house
is the source of truth**: an exact house resolves to its own zone; a split street
without a house is `ambiguous_street` (never a guessed zone); the same street
name in different settlements is not merged; **Varnița is always `no_delivery`**.

### Admin — `/admin/zone-registry`
A new, read-only page showing the versioned dataset (release + source version,
the four zone colours, edges) and an exact-address → zone lookup. It does **not**
touch `/admin/zones`, which remains the tariff (money) editor.

### Driver — `/driver/zones`
A driver-facing zones reference with a prominent **Varnița no-delivery warning**
("дороги через Варницу — только транзит") and a quick address check. Read-only,
no prices. `src/lib/zones/driver-zone-view.ts` provides the pure view logic
(`driverOrderZoneView(order)`).

### Immutable order zone snapshot — `src/lib/zones/order-zone-snapshot.ts`
`buildOrderZoneSnapshot` / `attachOrderZoneSnapshot` freeze the
`zone_dataset_version`, release and origin/destination zones onto an order.
`Order.zoneSnapshot?` was added as an **optional** field (existing orders and
tests are unaffected). Per the repo rule that old orders keep immutable
snapshots, a later zone or tariff change never rewrites a finished order. The
snapshot carries no monetary field and the helper does not read or write any
money on the order (financials are carried by reference, unchanged).

## Guarantees

- No file in `src/vendor/bender-zones-v1/` contains a price/fee/payout amount.
- The integration modules never import or modify `financials`,
  `order-money-movement`, tariffs or cash ledgers.
- `Order.zoneSnapshot` is optional; the 2283 pre-existing tests are unchanged.
- 15 new zone tests (`src/lib/zones/zones.test.ts`) cover resolution, the split
  street rule, Varnița no-delivery, Северный → Zone 4, and snapshot
  immutability.

## Not done (out of scope)

- No prices, tariffs or cash amounts were added or changed.
- Driver earnings / cash ledger / settlements were not touched.
- The zone snapshot capability is provided and tested; wiring it into the live
  order-creation flow can follow once the owner confirms the trigger point.

Source of truth for the zones: `bender-zones-v1` manifest
(`source_dataset_version` recorded in every snapshot).
