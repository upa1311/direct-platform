import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultState } from "./default-state.ts";
import type { PrototypeState } from "./models.ts";
import { resolvePrototypeRefresh } from "./prototype-store.ts";
import {
  createDriverConnectionController,
  driverConnectionReducer,
  getDriverConnectionView,
  INITIAL_DRIVER_CONNECTION_STATE,
  type DriverConnectionEnv,
  type DriverConnectionEvent,
  type DriverConnectionState,
  type PrototypeRefreshResult,
} from "./driver-connection.ts";

/**
 * Driver offline / connection recovery — pure model, view, controller and the
 * read-only persisted-state refresh resolution. Connection status is tab-local
 * and fail-closed: ONLINE (canMutate) is reachable ONLY via a successful refresh.
 */

const R = INITIAL_DRIVER_CONNECTION_STATE;
const reduce = (
  events: DriverConnectionEvent[],
  start: DriverConnectionState = R,
): DriverConnectionState => events.reduce(driverConnectionReducer, start);

// --- 1-7: connection model / canMutate -----------------------------------------

test("1: INITIALIZING → canMutate false", () => {
  assert.equal(getDriverConnectionView(R).status, "INITIALIZING");
  assert.equal(getDriverConnectionView(R).canMutate, false);
});

test("2: ONLINE only after a successful refresh → canMutate true", () => {
  const recovering = reduce([{ type: "HYDRATED", online: true }]);
  assert.equal(recovering.status, "RECOVERING");
  assert.equal(getDriverConnectionView(recovering).canMutate, false);
  const online = driverConnectionReducer(recovering, {
    type: "REFRESH_SUCCEEDED",
    revision: 7,
    updatedAt: "2026-07-31T10:00:00.000Z",
  });
  assert.equal(online.status, "ONLINE");
  const view = getDriverConnectionView(online);
  assert.equal(view.canMutate, true);
  assert.equal(view.lastKnownRevision, 7);
  assert.equal(view.lastStateUpdatedAt, "2026-07-31T10:00:00.000Z");
});

test("3-5: OFFLINE / RECOVERING / DEGRADED → canMutate false", () => {
  for (const status of ["OFFLINE", "RECOVERING", "DEGRADED"] as const) {
    assert.equal(getDriverConnectionView({ ...R, status }).canMutate, false);
  }
});

test("6: a raw browser online signal never yields ONLINE (only RECOVERING)", () => {
  assert.equal(reduce([{ type: "BROWSER_ONLINE" }]).status, "RECOVERING");
  // A refresh landing after the browser went offline must not claim ONLINE.
  const raced = reduce([
    { type: "BROWSER_ONLINE" },
    { type: "BROWSER_OFFLINE" },
    { type: "REFRESH_SUCCEEDED", revision: 9, updatedAt: "2026-07-31T11:00:00.000Z" },
  ]);
  assert.equal(raced.status, "OFFLINE");
  assert.equal(getDriverConnectionView(raced).canMutate, false);
});

test("7: a failed refresh cannot yield ONLINE (→ DEGRADED)", () => {
  const degraded = reduce([
    { type: "HYDRATED", online: true },
    { type: "REFRESH_FAILED" },
  ]);
  assert.equal(degraded.status, "DEGRADED");
  assert.equal(getDriverConnectionView(degraded).canMutate, false);
});

test("offline always wins; hydrate while offline → OFFLINE", () => {
  assert.equal(reduce([{ type: "HYDRATED", online: false }]).status, "OFFLINE");
  assert.equal(
    reduce([{ type: "BROWSER_OFFLINE" }, { type: "REFRESH_FAILED" }]).status,
    "OFFLINE",
  );
});

test("RETRY from DEGRADED → RECOVERING → ONLINE on success", () => {
  const degraded: DriverConnectionState = { ...R, status: "DEGRADED" };
  const recovering = driverConnectionReducer(degraded, { type: "RETRY" });
  assert.equal(recovering.status, "RECOVERING");
  assert.equal(
    driverConnectionReducer(recovering, {
      type: "REFRESH_SUCCEEDED",
      revision: 3,
      updatedAt: "2026-07-31T09:00:00.000Z",
    }).status,
    "ONLINE",
  );
});

// --- controller with a fake environment ----------------------------------------

