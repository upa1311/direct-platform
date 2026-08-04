import assert from "node:assert/strict";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { isAllowedAdminGithubId } from "./admin-auth.ts";
import { calculateDeliveryQuote } from "./calculator.ts";
import { catalogMetadata, findDeliveryAddress } from "./catalog.ts";
import {
  signQuoteCalculation,
  verifySignedQuoteCalculation,
} from "./calculation-signature.ts";
import type { QuoteSqlClient } from "./database.ts";
import { fetchOsrmRoute, RouteProviderError } from "./osrm.ts";
import { PostgresQuoteRepository, QuoteRateLimitError } from "./repository.ts";
import {
  calculateRouteGateMetrics,
  calculateTariffCents,
  type LonLat,
} from "./tariff.ts";
import type { QuoteCalculation } from "./types.ts";

const secret = "direct-delivery-test-signing-secret-000000000000";
const routeAcrossGate: readonly LonLat[] = [
  [29.48313, 46.82388],
  [29.48774, 46.82997],
  [29.495, 46.839],
];

function calculation(): QuoteCalculation {
  const origin = findDeliveryAddress("n11888388469");
  const destination = findDeliveryAddress("n11222053152");
  assert.ok(origin);
  assert.ok(destination);
  return {
    origin,
    destination,
    routeDistanceMeters: 8_000,
    routeDurationSeconds: 900,
    externalMeters: 2_000,
    crossesCheckpoint: true,
    basePriceCents: 3_400,
    externalSurchargeCents: 500,
    totalPriceCents: 3_900,
    currency: "RUB",
    checkpoint: {
      id: "parkany-owner-approved-gate-v1",
      lat: 46.82997,
      lon: 29.48774,
      routeIndex: 33,
      status: "owner_approved",
      approvedAt: "2026-08-03T22:31:23.434Z",
    },
    tariffVersion: "bender-reference-v3",
    routeProvider: "osrm",
    routeGeometry: { type: "LineString", coordinates: routeAcrossGate },
    calculatedAt: "2026-08-03T23:00:00.000Z",
  };
}

test("canonical address catalog preserves accepted 9,216-address release", () => {
  const metadata = catalogMetadata();
  assert.equal(metadata.canonical.catalogTotal, 9_216);
  assert.equal(metadata.canonical.routed, 9_215);
  assert.equal(metadata.canonical.duplicate, 1);
  assert.deepEqual(metadata.canonical.zoneCounts, [2_729, 2_557, 2_588, 1_341]);
  assert.equal(metadata.source.commit, "576b9257da44b655a2dd374f8dfca32827942af8");
  assert.equal(
    metadata.source.sha256,
    "4ad9b2c731af25135c03cd9a69aecac70ff53930bd2d38ca20ba7deddc714c8f",
  );
});

test("integer tariff matches accepted formula and is symmetric for one geometry", () => {
  assert.deepEqual(calculateTariffCents(3_000, 0), {
    basePriceCents: 1_400,
    externalSurchargeCents: 0,
    totalPriceCents: 1_400,
  });
  assert.deepEqual(calculateTariffCents(8_000, 2_000), {
    basePriceCents: 3_400,
    externalSurchargeCents: 500,
    totalPriceCents: 3_900,
  });
  const forward = calculateRouteGateMetrics(routeAcrossGate, 8_000);
  const reverse = calculateRouteGateMetrics([...routeAcrossGate].reverse(), 8_000);
  assert.equal(forward.crossesCheckpoint, true);
  assert.equal(reverse.crossesCheckpoint, true);
  assert.ok(Math.abs(forward.externalMeters - reverse.externalMeters) <= 1);
  assert.deepEqual(
    calculateTariffCents(8_000, forward.externalMeters),
    calculateTariffCents(8_000, reverse.externalMeters),
  );
});

test("server calculator resolves canonical coordinates and ignores client coordinate concepts", async () => {
  let requestedUrl = "";
  const result = await calculateDeliveryQuote({
    originAddressId: "n11888388469",
    destinationAddressId: "n11222053152",
  }, {
    maxAttempts: 1,
    fetcher: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        code: "Ok",
        routes: [{ distance: 8_000, duration: 900, geometry: { type: "LineString", coordinates: routeAcrossGate } }],
      }), { status: 200 });
    },
  }, new Date("2026-08-03T23:00:00.000Z"));
  assert.match(requestedUrl, /29\.47388,46\.84501;29\.43703,46\.84806/);
  assert.equal(result.totalPriceCents, result.basePriceCents + result.externalSurchargeCents);
  assert.equal(result.checkpoint.status, "owner_approved");
});

