import type { ZoneId } from "@/prototype/models";

import { fromZoneId, zoneColor } from "./zone-registry";

/**
 * UI-only presentation of a zone as a fully coloured control (button/chip).
 *
 * The background colour is taken ONLY from the versioned Bender Zone Registry
 * (`zoneColor(fromZoneId(zoneId))`) — there is no manual zone-number → colour
 * table here. The foreground colour is derived from the background's relative
 * luminance so text and icon stay readable on both dark and light/yellow zones;
 * colour is never the only signal (the caller keeps a MapPin and the zone name).
 * An unknown/offline zone (no registry colour) returns null → neutral control.
 */

export interface ZoneButtonPresentation {
  backgroundColor: string;
  foregroundColor: string;
  borderColor: string;
}

/** Near-black used on light zones; matches the app text colour. */
const DARK_TEXT = "#1f2723";
const LIGHT_TEXT = "#ffffff";

/** Parse #rgb / #rrggbb into [r,g,b] 0..255, or null. */
function parseHex(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const r = Number.parseInt(hex[0] + hex[0], 16);
    const g = Number.parseInt(hex[1] + hex[1], 16);
    const b = Number.parseInt(hex[2] + hex[2], 16);
    return [r, g, b];
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return [r, g, b];
  }
  return null;
}

/** WCAG relative luminance (0..1) of a colour, or null if unparseable. */
export function relativeLuminance(color: string): number | null {
  const rgb = parseHex(color);
  if (rgb === null) return null;
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Presentation for a confirmed zone, or null when there is no registry colour
 * (dataset invalid / unknown zone) so callers render a neutral control. Light
 * or yellow zones get dark text, dark zones get light text — chosen by real
 * luminance, not by zone number.
 */
export function getZoneButtonPresentation(
  zoneId: ZoneId,
): ZoneButtonPresentation | null {
  const color = zoneColor(fromZoneId(zoneId));
  if (color === null) return null;
  const lum = relativeLuminance(color);
  // Unparseable colour → safe neutral-on-colour default (dark text).
  const foregroundColor = lum === null ? DARK_TEXT : lum > 0.5 ? DARK_TEXT : LIGHT_TEXT;
  return {
    backgroundColor: color,
    foregroundColor,
    // Slightly darker outline than the fill, independent of the fill colour.
    borderColor: "rgba(0, 0, 0, 0.28)",
  };
}