class FakeEnv implements DriverConnectionEnv {
  private handlers = new Map<string, Set<() => void>>();
  online = true;
  visible = true;
  addEventListener(type: string, handler: () => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }
  removeEventListener(type: string, handler: () => void): void {
    this.handlers.get(type)?.delete(handler);
  }
  isOnline(): boolean {
    return this.online;
  }
  isVisible(): boolean {
    return this.visible;
  }
  fire(type: string): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler();
  }
  count(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

function deferredRefresh() {
  const resolvers: Array<(value: PrototypeRefreshResult) => void> = [];
  let callCount = 0;
  const refresh = (): Promise<PrototypeRefreshResult> => {
    callCount += 1;
    return new Promise<PrototypeRefreshResult>((resolve) => resolvers.push(resolve));
  };
  return {
    refresh,
    get callCount() {
      return callCount;
    },
    resolveNext(value: PrototypeRefreshResult) {
      const resolve = resolvers.shift();
      assert.ok(resolve, "expected a pending refresh");
      resolve(value);
    },
  };
}

/** Flush microtasks + timers so the refresh promise chain (then/finally) runs. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const OK: PrototypeRefreshResult = {
  ok: true,
  revision: 1,
  updatedAt: "2026-07-31T10:00:00.000Z",
  changed: false,
};
const FAIL: PrototypeRefreshResult = { ok: false, error: "boom" };

test("8: offline event dispatches BROWSER_OFFLINE", () => {
  const env = new FakeEnv();
  const events: DriverConnectionEvent[] = [];
  const c = createDriverConnectionController(env, {
    dispatch: (e) => events.push(e),
    refresh: () => Promise.resolve(OK),
  });
  c.start();
  env.online = false;
  env.fire("offline");
  assert.deepEqual(events, [{ type: "BROWSER_OFFLINE" }]);
  c.stop();
});

test("9-10: online event dispatches RECOVERING then ONLINE only after refresh", async () => {
  const env = new FakeEnv();
  const events: DriverConnectionEvent[] = [];
  const ref = deferredRefresh();
  const c = createDriverConnectionController(env, {
    dispatch: (e) => events.push(e),
    refresh: ref.refresh,
  });
  c.start();
  env.fire("online");
  assert.deepEqual(events[0], { type: "BROWSER_ONLINE" });
  assert.equal(ref.callCount, 1);
  assert.equal(events.length, 1); // no SUCCEEDED yet
  ref.resolveNext({ ok: true, revision: 4, updatedAt: "2026-07-31T10:05:00.000Z", changed: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events.at(-1), {
    type: "REFRESH_SUCCEEDED",
    revision: 4,
    updatedAt: "2026-07-31T10:05:00.000Z",
  });
  c.stop();
});

test("11-12: failed reconnect dispatches REFRESH_FAILED; retry refreshes again", async () => {
  const env = new FakeEnv();
  const events: DriverConnectionEvent[] = [];
  const ref = deferredRefresh();
  const c = createDriverConnectionController(env, {
    dispatch: (e) => events.push(e),
    refresh: ref.refresh,
  });
  c.start();
  env.fire("online");
  ref.resolveNext(FAIL);
  await flush();
  assert.deepEqual(events.at(-1), { type: "REFRESH_FAILED" });
  c.retry();
  assert.deepEqual(events.at(-1), { type: "RETRY" });
  assert.equal(ref.callCount, 2);
  c.stop();
});

test("13-15: focus/visibility refresh only while online and visible", async () => {
  const env = new FakeEnv();
  const ref = deferredRefresh();
  const c = createDriverConnectionController(env, {
    dispatch: () => {},
    refresh: ref.refresh,
  });
  c.start();
  env.online = true;
  env.visible = true;
  env.fire("focus");
  assert.equal(ref.callCount, 1);
  ref.resolveNext(OK);
  await flush();
  env.fire("visibilitychange");
  assert.equal(ref.callCount, 2);
  ref.resolveNext(OK);
  await flush();
  env.visible = false;
  env.fire("visibilitychange"); // hidden → no refresh
  assert.equal(ref.callCount, 2);
  c.stop();
});

test("16: stop() removes every listener", () => {
  const env = new FakeEnv();
  const c = createDriverConnectionController(env, {
    dispatch: () => {},
    refresh: () => Promise.resolve(OK),
  });
  c.start();
  for (const type of ["offline", "online", "focus", "visibilitychange"]) {
    assert.equal(env.count(type), 1, type);
  }
  c.stop();
  for (const type of ["offline", "online", "focus", "visibilitychange"]) {
    assert.equal(env.count(type), 0, type);
  }
});

test("17: overlapping refreshes do not run twice", () => {
  const env = new FakeEnv();
  const ref = deferredRefresh();
  const c = createDriverConnectionController(env, {
    dispatch: () => {},
    refresh: ref.refresh,
  });
  c.start();
  env.fire("online"); // starts refresh (pending)
  env.fire("online"); // pending → no second refresh
  assert.equal(ref.callCount, 1);
  c.stop();
});

test("18: a refresh resolving after stop() dispatches nothing", async () => {
  const env = new FakeEnv();
  const events: DriverConnectionEvent[] = [];
  const ref = deferredRefresh();
  const c = createDriverConnectionController(env, {
    dispatch: (e) => events.push(e),
    refresh: ref.refresh,
  });
  c.start();
  env.fire("online");
  const before = events.length;
  c.stop();
  ref.resolveNext(OK);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(events.length, before); // no REFRESH_SUCCEEDED after unmount
});

// --- 19-25: persisted refresh resolution (read, not mutation) ------------------

function stateAt(revision: number, updatedAt: string): PrototypeState {
  return { ...createDefaultState(), revision, updatedAt };
}

test("19: newer persisted revision is accepted", () => {
  const current = stateAt(5, "2026-07-31T10:00:00.000Z");
  const stored = stateAt(6, "2026-07-31T10:01:00.000Z");
  const { result, accepted } = resolvePrototypeRefresh(stored, current);
  assert.equal(accepted, stored);
  assert.deepEqual(result, {
    ok: true,
    revision: 6,
    updatedAt: "2026-07-31T10:01:00.000Z",
    changed: true,
  });
});

test("20: equal revision does not accept a new state (changed false)", () => {
  const current = stateAt(5, "2026-07-31T10:00:00.000Z");
  const stored = stateAt(5, "2026-07-31T10:00:00.000Z");
  const { result, accepted } = resolvePrototypeRefresh(stored, current);
  assert.equal(accepted, null);
  assert.equal(result.ok && result.changed, false);
});

test("21: an older persisted revision never replaces local state", () => {
  const current = stateAt(5, "2026-07-31T10:00:00.000Z");
  const stored = stateAt(4, "2026-07-31T09:00:00.000Z");
  const { result, accepted } = resolvePrototypeRefresh(stored, current);
  assert.equal(accepted, null);
  assert.ok(result.ok);
  assert.equal(result.revision, 5); // keeps the newer local revision
});

test("22-23: corrupt/unavailable persisted state → failure (not empty)", () => {
  const current = stateAt(5, "2026-07-31T10:00:00.000Z");
  const { result, accepted } = resolvePrototypeRefresh(null, current);
  assert.equal(accepted, null);
  assert.equal(result.ok, false);
});

test("24-25: refresh never bumps revision or changes updatedAt", () => {
  const current = stateAt(5, "2026-07-31T10:00:00.000Z");
  // Accept newer: result carries stored's exact revision/updatedAt (no +1).
  const stored = stateAt(6, "2026-07-31T10:02:00.000Z");
  const accept = resolvePrototypeRefresh(stored, current).result;
  assert.ok(accept.ok);
  assert.equal(accept.revision, 6);
  assert.equal(accept.updatedAt, "2026-07-31T10:02:00.000Z");
  // Keep local: result carries current's exact revision/updatedAt.
  const keep = resolvePrototypeRefresh(stateAt(5, "2026-07-31T10:00:00.000Z"), current).result;
  assert.ok(keep.ok);
  assert.equal(keep.revision, 5);
  assert.equal(keep.updatedAt, "2026-07-31T10:00:00.000Z");
});

test("view message differs per status (not colour-only signalling)", () => {
  const statuses = ["INITIALIZING", "ONLINE", "OFFLINE", "RECOVERING", "DEGRADED"] as const;
  const messages = statuses.map((status) => getDriverConnectionView({ ...R, status }).message);
  assert.equal(new Set(messages).size, statuses.length);
  for (const m of messages) assert.ok(m.length > 0);
});