test("OSRM client retries temporary failures and rejects malformed responses", async () => {
  let calls = 0;
  const route = await fetchOsrmRoute([29.47, 46.82], [29.48, 46.83], {
    maxAttempts: 2,
    fetcher: async () => {
      calls += 1;
      if (calls === 1) return new Response("temporary", { status: 503 });
      return new Response(JSON.stringify({
        code: "Ok",
        routes: [{ distance: 1234.4, duration: 200.2, geometry: { type: "LineString", coordinates: [[29.47, 46.82], [29.48, 46.83]] } }],
      }));
    },
  });
  assert.equal(calls, 2);
  assert.equal(route.distanceMeters, 1_234);
  await assert.rejects(
    fetchOsrmRoute([29.47, 46.82], [29.48, 46.83], {
      maxAttempts: 1,
      fetcher: async () => new Response(JSON.stringify({ code: "Ok", routes: [] })),
    }),
    (error: unknown) => error instanceof RouteProviderError && error.code === "MALFORMED_RESPONSE",
  );
});

test("signed calculation is actor-bound, expires and detects price tampering", () => {
  const now = new Date("2026-08-03T23:00:00.000Z");
  const envelope = signQuoteCalculation(calculation(), "42", { now, secret, ttlSeconds: 60 });
  assert.equal(verifySignedQuoteCalculation(envelope, "42", { now, secret }).totalPriceCents, 3_900);
  assert.throws(() => verifySignedQuoteCalculation(envelope, "43", { now, secret }));
  assert.throws(() => verifySignedQuoteCalculation(envelope, "42", {
    now: new Date("2026-08-03T23:02:00.000Z"),
    secret,
  }));
  const tampered = {
    ...envelope,
    calculation: { ...envelope.calculation, totalPriceCents: 1 },
  };
  assert.throws(() => verifySignedQuoteCalculation(tampered, "42", { now, secret }));
});

test("admin allowlist accepts immutable numeric IDs only", () => {
  const previous = process.env.ADMIN_GITHUB_USER_IDS;
  process.env.ADMIN_GITHUB_USER_IDS = "42, 9001,alice";
  try {
    assert.equal(isAllowedAdminGithubId("42"), true);
    assert.equal(isAllowedAdminGithubId("alice"), false);
    assert.equal(isAllowedAdminGithubId("7"), false);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_GITHUB_USER_IDS;
    else process.env.ADMIN_GITHUB_USER_IDS = previous;
  }
});

test("PostgreSQL migration saves, reads and protects immutable snapshots", async () => {
  const database = new PGlite();
  try {
    for (const migration of readMigrationFiles({ migrationsFolder: "drizzle" })) {
      for (const statement of migration.sql) await database.exec(statement);
    }
    const client: QuoteSqlClient = {
      async query<T extends Record<string, unknown>>(text: string, params = []) {
        const result = await database.query<T>(text, [...params]);
        return result.rows;
      },
    };
    const repository = new PostgresQuoteRepository(client);
    const first = await repository.save(calculation(), "42", "первичная заметка", new Date("2026-08-04T00:00:00.000Z"));
    const second = await repository.save(calculation(), "42", "", new Date("2026-08-04T00:00:00.000Z"));
    assert.notEqual(first.quoteNumber, second.quoteNumber);
    assert.match(first.quoteNumber, /^DQ-20260804-[0-9A-F]{8}$/);
    assert.equal(first.calculatedAt, calculation().calculatedAt);
    assert.equal((await repository.findById(first.id))?.totalPriceCents, 3_900);
    assert.equal((await repository.list({ query: first.quoteNumber })).total, 1);
    const updated = await repository.updateStatusAndNotes(first.id, "confirmed", "проверено");
    assert.equal(updated?.status, "confirmed");
    assert.equal(updated?.routeDistanceMeters, first.routeDistanceMeters);
    await assert.rejects(database.query(
      "UPDATE delivery_quotes SET total_price_cents = total_price_cents + 1 WHERE id = $1",
      [first.id],
    ));
    await repository.enforceRateLimit("42", { limit: 2, now: new Date("2026-08-04T00:00:00.000Z") });
    await repository.enforceRateLimit("42", { limit: 2, now: new Date("2026-08-04T00:00:01.000Z") });
    await assert.rejects(
      repository.enforceRateLimit("42", { limit: 2, now: new Date("2026-08-04T00:00:02.000Z") }),
      QuoteRateLimitError,
    );
  } finally {
    await database.close();
  }
});
