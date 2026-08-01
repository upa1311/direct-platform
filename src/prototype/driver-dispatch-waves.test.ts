import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  acceptRestaurantOrder,
  addCartItem,
  createOrderFromCart,
  goDriverOnline,
  markOrderReady,
  simulateSuccessfulOnlinePayment,
  updateCartAddress,
} from "./actions.ts";
import { createDefaultState } from "./default-state.ts";
import {
  DRIVER_OFFER_DURATION_MS,
  DRIVER_OFFER_WAVE_COOLDOWN_MS,
  acceptDriverOffer,
  declineDriverOffer,
  getDriverDispatchState,
  reconcileDriverOffers,
} from "./driver-offers.ts";
import {
  executeSerializedPrototypeMutation,
  parseStoredState,
} from "./prototype-store.ts";
import type { PrototypeState } from "./models.ts";

const D1 = "driver-1";
const D2 = "driver-2";
const BASE_MS = Date.parse("2026-07-22T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const PROVIDER_SOURCE = readFileSync(
  new URL("./prototype-provider.tsx", import.meta.url),
  "utf8",
);
const DRIVER_LAYOUT_SOURCE = readFileSync(
  new URL("../app/driver/layout.tsx", import.meta.url),
  "utf8",
);

function readyState(): { state: PrototypeState; orderId: string } {
  let state = updateCartAddress(createDefaultState(), {
    street: "Садовый переулок",
    house: "1",
  });
  state = addCartItem(state, "restaurant-2-item-1", "size-standard").state;
  const created = createOrderFromCart(state);
  const orderId = created.result.orderId as string;
  state = acceptRestaurantOrder(created.state, orderId, 20);
  state = simulateSuccessfulOnlinePayment(state, orderId);
  state = markOrderReady(state, orderId);
  return { state, orderId };
}

function preparingState(options?: {
  expectedReadyAt?: string | null;
  kitchenStartedAt?: string | null;
  split?: boolean;
}): { state: PrototypeState; orderId: string } {
  const ready = readyState();
  const expectedReadyAt =
    options?.expectedReadyAt === undefined
      ? iso(BASE_MS + 10 * 60_000)
      : options.expectedReadyAt;
  const kitchenStartedAt =
    options?.kitchenStartedAt === undefined
      ? iso(BASE_MS - 10 * 60_000)
      : options.kitchenStartedAt;
  return {
    orderId: ready.orderId,
    state: {
      ...ready.state,
      restaurants: ready.state.restaurants.map((restaurant) =>
        restaurant.id === "restaurant-2" && options?.split
          ? { ...restaurant, orderWorkflowMode: "SPLIT_OPERATOR_KITCHEN" }
          : restaurant,
      ),
      orders: ready.state.orders.map((order) =>
        order.id === ready.orderId
          ? {
              ...order,
              status: "PREPARING",
              expectedReadyAt,
              kitchenStartedAt,
            }
          : order,
      ),
    },
  };
}

function online(state: PrototypeState, driverId: string): PrototypeState {
  const result = goDriverOnline(state, driverId, "zone-2");
  assert.equal(result.result.ok, true);
  return result.state;
}

test("PREPARING is gated by the ten-minute ETA window", () => {
  const prepared = preparingState({
    expectedReadyAt: iso(BASE_MS + 10 * 60_000 + 1),
  });
  const before = reconcileDriverOffers(online(prepared.state, D1), iso(BASE_MS));
  assert.equal(before.result.createdCount, 0);
  assert.equal(before.state.driverDispatchWaves.length, 0);

  const dueState = preparingState();
  const due = reconcileDriverOffers(online(dueState.state, D1), iso(BASE_MS));
  assert.equal(due.result.createdCount, 1);
  assert.equal(due.state.driverDispatchWaves[0].trigger, "ETA_WINDOW");
});

test("reconciliation is idempotent and offers last exactly 30 seconds", () => {
  const prepared = preparingState();
  const first = reconcileDriverOffers(online(prepared.state, D1), iso(BASE_MS));
  const second = reconcileDriverOffers(first.state, iso(BASE_MS));
  assert.equal(second.state, first.state);
  assert.equal(second.state.revision, first.state.revision);
  assert.equal(second.state.driverDispatchWaves.length, 1);
  assert.equal(
    Date.parse(second.state.driverOffers[0].expiresAt) -
      Date.parse(second.state.driverOffers[0].offeredAt),
    DRIVER_OFFER_DURATION_MS,
  );
});

