import { z } from "zod";

import type { LonLat } from "./tariff";

const coordinateSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const osrmResponseSchema = z.object({
  code: z.literal("Ok"),
  routes: z.array(z.object({
    distance: z.number().finite().positive(),
    duration: z.number().finite().nonnegative(),
    geometry: z.object({
      type: z.literal("LineString"),
      coordinates: z.array(coordinateSchema).min(2).max(100_000),
    }),
  })).min(1),
});

export interface OsrmRoute {
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  readonly coordinates: readonly LonLat[];
}

export interface OsrmClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly fetcher?: typeof fetch;
}

export class RouteProviderError extends Error {
  readonly code: "TIMEOUT" | "UNAVAILABLE" | "MALFORMED_RESPONSE" | "NO_ROUTE";

  constructor(
    message: string,
    code: "TIMEOUT" | "UNAVAILABLE" | "MALFORMED_RESPONSE" | "NO_ROUTE",
  ) {
    super(message);
    this.name = "RouteProviderError";
    this.code = code;
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function fetchOsrmRoute(
  origin: LonLat,
  destination: LonLat,
  options: OsrmClientOptions = {},
): Promise<OsrmRoute> {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = (options.baseUrl
    ?? process.env.OSRM_BASE_URL
    ?? "https://router.project-osrm.org").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxAttempts = Math.max(1, Math.min(3, options.maxAttempts ?? 2));
  const coordinates = `${origin[0]},${origin[1]};${destination[0]},${destination[1]}`;
  const url = `${baseUrl}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        signal: controller.signal,
        headers: { "User-Agent": "DirectDeliveryAdmin/2.0" },
        cache: "no-store",
      });
      if (!response.ok) {
        if (retryableStatus(response.status) && attempt < maxAttempts) continue;
        throw new RouteProviderError(
          `Маршрутизатор временно недоступен (HTTP ${response.status}).`,
          response.status === 404 ? "NO_ROUTE" : "UNAVAILABLE",
        );
      }
      const parsed = osrmResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new RouteProviderError(
          "Маршрутизатор вернул некорректный ответ. Цена не рассчитана.",
          "MALFORMED_RESPONSE",
        );
      }
      const route = parsed.data.routes[0];
      return Object.freeze({
        distanceMeters: Math.round(route.distance),
        durationSeconds: Math.round(route.duration),
        coordinates: route.geometry.coordinates as LonLat[],
      });
    } catch (error) {
      if (error instanceof RouteProviderError) throw error;
      const timedOut = error instanceof Error && error.name === "AbortError";
      if (attempt < maxAttempts) continue;
      throw new RouteProviderError(
        timedOut
          ? "Маршрутизатор не ответил вовремя. Цена не рассчитана."
          : "Маршрутизатор недоступен. Цена не рассчитана.",
        timedOut ? "TIMEOUT" : "UNAVAILABLE",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new RouteProviderError("Маршрут не получен.", "NO_ROUTE");
}
