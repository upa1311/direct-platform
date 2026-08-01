/**
 * Pure ACK helpers for the confirmed request/response between a Direct client and
 * the notifications service worker. Every SHOW/CLOSE is now confirmed over a
 * MessageChannel: the client records a SHOW key only after a matching ACK, and
 * removes a CLOSE key only after a matching ACK. Fail-closed: no ACK → not
 * recorded/not removed, and a bounded timeout prevents a retry storm.
 */

export const NOTIFICATION_ACK_TYPE = "DIRECT_NOTIFICATION_ACK";
/** Bounded wait for a worker ACK before failing closed. */
export const NOTIFICATION_ACK_TIMEOUT_MS = 2000;

/** True only for a well-formed ACK that matches the request and reports success. */
export function isAckOk(response: unknown, requestId: string): boolean {
  if (response === null || typeof response !== "object") return false;
  const ack = response as Record<string, unknown>;
  return (
    ack.type === NOTIFICATION_ACK_TYPE &&
    typeof ack.requestId === "string" &&
    ack.requestId === requestId &&
    ack.ok === true
  );
}

/** Remove a stale CLOSE tag from the ledger only when its close was ACKed. */
export function ledgerAfterCloseAttempt(
  deliveredKeys: readonly string[],
  tag: string,
  ackOk: boolean,
): string[] {
  return ackOk
    ? deliveredKeys.filter((key) => key !== tag)
    : [...deliveredKeys];
}

/**
 * An inactive screen must not drive notifications at all: it does not show, does
 * not close stale tags, and never reads or writes the shared audience ledger.
 */
export function shouldRunNotificationReconcile(input: {
  active: boolean;
  enabled: boolean;
  nowMs: number;
  hasRegistration: boolean;
}): boolean {
  return (
    input.active &&
    input.enabled &&
    input.nowMs > 0 &&
    input.hasRegistration
  );
}

let requestCounter = 0;

/** Monotonic, collision-free request id for one browser session. */
export function nextNotificationRequestId(): string {
  requestCounter += 1;
  return `dnr-${requestCounter}`;
}
