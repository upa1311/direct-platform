import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Behavioural harness for the real service-worker file. It is loaded into a
 * fake ServiceWorkerGlobalScope, then message / notificationclick events are
 * dispatched and the observable effects (ACK reply, focus/navigate/openWindow)
 * are asserted. This exercises the shipped worker, not its source text.
 */

const SW_SOURCE = readFileSync("public/direct-notifications-sw.js", "utf8");
const ORIGIN = "https://app.example";

type Handler = (event: unknown) => void;

function loadWorker(clientsList: unknown[]) {
  const listeners = new Map<string, Handler>();
  const openWindowCalls: string[] = [];
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  let closedTag: string | null = null;

  const self = {
    location: { origin: ORIGIN },
    skipWaiting() {},
    addEventListener(type: string, handler: Handler) {
      listeners.set(type, handler);
    },
    registration: {
      showNotification(title: string, options: Record<string, unknown>) {
        shown.push({ title, options });
        return Promise.resolve();
      },
      getNotifications({ tag }: { tag: string }) {
        closedTag = tag;
        return Promise.resolve([{ close() {} }]);
      },
    },
    clients: {
      matchAll() {
        return Promise.resolve(clientsList);
      },
      openWindow(url: string) {
        openWindowCalls.push(url);
        return Promise.resolve({ id: "opened", url });
      },
      claim() {
        return Promise.resolve();
      },
    },
  };

  new Function("self", SW_SOURCE)(self);

  async function dispatch(type: string, event: Record<string, unknown>) {
    const waited: Array<Promise<unknown>> = [];
    const enriched = {
      ...event,
      waitUntil(promise: Promise<unknown>) {
        waited.push(promise);
      },
    };
    const handler = listeners.get(type);
    assert.ok(handler, `no listener for ${type}`);
    handler(enriched);
    await Promise.all(waited);
  }

  return {
    dispatch,
    openWindowCalls,
    shown,
    get closedTag() {
      return closedTag;
    },
  };
}

const validShow = {
  type: "SHOW_DIRECT_NOTIFICATION",
  requestId: "dnr-42",
  notification: {
    tag: "kitchen:order:1",
    title: "Новый заказ",
    body: "Стол 4",
    url: "/restaurant/kitchen",
    entityKind: "KITCHEN_ORDER",
    entityId: "order-1",
  },
};

test("SW acks a valid SHOW over the message port after showing", async () => {
  const acks: unknown[] = [];
  const port = { postMessage: (m: unknown) => acks.push(m) };
  const w = loadWorker([]);
  await w.dispatch("message", { data: validShow, ports: [port] });
  assert.equal(w.shown.length, 1);
  assert.deepEqual(acks, [
    { type: "DIRECT_NOTIFICATION_ACK", requestId: "dnr-42", ok: true },
  ]);
});

test("SW acks false (fail-closed) for an invalid message and does not show", async () => {
  const acks: unknown[] = [];
  const port = { postMessage: (m: unknown) => acks.push(m) };
  const w = loadWorker([]);
  await w.dispatch("message", {
    data: { type: "SHOW_DIRECT_NOTIFICATION", requestId: "dnr-7", notification: { tag: "" } },
    ports: [port],
  });
  assert.equal(w.shown.length, 0);
  assert.deepEqual(acks, [
    { type: "DIRECT_NOTIFICATION_ACK", requestId: "dnr-7", ok: false },
  ]);
});

test("SW acks a CLOSE only after the notifications are closed", async () => {
  const acks: unknown[] = [];
  const port = { postMessage: (m: unknown) => acks.push(m) };
  const w = loadWorker([]);
  await w.dispatch("message", {
    data: { type: "CLOSE_DIRECT_NOTIFICATION", requestId: "dnr-9", tag: "kitchen:order:1" },
    ports: [port],
  });
  assert.equal(w.closedTag, "kitchen:order:1");
  assert.deepEqual(acks, [
    { type: "DIRECT_NOTIFICATION_ACK", requestId: "dnr-9", ok: true },
  ]);
});

test("click focuses an existing exact-route tab", async () => {
  let focused: string | null = null;
  const client = {
    id: "a",
    url: `${ORIGIN}/restaurant/kitchen`,
    focus() {
      focused = "a";
      return Promise.resolve(this);
    },
  };
  const w = loadWorker([client]);
  await w.dispatch("notificationclick", {
    notification: { close() {}, data: { url: "/restaurant/kitchen" } },
  });
  assert.equal(focused, "a");
  assert.deepEqual(w.openWindowCalls, []);
});

test("click navigates and focuses a same-origin tab on another route", async () => {
  const events: string[] = [];
  const client = {
    id: "a",
    url: `${ORIGIN}/driver`,
    navigate(url: string) {
      events.push(`navigate:${url}`);
      return Promise.resolve(this);
    },
    focus() {
      events.push("focus");
      return Promise.resolve(this);
    },
  };
  const w = loadWorker([client]);
  await w.dispatch("notificationclick", {
    notification: { close() {}, data: { url: "/restaurant/kitchen" } },
  });
  assert.deepEqual(events, [`navigate:${ORIGIN}/restaurant/kitchen`, "focus"]);
  assert.deepEqual(w.openWindowCalls, []);
});

test("click opens a new window when no same-origin tab exists", async () => {
  const w = loadWorker([{ id: "x", url: "https://evil.example/driver", focus() {} }]);
  await w.dispatch("notificationclick", {
    notification: { close() {}, data: { url: "/driver" } },
  });
  assert.deepEqual(w.openWindowCalls, [`${ORIGIN}/driver`]);
});
