# Driver V1 Final Audit

## 1. Executive Verdict

- **SHIP-OK: NO**
- **Scope:** browser / localStorage prototype (single authoritative client-side state; no backend). This is NOT a production-readiness audit — missing backend transport, remote Web Push, GPS, WebSocket and real payment settlement are honestly-declared V1 limitations, not findings.
- **Audited SHA:** `537dfc308d259c20d7d5616dc93a3abc0121aa41` (branch `main`)
- **Audit branch:** `audit/driver-v1-final` (only this file added)
- **Date:** 2026-08-01
- **Checks:** `npm test` → 2742 pass / 0 fail; `npm run lint` → 0 problems; `npx tsc --noEmit` → clean; `npm run build` → compiled, 38/38 static pages; `git diff --check` → clean; `verify:zones` → OK (bender-zones-v1.1, 9216 verified addresses). GitHub Actions **Quality** run id `30685775622` on `main` head `537dfc308d259c20d7d5616dc93a3abc0121aa41` → `status: completed`, `conclusion: success` (https://github.com/upa1311/direct-platform/actions/runs/30685775622). `gh` CLI is not installed in this environment; this was read via the unauthenticated GitHub REST API — independent CI confirmation is limited to that API response.
- **Findings:** P0 = 0, P1 = 0, **P2 = 1**, P3 = 4.

Driver V1 is internally consistent, fail-closed, and financially rigorous at the money-movement layer, and most of the driver path is proven by runtime code and real behavioral/domain tests. **However, one P2 blocks sign-off:** the CASH offer card does not present the full pre-accept information the current `docs/driver-experience.md §5` contract requires (customer collection total and change/tender requirement), so a driver accepts a cash order without seeing how much to collect or whether change is needed (F-5). Automated checks all pass, but the automated suite does not assert this contract, so it did not catch the gap. Until F-5 is resolved (implement the missing pre-accept CASH disclosure, or formally remove the requirement from the Driver V1 contract), Driver V1 is not SHIP-OK.

## 2. Audit Method

- **Approach:** documentation and commit messages were treated as claimed contract only; every verdict was checked against runtime code, domain functions, selectors, provider wiring, persistence and tests.
- **Modules reviewed (evidence read directly):**
  - `src/prototype/driver-earnings.ts`, `src/prototype/driver-payouts.ts` (financial core, full read)
  - `src/prototype/prototype-store.ts` (`executeSerializedPrototypeMutation`, `finalizeMutation`, `resolveBootstrapState`, `isNewerState`, `safeReadStoredState`)
  - `src/prototype/prototype-provider.tsx` (mutation lock wiring, `refreshFromPersistedState`, storage/BroadcastChannel bootstrap)
  - `src/prototype/driver-offers.ts`, `src/prototype/driver-delivery.ts` (offer accept atomicity, lifecycle guards, CASH pickup gating)
  - `src/prototype/driver-connection.ts`, `src/components/driver/use-driver-connection.ts` (connection state machine + controller)
  - `src/prototype/driver-customer-instruction.ts`, `src/prototype/driver-delivery-handoff.ts`, `src/prototype/restaurant-waiting-analytics.ts`
  - `src/prototype/direct-notifications.ts`, `notification-ledger-storage.ts`, `direct-notification-ack.ts`, `public/direct-notifications-sw.js`
  - `src/components/driver/driver-workspace.tsx`, `driver-auth.ts`
- **Commands run:** `git status/fetch/switch/pull/rev-parse`, `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`, `git diff --check`, `git diff --stat main...HEAD`, GitHub Actions REST API.
- **Limitations of the audit:** static review + full automated suite; no live browser interaction (repo has no React render harness — UI is exercised by node:test source-contract + pure logic tests). Concurrency was assessed via the code paths and the existing fake-lock/fake-store behavioral tests, not by driving real tabs.

## 3. Driver V1 Feature Inventory

| Capability | Implementation evidence | Test evidence | Status |
|---|---|---|---|
| Login by name+phone, no profile picker, no field-specific error | `driver-auth.ts:authenticateDriver` (both fields required; `matches.length === 1` else null) | `driver-auth.test.ts`; `driver-workspace.test.ts` | PASS |
| Session integrity / invalid session | `driver-session.ts` (`readAuthenticatedDriverId`), workspace clears removed driver | `driver-workspace.test.ts` (tests 13–21) | PASS |
| Operational status + zones (explicit, no geolocation) | `driver-offers.ts` go-online/pause/resume; `finalizeMutation` operational events | `driver-workspace.test.ts`, operational-event coverage in store | PASS |
| Offer selector + eligibility + waves + accept/decline | `driver-offers.ts:getOpenDriverOffersForDriver`, accept (`assignedDriverId !== null` first-wins), waves | `driver-offers.test.ts` (behavioral) | PASS (domain); pre-accept CASH offer display incomplete — see CASH row + F-5 |
| CASH offer pre-accept disclosure (handoff, customer collection, change) | `driver-offer-card.tsx:DriverOfferCard` shows only "Нужно иметь при себе" from `cashHandoffCents`; `driver-workspace.tsx:NewOffersSection` passes only `restaurantHandoffCents`; `models.ts:PlatformDriverCashSnapshot` has no change/tender field | no test asserts the `docs/driver-experience.md §5` pre-accept CASH contract | **FAIL (F-5, P2)** |
| Active delivery lifecycle (arrive→pickup→arriving→delivered) | `driver-delivery.ts` (stage resolver, transition guards, identity, single active order) | `driver-delivery.test.ts` (behavioral) | PASS |
| Restaurant waiting (ONLINE+CASH) | `restaurant-waiting-analytics.ts`; workspace `RestaurantWaitingSummary` | `restaurant-waiting-analytics.test.ts`, `restaurant-waiting-cash.test.ts` | PASS |
| CASH lifecycle (handoff/receipt/collection) money integrity | `platform-driver-cash-handoff.ts`, `platform-driver-cash-collection.ts`, `money-movement-snapshot.ts` | `platform-driver-cash-handoff.test.ts`, `platform-driver-cash-collection.test.ts` | PASS (money movement); **FAIL overall for CASH capability** due to pre-accept disclosure gap (F-5) |
| Earnings (one per order, immutable amount) | `driver-earnings.ts` (`driverEarningEntryId`, snapshot amount, fail-closed proof) | `driver-earnings.test.ts`, `driver-earnings-final.test.ts` | PASS |
| Payouts (one earning→one payout, own-driver receipt) | `driver-payouts.ts` (`alreadyBatched`, overlap conflict, receipt guards) | `driver-payouts.test.ts`, `driver-settlement-period.test.ts` | PASS |
| Shift analytics (read-only) | `driver-shift-analytics.ts` | `analytics-presentation.test.ts` + shift analytics tests | PASS |
| Incidents (append-only, admin resolve) | `driver-order-incidents.ts` | incident coverage in `driver-workspace.test.ts` / domain tests | PASS |
| Customer instruction + handoff policy | `driver-customer-instruction.ts`, `driver-delivery-handoff.ts` | `driver-customer-instruction.test.ts`, `driver-delivery-handoff.test.ts` | PASS |
| Notifications (sound + system) | `direct-notifications*.ts`, `notification-ledger-storage.ts`, `direct-notifications-sw.js` | `direct-notification*.test.ts`, `notifications-contract.test.ts`, `*-sw-behavior.test.ts` | PASS |
| Offline / connection recovery | `driver-connection.ts`, `use-driver-connection.ts`, provider `refreshFromPersistedState` | `driver-connection.test.ts`, `driver-connection-integration.test.ts` | PASS |
| Persistence + cross-tab | `prototype-store.ts`, `prototype-provider.tsx`, `browser-adapters.ts` | `concurrency-serialization.test.ts`, `bootstrap-race.test.ts`, `browser-adapters.test.ts` | PASS |

## 4. End-to-End Scenario Matrix

| Scenario | Expected | Evidence | Verdict |
|---|---|---|---|
| 1 — ONLINE delivery | login→online→offer→accept→arrive→wait→pickup→arriving→complete→earning appears | `driver-delivery.ts` transitions; `driver-earnings.ts:buildPreparedDriverEarningEntry` (ONLINE branch requires exact pickup/arriving events + chronology); `driver-delivery.test.ts` | PASS |
| 2 — CASH delivery | reserved offer→accept→arrive→hand cash→restaurant confirms→pickup→collect→complete→consistent earning/accounting; **and the pre-accept offer discloses collection total + change requirement (`docs/driver-experience.md §5`)** | Money movement is correct: `platform-driver-cash-handoff.ts` (report→confirm), `driver-delivery.ts:334` pickup blocked until `hasRestaurantConfirmedDriverCashHandoff`, `driver-earnings.ts` CASH branch verifies `CASH_TO_PLATFORM_DRIVER`. BUT pre-accept the driver sees only restaurant-handoff — `driver-offer-card.tsx` / `NewOffersSection` never surface `customerCollectionCents` and no change/tender field exists (F-5). | **FAIL** |
| 3 — Competing tabs | one authoritative outcome, no duplicate event/earning/payment | `executeSerializedPrototypeMutation` (rebase on freshest + persist-before-accept); offer accept `assignedDriverId !== null → false`; earning/payout deterministic ids + dedup; `concurrency-serialization.test.ts` | PASS |
| 4 — Connection loss | active order visible, actions blocked, no replay, reconnect re-reads persisted, stale rejected | `driver-connection.ts` (`canMutate` only ONLINE, generation token), `useAction` gate, `refreshFromPersistedState` read-only; `driver-connection.test.ts`, `driver-connection-integration.test.ts` | PASS |
| 5 — Incident | lifecycle not silently changed, admin resolves, history preserved | `driver-order-incidents.ts` (append-only, no auto-transition, no financial effect) | PASS |
| 6 — Payout | earning→batch→receipt→duplicate blocked→unrelated driver cannot confirm | `driver-payouts.ts:createDriverPayoutBatch` (alreadyBatched), `confirmDriverPayoutReceipt` (own-driver, idempotent/CONFLICT); `driver-payouts.test.ts` | PASS |
| 7 — Corrupt/recovery | malformed state/ledger, unavailable storage/locks, worker ACK failure fail closed | `safeReadStoredState`→null; `parseNotificationLedger`→INVALID_DATA; `runWithNotificationLock`→LOCK_UNAVAILABLE; `requestWorkerAck` timeout→false; corresponding tests | PASS |

## 5. Domain and Lifecycle Invariants

- **Identity on fresh state:** delivery/earning actions re-check `driverId`, `BUSY_DIRECT`, and `getDriverActiveOrder(...) === order.id` on the state passed into the domain function (`driver-earnings.ts:184-187`, `driver-delivery.ts`). PASS.
- **Single active Direct order:** `goDriverOnline`/accept fail if `getDriverActiveOrder(state, driverId) !== null` (`driver-offers.ts:260, 638`). PASS.
- **No stage skipping:** completion requires exactly one `ORDER_PICKED_UP`(READY→OUT_FOR_DELIVERY) + one `ARRIVING_TO_CUSTOMER`(OUT_FOR_DELIVERY→ARRIVING) with `pickup ≤ arriving ≤ now` (`driver-earnings.ts:191-232`). PASS.
- **`ORDER_DELIVERED` is the only completion evidence:** earnings recognize on the delivered event; no alternate completion path. PASS.
- **No-op does not create revision/event:** `executeSerializedPrototypeMutation` returns `committed:false` when `action.state === baseState`. PASS.
- **UI never shows success on domain failure:** actions return `{ok:false}` and the UI surfaces the domain error; `useAction` only clears error on a real run. PASS.

## 6. CASH and Financial Invariants

| # | Invariant | Verdict | Evidence |
|---|---|---|---|
| 1 | Amounts not recomputed from mutable menu/cart after order | PASS | `driver-earnings.ts` uses `order.financials.driverPayoutCents` / immutable `platformDriverCash` snapshot only |
| 2 | CASH snapshot immutable | PASS | snapshot read via `getPlatformDriverCashSnapshot`; never written by driver actions; `platform-driver-cash-handoff.ts` amounts sourced from snapshot |
| 3 | Driver UI passes no authoritative money into domain | PASS | cash actions take no amount arg; completion input is a boolean `cashCollectionConfirmed` |
| 4 | Completion alone creates no unconfirmed cash movement | PASS | earning CASH branch requires `moneyMovementStatus === "COMPLETE"` + `CASH_TO_PLATFORM_DRIVER` + confirmed handoff/collection |
| 5 | One completed delivery → one earning | PASS | deterministic `driver-earning-<orderId>`; `hasValidDriverEarningEntry` requires exactly one matching entry |
| 6 | One earning not paid twice | PASS | `createDriverPayoutBatch` `alreadyBatched` set + cross-batch overlap → conflict |
| 7 | Payout receipt does not create a second payout | PASS | receipt is a separate append-only event; deterministic `driver-payout-receipt-<batchId>`; idempotent |
| 8 | Offline/reconnect/notification logic does not mutate finances | PASS | `refreshFromPersistedState` is read-only; connection/notification modules never call financial mutations |
| 9 | Corrected CASH recovery creates no double economy | PASS | `validateCompletedCashEvidence` + `computeCompletedOrderAccounting` require already-recognized (or legitimately zero) obligation |
| 10 | Every financial mutation on fresh serialized state | PASS | all provider mutations run through `runSerializedMutationCore` → `executeSerializedPrototypeMutation` under the shared Web Lock |

## 7. Persistence and Cross-Tab Integrity

- Schema `PROTOTYPE_SCHEMA_VERSION = 30` (`models.ts:10`); storage key `direct-prototype-state-v7`.
- Bootstrap (`resolveBootstrapState`) re-reads v7 under the lock; existing v7 authoritative; legacy migrated only when no v7; never overwrites newer state.
- Mutations: base = `selectLatestPrototypeState(local, stored)` (rebase on freshest); **persist before local acceptance/broadcast**; a persist throw aborts with no false success; broadcast failure after persist is non-fatal (storage event catches up).
- Cross-tab: `storage` event + `BroadcastChannel` both funnel through `isNewerState` (revision, then updatedAt) — no last-writer-wins silent loss. Missing Web Locks → critical mutations fail closed (`SAFE_TAB_SYNC_UNAVAILABLE_ERROR`), no spin-lock.
- No second state lifecycle: connection `refreshFromPersistedState` reuses `safeReadStoredState`/`isNewerState`/`replaceState`.
- Evidence: `concurrency-serialization.test.ts` (1312 lines... covers lock/persist/rebase), `bootstrap-race.test.ts`, `browser-adapters.test.ts`.

## 8. Notifications, Sound and Connection Recovery

- **Sound (channel 1):** explicit preference keys (`direct-driver-offer-sound-enabled`, `direct-kitchen-sound-enabled`), fixed intervals (10s driver / 20s kitchen), audio failures guarded; system notifications never touch sound preference. PASS (`kitchen-sound.ts`, `driver-offer-sound-logic.ts`, contract tests).
- **System notifications (channel 2):** permission only on explicit enable gesture; driver offer privacy (neutral text pre-accept); kitchen text = public number only; worker message validation (bounded strings, approved same-origin route, known `entityKind`, no external URL); MessageChannel SHOW/CLOSE ACK; Web-Lock-serialized; durable two-phase `PENDING→DELIVERED`; stale close on CLOSE-ACK; role-scoped kitchen tags/ledger; corrupt ledger → `INVALID_DATA` fail-closed; legacy value + legacy storage-key migration; no `PushManager`/VAPID/backend sender; SW has no `fetch`/cache handler. PASS (`direct-notifications.ts`, `notification-ledger-storage.ts`, `direct-notification-ack.ts`, `direct-notifications-sw.js`, and tests `direct-notification*.test.ts`, `direct-notifications-sw-behavior.test.ts`, `notifications-contract.test.ts`).
- **Connection recovery:** states INITIALIZING/ONLINE/OFFLINE/RECOVERING/DEGRADED; `canMutate` only ONLINE; browser signal never called backend proof; generation token invalidates pre-reconnect refreshes; focus/visibility refresh flips to RECOVERING (blocks); coalesced single follow-up; offline-during-refresh and stale completion handled; connection state tab-local (never persisted/broadcast). PASS (`driver-connection.ts`, `driver-connection.test.ts` behavioral controller tests).

## 9. Privacy and Security Boundaries

- Driver auth is a prototype boundary (documented), not production auth. Session `driverId` cannot drive another driver's mutation — every driver action re-verifies identity on fresh state.
- Offer privacy pre-accept: `driver-offer-card.tsx` renders the customer street WITHOUT the house number (and no phone/name/comment); grep confirms no `.comment` in the offer card. Showing the street without the house number is explicitly permitted by `docs/driver-experience.md §5` and §13, so it is NOT a privacy finding. (Note: F-5 concerns the CASH *money* fields that §5 requires but the card omits — a functional/UX gap, not a privacy leak.)
- Customer instruction shown only inside `ActiveOrderCard` (assigned active order) via `getDriverCustomerInstructionView`.
- Notification routes limited to approved same-origin relative routes; no external URL accepted by the worker contract.
- No localStorage data is described as secure server storage; docs state prototype limitations.
- Verdict: PASS within prototype scope.

## 10. Mobile and Accessibility Review

- Driver workspace uses `role="status"`/`role="alert"` for connection, incident, sound and notification blocks; state conveyed by text (not colour alone) — e.g. connection block has distinct titles per state.
- Buttons expose `disabled` on `pending`/`blocked`; primary lifecycle buttons (`MainButton`) and offer/cash/note/incident controls disable under the connection gate.
- Sheets (`DriverControlSheet`) support Escape/outside-click/focus-return; login form has labels, `autoComplete`, `inputMode`, `role="alert"`.
- Long customer instruction / address / CASH values wrap (`white-space: pre-wrap`, `overflow-wrap: anywhere`), no forced ellipsis on meaningful text.
- **Usability gap (F-5, P2):** the CASH offer card is operationally incomplete pre-accept. It shows only "Нужно иметь при себе" (restaurant handoff) and does not show the customer collection total or whether change is needed / the tender amount change is expected from. A cash-enabled driver therefore accepts a cash order without the full "how much to collect / change" picture the `docs/driver-experience.md §5` contract requires. This is a decision/operational usability blocker (not a layout blocker).
- Verdict: FAIL — one operational usability blocker (F-5). No layout/rendering/accessibility-semantics blocker found; pixel-perfect visual review out of scope.

## 11. Test Quality Review

Overall: strong behavioral/domain coverage on the highest-risk areas; source-contract assertions are used as a supplement, not the sole proof, for UI wiring.

- **Real behavioral/domain tests:** earnings, payouts, cash handoff/collection, offers, delivery lifecycle, waiting analytics, connection controller (fake env + deferred refresh + reduced-state assertions), notification ledger/ACK/worker (fake worker/lock/storage, ordering asserted), serialization/bootstrap concurrency (shared store + lock).
- **Failure tests** assert absence of mutation/event/state change (e.g. earnings/payouts return same state; connection stale completion asserts no `REFRESH_SUCCEEDED`), not merely error text.
- **CASH fixtures** are valid (enabled flag, reserved offer, immutable snapshot, assigned driver, arrival events).
- **Concurrency tests** use a genuinely shared fake store + serializing lock (notifications) and the real serialized-mutation core (persistence).
- **Gaps / debt (non-blocking, see P3):** some connection/notification UI-wiring gates are proven by `source.includes()`/slice-order assertions rather than a rendered component, because the repo has no React render harness. The underlying gate logic (`canMutate`, `useAction` run-gate, reducer) is behaviorally tested; only the JSX binding is source-verified.

## 12. Findings

| ID | Severity | Area | Finding | Evidence | Reproduction | Required resolution |
|---|---|---|---|---|---|---|
| F-5 | **P2** | CASH offer UX / domain contract | The current `docs/driver-experience.md §5` contract requires a CASH offer to show, before acceptance, how much to hand the restaurant, how much to collect from the customer, and whether change is needed (and from what tender amount). Runtime shows only the restaurant-handoff amount: `DriverOfferCard` accepts only `cashHandoffCents` and renders only "Нужно иметь при себе"; `NewOffersSection` passes only `snapshot.restaurantHandoffCents`; `snapshot.customerCollectionCents` is never surfaced pre-accept; and `PlatformDriverCashSnapshot` has no change/tender field at all. A cash-enabled driver accepts a cash order without seeing the full collection total or change requirement — a material operational gap. | `docs/driver-experience.md` §5 ("Карточка предложения до принятия"); `src/components/driver/driver-offer-card.tsx` `DriverOfferCard` (`cashHandoffCents` prop; "Нужно иметь при себе"); `src/components/driver/driver-workspace.tsx` `NewOffersSection` (passes `cashSnapshot.restaurantHandoffCents` only); `src/prototype/models.ts` `PlatformDriverCashSnapshot` (has `customerCollectionCents`, no change/tender field) | 1. Open a CASH offer for an eligible cash-enabled driver. 2. Before accepting, the card shows the restaurant-handoff amount. 3. The customer collection total and the change requirement are absent. | Either (a) add an immutable change/tender snapshot and show pre-accept: customer collection total, whether change is needed, and the tender amount change is expected from; **or** (b) by an explicit product decision, formally remove this requirement from the current Driver V1 contract in `docs/driver-experience.md`. Until one of these lands, Driver V1 is not SHIP-OK. (No product-code change made by this audit.) |
| F-1 | P3 | Test quality | Driver-workspace mutation-gate wiring (note/logout/offer/cash button `disabled` and early-returns) is verified by source-string/slice assertions, not by rendering the component. Core gate logic is behaviorally tested, but a future refactor could silently detach a button from `blocked` without failing a test. | `driver-connection-integration.test.ts` (source slices), `driver-workspace.test.ts` (source `.includes`) vs behavioral `driver-connection.test.ts` | Rewire a button to ignore `blocked`; source tests may still pass. | Add a lightweight render/interaction test harness for the gate (future); not required for V1 sign-off. |
| F-2 | P3 | Test quality | `finalizeMutation` default timestamp is `new Date().toISOString()` (`prototype-store.ts:159`); provider always passes an explicit `nowIso`, so this default is only a fallback. Not a correctness defect, but a non-deterministic default in an otherwise time-injected codebase. | `prototype-store.ts:156-160` | N/A (provider passes timestamp) | Consider making the timestamp required (future hardening). |
| F-3 | P3 | Docs | Multiple corrective decisions (DEC-138…DEC-143) describe the notification/connection evolution; a reader must follow the chain to derive the final contract. No contradiction found, but the final consolidated contract lives across several entries. | `docs/decision-log.md`, `docs/notifications.md` | N/A | Optional: a single consolidated "current contract" note (future). |
| F-4 | P3 | Prototype limitation (honestly declared) | Connection "ONLINE" and notification delivery depend on `navigator.onLine` + an open Direct client; there is no backend health signal. This is declared in code/UI/docs and is correct for V1 — recorded here for completeness, not as a defect. | `driver-connection.ts` header; UI "Работают, пока Direct открыт в браузере." | N/A | None for V1. |

One P2 finding (F-5). No P0 or P1 findings.

## 13. Honest Prototype Limitations

- No production backend / authoritative server event stream or health check — connection status is derived from the browser signal + last confirmed local state only.
- No remote Web Push — system notifications require an open Direct client; no `PushManager`/VAPID/server sender.
- No real payment transfer — payout batch and receipt are administrative/driver confirmations, not bank movements; UI does not claim a real transfer.
- No production authentication — driver login is a name+phone prototype boundary.
- No GPS / WebSocket / SSE — zones are explicit; dispatch is client-side timed waves.
- Service worker has no offline cache / fetch handler / background sync (intentional).
These are consistent with the declared V1 scope and are not counted as findings.

## 14. Final Gate

- **P0 count:** 0
- **P1 count:** 0
- **P2 count:** 1 (F-5)
- **P3 count:** 4 (non-blocking)
- **SHIP-OK: NO**
- **Reason:** One P2 finding (F-5) blocks sign-off: the CASH offer card omits the pre-accept customer-collection total and change/tender requirement mandated by the current `docs/driver-experience.md §5` contract, so a driver accepts a cash order without the full collection picture. The automated suite passes (test 2742/0, lint, tsc, build, diff-check, verify:zones) and GitHub Actions run `30685775622` on `main` is `success`, but the suite does not assert this contract, so green checks do not clear F-5. All financial money-movement invariants and the ONLINE, competing-tabs, connection-recovery, incident, payout and corruption-boundary scenarios are proven by code and real behavioral/domain tests. Driver V1 becomes SHIP-OK once F-5 is resolved — either by implementing the missing pre-accept CASH disclosure (customer collection total + change requirement + tender amount) or by an explicit product decision removing that requirement from the Driver V1 contract. The four P3 items are test-quality/documentation debt and a declared limitation and remain non-blocking. This audit changed no product code.
