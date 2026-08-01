/**
 * Pure decision logic for a Direct notification click. The service worker mirrors
 * this algorithm defensively (same pattern as the message-contract validator), so
 * both are behaviourally tested.
 *
 * Click policy (in order):
 *   1. focus an existing same-origin tab that is ALREADY on the exact target route;
 *   2. otherwise navigate an existing same-origin tab to the approved route and focus it;
 *   3. otherwise open a new window on the approved route.
 *
 * Only same-origin tabs are ever touched; the route must already be an approved
 * relative route (validated upstream).
 */

export interface NotificationClickClient {
  readonly id: string;
  readonly url: string;
}

export type NotificationClickAction =
  | { readonly kind: "FOCUS"; readonly clientId: string }
  | { readonly kind: "NAVIGATE"; readonly clientId: string; readonly url: string }
  | { readonly kind: "OPEN"; readonly url: string };

export function isSameOrigin(url: string, origin: string): boolean {
  return (
    url === origin ||
    url.startsWith(`${origin}/`) ||
    url.startsWith(`${origin}?`) ||
    url.startsWith(`${origin}#`)
  );
}

/** Path portion of a same-origin absolute URL (query/hash stripped). */
export function sameOriginPath(url: string, origin: string): string {
  if (!isSameOrigin(url, origin)) return "";
  const rest = url.slice(origin.length) || "/";
  const path = rest.split("?")[0].split("#")[0];
  return path === "" ? "/" : path;
}

export function selectNotificationClickAction(
  clients: readonly NotificationClickClient[],
  origin: string,
  route: string,
): NotificationClickAction {
  const targetUrl = origin + route;
  const sameOrigin = clients.filter((client) => isSameOrigin(client.url, origin));

  const exact = sameOrigin.find(
    (client) => sameOriginPath(client.url, origin) === route,
  );
  if (exact) return { kind: "FOCUS", clientId: exact.id };

  const reusable = sameOrigin[0];
  if (reusable) {
    return { kind: "NAVIGATE", clientId: reusable.id, url: targetUrl };
  }

  return { kind: "OPEN", url: targetUrl };
}
