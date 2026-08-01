import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isAckOk,
  ledgerAfterCloseAttempt,
  nextNotificationRequestId,
  NOTIFICATION_ACK_TYPE,
  shouldRunNotificationReconcile,
} from "./direct-notification-ack";

test("isAckOk accepts only a matching, successful ACK", () => {
  const id = "dnr-1";
  assert.equal(isAckOk({ type: NOTIFICATION_ACK_TYPE, requestId: id, ok: true }, id), true);
  assert.equal(isAckOk({ type: NOTIFICATION_ACK_TYPE, requestId: id, ok: false }, id), false);
  assert.equal(isAckOk({ type: NOTIFICATION_ACK_TYPE, requestId: "other", ok: true }, id), false);
  assert.equal(isAckOk({ type: "WRONG", requestId: id, ok: true }, id), false);
  assert.equal(isAckOk(null, id), false);
  assert.equal(isAckOk("nope", id), false);
  assert.equal(isAckOk({ requestId: id, ok: true }, id), false);
});

test("CLOSE key is removed only after a confirmed ACK", () => {
  const ledger = ["k1", "k2", "k3"];
  assert.deepEqual(ledgerAfterCloseAttempt(ledger, "k2", true), ["k1", "k3"]);
  // fail-closed: no ACK → the key stays, so a real close can be retried later.
  assert.deepEqual(ledgerAfterCloseAttempt(ledger, "k2", false), ["k1", "k2", "k3"]);
  // original array is not mutated
  assert.deepEqual(ledger, ["k1", "k2", "k3"]);
});

test("an inactive screen never reconciles (no show/close/ledger access)", () => {
  const base = { active: true, enabled: true, nowMs: 1000, hasRegistration: true };
  assert.equal(shouldRunNotificationReconcile(base), true);
  assert.equal(shouldRunNotificationReconcile({ ...base, active: false }), false);
  assert.equal(shouldRunNotificationReconcile({ ...base, enabled: false }), false);
  assert.equal(shouldRunNotificationReconcile({ ...base, nowMs: 0 }), false);
  assert.equal(shouldRunNotificationReconcile({ ...base, hasRegistration: false }), false);
});

test("request ids are unique per call", () => {
  const a = nextNotificationRequestId();
  const b = nextNotificationRequestId();
  assert.notEqual(a, b);
  assert.match(a, /^dnr-\d+$/);
});
