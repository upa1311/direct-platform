import {
  CANONICAL_CHECKPOINT,
  DELIVERY_QUOTE_CURRENCY,
  DELIVERY_QUOTE_TARIFF_VERSION,
} from "./constants";
import { requireRoutableAddress } from "./catalog";
import { fetchOsrmRoute, type OsrmClientOptions } from "./osrm";
import { calculateRouteGateMetrics, calculateTariffCents } from "./tariff";
import type { QuoteCalculation } from "./types";

export interface CalculateQuoteInput {
  readonly originAddressId: string;
  readonly destinationAddressId: string;
}

export async function calculateDeliveryQuote(
  input: CalculateQuoteInput,
  options: OsrmClientOptions = {},
  now = new Date(),
): Promise<QuoteCalculation> {
  if (!input.originAddressId || !input.destinationAddressId) {
    throw new Error("Необходимо выбрать оба адреса.");
  }
  if (input.originAddressId === input.destinationAddressId) {
    throw new Error("Адреса A и B должны различаться.");
  }
  const origin = requireRoutableAddress(input.originAddressId);
  const destination = requireRoutableAddress(input.destinationAddressId);
  const route = await fetchOsrmRoute(
    [origin.lon, origin.lat],
    [destination.lon, destination.lat],
    options,
  );
  const gateMetrics = calculateRouteGateMetrics(
    route.coordinates,
    route.distanceMeters,
  );
  const tariff = calculateTariffCents(
    route.distanceMeters,
    gateMetrics.externalMeters,
  );
  return Object.freeze({
    origin,
    destination,
    routeDistanceMeters: route.distanceMeters,
    routeDurationSeconds: route.durationSeconds,
    externalMeters: gateMetrics.externalMeters,
    crossesCheckpoint: gateMetrics.crossesCheckpoint,
    ...tariff,
    currency: DELIVERY_QUOTE_CURRENCY,
    checkpoint: {
      id: CANONICAL_CHECKPOINT.id,
      lat: CANONICAL_CHECKPOINT.lat,
      lon: CANONICAL_CHECKPOINT.lon,
      routeIndex: CANONICAL_CHECKPOINT.routeIndex,
      status: CANONICAL_CHECKPOINT.status,
      approvedAt: CANONICAL_CHECKPOINT.approvedAt,
    },
    tariffVersion: DELIVERY_QUOTE_TARIFF_VERSION,
    routeProvider: "osrm",
    routeGeometry: {
      type: "LineString" as const,
      coordinates: route.coordinates,
    },
    calculatedAt: now.toISOString(),
  });
}
