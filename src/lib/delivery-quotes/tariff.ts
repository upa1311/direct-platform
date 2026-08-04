import {
  CANONICAL_CHECKPOINT,
  INTERNAL_REFERENCE_LON_LAT,
} from "./constants";

export type LonLat = readonly [number, number];

export interface RouteGateMetrics {
  crossesCheckpoint: boolean;
  externalMeters: number;
  intersectionChainagesMeters: readonly number[];
}

export interface TariffAmounts {
  basePriceCents: number;
  externalSurchargeCents: number;
  totalPriceCents: number;
}

function cross(a: LonLat, b: LonLat): number {
  return a[0] * b[1] - a[1] * b[0];
}

function haversineMeters(a: LonLat, b: LonLat): number {
  const radians = Math.PI / 180;
  const radiusMeters = 6_371_008.8;
  const deltaLat = (b[1] - a[1]) * radians;
  const deltaLon = (b[0] - a[0]) * radians;
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(a[1] * radians)
      * Math.cos(b[1] * radians)
      * Math.sin(deltaLon / 2) ** 2;
  return 2 * radiusMeters * Math.asin(Math.sqrt(value));
}

export function segmentIntersectionFraction(
  routeA: LonLat,
  routeB: LonLat,
  gateA: LonLat,
  gateB: LonLat,
): number | null {
  const route = [routeB[0] - routeA[0], routeB[1] - routeA[1]] as const;
  const gate = [gateB[0] - gateA[0], gateB[1] - gateA[1]] as const;
  const offset = [gateA[0] - routeA[0], gateA[1] - routeA[1]] as const;
  const denominator = cross(route, gate);
  const epsilon = 1e-12;
  if (Math.abs(denominator) <= epsilon) return null;
  const routeFraction = cross(offset, gate) / denominator;
  const gateFraction = cross(offset, route) / denominator;
  if (
    routeFraction < -epsilon
    || routeFraction > 1 + epsilon
    || gateFraction < -epsilon
    || gateFraction > 1 + epsilon
  ) return null;
  return Math.max(0, Math.min(1, routeFraction));
}

function pointSide(point: LonLat, gate: readonly [LonLat, LonLat]): number {
  return Math.sign(cross(
    [gate[1][0] - gate[0][0], gate[1][1] - gate[0][1]],
    [point[0] - gate[0][0], point[1] - gate[0][1]],
  ));
}

function intersectionChainagesMeters(
  points: readonly LonLat[],
  routeDistanceMeters: number,
  gate: readonly [LonLat, LonLat],
): number[] {
  if (points.length < 2 || routeDistanceMeters <= 0) return [];
  const lengths: number[] = [];
  let geometryMeters = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const length = haversineMeters(points[index], points[index + 1]);
    lengths.push(length);
    geometryMeters += length;
  }
  if (geometryMeters <= 0) return [];
  const intersections: number[] = [];
  let traversed = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const fraction = segmentIntersectionFraction(
      points[index],
      points[index + 1],
      gate[0],
      gate[1],
    );
    if (fraction !== null) {
      const chainage = Math.max(
        0,
        Math.min(
          routeDistanceMeters,
          ((traversed + lengths[index] * fraction) * routeDistanceMeters)
            / geometryMeters,
        ),
      );
      const previous = intersections.at(-1);
      if (previous === undefined || Math.abs(chainage - previous) > 0.1) {
        intersections.push(chainage);
      }
    }
    traversed += lengths[index];
  }
  return intersections;
}

export function calculateRouteGateMetrics(
  points: readonly LonLat[],
  routeDistanceMeters: number,
  gate: readonly [LonLat, LonLat] = CANONICAL_CHECKPOINT.geometry,
  internalReference: LonLat = INTERNAL_REFERENCE_LON_LAT,
): RouteGateMetrics {
  const intersections = intersectionChainagesMeters(
    points,
    routeDistanceMeters,
    gate,
  );
  if (intersections.length === 0) {
    return {
      crossesCheckpoint: false,
      externalMeters: 0,
      intersectionChainagesMeters: [],
    };
  }
  const internalSide = pointSide(internalReference, gate);
  if (internalSide === 0) throw new Error("Internal reference lies on checkpoint");
  const startSide = points.map((point) => pointSide(point, gate)).find(Boolean)
    ?? internalSide;
  let outside = startSide !== internalSide;
  let externalMeters = 0;
  let previous = 0;
  for (const intersection of intersections) {
    if (outside) externalMeters += intersection - previous;
    outside = !outside;
    previous = intersection;
  }
  if (outside) externalMeters += routeDistanceMeters - previous;
  return {
    crossesCheckpoint: true,
    externalMeters: Math.max(
      0,
      Math.min(routeDistanceMeters, Math.round(externalMeters)),
    ),
    intersectionChainagesMeters: intersections.map(Math.round),
  };
}

export function calculateTariffCents(
  routeDistanceMeters: number,
  externalMeters: number,
): TariffAmounts {
  if (!Number.isSafeInteger(routeDistanceMeters) || routeDistanceMeters < 0) {
    throw new Error("Route distance must be a non-negative integer number of meters");
  }
  if (!Number.isSafeInteger(externalMeters) || externalMeters < 0) {
    throw new Error("External distance must be a non-negative integer number of meters");
  }
  const basePriceCents = routeDistanceMeters <= 3_000
    ? 1_400
    : 1_400 + Math.round((routeDistanceMeters - 3_000) * 0.4);
  const externalSurchargeCents = externalMeters <= 0
    ? 0
    : Math.max(500, Math.round(externalMeters * 0.2));
  return {
    basePriceCents,
    externalSurchargeCents,
    totalPriceCents: basePriceCents + externalSurchargeCents,
  };
}
