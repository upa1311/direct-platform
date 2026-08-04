import { randomUUID } from "node:crypto";

import type { QuoteSqlClient } from "./database";
import { getQuoteSqlClient } from "./database";
import type { QuoteCalculation, QuoteStatus, StoredQuote } from "./types";

interface QuoteRow extends Record<string, unknown> {
  id: string;
  quote_number: string;
  created_at: Date | string;
  calculated_at: Date | string;
  created_by: string;
  origin_address_id: string;
  origin_address_label: string;
  origin_zone_id: number;
  destination_address_id: string;
  destination_address_label: string;
  destination_zone_id: number;
  origin_lat: number;
  origin_lon: number;
  destination_lat: number;
  destination_lon: number;
  route_distance_meters: number;
  route_duration_seconds: number;
  external_meters: number;
  crosses_checkpoint: boolean;
  base_price_cents: number;
  external_surcharge_cents: number;
  total_price_cents: number;
  currency: "RUB";
  checkpoint_id: string;
  checkpoint_lat: number;
  checkpoint_lon: number;
  checkpoint_route_index: number;
  checkpoint_status: "owner_approved";
  checkpoint_approved_at: Date | string;
  tariff_version: string;
  route_provider: "osrm";
  route_geometry: QuoteCalculation["routeGeometry"];
  status: QuoteStatus;
  notes: string;
}

export interface QuoteListInput {
  readonly query?: string;
  readonly status?: QuoteStatus;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface QuoteListResult {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly items: readonly StoredQuote[];
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToStoredQuote(row: QuoteRow): StoredQuote {
  return Object.freeze({
    id: row.id,
    quoteNumber: row.quote_number,
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
    origin: Object.freeze({
      id: row.origin_address_id,
      label: row.origin_address_label,
      lat: row.origin_lat,
      lon: row.origin_lon,
      status: "routed" as const,
      zoneId: row.origin_zone_id,
      settlement: row.origin_address_label.split(",")[0]?.trim() ?? "",
      street: "",
      house: "",
    }),
    destination: Object.freeze({
      id: row.destination_address_id,
      label: row.destination_address_label,
      lat: row.destination_lat,
      lon: row.destination_lon,
      status: "routed" as const,
      zoneId: row.destination_zone_id,
      settlement: row.destination_address_label.split(",")[0]?.trim() ?? "",
      street: "",
      house: "",
    }),
    routeDistanceMeters: row.route_distance_meters,
    routeDurationSeconds: row.route_duration_seconds,
    externalMeters: row.external_meters,
    crossesCheckpoint: row.crosses_checkpoint,
    basePriceCents: row.base_price_cents,
    externalSurchargeCents: row.external_surcharge_cents,
    totalPriceCents: row.total_price_cents,
    currency: row.currency,
    checkpoint: {
      id: row.checkpoint_id,
      lat: row.checkpoint_lat,
      lon: row.checkpoint_lon,
      routeIndex: row.checkpoint_route_index,
      status: row.checkpoint_status,
      approvedAt: iso(row.checkpoint_approved_at),
    },
    tariffVersion: row.tariff_version,
    routeProvider: row.route_provider,
    routeGeometry: row.route_geometry,
    calculatedAt: iso(row.calculated_at),
    status: row.status,
    notes: row.notes,
  });
}

function quoteNumber(now: Date): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `DQ-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

const selectedColumns = `
  id, quote_number, created_at, calculated_at, created_by,
  origin_address_id, origin_address_label, origin_zone_id, destination_address_id,
  destination_address_label, destination_zone_id, origin_lat, origin_lon, destination_lat,
  destination_lon, route_distance_meters, route_duration_seconds,
  external_meters, crosses_checkpoint, base_price_cents,
  external_surcharge_cents, total_price_cents, currency, checkpoint_id,
  checkpoint_lat, checkpoint_lon, checkpoint_route_index, checkpoint_status,
  checkpoint_approved_at, tariff_version, route_provider, route_geometry,
  status, notes`;

export class PostgresQuoteRepository {
  private readonly sql: QuoteSqlClient;

  constructor(sql: QuoteSqlClient = getQuoteSqlClient()) {
    this.sql = sql;
  }

  async save(
    calculation: QuoteCalculation,
    createdBy: string,
    notes: string,
    now = new Date(),
  ): Promise<StoredQuote> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = randomUUID();
      const number = quoteNumber(now);
      try {
        const rows = await this.sql.query<QuoteRow>(`
          INSERT INTO delivery_quotes (
            id, quote_number, created_at, calculated_at, created_by, origin_address_id,
            origin_address_label, origin_zone_id, destination_address_id,
            destination_address_label, destination_zone_id, origin_lat, origin_lon, destination_lat,
            destination_lon, route_distance_meters, route_duration_seconds,
            external_meters, crosses_checkpoint, base_price_cents,
            external_surcharge_cents, total_price_cents, currency, checkpoint_id,
            checkpoint_lat, checkpoint_lon, checkpoint_route_index,
            checkpoint_status, checkpoint_approved_at, tariff_version,
            route_provider, route_geometry, status, notes
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
            $25, $26, $27, $28, $29, $30, $31, $32::jsonb, 'draft', $33
          ) RETURNING ${selectedColumns}
        `, [
          id,
          number,
          now.toISOString(),
          calculation.calculatedAt,
          createdBy,
          calculation.origin.id,
          calculation.origin.label,
          calculation.origin.zoneId,
          calculation.destination.id,
          calculation.destination.label,
          calculation.destination.zoneId,
          calculation.origin.lat,
          calculation.origin.lon,
          calculation.destination.lat,
          calculation.destination.lon,
          calculation.routeDistanceMeters,
          calculation.routeDurationSeconds,
          calculation.externalMeters,
          calculation.crossesCheckpoint,
          calculation.basePriceCents,
          calculation.externalSurchargeCents,
          calculation.totalPriceCents,
          calculation.currency,
          calculation.checkpoint.id,
          calculation.checkpoint.lat,
          calculation.checkpoint.lon,
          calculation.checkpoint.routeIndex,
          calculation.checkpoint.status,
          calculation.checkpoint.approvedAt,
          calculation.tariffVersion,
          calculation.routeProvider,
          JSON.stringify(calculation.routeGeometry),
          notes,
        ]);
        return rowToStoredQuote(rows[0]);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "23505" || attempt === 3) throw error;
      }
    }
    throw new Error("Could not allocate a unique quote number");
  }

  async findById(id: string): Promise<StoredQuote | null> {
    const rows = await this.sql.query<QuoteRow>(
      `SELECT ${selectedColumns} FROM delivery_quotes WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToStoredQuote(rows[0]) : null;
  }

