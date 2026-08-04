import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { LonLat } from "./tariff";

export const deliveryQuotes = pgTable("delivery_quotes", {
  id: uuid("id").primaryKey(),
  quoteNumber: text("quote_number").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull(),
  createdBy: text("created_by").notNull(),
  originAddressId: text("origin_address_id").notNull(),
  originAddressLabel: text("origin_address_label").notNull(),
  originZoneId: integer("origin_zone_id").notNull(),
  destinationAddressId: text("destination_address_id").notNull(),
  destinationAddressLabel: text("destination_address_label").notNull(),
  destinationZoneId: integer("destination_zone_id").notNull(),
  originLat: doublePrecision("origin_lat").notNull(),
  originLon: doublePrecision("origin_lon").notNull(),
  destinationLat: doublePrecision("destination_lat").notNull(),
  destinationLon: doublePrecision("destination_lon").notNull(),
  routeDistanceMeters: integer("route_distance_meters").notNull(),
  routeDistanceKm: numeric("route_distance_km", { precision: 10, scale: 3 })
    .generatedAlwaysAs(sql`route_distance_meters / 1000.0`),
  routeDurationSeconds: integer("route_duration_seconds").notNull(),
  routeDurationMin: numeric("route_duration_min", { precision: 10, scale: 2 })
    .generatedAlwaysAs(sql`route_duration_seconds / 60.0`),
  externalMeters: integer("external_meters").notNull(),
  externalKm: numeric("external_km", { precision: 10, scale: 3 })
    .generatedAlwaysAs(sql`external_meters / 1000.0`),
  crossesCheckpoint: boolean("crosses_checkpoint").notNull(),
  basePriceCents: integer("base_price_cents").notNull(),
  basePrice: numeric("base_price", { precision: 12, scale: 2 })
    .generatedAlwaysAs(sql`base_price_cents / 100.0`),
  externalSurchargeCents: integer("external_surcharge_cents").notNull(),
  externalSurcharge: numeric("external_surcharge", { precision: 12, scale: 2 })
    .generatedAlwaysAs(sql`external_surcharge_cents / 100.0`),
  totalPriceCents: integer("total_price_cents").notNull(),
  totalPrice: numeric("total_price", { precision: 12, scale: 2 })
    .generatedAlwaysAs(sql`total_price_cents / 100.0`),
  currency: text("currency").notNull(),
  checkpointId: text("checkpoint_id").notNull(),
  checkpointLat: doublePrecision("checkpoint_lat").notNull(),
  checkpointLon: doublePrecision("checkpoint_lon").notNull(),
  checkpointRouteIndex: integer("checkpoint_route_index").notNull(),
  checkpointStatus: text("checkpoint_status").notNull(),
  checkpointApprovedAt: timestamp("checkpoint_approved_at", { withTimezone: true }).notNull(),
  tariffVersion: text("tariff_version").notNull(),
  routeProvider: text("route_provider").notNull(),
  routeGeometry: jsonb("route_geometry")
    .$type<{ type: "LineString"; coordinates: readonly LonLat[] }>()
    .notNull(),
  status: text("status").notNull().default("draft"),
  notes: text("notes").notNull().default(""),
}, (table) => [
  uniqueIndex("delivery_quotes_quote_number_unique").on(table.quoteNumber),
  index("delivery_quotes_created_at_idx").on(table.createdAt),
  index("delivery_quotes_status_idx").on(table.status),
  check("delivery_quotes_status_check", sql`${table.status} IN ('draft', 'confirmed', 'cancelled')`),
  check("delivery_quotes_currency_check", sql`${table.currency} = 'RUB'`),
  check("delivery_quotes_route_distance_check", sql`${table.routeDistanceMeters} > 0`),
  check("delivery_quotes_external_distance_check", sql`${table.externalMeters} >= 0`),
  check("delivery_quotes_money_check", sql`
    ${table.basePriceCents} >= 0
    AND ${table.externalSurchargeCents} >= 0
    AND ${table.totalPriceCents} = ${table.basePriceCents} + ${table.externalSurchargeCents}
  `),
]);

export const deliveryQuoteRateLimits = pgTable("delivery_quote_rate_limits", {
  actorId: text("actor_id").primaryKey(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  requestCount: integer("request_count").notNull(),
});
