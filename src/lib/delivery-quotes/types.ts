import type { DeliveryAddress } from "./catalog";
import type { LonLat } from "./tariff";

export type QuoteStatus = "draft" | "confirmed" | "cancelled";

export interface QuoteCalculation {
  readonly origin: DeliveryAddress;
  readonly destination: DeliveryAddress;
  readonly routeDistanceMeters: number;
  readonly routeDurationSeconds: number;
  readonly externalMeters: number;
  readonly crossesCheckpoint: boolean;
  readonly basePriceCents: number;
  readonly externalSurchargeCents: number;
  readonly totalPriceCents: number;
  readonly currency: "RUB";
  readonly checkpoint: {
    readonly id: string;
    readonly lat: number;
    readonly lon: number;
    readonly routeIndex: number;
    readonly status: "owner_approved";
    readonly approvedAt: string;
  };
  readonly tariffVersion: string;
  readonly routeProvider: "osrm";
  readonly routeGeometry: {
    readonly type: "LineString";
    readonly coordinates: readonly LonLat[];
  };
  readonly calculatedAt: string;
}

export interface SignedQuoteCalculation {
  readonly calculation: QuoteCalculation;
  readonly actorGithubUserId: string;
  readonly expiresAt: string;
  readonly signature: string;
}

export interface StoredQuote extends QuoteCalculation {
  readonly id: string;
  readonly quoteNumber: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly status: QuoteStatus;
  readonly notes: string;
}