test("READY starts immediately, while SPLIT before kitchen start fails closed", () => {
  const ready = readyState();
  const urgent = reconcileDriverOffers(online(ready.state, D1), iso(BASE_MS));
  assert.equal(urgent.result.createdCount, 1);
  assert.equal(urgent.state.driverDispatchWaves[0].trigger, "READY_URGENT");

  const split = preparingState({
    split: true,
    kitchenStartedAt: null,
    expectedReadyAt: null,
  });
  const blocked = reconcileDriverOffers(online(split.state, D1), iso(BASE_MS));
  assert.equal(blocked.result.createdCount, 0);
  assert.equal(
    getDriverDispatchState(blocked.state, blocked.state.orders.find((o) => o.id === split.orderId)!, BASE_MS),
    "DATA_INVALID",
  );
});

test("missing, corrupt, or lifecycle-inconsistent PREPARING ETA fails closed", () => {
  for (const values of [
    { expectedReadyAt: null },
    { expectedReadyAt: "broken" },
    {
      expectedReadyAt: iso(BASE_MS - 20 * 60_000),
      kitchenStartedAt: iso(BASE_MS - 10 * 60_000),
    },
  ]) {
    const prepared = preparingState(values);
    const result = reconcileDriverOffers(online(prepared.state, D1), iso(BASE_MS));
    assert.equal(result.result.createdCount, 0);
    assert.equal(result.state.driverDispatchWaves.length, 0);
  }
});

test("later ETA cancellation is recovered immediately when an earlier ETA is due", () => {
  const prepared = preparingState();
  const started = reconcileDriverOffers(online(prepared.state, D1), iso(BASE_MS));
  const delayed: PrototypeState = {
    ...started.state,
    orders: started.state.orders.map((order) =>
      order.id === prepared.orderId
        ? { ...order, expectedReadyAt: iso(BASE_MS + 30 * 60_000) }
        : order,
    ),
  };
  const canceled = reconcileDriverOffers(delayed, iso(BASE_MS + 1_000));
  assert.equal(canceled.result.canceledCount, 1);
  assert.equal(canceled.state.driverOffers[0].status, "CANCELED");
  assert.equal(
    canceled.state.driverOffers[0].systemCancellationReason,
    "ORDER_NOT_DUE",
  );

  const persisted = parseStoredState(JSON.stringify(canceled.state));
  assert.ok(persisted);
  const recoveredEarlier: PrototypeState = {
    ...persisted,
    orders: persisted.orders.map((order) =>
      order.id === prepared.orderId
        ? { ...order, expectedReadyAt: iso(BASE_MS + 5 * 60_000) }
        : order,
    ),
  };
  const recovered = reconcileDriverOffers(recoveredEarlier, iso(BASE_MS + 2_000));
  assert.equal(recovered.state.driverDispatchWaves.length, 2);
  assert.equal(recovered.state.driverDispatchWaves[0].id, started.state.driverDispatchWaves[0].id);
  assert.equal(recovered.state.driverDispatchWaves[1].trigger, "ETA_WINDOW");
  assert.equal(
    recovered.state.driverOffers.filter((offer) => offer.status === "OPEN").length,
    1,
  );
  assert.equal(recovered.state.driverOffers[0].status, "CANCELED");
  const repeated = reconcileDriverOffers(recovered.state, iso(BASE_MS + 2_000));
  assert.equal(repeated.state, recovered.state);

  const notDue = preparingState({
    expectedReadyAt: iso(BASE_MS + 20 * 60_000),
  });
  const movedEarlier: PrototypeState = {
    ...online(notDue.state, D1),
    orders: notDue.state.orders.map((order) =>
      order.id === notDue.orderId
        ? { ...order, expectedReadyAt: iso(BASE_MS + 5 * 60_000) }
        : order,
    ),
  };
  const immediate = reconcileDriverOffers(movedEarlier, iso(BASE_MS));
  assert.equal(immediate.result.createdCount, 1);
});

