"use client";

import { useMemo } from "react";

import {
  varnitaAdminLines,
  varnitaVillageRings,
  zoneColor,
  zonePolygons,
} from "@/lib/zones/zone-registry";

/**
 * Self-contained SVG map of the zone polygons from the vendored, hash-verified
 * release. No Leaflet, no tiles, no CDN, no money — the K=4 bands and the
 * Северный enclave in the canonical zone colours, the Varnița village shaded as
 * a no-delivery area, and the Varnița administrative border as a dashed line.
 */
export function ZonePolygonMap({ height = 320 }: { height?: number }) {
  const polys = useMemo(() => zonePolygons(), []);
  const villageRings = useMemo(() => varnitaVillageRings(), []);
  const adminLines = useMemo(() => varnitaAdminLines(), []);

  const view = useMemo(() => {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const scan = (ring: [number, number][]) => {
      for (const [lng, lat] of ring) {
        if (lng < minX) minX = lng;
        if (lng > maxX) maxX = lng;
        if (lat < minY) minY = lat;
        if (lat > maxY) maxY = lat;
      }
    };
    for (const p of polys) for (const ring of p.rings) scan(ring);
    for (const ring of villageRings) scan(ring);
    for (const line of adminLines) scan(line);
    return { minX, minY, maxX, maxY };
  }, [polys, villageRings, adminLines]);

  if (polys.length === 0) {
    return (
      <div style={{ color: "#888", fontSize: 13 }}>Карта зон недоступна.</div>
    );
  }

  const W = 640;
  const H = height;
  const spanX = view.maxX - view.minX || 1;
  const spanY = view.maxY - view.minY || 1;
  // Preserve aspect ratio; latitude grows upward, SVG y grows downward.
  const scale = Math.min(W / spanX, H / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const project = (lng: number, lat: number): [number, number] => [
    offX + (lng - view.minX) * scale,
    H - (offY + (lat - view.minY) * scale),
  ];

  // Draw larger zones first so the inner bands stay visible on top.
  const ordered = [...polys].sort(
    (a, b) => (b.zoneNumber ?? 0) - (a.zoneNumber ?? 0),
  );

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Карта зон доставки"
      style={{ border: "1px solid #e5e7eb", borderRadius: 8, background: "#f8fafc" }}
    >
      {ordered.map((p, i) =>
        p.rings.map((ring, j) => {
          const d =
            ring
              .map((pt, k) => {
                const [x, y] = project(pt[0], pt[1]);
                return `${k === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
              })
              .join(" ") + " Z";
          const color = p.zoneNumber != null ? zoneColor(p.zoneNumber) : null;
          return (
            <path
              key={`${i}-${j}`}
              d={d}
              fill={color ?? "#999"}
              fillOpacity={0.45}
              stroke={color ?? "#666"}
              strokeWidth={1}
            />
          );
        }),
      )}

      {/* Varnița village — no-delivery area (grey shaded). */}
      {villageRings.map((ring, i) => {
        const d =
          ring
            .map((pt, k) => {
              const [x, y] = project(pt[0], pt[1]);
              return `${k === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ") + " Z";
        return (
          <path
            key={`village-${i}`}
            d={d}
            fill="#6b7280"
            fillOpacity={0.5}
            stroke="#374151"
            strokeWidth={1}
          />
        );
      })}

      {/* Varnița administrative border — dashed reference line. */}
      {adminLines.map((line, i) => {
        const d = line
          .map((pt, k) => {
            const [x, y] = project(pt[0], pt[1]);
            return `${k === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ");
        return (
          <path
            key={`admin-${i}`}
            d={d}
            fill="none"
            stroke="#111827"
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
        );
      })}
    </svg>
  );
}
