import {
  legacyKitchenLedgerScope,
  parseNotificationLedger,
  type BrowserStorageReadResult,
  type NotificationLedgerEntry,
} from "./direct-notifications";

/**
 * Storage-key migration for the notification delivery ledger. The first feature
 * version stored the kitchen ledger under a role-less shared key
 * (`direct-notification-ledger:kitchen:<restaurantId>`); the current version
 * reads a role-scoped key (`…:kitchen:<restaurantId>:<workspaceRole>`). This
 * adapter reads the new key first and, only when it is absent, migrates the old
 * shared key into the new role-scoped one via the accepted scope-aware value
 * parser — durably, and WITHOUT deleting the old key (so the other role can
 * still migrate it too). Pure over an injected storage port so it can be tested
 * with a real two-key store.
 */

export const LEDGER_STORAGE_PREFIX = "direct-notification-ledger";

export function ledgerStorageKeyFor(scope: string): string {
  return `${LEDGER_STORAGE_PREFIX}:${scope}`;
}

/** Injected storage: read distinguishes absent (`raw:null`) from unavailable. */
export interface LedgerStorage {
  read: (storageKey: string) => { ok: true; raw: string | null } | { ok: false };
  write: (storageKey: string, value: string) => boolean;
}

function parseRaw(
  raw: string,
  scope: string,
): BrowserStorageReadResult<NotificationLedgerEntry[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "INVALID_DATA" };
  }
  const result = parseNotificationLedger(parsed, scope);
  return result.ok
    ? { ok: true, value: result.entries }
    : { ok: false, error: "INVALID_DATA" };
}

/**
 * Read the ledger for `scope`, migrating a legacy role-less kitchen storage key
 * when needed.
 *  1. Read the new role-scoped key. If present → parse ONLY it (corrupt →
 *     INVALID_DATA); never fall back to the old key.
 *  2. If absent and scope is kitchen → read the legacy shared key. Absent →
 *     valid empty ledger. Present → parse/migrate via the scope-aware parser
 *     (corrupt → INVALID_DATA).
 *  3. On a successful migration, durably write the result to the new key (the old
 *     key is left intact for the other role). A failed write is not fatal to this
 *     read — it is simply re-migrated next time.
 */
export function readMigratedLedger(
  storage: LedgerStorage,
  scope: string,
): BrowserStorageReadResult<NotificationLedgerEntry[]> {
  const primary = storage.read(ledgerStorageKeyFor(scope));
  if (!primary.ok) return { ok: false, error: "UNAVAILABLE" };
  if (primary.raw !== null) return parseRaw(primary.raw, scope);

  const legacyScope = legacyKitchenLedgerScope(scope);
  if (legacyScope === null) return { ok: true, value: [] };

  const legacy = storage.read(ledgerStorageKeyFor(legacyScope));
  if (!legacy.ok) return { ok: false, error: "UNAVAILABLE" };
  if (legacy.raw === null) return { ok: true, value: [] };

  const migratedResult = parseRaw(legacy.raw, scope);
  if (!migratedResult.ok) return migratedResult;

  // Durably seed the new role-scoped key; keep the legacy key for the other role.
  storage.write(ledgerStorageKeyFor(scope), JSON.stringify(migratedResult.value));
  return migratedResult;
}
