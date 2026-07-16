# herbe.service — WS4 ERP outbound: push-queue saga & write mechanics

Branch: `feature/service-phase1-erp-outbound` (cut from origin/preview @ 69c006f).
Worktree: `/Users/elviskvalbergs/AI/herbe-service/.claude/worktrees/erp-outbound`.

> **For agentic workers:** execute task-by-task with superpowers:subagent-driven-development. Gates per task: `pnpm exec tsc --noEmit` clean, `pnpm exec vitest run` green, `pnpm exec vitest run --coverage` exit 0. ERP-touching tasks extend `tests/live/erp-contract.test.ts` and must pass `pnpm test:live`.

Builds the app→ERP write path per `docs/04-erp-sync.md` §"Outbound" + creation field-maps, scoped per doc 24 §4 item 5: push-queue saga over a new push table pair, SVOVc/WSVc create + update mechanics, persistence verification, OKFlag readback wiring, and the deferred IVVc invoiced-status readback (WebExcellentAPI `getrecordlinks`).

## Existing infra (verified — extend, don't reinvent)
- `outbox_ops` (0004) — client-op journal; `app/api/sync/outbox/route.ts` is the Phase-0 spike that pushes SVOVc directly (violates "push queue is the only ERP writer" once WS4 lands → refactored in Task 6).
- Adapter (`lib/erp/standard-books/adapter.ts`): `pushCreate` SVOVc-only spike (POST payload verbatim, returns `{erpRef}` from `body.SerNr ?? body['@url']`, may be `''`); `fetchRegisterJson(config, register, params)` is the REST GET layer (Basic auth, `Accept: application/json`, transient/permanent error mapping). REST supports `filter.<Field>=<value>`, `fields`, `limit` params (portal-proven).
- `buildAdapterForConnection(db, erpCompanyId)` — the only production path to a live adapter.
- `erp_refs` store: `putErpRef`/`findEntityIdByErpRef`; orders/worksheets match via `(purpose='primary', register='SVOVc'|'WSVc', recordRef=String(SerNr))`.
- Status machines: `assertWorksheetTransition` (`Done→Approved→Synced`), `deriveOrderStatus`; inbound ingest already maps `WSVc.OKFlag=1 → Synced` and `SVOVc.DoneMark=1 → Closed`.
- `chargeTypeToItemType`: invoiceable=1, warranty=2, contract=3, goodwill=4 (push writes the integer).
- Cron pattern: `sync-tick` route (CRON_SECRET `bearerMatches` + `acquireCronLock` + fan-out over active companies); `vercel.json` crons array.
- Fake ERP (`packages/fake-erp`): GET-only Hono server, envelope `{data:{<Register>:rows}, '@sequence':N}`; no POST, no failure modes (Task 2 adds them).
- Live suite `tests/live/erp-contract.test.ts`: `.env.vars`-driven, read-only today; counts/shapes logged, never row values.
- WebExcellentAPI (portal `excellent-api-client`, reuse ledger says copy-first): dispatcher at `<baseUrl>/WebExcellentAPIVc.hal`-style path — portal uses `/WebExcellentAPI.hal` with `action` + params, Basic auth, XML response, **HTTP/1.1 only** (H2 → 403 empty; portal forces `undici Agent {allowH2:false}`). `getrecordlinks` params `{action:'getrecordlinks', id:<sernr>, regname:<register>}` → repeated `<LinkVc><VcName>…</VcName><ID>…</ID></LinkVc>`; `ID` sometimes a raw LE-uint32 (port portal's `decodeLinkId`). Confirmed functional on the demo install (`docs/19` §8).

## Decisions (FINAL)

1. **New tables, migration `0017_erp_push_queue.sql`** — `outbox_ops` stays a client-op journal; the ERP push queue is its own pair:
   - `erp_push_groups`: `id uuid PK default gen_random_uuid()`, `tenant_id uuid NOT NULL → tenants`, `erp_company_id uuid NOT NULL → erp_companies`, `lane text NOT NULL` (FIFO key, `order:<orderId>` today), `kind text NOT NULL` (`order_create` | `worksheet_push`), `status text NOT NULL DEFAULT 'pending'` (`pending|running|succeeded|failed|dead`), `created_at timestamptz default now()`, `updated_at timestamptz default now()`. Index `(erp_company_id, status)`, `(lane, created_at)`.
   - `erp_push_steps`: `id uuid PK`, `group_id uuid NOT NULL → erp_push_groups ON DELETE CASCADE`, `seq int NOT NULL`, `entity_type text NOT NULL` (`serviceOrder|worksheet`), `entity_id uuid NOT NULL`, `register text NOT NULL`, `op text NOT NULL` (`create|update`), `status text NOT NULL DEFAULT 'pending'` (`pending|running|succeeded|failed|dead`), `attempts int NOT NULL DEFAULT 0`, `next_attempt_at timestamptz`, `erp_ref text`, `error_message text`, `updated_at timestamptz default now()`, unique `(group_id, seq)`.
2. **Payloads are built at push time** from current domain state (step rows store entity refs, never payload snapshots) — avoids stale data and keeps steps re-runnable.
3. **Saga semantics** (`lib/sync/push/engine.ts` `processPushQueue(db, adapter, erpCompanyId): Promise<PushSummary>`):
   - FIFO per lane: only the **oldest** non-terminal group per lane runs; a `dead` group blocks its lane until manually retried (doc 04: "a worksheet never races ahead of its failed order push").
   - Within a group, steps run in `seq` order; first non-succeeded step executes; failure stops the group.
   - Error taxonomy: `ErpPermanentError` → step `dead` immediately (DLQ); anything else → `failed`, `attempts+1`, `next_attempt_at = now + 2^attempts minutes`; `attempts >= 5` → `dead`. Group status mirrors its worst step (`dead` step → group `dead`; else in-flight → `running`→`pending`; all succeeded → `succeeded`).
   - Idempotency per step, in order: (a) stored ref — `erp_refs(purpose='primary')` for the entity → step succeeds by adoption (create) or proceeds (update); (b) **natural-key lookup** against the ERP (`filter.` reads): SVOVc by `CustCode`+`TransDate`+the row `SerialNr` set, WSVc by `SVONr`+`EMCode` (unique per one-worksheet-per-order×tech); a match adopts the found `SerNr` (putErpRef + succeed); (c) create.
   - **Persistence verification** (constraint doc 21 §8): after a create POST, non-empty numeric `SerNr` (or `@url`) required; empty → `ErpPermanentError` with the number-series onboarding message (doc 04: "Already registered" no-op) — a 200 is never proof. After an update POST, read back via `filter.SerNr` and verify the record exists.
   - On step success: `putErpRef` (purpose `primary`, register, `String(SerNr)`), step `erp_ref`; order create additionally sets `service_orders.order_number = String(SerNr)`; worksheet push transitions the worksheet `Approved→Synced` via `setWorksheetStatus`.
4. **Enqueue API** (`lib/sync/push/enqueue.ts`):
   - `enqueueOrderCreatePush(db, {tenantId, erpCompanyId, orderId})` → group `order_create`, lane `order:<orderId>`, one step (`serviceOrder`, `create`, `SVOVc`).
   - `approveWorksheet(db, {tenantId, erpCompanyId, worksheetId, actor?})` — the approval entry point: asserts `Done→Approved` transition, **blocks if the technician has no ERP person code** (decision 6) with an actionable `DomainError`, sets status `Approved`, enqueues group `worksheet_push` on lane `order:<orderId>` with steps: order create (seq 1, only when the order lacks a primary SVOVc ref) → worksheet create (seq 2). No customer step in v1 (field-created customers are WS9 scope — deferred).
5. **SVOVc create payload** (`lib/sync/push/builders.ts` `buildSvoCreatePayload`): minimal per doc 04 — `CustCode` (customer's erpRef), `TransDate` (order `requestedAt` date, else today, `YYYY-MM-DD`), rows of `ArtCode`/`Quant`/`SerialNr`/`ItemType` (int via `chargeTypeToItemType`) from `service_order_rows` joined to service items (`serial_nr`, `attributes.ItemCode`). **No `SerNr`.** `CustComplaint1` = order description (first 60 chars) — doubles as the live-test marker field. Customer without an erpRef → `ErpPermanentError` (customer-create push is deferred; ERP-ingested customers always have one).
6. **Technician EMCode** = `erp_refs(entityType='user', purpose='primary', register='UserVc', recordRef=<UserVc.Code>)` — reuses existing infra, no schema change; seeding the link is WS2/WS6 scope (tests insert directly). `EMName` deferred (ERP derives from EMCode; verified live in Task 7).
7. **WSVc create payload** (`buildWsCreatePayload`): precondition — read the live SVOVc via `filter.SerNr` and require `DoneMark == 0` (`ErpPermanentError` otherwise). Header: `SVONr`, `WONr: -1`, `EMCode` (decision 6), copied **verbatim from the live SVOVc read** where present: `CustCode, Addr0, CustContact, Objects, Phone, LangCode, CurncyCode, FrRate, ToRateB1, ToRateB2, BaseRate1, BaseRate2, InvoiceToCode, CustVATCode, PriceList, InclVAT, ExportFlag`; `Location` resolved `adapterConfigJson.push.mainServiceLocation → MainStockBlock.MainStock (REST read, best effort) → ErpPermanentError` (doc 04: never post without a stock location; `UserVc.Location` tier deferred with the identity-link work); `UpdStockFlag: 1`. Rows from `worksheet_rows`: `ArtCode` via linked service item `attributes.ItemCode` else `adapterConfigJson.push.fallbackItemCode` else `ErpPermanentError` (no silent drops), `Quant`, `Price`, `Sum`, `SerialNr`, `ItemType` int. Time/distance entries: pushed only when `push.laborItemCode`/`push.distanceItemCode` configured (labor `Quant` = hours rounded to 0.25, distance = billable km); entries present but code unconfigured → `ErpPermanentError` naming the missing setting. Totals (WSSumup port): `Sum1` = Σ row `Sum`; `Sum3` = 0 and `Sum4 = Sum1` in v1 — the app stores no VAT codes yet; the record is pushed **un-OK'd** and the ERP recalculates on the manager's OK. Task 7's live read-back records what the ERP actually derives; revisit when VAT data lands.
8. **Adapter write surface** (`packages/erp-core` `ErpAdapter` + standard-books impl): `pushCreate(register, payload)` generalized to SVOVc+WSVc (same verbatim-POST mechanics); new `pushUpdate(register: string, recordRef: string, payload: Record<string, unknown>): Promise<void>` — POST with `SerNr: recordRef` included (Standard Books update-by-key); new `fetchRecords(register: string, params: Record<string,string>): Promise<Record<string,unknown>[]>` exposing `filter.`/`fields`/`limit` reads; new `getRecordLinks(register: string, serNr: string): Promise<{register: string, id: string}[]>` (decision 9). Capability `supportsInvoiceStatusReadback` = `adapterConfigJson.features?.invoiceReadback === true`.
9. **WebExcellentAPI client** (`lib/erp/standard-books/excellent-api.ts`, copy-first from portal with attribution): GET `<baseUrl>/WebExcellentAPI.hal?action=getrecordlinks&id=<sernr>&regname=<register>`, Basic auth, response read as latin1 text; parse `<LinkVc>` blocks with the portal's regex helpers + `decodeLinkId` (LE-uint32). HTTP/1.1 forced via `undici` `Agent({allowH2:false})` (new dependency, portal-proven). No session/window-state machinery — v1 needs only this one read action.
10. **Invoiced sweep** (`lib/sync/invoice-status.ts` `sweepInvoiceStatus(db, adapter, erpCompanyId)`): for orders with a primary SVOVc ref and status ∉ {`Invoiced`,`Closed`,`Cancelled`}: `getRecordLinks('SVOVc', serNr)`; any link with register `IVVc` → order status `Invoiced` (erp-owned set, ingest precedence keeps `Closed` above it) + `putErpRef(order, purpose='invoice', register='IVVc', recordRef=<invoice id>)` (`ErpRefPurpose` union gains `'invoice'`). Wired into `syncConnection` as a final step, gated on `supportsInvoiceStatusReadback`, same `withRegisterSync` isolation (register key `IVVc-links`).
11. **Routes**: `app/api/cron/push-tick/route.ts` — mirror sync-tick (CRON_SECRET, lock key `push-tick`, fan-out, `processPushQueue`); add to `vercel.json` crons (`* * * * *`). `app/api/admin/push-retry/route.ts` POST `{stepId}` gated on `ADMIN_MIGRATIONS_SECRET` — resets a `dead` step (+its group) to `pending`, `attempts=0` (the DLQ re-entry; a subsequent tick resumes from that step, repairing `erpRef` downstream per doc 04). `app/api/sync/outbox/route.ts` refactored: same request/response contract, but the SVOVc write goes enqueue→`processPushQueue` inline (the saga is now the only ERP writer).
12. **OKFlag / DoneMark readback**: no adapter-side OK write in v1 (doc 04: manager OKs in the ERP; doc 24's "OK-flag write" = `UpdStockFlag` set correctly at POST). Inbound ingest already maps flags; Task 5 asserts a saga-pushed worksheet is matched by a subsequent ingest via its erp_ref (no duplicate row) and flips to the flag-derived status.

## Tasks

### Task 1 — Migration 0017 + push store

`scripts/migrations/0017_erp_push_queue.sql` (decision 1, idempotent), drizzle schema entries, `lib/sync/push/store.ts`: `createPushGroup(db, {tenantId, erpCompanyId, lane, kind, steps: [{seq, entityType, entityId, register, op}]})`, `getRunnableGroups(db, erpCompanyId, now)` (oldest non-terminal per lane, honoring `next_attempt_at`), `markStep`/`markGroup` updaters, `resetDeadStep(db, stepId)`. DB-backed tests incl. lane FIFO pick and next_attempt gating. Gates + commit.

### Task 2 — Fake-ERP write support

POST route `/api/:company/:register` on the Hono server: in-memory per-instance record store, assigns `SerNr` = max(fixtures∪created)+1, echoes the stored record JSON (top-level `SerNr`, real-envelope shapes preserved on GET: created records appear in subsequent GETs); `SerNr` present in payload → update-by-key (404-equivalent empty behavior if unknown: echo without storing). Modes via `x-fake-erp-mode` header or server option: `noop-create` (200 + echoed payload, **no** SerNr — the "200-but-empty" persistence trap), `http-500`. GET gains `filter.<Field>` param support (exact string match) so natural-key/read-back paths are testable. Unit tests. Gates + commit.

### Task 3 — Adapter write surface

Decision 8 minus getRecordLinks: `pushCreate` (SVOVc+WSVc), `pushUpdate`, `fetchRecords` in `lib/erp/standard-books/adapter.ts` + `ErpAdapter` type. Tests against fake-ERP: create happy path, noop-create returns `''` erpRef, update round-trip, fetchRecords filter. Gates + commit.

### Task 4 — Payload builders

Decisions 5/7 in `lib/sync/push/builders.ts` (+ `wsSumup(rows): {Sum1, Sum3, Sum4}`). Pure where possible (the SVOVc live-read is passed in). Exhaustive unit tests: charge-type ints, marker field, missing customer ref, DoneMark≠0, EMCode missing, Location chain incl. both-missing error, ArtCode chain, time/distance gating, totals. Gates + commit.

### Task 5 — Saga engine + enqueue

Decisions 3/4 in `lib/sync/push/engine.ts` + `enqueue.ts`. DB+fake-ERP tests: happy order_create; worksheet_push group where order step runs first then worksheet (erp_ref written, statuses flip, `order_number` set, worksheet → Synced); noop-create mode → step dead with number-series message, lane blocked; transient 500 → failed with backoff then succeeds on retry; resume-from-failed-step never re-posts the succeeded order step (fake-ERP records only one SVOVc); natural-key adoption (pre-created record in fake ERP + no erp_ref → adopted, no duplicate); `approveWorksheet` blocks without UserVc link and from non-`Done` status; re-ingest of a pushed worksheet matches via erp_ref (decision 12). Gates + commit.

### Task 6 — Routes + cron

Decision 11: push-tick route (+`vercel.json`), push-retry admin route, outbox route refactor keeping its contract tests green. Route tests: 401s, lock skip, retry resets dead step and next tick completes the group. Update `scripts/CRON-HANDOFF`-equivalent if present (none in this repo — vercel.json only). Gates + commit.

### Task 7 — Live proof (create/update path)

Extend `tests/live/erp-contract.test.ts`: seed an order (customer + service item from a prior live ingest) → `enqueueOrderCreatePush` + `processPushQueue` against the demo ERP → assert non-empty numeric erpRef, read-back via `fetchRecords` `filter.SerNr` (1 record, our CustCode, marker present); `pushUpdate` on that same record (change `CustComplaint2`) → read-back confirms; seed+approve a worksheet (EMCode taken from an existing demo WSVc's `EMCode`; `push.mainServiceLocation` from `MainStockBlock` read or first existing WSVc `Location`) → saga pushes WSVc → assert SerNr, read-back `SVONr`/`EMCode`/`WONr=-1`/row count, log which totals/VAT fields the ERP derived (counts/field-presence only, never values beyond our own markers). `pnpm test:live` green. Record any real-data mismatch as a code fix, never a weakened assertion. Gates + commit.

### Task 8 — WebExcellentAPI + invoiced readback

Decisions 9/10: client, adapter `getRecordLinks`, capability wiring, `sweepInvoiceStatus`, `syncConnection` integration, `'invoice'` purpose. Unit tests with a stubbed XML server (Hono test route or fetch mock): LinkVc parsing incl. binary ID, capability-off skips sweep, IVVc link flips exactly matching orders, non-IVVc links ignored. Live: enable `features.invoiceReadback` on the test connection, `getRecordLinks` against a real demo WSVc/SVOVc (log link count + registers seen), run `sweepInvoiceStatus` (log flipped count ≥ 0). Gates + `pnpm test:live` + commit.

### Task 9 — Doc 24 update + final sweep

Flip WS4 in §1, add §2 bullets (push-queue tables/engine, adapter write surface, WebExcellentAPI client, `filter.` read support), record newly-verified ERP facts from Tasks 7/8, list deferred items in §4, refresh "Last updated". Full gates + `pnpm test:live` one last time. Commit + push.

## Deferred (recorded in doc 24 §4 by Task 9)
- Standalone→ERP initial-load wizard (needs standalone mode + UI; doc 21 WS4 tail).
- Customer-create push step (field-created customers, WS9 flows) — saga lane/seq design already accommodates it.
- `UserVc.Location` tier of the van-stock chain + identity-link seeding UI (WS2/WS6); `EMName` supply if live proves the ERP doesn't derive it.
- VAT-aware `Sum3`/`Sum4` (needs VAT-code data model); stock-transaction fallback tier for non-Work-Sheet-OK connections; adapter-side OK write (future per-connection option, doc 04).
- REST-only invoiced fallback tiers (agreed ERP field / heuristic, doc 04) — v1 is WebExcellentAPI-gated only.
- Bounded natural-key scans (filter reads are exact-match; fine at demo scale).
