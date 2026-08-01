# Driver V1 Final Audit

## 1. Executive Verdict

- **SHIP-OK: YES** (updated by the targeted F-5 re-audit; see §15)
- **Scope:** browser / localStorage prototype (single authoritative client-side state; no backend). This is NOT a production-readiness audit — missing backend transport, remote Web Push, GPS, WebSocket and real payment settlement are honestly-declared V1 limitations, not findings.
- **Original audited SHA:** `537dfc308d259c20d7d5616dc93a3abc0121aa41` (the initial audit correctly found F-5 here).
- **Re-audited SHA:** `709e09819caf30b7b1053790dc4a00b9f9da990b` (branch `main`) — F-5 fix merged (commits `083a79d`, `3cb3cb8`, `22fa188`, `709e098`).
- **Audit branch:** `audit/driver-v1-f5-reaudit` (only this file changed).
- **Date:** 2026-08-01 (re-audit same day)
- **Checks (re-audit, on `709e098`):** `npm test` → 2830 pass / 0 fail; `npm run lint` → 0 problems; `npx tsc --noEmit` → clean; `npm run build` → compiled; `git diff --check` → clean; `verify:zones` → OK (bender-zones-v1.1, 9216 verified addresses). GitHub Actions **Quality** run id `30721859937` on `main` head `709e09819caf30b7b1053790dc4a00b9f9da990b` → `status: completed`, `conclusion: success`, job `quality` completed/success (Test, Lint, TypeScript, Build, Check whitespace, Check clean tracked tree all success) (https://github.com/upa1311/direct-platform/actions/runs/30721859937). `gh` CLI is not installed in this environment; this was read via the unauthenticated GitHub REST API.
- **Findings:** P0 = 0, P1 = 0, **P2 = 0** (F-5 RESOLVED), P3 = 4.

Driver V1 is internally consistent, fail-closed, and financially rigorous at the money-movement layer, and the driver path is proven by runtime code and real behavioral/domain tests. The single blocking P2 (F-5) has been **resolved**: the CASH offer now discloses, before acceptance, the full customer-collection total and the change/tender requirement mandated by `docs/driver-experience.md §5`, backed by an immutable `PlatformDriverCashTenderSnapshot` (schema v31), a compare-and-set persistence path under the shared Web Lock, and behavioral tests that assert the contract. The tender snapshot is operational disclosure only — it introduces no new money movement and does not change the order economics. Driver V1 is SHIP-OK.

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
| Offer selector + eligibility + waves + accept/decline | `driver-offers.ts:getOpenDriverOffersForDriver`, accept (`assignedDriverId !== null` first-wins), waves | `driver-offers.test.ts` (behavioral) | PASS |
| CASH offer pre-accept disclosure (handoff, customer collection, change) | `driver-offer-card.tsx:DriverOfferCard` renders the disclosure view (`getDriverCashOfferDisclosureView`): "Получить от клиента" + "Передать ресторану" + "Сдача не нужна" (EXACT) or "Клиент заплатит"/"Подготовить сдачу" (CHANGE_FROM); `models.ts:PlatformDriverCashTenderSnapshot` (`mode`,`tenderCents`,`changeDueCents`, schema v31); strict builder/resolver in `platform-driver-cash.ts` | `platform-driver-cash-tender.test.ts` (disclosure READY/REVIEW_REQUIRED/NOT_APPLICABLE + card contract), `cash-tender-checkout-view.test.ts` | **PASS (F-5 RESOLVED)** |
| Active delivery lifecycle (arrive→pickup→arriving→delivered) | `driver-delivery.ts` (stage resolver, transition guards, identity, single active order) | `driver-delivery.test.ts` (behavioral) | PASS |
| Restaurant waiting (ONLINE+CASH) | `restaurant-waiting-analytics.ts`; workspace `RestaurantWaitingSummary` | `restaurant-waiting-analytics.test.ts`, `restaurant-waiting-cash.test.ts` | PASS |
| CASH lifecycle (handoff/receipt/collection) money integrity | `platform-driver-cash-handoff.ts`, `platform-driver-cash-collection.ts`, `money-movement-snapshot.ts` | `platform-driver-cash-handoff.test.ts`, `platform-driver-cash-collection.test.ts` | PASS (money movement + pre-accept disclosure; F-5 RESOLVED) |
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
| 2 — CASH delivery | reserved offer→accept→arrive→hand cash→restaurant confirms→pickup→collect→complete→consistent earning/accounting; **and the pre-accept offer discloses collection total + change requirement (`docs/driver-experience.md §5`)** | Money movement is correct: `platform-driver-cash-handoff.ts` (report→confirm), `driver-delivery.ts` pickup blocked until `hasRestaurantConfirmedDriverCashHandoff`, `driver-earnings.ts` CASH branch verifies `CASH_TO_PLATFORM_DRIVER`. Pre-accept disclosure now present: `getDriverCashOfferDisclosureView` + `DriverOfferCard` surface customer collection, restaurant handoff and change/tender; the confirmation sheet and the assigned-order view repeat them; eligibility and `acceptDriverOffer` fail-closed require both the cash and tender snapshots (F-5 RESOLVED). | **PASS** |
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

- Schema `PROTOTYPE_SCHEMA_VERSION = 31` (`models.ts`); storage key `direct-prototype-state-v7` не изменён. Migration v30 → v31 сохраняет существующую историю и нормализует отсутствующий legacy `platformDriverCashTender` в `null` без предположения `EXACT` и без пересчёта CASH accounting, earnings или payouts.
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
- Offer privacy pre-accept: `driver-offer-card.tsx` renders the customer street WITHOUT the house number (and no phone/name/comment); grep confirms no `.comment` in the offer card. Showing the street without the house number is explicitly permitted by `docs/driver-experience.md §5` and §13, so it is NOT a privacy finding. The F-5 fix added only CASH *money* disclosure (collection/handoff/change); pre-accept privacy did not regress — `platform-driver-cash-tender.test.ts` asserts the card still exposes no house/apartment/phone/name/comment.
- Customer instruction shown only inside `ActiveOrderCard` (assigned active order) via `getDriverCustomerInstructionView`.
- Notification routes limited to approved same-origin relative routes; no external URL accepted by the worker contract.
- No localStorage data is described as secure server storage; docs state prototype limitations.
- Verdict: PASS within prototype scope.

## 10. Mobile and Accessibility Review

- Driver workspace uses `role="status"`/`role="alert"` for connection, incident, sound and notification blocks; state conveyed by text (not colour alone) — e.g. connection block has distinct titles per state.
- Buttons expose `disabled` on `pending`/`blocked`; primary lifecycle buttons (`MainButton`) and offer/cash/note/incident controls disable under the connection gate.
- Sheets (`DriverControlSheet`) support Escape/outside-click/focus-return; login form has labels, `autoComplete`, `inputMode`, `role="alert"`.
- Long customer instruction / address / CASH values wrap (`white-space: pre-wrap`, `overflow-wrap: anywhere`), no forced ellipsis on meaningful text.
- **CASH disclosure (F-5 RESOLVED):** the CASH offer card is now operationally complete pre-accept — it shows "Получить от клиента" (customer collection), "Передать ресторану" (restaurant handoff), and either "Сдача не нужна" (EXACT) or "Клиент заплатит" + "Подготовить сдачу" (CHANGE_FROM), from the immutable snapshots via `getDriverCashOfferDisclosureView`. The confirmation sheet repeats the same amounts before the driver commits, and the assigned-order view keeps them visible; a corrupted/missing snapshot shows the honest "Данные о сдаче требуют проверки Direct" and cannot be accepted. The cash-enabled driver now has the full "how much to collect / change" picture `docs/driver-experience.md §5` requires.
- Verdict: PASS — the prior operational usability blocker (F-5) is resolved. No layout/rendering/accessibility-semantics blocker found; pixel-perfect visual review out of scope.

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
| F-5 | **P2 → RESOLVED** | CASH offer UX / domain contract | **Original finding (SHA `537dfc3`):** `docs/driver-experience.md §5` requires a CASH offer to show, before acceptance, how much to hand the restaurant, how much to collect from the customer, and whether change is needed (and from what tender amount). At the original SHA the runtime showed only the restaurant-handoff amount (`DriverOfferCard` took only `cashHandoffCents`, "Нужно иметь при себе"; no change/tender field existed). **Resolution (re-audited SHA `709e098`, resolution option (a)):** an immutable `PlatformDriverCashTenderSnapshot` (`mode` EXACT\|CHANGE_FROM, `tenderCents`, `changeDueCents`; schema v31) is built by a strict fail-closed builder from the canonical order total; `getDriverCashOfferDisclosureView` returns READY / REVIEW_REQUIRED / NOT_APPLICABLE; the offer card, confirmation sheet and assigned-order view surface customer collection + restaurant handoff + change/tender; eligibility and `acceptDriverOffer` fail-closed require both cash and tender snapshots; and persistence is a compare-and-set under the shared Web Lock. It is disclosure only — no new money movement, economics unchanged. | Fixed by commits `083a79d`, `3cb3cb8`, `22fa188`, `709e098`. Runtime: `src/prototype/models.ts` (`PlatformDriverCashTenderSnapshot`, `PROTOTYPE_SCHEMA_VERSION = 31`); `src/prototype/platform-driver-cash.ts` (`buildPlatformDriverCashTenderSnapshot`/`resolvePlatformDriverCashTenderSnapshot`); `src/prototype/selectors.ts` (`getDriverCashOfferDisclosureView`); `src/components/driver/driver-offer-card.tsx` + `driver-workspace.tsx` (disclosure + confirmation + active order); `src/prototype/driver-offers.ts` (eligibility/accept require tender). Tests: `platform-driver-cash-tender.test.ts`, `cash-tender-checkout.test.ts`, `cash-tender-cas.test.ts`, `cash-tender-editor.test.ts`, `cash-tender-checkout-view.test.ts`. Quality run `30721859937` → `success`. | Re-verified: open a CASH offer for a cash-enabled driver → the card shows collection total, restaurant handoff and change requirement before acceptance; a missing/corrupt snapshot shows review-required and cannot be accepted. | **RESOLVED.** No further action. (This re-audit changed no product code.) |
| F-1 | P3 | Test quality | Driver-workspace mutation-gate wiring (note/logout/offer/cash button `disabled` and early-returns) is verified by source-string/slice assertions, not by rendering the component. Core gate logic is behaviorally tested, but a future refactor could silently detach a button from `blocked` without failing a test. | `driver-connection-integration.test.ts` (source slices), `driver-workspace.test.ts` (source `.includes`) vs behavioral `driver-connection.test.ts` | Rewire a button to ignore `blocked`; source tests may still pass. | Add a lightweight render/interaction test harness for the gate (future); not required for V1 sign-off. |
| F-2 | P3 | Test quality | `finalizeMutation` default timestamp is `new Date().toISOString()` (`prototype-store.ts:159`); provider always passes an explicit `nowIso`, so this default is only a fallback. Not a correctness defect, but a non-deterministic default in an otherwise time-injected codebase. | `prototype-store.ts:156-160` | N/A (provider passes timestamp) | Consider making the timestamp required (future hardening). |
| F-3 | P3 | Docs | Multiple corrective decisions (DEC-138…DEC-143) describe the notification/connection evolution; a reader must follow the chain to derive the final contract. No contradiction found, but the final consolidated contract lives across several entries. | `docs/decision-log.md`, `docs/notifications.md` | N/A | Optional: a single consolidated "current contract" note (future). |
| F-4 | P3 | Prototype limitation (honestly declared) | Connection "ONLINE" and notification delivery depend on `navigator.onLine` + an open Direct client; there is no backend health signal. This is declared in code/UI/docs and is correct for V1 — recorded here for completeness, not as a defect. | `driver-connection.ts` header; UI "Работают, пока Direct открыт в браузере." | N/A | None for V1. |

F-5 (the single P2) is RESOLVED at re-audited SHA `709e098`. No open P0, P1 or P2 findings remain; the four P3 items are non-blocking test-quality/documentation debt and a declared limitation.

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
- **P2 count:** 0 (F-5 RESOLVED)
- **P3 count:** 4 (non-blocking)
- **SHIP-OK: YES**
- **Reason:** The only blocking finding (F-5, P2) is resolved at re-audited SHA `709e098`: the CASH offer now discloses the pre-accept customer-collection total and change/tender requirement mandated by `docs/driver-experience.md §5`, backed by the immutable `PlatformDriverCashTenderSnapshot` (schema v31), a compare-and-set persistence path under the shared Web Lock, and behavioral tests that assert the disclosure, the CAS/concurrency protocol and the accept-time re-validation. The financial money-movement invariants are unchanged (the tender snapshot is disclosure only, no new money movement), and the ONLINE, competing-tabs, connection-recovery, incident, payout and corruption-boundary scenarios remain proven by code and real behavioral/domain tests. The automated suite passes (test 2830/0, lint, tsc, build, diff-check, verify:zones) and GitHub Actions **Quality** run `30721859937` on `main` head `709e098` is `completed/success`. The four P3 items are test-quality/documentation debt and a declared limitation and remain non-blocking. This re-audit changed no product code.

## 15. Targeted F-5 Re-audit

- **Original audited SHA:** `537dfc308d259c20d7d5616dc93a3abc0121aa41` — the initial audit correctly found F-5 (P2) here; that historical finding stands.
- **Fix SHAs (merged to `main`, fast-forward):** `083a79d` (add cash tender snapshot) → `3cb3cb8` (synchronize disclosure) → `22fa188` (serialize editor state) → `709e098` (make cash tender saves compare-and-set).
- **Re-audited SHA:** `709e09819caf30b7b1053790dc4a00b9f9da990b` (branch `main`).
- **Quality run:** `30721859937` — workflow `Quality`, event `push`, head_sha `709e098`, `status: completed`, `conclusion: success`; job `quality` completed/success with all steps (Test, Lint, TypeScript, Build, Check whitespace, Check clean tracked tree) success.
- **Files reviewed (runtime, not commit messages):** `src/prototype/models.ts`, `src/prototype/platform-driver-cash.ts`, `src/prototype/cash-tender-intent.ts`, `src/prototype/prototype-store.ts`, `src/prototype/money-movement-snapshot.ts`, `src/prototype/actions.ts`, `src/prototype/selectors.ts`, `src/prototype/driver-offers.ts`, `src/prototype/prototype-provider.tsx`, `src/components/client/cash-tender-checkout-view.ts`, `src/components/client/cash-tender-editor.ts`, `src/app/client/cart/page.tsx`, `src/components/driver/driver-offer-card.tsx`, `src/components/driver/driver-workspace.tsx`. Tests reviewed: `platform-driver-cash-tender.test.ts`, `cash-tender-checkout.test.ts`, `cash-tender-cas.test.ts`, `cash-tender-editor.test.ts`, `cash-tender-checkout-view.test.ts`, `driver-offers.test.ts`, and the existing CASH handoff/collection/earnings/payout tests.
- **Checks executed (re-audit, local, on `709e098`):** `npm test` → 2830 pass / 0 fail; `npm run lint` → 0 problems; `npx tsc --noEmit` → clean; `npm run build` → compiled; `npm run verify:zones` → OK (9216 addresses); `git diff --check` → clean. Before this file was edited the product diff `main...HEAD` was empty.
- **CASH disclosure evidence:** `PlatformDriverCashTenderSnapshot { mode: EXACT|CHANGE_FROM, tenderCents, changeDueCents }` (models.ts:838), schema v31; builder enforces EXACT ⇒ tender == collection ∧ change == 0, CHANGE_FROM ⇒ tender > collection ∧ change == tender − collection, integer-safe cents, unknown mode fail-closed (platform-driver-cash.ts:205-249); resolver accepts a stored snapshot only on field-by-field match — no repair by assumption (platform-driver-cash.ts:252-299); `getDriverCashOfferDisclosureView` classifies non-CASH/non-PLATFORM_DRIVER → NOT_APPLICABLE, CASH with missing/corrupt cash or tender → REVIEW_REQUIRED, both valid → READY (selectors.ts:2857+); `DriverOfferCard` shows collection/handoff/change and REVIEW_REQUIRED cannot be accepted (accept re-validates both snapshots, driver-offers.ts:673-674; eligibility requires both, :127/:132).
- **CAS / concurrency evidence:** `saveCartCashTenderIntent(state, expectedIntentKey, nextIntent)` runs inside `runSerializedMutationCore` → `executeSerializedPrototypeMutation` on the fresh rebased `baseState` under the shared Web Lock (prototype-provider.tsx:1026-1047); non-CASH or fingerprint mismatch → conflict with the state returned unchanged (no mutation, no revision, no broadcast, no overwrite of the incoming intent); same-value → idempotent `ok:true, changed:false`; else applied via `finalizeMutation` (actions.ts:358-384). Editor: monotonic `attemptId`, CLEAN only when ack success **and** authoritative match (or idempotent `changed:false`), late responses from superseded attempts ignored, cross-tab conflict accepts incoming and invalidates the attempt, retry starts a new attempt, double-save fires at most one mutation, submit allowed only when CLEAN ∧ no attempt ∧ base key == authoritative key ∧ valid-for-total (cash-tender-editor.ts). Behavioral proof: `cash-tender-cas.test.ts` (apply / stale-reject / idempotent / non-CASH / lost queued save / winning intent in order creation) and `cash-tender-editor.test.ts` (ack-first, incoming-first, late-response suppression, retry, rapid typing = 0 mutations, submit-mismatch prevention).
- **Financial invariants:** unchanged by the tender snapshot. `changeDueCents = tenderCents − customerCollectionCents` (builder) and `customerCollectionCents = restaurantHandoffCents + driverEarningCents` (unchanged `buildPlatformDriverCashSnapshot`, platform-driver-cash.ts:86/106). `customerCollectionCents`, `restaurantHandoffCents`, `driverEarningCents`, `restaurantOwesDirectCents`, handoff/receipt/collection events, earnings, payouts, accounting and corrected CASH completion are not modified — the tender snapshot is disclosure, not a money movement.
- **F-5 status:** RESOLVED.
- **Updated Driver V1 verdict:** P0 = 0, P1 = 0, P2 = 0, P3 = 4, **SHIP-OK: YES**.
