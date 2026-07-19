# 24 — Phase 1 status & parallel-session handoff

Last updated: **2026-07-16** (preview @ PR #9 sync-runner + PR #10 phase-2-recurrence; WS4 ERP outbound landed on `feature/service-phase1-erp-outbound`, pending PR into preview).
Purpose: let a fresh Claude/dev session pick up any remaining workstream without re-deriving state.
Workstream numbering follows `docs/21-phase-1-implementation-plan.md` §4.

## 1. Status by workstream

| WS | Scope | Status |
|---|---|---|
| WS1 | Platform foundations & app shell | **Done** (Phase 0: migrations runner, tenancy, changeSeq triggers, PWA shell, proxy.ts) |
| WS3 | **ERP adapter, inbound** | **Done, proven live** — see §2 |
| WS7 | Master data & service-item tree | **Done** (domain core: types, stores, charge-type, coverage; SVOSerVc tree via MotherNr) |
| WS8 | Orders/worksheets/status machine (domain) | **Done** (order+worksheet stores, `deriveOrderStatus`, worksheet transitions, 9→6 customer projection) |
| WS13 | HistoryEvent projector | **Done** (`lib/domain/history-projector.ts` + history store + /history endpoint) |
| WS14 | API shell (read) | **Done** — `/api/ext/v1` read API (service-items, orders, history; token auth + scope + rate limit) matches the frozen portal contract (`herbe-portal/lib/service/dto.ts`). Writes (POST /requests, /confirm, /feedback) NOT built (need Phase-2 entities / WS4) |
| WS2 | Auth roles, WebAuthn, seat licensing | **Not started** (next-auth session exists from Phase 0; no roles/licensing) |
| WS4 | ERP outbound (push-queue saga, approve→invoice) | **Done, proven live** (push-queue saga; SVOVc/WSVc create via saga + update mechanics; persistence verification; IVVc invoiced sweep — see §2; initial-load wizard NOT built — deferred) |
| WS5 | Bookings ↔ ActVc | **Not started** |
| WS6 | Connection config UI & sync health | **Not started** (backend state exists: `erp_sync_state` per register; no UI) |
| WS9 | Field execution UX (technician PWA) | **Not started** (offline sync-client + virtual-device simulation exist from Phase 0) |
| WS10 | Dispatch & scheduling | **Not started** |
| WS11 | Van stock, scanning, QR labels | **Not started** (`labelId` placeholder convention: `erp:<companyId>:<serial>` — see §3) |
| WS12 | Documents (report PDF/DOCX) | **Not started** |
| Phase 2 | Recurrence/SVCVc overlay | **In progress in a SEPARATE session** (docs 22/23, PR #10) — do not double-assign |

## 2. WS3 inbound — what exists and is live-proven

One `syncConnection(db, adapter, erpCompanyId)` run against the dedicated demo ERP syncs:
CUVc→customers (190), DelAddrVc→site-name map (4), SVOSerVc→service_items (55→53, dup serials collapse),
SVOVc→service_orders+service_order_rows (43+43, charge types parsed, DoneMark→Closed),
WSVc→worksheets+worksheet_rows (3+2, flags→status). All idempotent; re-runs never duplicate.

Key modules (all under the preview tip):
- `lib/security/envelope.ts` + `lib/erp/credentials.ts` — AES-256-GCM creds (`MASTER_ENCRYPTION_KEY`), portal-compatible packing; `apiCredsEncrypted` column is **text/base64** here (portal's is bytea).
- `lib/erp/connection.ts` — `buildAdapterForConnection(db, erpCompanyId)`: stored row → decrypted creds → adapter. The ONLY production path to a live adapter.
- `lib/erp/standard-books/adapter.ts` — `pullChanges` (delta), `pullFullList` (no-delta), `listLiveRefs` (`REF_FIELD` map), `probeIncrementalSupport`, `pushCreate` (SVOVc spike only).
- `lib/sync/ingest/{customers,service-items,service-orders,worksheets}.ts` + `key-sweep.ts` (Register union: CUVc|INVc|SVOSerVc, exhaustive table map).
- `lib/domain/stores/erp-refs.ts` — `putErpRef` + `findEntityIdByErpRef` (reverse lookup; migration 0016 index). Orders/worksheets have NO scalar erpRef — always match via erp_refs (purpose `primary`, register SVOVc/WSVc).
- `lib/sync/sync-connection.ts` — the orchestrator (register order = FK dependency order; per-register error isolation; `erp_sync_state` cursors: delta registers persist syncCursor, full pulls stamp lastFullSyncAt).
- `app/api/cron/sync-tick/route.ts` — cron drives it: CRON_SECRET + cron-lock + fan-out over active `erp_companies`.

ERP facts (verified live; also in memory + `docs/17/19`):
- Send `Accept: application/json` or you get XML. Rows nest under `data.<Register>` (`{data:{CUVc:[...]}, '@sequence':N}`).
- Delta (`updates_after`) works ONLY for base registers (CUVc, DelAddrVc). SVOSerVc/SVOVc/WSVc → 404: full pull + key-sweep.
- SVOSerVc identity = `SerialNr` (no SerNr). SVOVc has no OKFlag; terminal = `DoneMark`. `InvFlag/InvMark` are NOT invoiced signals (never derive Invoiced from them — needs IVVc link, deferred).
- Line `ItemType` returns localized label strings ("Invoiceable"/"Warranty"/"Goodwill") → `parseItemTypeLabel` (`lib/domain/charge-type.ts`); unmapped → invoiceable + needsReview.
- Unset numerics come back as `''` — coerce via `booksNumeric` (worksheets.ts), never bind `''` to a numeric column.
- **Writes are form-urlencoded** `set_field.<Field>=<value>` / `set_row_field.<n>.<Field>=<value>` pairs — a JSON body is silently ignored (200 OK, nothing set). Write responses are GET-enveloped: `data.<Register>: [record]`, same shape as a read. Update = `PATCH` to the record URL, not POST with `SerNr` in the body (verified live, WS4 Task 7).
- `WSVc.WONr` reads back blank (`''`) after a `-1` write, never literally `"-1"`. `MainStockBlock` is REST-readable but empty on the demo tenant — `Location` needs the `push.mainServiceLocation` fallback in practice, not just in theory.
- `WebExcellentAPI` `getrecordlinks` true wire format (verified against HAL source via halocron, not just the portal client): `action=action&register=getrecordlinks&id=<sernr>&regname=<register>&compno=<n>` → repeated `<LinkVc><VcName>/<ID>` blocks; `ID` is sometimes a raw LE-uint32 binary value, not a decimal string.
- Ingest stores item code as `attributes.itemCode` (camelCase) — a `.ItemCode` casing mismatch silently nulled every `ArtCode` on push until WS4 Task 7 caught it live.
- One demo customer's `Objects` field trips an unrelated ERP business rule on SVOVc create ("Kods nav reģistrēts" / error 1071) — a demo-data quirk, not a code bug; route around it when picking a live-test customer.

## 2b. WS4 outbound — what exists and is live-proven

`enqueueOrderCreatePush` + `processPushQueue` against the demo ERP creates a real SVOVc (non-empty `SerNr`, read-back verified via `filter.SerNr`, marker-tagged `CustComplaint1`); `pushUpdate` round-trips `CustComplaint2` (PATCH-by-URL); `approveWorksheet` + the saga creates a real WSVc (`SVONr` link, worksheet → `Synced`). A live `DoneMark=1` SVOVc is rejected before any write, and natural-key re-adoption after local `erp_ref` loss produces no duplicate. All proven live, WS4 Task 7/8.

Key modules (all on `feature/service-phase1-erp-outbound`):
- Migration `0017` (`erp_push_groups`/`erp_push_steps`) — the push-queue tables, independent of `outbox_ops` (client-op journal).
- `lib/sync/push/{store,engine,gather,builders,enqueue}.ts` — lane-FIFO saga (`processPushQueue`); per-step idempotency ref → natural-key → create; `2^attempts` backoff to DLQ; `approveWorksheet` is the approval entry point (`Done→Approved` + `UserVc`-link guard, atomic status+enqueue in one tx).
- Adapter write surface (`lib/erp/standard-books/adapter.ts`): `pushCreate` (SVOVc/WSVc), `pushUpdate` (PATCH-by-URL, read-back-verified via `filter.SerNr` against the real ERP's unknown-SerNr silent no-op), `fetchRecords` (`filter.` reads), `getRecordLinks`.
- `lib/erp/standard-books/excellent-api.ts` — the WebExcellentAPI `getrecordlinks` client.
- Routes: `app/api/cron/push-tick/route.ts` (cron in `vercel.json`), `app/api/admin/push-retry/route.ts` (DLQ re-entry), `app/api/sync/outbox/route.ts` (now saga-only — the push queue is the only ERP writer).
- `adapterConfigJson` conventions: `push.{mainServiceLocation,laborItemCode,distanceItemCode,fallbackItemCode,timezone}`, `features.invoiceReadback`.
- `erp_refs` purpose `'invoice'` + `entityType 'user'`/register `'UserVc'` as the technician link convention.
- `packages/fake-erp` now speaks the real write wire contract (form-urlencoded body, PATCH route, enveloped write responses) — a faithful contract test, not just internally consistent with itself.

## 3. Conventions a new session must follow

- **TDD + subagent-per-task**; plans live in `docs/superpowers/plans/*.md` (one per slice — read the relevant one before extending its area).
- Tests: `TEST_DATABASE_URL=postgres://<user>@localhost:5432/postgres` (Postgres 14 via Homebrew), `pnpm exec vitest run`; coverage gate 90% on `lib/erp/**`, `lib/sync/**`, `packages/erp-core/**`. `pnpm exec tsc --noEmit` must stay clean.
- **Live contract suite**: `tests/live/erp-contract.test.ts`, gated on `RUN_LIVE_ERP_TESTS`, run via `pnpm test:live`. Needs a worktree-local `.env.vars` (git-ignored) with `ERP_DEMO_BASE_URL/COMPANY/USER/PASSWORD` + `RUN_LIVE_ERP_TESTS=1` (names in `.env.test.example`; values in the repo root `.env.local`). **Any new ERP-touching feature must extend this suite** — it has caught 3 real bugs unit tests missed (XML, envelope shape, `''` numerics). Log counts only, never row values.
- Migrations: `scripts/migrations/NNNN_*.sql` (next free number; idempotent; filename-sorted; NO _journal.json in this repo).
- Deferred-not-broken pattern: unresolvable FK → null + pick up next run (modelId, technicianUserId, siteName) — or skip+count when the column is NOT NULL (order customerId, worksheet orderId).
- `labelId` on ERP-ingested service_items: `erp:<erpCompanyId>:<serialNr>`, insert-only, pending the real QR-label design (WS11 owns replacing this).
- Admin/ops secrets: `ADMIN_MIGRATIONS_SECRET` (shared admin bearer), `CRON_SECRET`, `MASTER_ENCRYPTION_KEY` — per environment.
- Deploys: push to `preview` = herbe.service production deploy (service-test.herbe.app). Work on feature branches, PR into preview; never push main.

## 4. Ready-to-assign parallel jobs (conflict map)

Independent of each other (safe to run as parallel sessions):
1. **WS12 Documents** — worksheet/order report PDF+DOCX engine (portal's `/orders/{id}/report` expects it). Touches new `lib/documents/**` + a route; no overlap with sync code.
2. **WS2 Auth roles + seat licensing (+WebAuthn)** — touches `lib/auth`, users table, middleware. No overlap with WS3/WS12.
3. **WS6 Connection config + sync health UI** — admin UI over existing `erp_companies` + `erp_sync_state` + creds encrypt (write side of `encryptErpCredentials`). Reads WS3 but doesn't change it.
4. **WS10 Dispatch board** (office UI over orders/worksheets/bookings-stub) — UI-heavy, minimal domain writes.
5. ~~WS4 ERP outbound~~ — **done, see §2b**; no longer open. WS9 can now build directly on `approveWorksheet` (the approval entry point) and the saga-backed `/api/sync/outbox` route.
6. **WS9 Field PWA** — biggest; builds on offline sync-client + worksheets domain. WS4 now landed (produces the writes WS4 pushes) but can still start UI-first.

Deferred/blocked bits to fold into whichever session touches the area: SVOVc/WSVc deletion detection (needs an erp_refs-based key-sweep variant), windowed-scan date bounds for full pulls (fine at demo scale), UserVc→technician identity links (WS2/WS9), DelAddrVc siteName re-check on real tenant data (0/43 overlap on demo); from WS4: standalone→ERP initial-load wizard (needs standalone mode + UI, neither exists), customer-create push step (field-created customers are WS9 scope; ERP-ingested customers always carry an erp_ref), `UserVc.Location` van-stock tier + identity-link seeding UI (WS2/WS6 own identity links and connection config; push.mainServiceLocation covers v1), VAT-aware `Sum3`/`Sum4` (no VAT-code data model yet; ERP recalculates on the manager's OK), stock-transaction fallback tier (only for connections bypassing Work Sheet OK — none exist yet), adapter-side OK write (doc 04 decision: manager OKs in the ERP in v1), REST-only invoiced fallback tiers (v1 WebExcellentAPI-gated; no REST-only tenant exists), update-op domain flows (nothing enqueues updates yet; engine dead-letters them), per-candidate isolation in `sweepInvoiceStatus` (one transient failure stalls a tick, self-heals next tick; fine at demo scale, revisit at volume), `outbox_ops` failed-row reconciliation after DLQ heal (pre-existing Phase-0 scope note, unchanged by WS4).

Each new session should read: this doc → `docs/21-phase-1-implementation-plan.md` (its WS section) → the relevant `docs/superpowers/plans/*.md` → then plan its own slice the same way (plan doc → subagent tasks → live proof where ERP-touching).
