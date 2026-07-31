/**
 * Fixed, safe contract for messages sent to the Direct notifications service
 * worker. The worker must never act on arbitrary data: only these two message
 * shapes are accepted, every string is bounded, the URL must be a known
 * same-origin relative route, and there is no HTML, no functions and no external
 * URL. Notification clicks only focus/open an approved workspace route — they
 * never mutate domain state.
 *
 * This validator is the single source of truth. The client validates here before
 * posting to the worker, and the worker mirrors the same minimal check
 * defensively. It is pure and fully testable outside the worker global scope.
 */

export type DirectNotificationEntityKind = "DRIVER_OFFER" | "KITCHEN_ORDER";

export interface DirectNotificationPayload {
  tag: string;
  title: string;
  body: string;
  url: string;
  entityKind: DirectNotificationEntityKind;
  entityId: string;
}

export type DirectNotificationWorkerMessage =
  | { type: "SHOW_DIRECT_NOTIFICATION"; notification: DirectNotificationPayload }
  | { type: "CLOSE_DIRECT_NOTIFICATION"; tag: string };

/** Only these same-origin relative routes may be opened/focused on click. */
export const APPROVED_NOTIFICATION_ROUTES = [
  "/driver",
  "/restaurant/kitchen",
  "/restaurant/operator",
] as const;

/** Bounded length for every string in the contract (defence against abuse). */
export const NOTIFICATION_STRING_MAX = 200;

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= NOTIFICATION_STRING_MAX
  );
}

/**
 * A safe click target: a non-empty, bounded, same-origin RELATIVE route that
 * exactly matches an approved workspace route (query/hash ignored). Rejects
 * external URLs, protocol-relative URLs, traversal and backslashes.
 */
export function isApprovedNotificationRoute(url: unknown): boolean {
  if (!isBoundedString(url)) return false;
  if (!url.startsWith("/") || url.startsWith("//")) return false;
  if (url.includes("://") || url.includes("..") || url.includes("\\")) return false;
  const path = url.split("?")[0].split("#")[0];
  return (APPROVED_NOTIFICATION_ROUTES as readonly string[]).includes(path);
}

/**
 * Validate an untrusted worker message. Returns the typed message when valid, or
 * null for anything unexpected: unknown type, missing/oversized/blank strings,
 * unknown entityKind, or a non-approved/external URL.
 */
export function validateWorkerNotificationMessage(
  raw: unknown,
): DirectNotificationWorkerMessage | null {
  if (raw === null || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;

  if (message.type === "CLOSE_DIRECT_NOTIFICATION") {
    return isBoundedString(message.tag)
      ? { type: "CLOSE_DIRECT_NOTIFICATION", tag: message.tag }
      : null;
  }

  if (message.type !== "SHOW_DIRECT_NOTIFICATION") return null;
  const notification = message.notification;
  if (notification === null || typeof notification !== "object") return null;
  const payload = notification as Record<string, unknown>;

  if (
    !isBoundedString(payload.tag) ||
    !isBoundedString(payload.title) ||
    !isBoundedString(payload.body) ||
    !isBoundedString(payload.entityId)
  ) {
    return null;
  }
  if (
    payload.entityKind !== "DRIVER_OFFER" &&
    payload.entityKind !== "KITCHEN_ORDER"
  ) {
    return null;
  }
  if (!isApprovedNotificationRoute(payload.url)) return null;

  return {
    type: "SHOW_DIRECT_NOTIFICATION",
    notification: {
      tag: payload.tag,
      title: payload.title,
      body: payload.body,
      url: payload.url as string,
      entityKind: payload.entityKind,
      entityId: payload.entityId,
    },
  };
}
