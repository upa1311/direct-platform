export const DELIVERY_QUOTE_TARIFF_VERSION = "bender-reference-v3";
export const DELIVERY_QUOTE_CURRENCY = "RUB";

export const CANONICAL_CHECKPOINT = Object.freeze({
  id: "parkany-owner-approved-gate-v1",
  lat: 46.829970,
  lon: 29.487740,
  routeIndex: 33,
  status: "owner_approved" as const,
  approvedAt: "2026-08-03T22:31:23.434Z",
  geometry: Object.freeze([
    Object.freeze([29.488916486194423, 46.82989358661517] as const),
    Object.freeze([29.486563513805574, 46.830046413384835] as const),
  ]) as readonly [readonly [number, number], readonly [number, number]],
});

export const INTERNAL_REFERENCE_LON_LAT = Object.freeze([
  29.48313,
  46.82388,
] as const);

export const CANONICAL_CATALOG_METRICS = Object.freeze({
  catalogTotal: 9216,
  routed: 9215,
  duplicate: 1,
  crossesCheckpoint: 4315,
  doesNotCrossCheckpoint: 4900,
  zoneCounts: Object.freeze([2729, 2557, 2588, 1341]),
  jenksBreaks: Object.freeze([18.3, 25.7, 33.0, 52.9]),
});
