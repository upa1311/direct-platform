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

self.addEventListener("message", function (event) {
  var message = validateMessage(event.data);
  if (message === null) return;

  if (message.type === "CLOSE_DIRECT_NOTIFICATION") {
    event.waitUntil(
      self.registration
        .getNotifications({ tag: message.tag })
        .then(function (list) {
          for (var i = 0; i < list.length; i += 1) list[i].close();
        })
    );
    return;
  }

  var n = message.notification;
  event.waitUntil(
    self.registration.showNotification(n.title, {
      body: n.body,
      tag: n.tag,
      // Store only the validated, approved relative route + safe identity.
      data: { url: n.url, entityKind: n.entityKind, entityId: n.entityId },
      renotify: false,
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var url = isApprovedRoute(data.url) ? data.url : "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clientsList) {
        var targetOrigin = self.location.origin;
        for (var i = 0; i < clientsList.length; i += 1) {
          var client = clientsList[i];
          // Focus an existing same-origin Direct tab instead of opening a new one.
          if (client.url.indexOf(targetOrigin) === 0 && "focus" in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetOrigin + url);
        }
        return undefined;
      })
  );
});