test("acceptance rejects an OPEN offer made premature by a later ETA", () => {
  const prepared = preparingState();
  const offered = reconcileDriverOffers(online(prepared.state, D1), iso(BASE_MS));
  const stale: PrototypeState = {
    ...offered.state,
    orders: offered.state.orders.map((order) =>
      order.id === prepared.orderId
        ? { ...order, expectedReadyAt: iso(BASE_MS + 30 * 60_000) }
        : order,
    ),
  };
  const beforeRevision = stale.revision;
  const accepted = acceptDriverOffer(
    stale,
    D1,
    stale.driverOffers[0].id,
    iso(BASE_MS + 1_000),
    { cashReserveConfirmed: false },
  );
  assert.equal(accepted.result.ok, false);
  assert.equal(accepted.result.error, "Предложение уже недоступно.");
  assert.equal(accepted.state, stale);
  assert.equal(accepted.state.revision, beforeRevision);
  assert.equal(accepted.state.driverOffers[0].status, "OPEN");
  assert.equal(accepted.state.orders.find((order) => order.id === prepared.orderId)?.assignedDriverId, null);
  assert.equal(accepted.state.drivers.find((driver) => driver.id === D1)?.status, "AVAILABLE");
});

test("acceptance rejects an OPEN offer after kitchen or ETA lifecycle corruption", () => {
  for (const orderPatch of [
    { kitchenStartedAt: null },
    { expectedReadyAt: "broken" },
  ]) {
    const prepared = preparingState();
    const offered = reconcileDriverOffers(online(prepared.state, D1), iso(BASE_MS));
    const corrupted: PrototypeState = {
      ...offered.state,
      orders: offered.state.orders.map((order) =>
        order.id === prepared.orderId ? { ...order, ...orderPatch } : order,
      ),
    };
    const accepted = acceptDriverOffer(
      corrupted,
      D1,
      corrupted.driverOffers[0].id,
      iso(BASE_MS + 1_000),
      { cashReserveConfirmed: false },
    );
    assert.equal(accepted.result.ok, false);
    assert.equal(accepted.result.error, "Предложение уже недоступно.");
    assert.equal(accepted.state, corrupted);
    assert.equal(accepted.state.driverOffers[0].status, "OPEN");
    assert.equal(accepted.state.orders.find((order) => order.id === prepared.orderId)?.assignedDriverId, null);
    assert.equal(accepted.state.drivers.find((driver) => driver.id === D1)?.status, "AVAILABLE");
  }
});

test("mixed terminal offers do not block immediate ETA recovery", () => {
  const prepared = preparingState();
  let state = online(prepared.state, D1);
  state = online(state, D2);
  const first = reconcileDriverOffers(state, iso(BASE_MS));
  assert.equal(first.state.driverOffers.length, 2);
  const firstWaveId = first.state.driverDispatchWaves[0].id;
  const firstOfferIds = first.state.driverOffers.map((offer) => offer.id);

  const oneIneligible: PrototypeState = {
    ...first.state,
    drivers: first.state.drivers.map((driver) =>
      driver.id === D1 ? { ...driver, status: "PAUSED" } : driver,
    ),
  };
  const partlyCanceled = reconcileDriverOffers(
    oneIneligible,
    iso(BASE_MS + 1_000),
  );
  assert.equal(
    partlyCanceled.state.driverOffers.find((offer) => offer.driverId === D1)?.status,
    "CANCELED",
  );
  assert.equal(
    partlyCanceled.state.driverOffers.find((offer) => offer.driverId === D1)
      ?.systemCancellationReason,
    undefined,
  );
  assert.equal(
    partlyCanceled.state.driverOffers.find((offer) => offer.driverId === D2)?.status,
    "OPEN",
  );

  const delayed: PrototypeState = {
    ...partlyCanceled.state,
    orders: partlyCanceled.state.orders.map((order) =>
      order.id === prepared.orderId
        ? { ...order, expectedReadyAt: iso(BASE_MS + 30 * 60_000) }
        : order,
    ),
  };
  const notDue = reconcileDriverOffers(delayed, iso(BASE_MS + 2_000));
  assert.equal(
    notDue.state.driverOffers.find((offer) => offer.driverId === D2)
      ?.systemCancellationReason,
    "ORDER_NOT_DUE",
  );

  const earlier: PrototypeState = {
    ...notDue.state,
    orders: notDue.state.orders.map((order) =>
      order.id === prepared.orderId
        ? { ...order, expectedReadyAt: iso(BASE_MS + 5 * 60_000) }
        : order,
    ),
  };
  const recovered = reconcileDriverOffers(earlier, iso(BASE_MS + 3_000));
  assert.equal(recovered.state.driverDispatchWaves.length, 2);
  assert.equal(recovered.state.driverDispatchWaves[0].id, firstWaveId);
  assert.equal(recovered.state.driverDispatchWaves[1].trigger, "ETA_WINDOW");
  assert.deepEqual(
    recovered.state.driverOffers.slice(0, 2).map((offer) => offer.id),
    firstOfferIds,
  );
  assert.equal(recovered.state.driverOffers.length, 3);
  const openOffers = recovered.state.driverOffers.filter(
    (offer) => offer.status === "OPEN",
  );
  assert.equal(openOffers.length, 1);
  assert.equal(new Set(openOffers.map((offer) => offer.waveId)).size, 1);
  assert.notEqual(openOffers[0].waveId, firstWaveId);
  const repeated = reconcileDriverOffers(recovered.state, iso(BASE_MS + 3_000));
  assert.equal(repeated.state, recovered.state);
});

