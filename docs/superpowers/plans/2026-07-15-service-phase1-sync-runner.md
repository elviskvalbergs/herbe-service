# herbe.service — Sync orchestrator + DelAddrVc siteName (WS3/WS4-inbound)

Branch: `feature/service-phase1-sync-runner` (cut from the WSVc branch tip — has all 4 ingests).
Worktree: `/Users/elviskvalbergs/AI/herbe-service/.claude/worktrees/phase1-plan`.

Turns the proven per-register ingests into an actual scheduled per-connection sync, and folds in `DelAddrVc` as the order site-name resolver. Ends the inbound path.

## Existing infra (verified — extend, don't reinvent)
- `erp_sync_state` (schema ~26): PK `(erpCompanyId, register)`, `syncCursor` default '0', `lastSyncAt`, `lastFullSyncAt`, `syncStatus` (idle/running/error), `errorMessage`.
- `app/api/cron/sync-tick/route.ts` — Vercel cron (every minute), CRON_SECRET-gated, `acquireCronLock('sync-tick')`, fans out over active `erp_companies`. **Currently CUVc-only and uses `getAdapter(adapterType, adapterConfigJson)` — no decrypted creds.** The orchestrator replaces that inline logic and switches to `buildAdapterForConnection` (decrypts `apiCredsEncrypted`).
- Ingests: `ingestCustomers`, `ingestServiceItems`, `ingestServiceOrders`, `ingestWorksheets`. Adapter: `pullChanges(register, cursor)` (delta), `pullFullList(register)` (no-delta), `listLiveRefs(register)`, `probeIncrementalSupport`. `keySweepReconcile(db, adapter, companyId, register)`.

## Register facts (probed live)
- Delta-capable (updates_after=200): **CUVc**, **DelAddrVc**.
- No-delta (updates_after=404, full pull each run): **SVOSerVc**, **SVOVc**, **WSVc**.
- Key-swept (deletion detection via listLiveRefs): **CUVc→customers**, **SVOSerVc→service_items**. (INVc/items has no ingest; SVOVc/WSVc have no scalar erpRef → key-sweep deferred.)

## Decisions (FINAL)
1. **DelAddrVc is a lookup, not an entity** (docs define no sites table). `buildDelAddrSiteMap(rows): Map<string,string>` (DelCode→Name) from a DelAddrVc pull. No table, no store, no migration.
2. **`ingestServiceOrders` gains an optional 3rd arg** `opts?: { siteNameByDelCode?: Map<string,string> }`. It reads `row.DelAddrCode` and sets `siteName = opts?.siteNameByDelCode?.get(String(row.DelAddrCode)) ?? null`. **Backward compatible** — no opts → siteName stays null, all existing tests/callers unaffected.
3. **`syncConnection(db, adapter, erpCompanyId): Promise<SyncSummary>`** (`lib/sync/sync-connection.ts`) — the orchestrator. Dependency order (later registers resolve FKs against earlier ones):
   - CUVc → `ingestCustomers` (delta: pullChanges(cursor), advance cursor) → key-sweep customers.
   - DelAddrVc → `buildDelAddrSiteMap` (delta pull; transient, not persisted).
   - SVOSerVc → `ingestServiceItems` (full: pullFullList) → key-sweep service_items.
   - SVOVc → `ingestServiceOrders(..., { siteNameByDelCode })` (full).
   - WSVc → `ingestWorksheets` (full).
   Per register, wrapped in try/catch: set sync_state syncStatus 'running' → on success upsert `{ syncCursor (delta only), lastSyncAt, lastFullSyncAt (full pulls), syncStatus:'idle', errorMessage:null }`; on failure record `{ syncStatus:'error', errorMessage }` and CONTINUE (one register's failure never aborts the rest). Return `SyncSummary { perRegister: Record<register, { ingested?, skipped?, tombstoned?, error? }> }`.
   Cursor model: delta registers persist + reuse `syncCursor`; no-delta registers ignore cursor (always full pull) but still stamp `lastSyncAt`/`lastFullSyncAt`.
4. **`sync-tick` route**: for each active company, `buildAdapterForConnection(db, company.id)` then `await syncConnection(db, adapter, company.id)`; a company whose creds are missing/undecryptable throws → caught per-company, recorded, tick continues. Keep CRON_SECRET auth + cron-lock + fan-out. Drop the CUVc-only inline block.
5. **Adapter registration**: keep the `import '@/lib/erp/standard-books/adapter'` side-effect; but since `buildAdapterForConnection` already imports it, ensure the registry has standard_books.

## Task A — DelAddrVc siteName resolution in ingestServiceOrders
- `buildDelAddrSiteMap(rows: Record<string,unknown>[]): Map<string,string>` (skip rows with empty DelCode/Name) — put in `lib/sync/ingest/service-orders.ts` or a small helper module.
- Extend `ingestServiceOrders` with the optional opts param (decision 2). Read `row.DelAddrCode`.
- Tests: with a site map, an order's siteName is set from its DelAddrCode; without opts, siteName stays null (existing behavior); unknown DelAddrCode → null. `buildDelAddrSiteMap` unit test.
- Verify tsc + full suite + coverage. Commit.

## Task B — syncConnection orchestrator + sync-tick refactor + live proof
- `lib/sync/sync-connection.ts` `syncConnection` per decision 3. Reuse existing ingests + keySweepReconcile + listLiveRefs.
- Refactor `app/api/cron/sync-tick/route.ts` per decision 4.
- Tests (DB-backed): a full `syncConnection` against the **fake-ERP** adapter ingests all registers, populates siteName on an order whose DelAddrCode matches a DelAddr fixture, records sync_state per register (idle + lastSyncAt), and a per-register failure is isolated (mock one ingest to throw → its state=error, others still idle). Route test: 401 without CRON_SECRET; with it, fans out (can mock syncConnection or use fake-ERP company).
- **Live proof**: extend `tests/live/erp-contract.test.ts` — build the adapter, call `syncConnection(db, adapter, companyId)` against the REAL ERP, assert every register's summary has no error + customers/service_items/orders/worksheets counts > 0, assert at least one order has a non-null siteName (DelAddrVc resolved), assert sync_state rows exist with syncStatus 'idle'. Counts/shape only. Run `pnpm test:live`.
- Verify tsc + full suite + coverage + live. Commit.

## Deferred (note, don't build): windowed-scan date filtering for the no-delta registers (full pull is correct-but-unbounded; fine at demo scale), SVOVc/WSVc key-sweep (needs erp_refs-based sweep), UserVc/technician identity links, IVVc invoice-status readback.
