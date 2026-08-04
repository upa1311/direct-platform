CREATE TABLE "delivery_quote_rate_limits" (
	"actor_id" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"request_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"quote_number" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"origin_address_id" text NOT NULL,
	"origin_address_label" text NOT NULL,
	"origin_zone_id" integer NOT NULL,
	"destination_address_id" text NOT NULL,
	"destination_address_label" text NOT NULL,
	"destination_zone_id" integer NOT NULL,
	"origin_lat" double precision NOT NULL,
	"origin_lon" double precision NOT NULL,
	"destination_lat" double precision NOT NULL,
	"destination_lon" double precision NOT NULL,
	"route_distance_meters" integer NOT NULL,
	"route_distance_km" numeric(10, 3) GENERATED ALWAYS AS (route_distance_meters / 1000.0) STORED,
	"route_duration_seconds" integer NOT NULL,
	"route_duration_min" numeric(10, 2) GENERATED ALWAYS AS (route_duration_seconds / 60.0) STORED,
	"external_meters" integer NOT NULL,
	"external_km" numeric(10, 3) GENERATED ALWAYS AS (external_meters / 1000.0) STORED,
	"crosses_checkpoint" boolean NOT NULL,
	"base_price_cents" integer NOT NULL,
	"base_price" numeric(12, 2) GENERATED ALWAYS AS (base_price_cents / 100.0) STORED,
	"external_surcharge_cents" integer NOT NULL,
	"external_surcharge" numeric(12, 2) GENERATED ALWAYS AS (external_surcharge_cents / 100.0) STORED,
	"total_price_cents" integer NOT NULL,
	"total_price" numeric(12, 2) GENERATED ALWAYS AS (total_price_cents / 100.0) STORED,
	"currency" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"checkpoint_lat" double precision NOT NULL,
	"checkpoint_lon" double precision NOT NULL,
	"checkpoint_route_index" integer NOT NULL,
	"checkpoint_status" text NOT NULL,
	"checkpoint_approved_at" timestamp with time zone NOT NULL,
	"tariff_version" text NOT NULL,
	"route_provider" text NOT NULL,
	"route_geometry" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	CONSTRAINT "delivery_quotes_status_check" CHECK ("delivery_quotes"."status" IN ('draft', 'confirmed', 'cancelled')),
	CONSTRAINT "delivery_quotes_currency_check" CHECK ("delivery_quotes"."currency" = 'RUB'),
	CONSTRAINT "delivery_quotes_route_distance_check" CHECK ("delivery_quotes"."route_distance_meters" > 0),
	CONSTRAINT "delivery_quotes_external_distance_check" CHECK ("delivery_quotes"."external_meters" >= 0),
	CONSTRAINT "delivery_quotes_money_check" CHECK (
    "delivery_quotes"."base_price_cents" >= 0
    AND "delivery_quotes"."external_surcharge_cents" >= 0
    AND "delivery_quotes"."total_price_cents" = "delivery_quotes"."base_price_cents" + "delivery_quotes"."external_surcharge_cents"
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_quotes_quote_number_unique" ON "delivery_quotes" USING btree ("quote_number");--> statement-breakpoint
CREATE INDEX "delivery_quotes_created_at_idx" ON "delivery_quotes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "delivery_quotes_status_idx" ON "delivery_quotes" USING btree ("status");