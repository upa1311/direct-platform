import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSameOrigin,
  sameOriginPath,
  selectNotificationClickAction,
} from "./direct-notification-click";

const ORIGIN = "https://app.example";

test("focuses an existing tab already on the exact target route", () => {
  const action = selectNotificationClickAction(
    [
      { id: "a", url: `${ORIGIN}/restaurant/operator` },
      { id: "b", url: `${ORIGIN}/driver` },
    ],
    ORIGIN,
    "/driver",
  );
  assert.deepEqual(action, { kind: "FOCUS", clientId: "b" });
});

test("route match ignores query and hash", () => {
  const action = selectNotificationClickAction(
    [{ id: "a", url: `${ORIGIN}/driver?tab=offers#top` }],
    ORIGIN,
    "/driver",
  );
  assert.deepEqual(action, { kind: "FOCUS", clientId: "a" });
});

test("navigates and focuses a same-origin tab on a different route", () => {
  const action = selectNotificationClickAction(
    [{ id: "a", url: `${ORIGIN}/restaurant/kitchen` }],
    ORIGIN,
    "/driver",
  );
  assert.deepEqual(action, {
    kind: "NAVIGATE",
    clientId: "a",
    url: `${ORIGIN}/driver`,
  });
});

test("opens a new window when there is no same-origin tab", () => {
  const action = selectNotificationClickAction(
    [{ id: "x", url: "https://evil.example/driver" }],
    ORIGIN,
    "/driver",
  );
  assert.deepEqual(action, { kind: "OPEN", url: `${ORIGIN}/driver` });
});

test("prefers the exact-route tab even when a reusable tab comes first", () => {
  const action = selectNotificationClickAction(
    [
      { id: "first", url: `${ORIGIN}/restaurant/kitchen` },
      { id: "exact", url: `${ORIGIN}/driver` },
    ],
    ORIGIN,
    "/driver",
  );
  assert.deepEqual(action, { kind: "FOCUS", clientId: "exact" });
});

test("cross-origin tabs are never focused or navigated", () => {
  assert.equal(isSameOrigin("https://evil.example/driver", ORIGIN), false);
  assert.equal(isSameOrigin(`${ORIGIN}.attacker.test/driver`, ORIGIN), false);
  assert.equal(isSameOrigin(`${ORIGIN}/driver`, ORIGIN), true);
});

test("sameOriginPath returns / for the bare origin and strips query/hash", () => {
  assert.equal(sameOriginPath(ORIGIN, ORIGIN), "/");
  assert.equal(sameOriginPath(`${ORIGIN}/driver?x=1`, ORIGIN), "/driver");
  assert.equal(sameOriginPath("https://other.test/driver", ORIGIN), "");
});
