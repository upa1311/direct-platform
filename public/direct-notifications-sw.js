/*
 * Direct notifications service worker (V1).
 *
 * Purpose: show/close local system notifications on behalf of an ACTIVE Direct
 * client and focus/open a workspace route on click. It is NOT remote Web Push:
 * no push subscription, no server keys, no push event handler and no server
 * sender. With every Direct tab closed nothing here can fire.
 *
 * Deliberately minimal: NO fetch handler, no offline cache, no precaching, no
 * background sync. It never mutates domain state. Every inbound message is
 * validated against a fixed contract (mirrors validateWorkerNotificationMessage);
 * unknown types, external URLs and oversized/blank strings are ignored.
 */

var APPROVED_ROUTES = ["/driver", "/restaurant/kitchen", "/restaurant/operator"];
var MAX_LEN = 200;

function boundedString(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_LEN
  );
}

function isApprovedRoute(url) {
  if (!boundedString(url)) return false;
  if (url.charAt(0) !== "/" || url.slice(0, 2) === "//") return false;
  if (url.indexOf("://") !== -1 || url.indexOf("..") !== -1 || url.indexOf("\\") !== -1) {
    return false;
  }
  var path = url.split("?")[0].split("#")[0];
  return APPROVED_ROUTES.indexOf(path) !== -1;
}

function validateMessage(raw) {
  if (raw === null || typeof raw !== "object") return null;
  if (raw.type === "CLOSE_DIRECT_NOTIFICATION") {
    return boundedString(raw.tag)
      ? { type: "CLOSE_DIRECT_NOTIFICATION", tag: raw.tag }
      : null;
  }
  if (raw.type !== "SHOW_DIRECT_NOTIFICATION") return null;
  var n = raw.notification;
  if (n === null || typeof n !== "object") return null;
  if (
    !boundedString(n.tag) ||
    !boundedString(n.title) ||
    !boundedString(n.body) ||
    !boundedString(n.entityId)
  ) {
    return null;
  }
  if (n.entityKind !== "DRIVER_OFFER" && n.entityKind !== "KITCHEN_ORDER") {
    return null;
  }
  if (!isApprovedRoute(n.url)) return null;
  return {
    type: "SHOW_DIRECT_NOTIFICATION",
    notification: {
      tag: n.tag,
      title: n.title,
      body: n.body,
      url: n.url,
      entityKind: n.entityKind,
      entityId: n.entityId,
    },
  };
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

// Confirmed request/response: reply on the MessageChannel port the client opened,
// echoing its requestId, only after the show/close actually settled. The client
// records/removes its ledger key only on this ACK (fail-closed otherwise).
function ackPort(event, ok) {
  var raw = event.data;
  var requestId =
    raw !== null && typeof raw === "object" && typeof raw.requestId === "string"
      ? raw.requestId
      : null;
  var port = event.ports && event.ports[0];
  if (port) {
    port.postMessage({
      type: "DIRECT_NOTIFICATION_ACK",
      requestId: requestId,
      ok: ok === true,
    });
  }
}

self.addEventListener("message", function (event) {
  var message = validateMessage(event.data);
  if (message === null) {
    ackPort(event, false);
    return;
  }

  if (message.type === "CLOSE_DIRECT_NOTIFICATION") {
    event.waitUntil(
      self.registration
        .getNotifications({ tag: message.tag })
        .then(function (list) {
          for (var i = 0; i < list.length; i += 1) list[i].close();
          ackPort(event, true);
        })
        .catch(function () {
          ackPort(event, false);
        })
    );
    return;
  }

  var n = message.notification;
  event.waitUntil(
    self.registration
      .showNotification(n.title, {
        body: n.body,
        tag: n.tag,
        // Store only the validated, approved relative route + safe identity.
        data: { url: n.url, entityKind: n.entityKind, entityId: n.entityId },
        renotify: false,
      })
      .then(function () {
        ackPort(event, true);
      })
      .catch(function () {
        ackPort(event, false);
      })
  );
});

// Mirrors the client-side selectNotificationClickAction helper:
// 1) focus a tab already on the exact route; 2) else navigate a same-origin tab
// to the route and focus it; 3) else open a new window on the route.
function sameOrigin(url, origin) {
  return (
    url === origin ||
    url.indexOf(origin + "/") === 0 ||
    url.indexOf(origin + "?") === 0 ||
    url.indexOf(origin + "#") === 0
  );
}

function sameOriginPath(url, origin) {
  if (!sameOrigin(url, origin)) return "";
  var rest = url.slice(origin.length) || "/";
  var path = rest.split("?")[0].split("#")[0];
  return path === "" ? "/" : path;
}

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var route = isApprovedRoute(data.url) ? data.url : "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clientsList) {
        var origin = self.location.origin;
        var targetUrl = origin + route;
        var reusable = null;
        for (var i = 0; i < clientsList.length; i += 1) {
          var client = clientsList[i];
          if (!sameOrigin(client.url, origin)) continue;
          if (sameOriginPath(client.url, origin) === route && "focus" in client) {
            return client.focus();
          }
          if (reusable === null) reusable = client;
        }
        if (reusable !== null) {
          if ("navigate" in reusable && typeof reusable.navigate === "function") {
            return reusable.navigate(targetUrl).then(function (navigated) {
              var target = navigated || reusable;
              return target && "focus" in target ? target.focus() : undefined;
            });
          }
          if ("focus" in reusable) return reusable.focus();
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});