test("expiry plus 15-second cooldown creates a retry wave and reoffers", () => {
  const prepared = preparingState();
  const first = reconcileDriverOffers(online(prepared.state, D1), iso(BASE_MS));
  const expired = reconcileDriverOffers(
    first.state,
    iso(BASE_MS + DRIVER_OFFER_DURATION_MS),
  );
  assert.equal(expired.state.driverOffers[0].status, "EXPIRED");
  const duringCooldown = reconcileDriverOffers(
    expired.state,
    iso(BASE_MS + DRIVER_OFFER_DURATION_MS + DRIVER_OFFER_WAVE_COOLDOWN_MS - 1),
  );
  assert.equal(duringCooldown.state.driverDispatchWaves.length, 1);
  const retry = reconcileDriverOffers(
    duringCooldown.state,
    iso(BASE_MS + DRIVER_OFFER_DURATION_MS + DRIVER_OFFER_WAVE_COOLDOWN_MS),
  );
  assert.equal(retry.state.driverDispatchWaves.length, 2);
  assert.equal(retry.state.driverDispatchWaves[1].trigger, "RETRY");
  assert.equal(retry.state.driverOffers[1].driverId, D1);
  assert.equal(retry.state.driverOffers[1].waveNumber, 2);
});

test("explicit decline excludes only that driver; new eligible drivers join next wave", () => {
  const prepared = preparingState();
  let state = online(prepared.state, D1);
  const first = reconcileDriverOffers(state, iso(BASE_MS));
  const declined = declineDriverOffer(
    first.state,
    D1,
    first.state.driverOffers[0].id,
    iso(BASE_MS + 1_000),
  );
  state = online(declined.state, D2);
  const retry = reconcileDriverOffers(
    state,
    iso(BASE_MS + DRIVER_OFFER_DURATION_MS + DRIVER_OFFER_WAVE_COOLDOWN_MS),
  );
  const waveTwo = retry.state.driverOffers.filter((offer) => offer.waveNumber === 2);
  assert.deepEqual(waveTwo.map((offer) => offer.driverId), [D2]);
});

test("READY bypasses cooldown once without creating concurrent active waves", () => {
  const prepared = preparingState();
  const first = reconcileDriverOffers(online(prepared.state, D1), iso(BASE_MS));
  const expired = reconcileDriverOffers(first.state, iso(BASE_MS + 30_000));
  const ready: PrototypeState = {
    ...expired.state,
    orders: expired.state.orders.map((order) =>
      order.id === prepared.orderId ? { ...order, status: "READY" } : order,
    ),
  };
  const urgent = reconcileDriverOffers(ready, iso(BASE_MS + 35_000));
  assert.equal(urgent.state.driverDispatchWaves.length, 2);
  assert.equal(urgent.state.driverDispatchWaves[1].trigger, "READY_URGENT");
  const again = reconcileDriverOffers(urgent.state, iso(BASE_MS + 35_000));
  assert.equal(again.state, urgent.state);
  assert.equal(
    urgent.state.driverDispatchWaves.filter(
      (wave) => Date.parse(wave.offerExpiresAt) > BASE_MS + 35_000,
    ).length,
    1,
  );
});

test("acceptance closes the wave, rejects old/expired offers, and stops retries", () => {
  const ready = readyState();
  let state = online(ready.state, D1);
  state = online(state, D2);
  const wave = reconcileDriverOffers(state, iso(BASE_MS));
  const acceptedOffer = wave.state.driverOffers.find((offer) => offer.driverId === D1)!;
  const accepted = acceptDriverOffer(
    wave.state,
    D1,
    acceptedOffer.id,
    iso(BASE_MS + 1_000),
    { cashReserveConfirmed: false },
  );
  assert.equal(accepted.result.ok, true);
  assert.equal(
    accepted.state.driverOffers.find((offer) => offer.driverId === D2)?.status,
    "CANCELED",
  );
  const later = reconcileDriverOffers(accepted.state, iso(BASE_MS + 60_000));
  assert.equal(later.state.driverDispatchWaves.length, 1);
});