  async list(input: QuoteListInput = {}): Promise<QuoteListResult> {
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.max(1, Math.min(500, input.limit ?? 50));
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (condition: string, value: unknown) => {
      params.push(value);
      conditions.push(condition.replace("?", `$${params.length}`));
    };
    if (input.query?.trim()) {
      add("(quote_number ILIKE ? OR origin_address_label ILIKE ? OR destination_address_label ILIKE ?)", `%${input.query.trim()}%`);
      const value = params.at(-1);
      params.push(value, value);
      conditions[conditions.length - 1] = conditions.at(-1)!
        .replace("?", `$${params.length - 1}`)
        .replace("?", `$${params.length}`);
    }
    if (input.status) add("status = ?", input.status);
    if (input.dateFrom) add("created_at >= ?", input.dateFrom);
    if (input.dateTo) add("created_at < ?", input.dateTo);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countRows = await this.sql.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM delivery_quotes ${where}`,
      params,
    );
    const listParams = [...params, limit, offset];
    const rows = await this.sql.query<QuoteRow>(`
      SELECT ${selectedColumns}
      FROM delivery_quotes ${where}
      ORDER BY created_at DESC, quote_number DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `, listParams);
    return Object.freeze({
      total: Number(countRows[0]?.count ?? 0),
      offset,
      limit,
      items: rows.map(rowToStoredQuote),
    });
  }

  async updateStatusAndNotes(
    id: string,
    status: QuoteStatus,
    notes: string,
  ): Promise<StoredQuote | null> {
    const rows = await this.sql.query<QuoteRow>(`
      UPDATE delivery_quotes
      SET status = $2, notes = $3
      WHERE id = $1
      RETURNING ${selectedColumns}
    `, [id, status, notes]);
    return rows[0] ? rowToStoredQuote(rows[0]) : null;
  }

  async enforceRateLimit(
    actorId: string,
    options: { now?: Date; limit?: number; windowSeconds?: number } = {},
  ): Promise<void> {
    const now = options.now ?? new Date();
    const limit = options.limit ?? 12;
    const windowSeconds = options.windowSeconds ?? 60;
    const rows = await this.sql.query<{ request_count: number }>(`
      INSERT INTO delivery_quote_rate_limits (actor_id, window_started_at, request_count)
      VALUES ($1, $2, 1)
      ON CONFLICT (actor_id) DO UPDATE SET
        window_started_at = CASE
          WHEN delivery_quote_rate_limits.window_started_at <= $2::timestamptz - ($3 * interval '1 second')
            THEN $2::timestamptz
          ELSE delivery_quote_rate_limits.window_started_at
        END,
        request_count = CASE
          WHEN delivery_quote_rate_limits.window_started_at <= $2::timestamptz - ($3 * interval '1 second')
            THEN 1
          ELSE delivery_quote_rate_limits.request_count + 1
        END
      RETURNING request_count
    `, [actorId, now.toISOString(), windowSeconds]);
    if ((rows[0]?.request_count ?? limit + 1) > limit) {
      throw new QuoteRateLimitError();
    }
  }
}

export class QuoteRateLimitError extends Error {
  constructor() {
    super("Слишком много расчётов. Повторите попытку через минуту.");
    this.name = "QuoteRateLimitError";
  }
}