test("v29 migration preserves offer history as deterministic LEGACY waves", () => {
  const ready = readyState();
  const raw = {
    ...ready.state,
    schemaVersion: 29,
    driverOffers: [
      {
        id: "legacy-offer",
        orderId: ready.orderId,
        driverId: D1,
        status: "DECLINED",
        offeredAt: iso(BASE_MS),
        expiresAt: iso(BASE_MS + 30_000),
        resolvedAt: iso(BASE_MS + 1_000),
        cashReserveConfirmedAt: null,
      },
    ],
  };
  delete (raw as Partial<PrototypeState>).driverDispatchWaves;
  const migrated = parseStoredState(JSON.stringify(raw));
  assert.ok(migrated);
  assert.equal(migrated.schemaVersion, 31);
  assert.equal(migrated.driverDispatchWaves[0].trigger, "LEGACY");
  assert.equal(migrated.driverOffers[0].status, "DECLINED");
  assert.equal(migrated.driverOffers[0].waveNumber, 1);
});

test("v29 migration drops injected ETA recovery reason and preserves cooldown", () => {
  const prepared = preparingState();
  const state = online(prepared.state, D1);
  const raw = {
    ...state,
    schemaVersion: 29,
    driverOffers: [
      {
        id: "legacy-canceled-offer",
        orderId: prepared.orderId,
        driverId: D1,
        status: "CANCELED",
        offeredAt: iso(BASE_MS),
        expiresAt: iso(BASE_MS + DRIVER_OFFER_DURATION_MS),
        resolvedAt: iso(BASE_MS + 1_000),
        systemCancellationReason: "ORDER_NOT_DUE",
        cashReserveConfirmedAt: null,
      },
    ],
  };
  delete (raw as Partial<PrototypeState>).driverDispatchWaves;
  const migrated = parseStoredState(JSON.stringify(raw));
  assert.ok(migrated);
  assert.equal(migrated.driverDispatchWaves[0].trigger, "LEGACY");
  assert.equal(migrated.driverOffers[0].status, "CANCELED");
  assert.equal(migrated.driverOffers[0].systemCancellationReason, undefined);

  const beforeExpiry = reconcileDriverOffers(migrated, iso(BASE_MS + 2_000));
  assert.equal(beforeExpiry.state, migrated);
  const duringCooldown = reconcileDriverOffers(
    migrated,
    iso(
      BASE_MS +
        DRIVER_OFFER_DURATION_MS +
        DRIVER_OFFER_WAVE_COOLDOWN_MS -
        1,
    ),
  );
  assert.equal(duringCooldown.state, migrated);
  const afterCooldown = reconcileDriverOffers(
    migrated,
    iso(
      BASE_MS +
        DRIVER_OFFER_DURATION_MS +
        DRIVER_OFFER_WAVE_COOLDOWN_MS,
    ),
  );
  assert.equal(afterCooldown.state.driverDispatchWaves.length, 2);
  assert.equal(afterCooldown.state.driverDispatchWaves[1].trigger, "RETRY");
});

test("serialized fresh-state reconciliation models two tabs without duplicate waves", () => {
  const ready = readyState();
  const local = online(ready.state, D1);
  let persisted: PrototypeState | null = null;
  const mutation = (base: PrototypeState) =>
    reconcileDriverOffers(base, iso(BASE_MS));
  const first = executeSerializedPrototypeMutation({
    localState: local,
    storedState: persisted,
    mutation,
    persist: (next) => {
      persisted = next;
    },
  });
  const second = executeSerializedPrototypeMutation({
    localState: local,
    storedState: persisted,
    mutation,
    persist: (next) => {
      persisted = next;
    },
  });
  assert.equal(first.committed, true);
  assert.equal(second.committed, false);
  assert.equal(second.nextState.driverDispatchWaves.length, 1);
  assert.equal(second.nextState.driverOffers.length, 1);
});

test("dispatch scheduler is provider-global and no longer owned by driver routes", () => {
  assert.match(PROVIDER_SOURCE, /getNextDriverOfferReconciliationAt/);
  assert.match(
    PROVIDER_SOURCE,
    /return reconcileDriverOffers\(next, nowIso\)\.state/,
  );
  assert.doesNotMatch(DRIVER_LAYOUT_SOURCE, /DriverOfferRuntime/);
});
