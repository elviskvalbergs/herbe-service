# herbe.service — WSVc → worksheets ingest (WS3)

Branch: `feature/service-phase1-wsvc-worksheets` (cut from `preview` @ df787c7).
Worktree: `/Users/elviskvalbergs/AI/herbe-service/.claude/worktrees/phase1-plan`.

The last transactional register. Reuses two pieces already built: `findEntityIdByErpRef` (erp-refs store) and `parseItemTypeLabel` (charge-type). Like orders, worksheets have **no scalar erpRef** — refs live in `erp_refs` (purpose `'primary'`, register `'WSVc'`, entityType `'worksheet'`). No-delta register (updates_after→404).

## Target (verified)
- `worksheets` (schema ~231): `orderId` NOT NULL→serviceOrders, `technicianUserId` nullable→users, `status` (WorksheetStatus, default 'Draft'), `workDescription`, `fault`, `cause`, `remedy`, `signedOnSite`, `revision`, changeSeq/updatedAt/deletedAt. Partial-unique index on (order × technician) via migration.
- `worksheet_rows` (schema ~270): `worksheetId` NOT NULL, `serviceItemId` nullable→serviceItems, `description`, `quantity` numeric, `unit`, `serial`, `chargeType` default 'invoiceable', `stockLocation`, `price` numeric, `sum` numeric. No per-row ERP key (children ride the parent).
- `WorksheetStatus` = Draft|Assigned|Accepted|In progress|Paused|Done|Approved|Synced|Rejected. `worksheet-status.ts` is a transition VALIDATOR, not an ERP-flag deriver — the ingest maps flags→status directly.
- Store `lib/domain/stores/worksheets.ts`: `insertWorksheet({tenantId, orderId, technicianUserId?, ...})`, `setWorksheetStatus`, `getWorksheetsForOrder`.

## Real WSVc shape (probed live, 3 records)
Header keys incl.: `SerNr, WONr, EMCode, EMName, CustCode, SVONr, OKFlag, PrelOK, Invalid, InvFlag, Location, Comment1-4, Spec`. Flags are string `"0"`/`"1"` (like DoneMark). All 3 records have `SVONr` + `EMCode`; one has `OKFlag="1"`.
Line keys (`rows[]`): `ArtCode, Quant, Price, Sum, SerialNr, ItemType, Spec, PosCode, MotherNr, Recepy, UsageUnit`.

## Decisions (FINAL)
1. **erpRef match**: `erpRef = String(SerNr)`. Match existing worksheet via `findEntityIdByErpRef({ erpCompanyId, entityType:'worksheet', purpose:'primary', recordRef: erpRef })`; on insert, `putErpRef({ entityType:'worksheet', purpose:'primary', register:'WSVc', recordRef: erpRef, ... })`.
2. **orderId** (NOT NULL) via `SVONr`: `findEntityIdByErpRef({ erpCompanyId, entityType:'service_order', purpose:'primary', recordRef: String(SVONr) })`. If unresolved → **skip the worksheet + count** (orders must ingest first; picked up next run). Return `{ ingested, skipped }`.
3. **technicianUserId = null** — defer. No UserVc/identity-link ingest exists; `EMCode`→user resolution is a future task. (Consistent with orders deferring siteName, service-items deferring modelId.)
4. **status from flags** (grounded by probe): `Invalid==1 → 'Rejected'`; else `OKFlag==1 → 'Synced'`; else `PrelOK==1 → 'Done'`; else `'Draft'`. Helper `deriveWorksheetStatusFromErp({ OKFlag, PrelOK, Invalid })` (flags read as string/int 1). Set via `setWorksheetStatus` after insert; on update apply the same mapping (worksheets are ERP-owned on the inbound path — unlike orders there's no local manual status to protect yet, so recompute is fine).
5. **fields**: `workDescription` = non-empty `Comment1..4` joined '\n'; `fault`/`cause`/`remedy` = null (WSVc header has no clean equivalents). `signedOnSite`=false, `revision`=0 defaults.
6. **worksheet_rows**: delete-and-reinsert per worksheet (no per-row key). Per line: `serviceItemId` best-effort by `(erpCompanyId, serialNr=SerialNr)`; `description`=Spec; `quantity`=String(Quant); `unit`=String(UsageUnit)||null; `serial`=SerialNr; `chargeType`=`parseItemTypeLabel(ItemType).charge`; `stockLocation`=String(PosCode||header Location)||null; `price`=String(Price); `sum`=String(Sum). (numeric columns take strings in drizzle.)
7. **key-sweep for WSVc DEFERRED** (no scalar erpRef; needs erp_refs-based sweep — separate concern). Do NOT widen the key-sweep Register union.

## Task (single implementer)
`lib/sync/ingest/worksheets.ts` — `ingestWorksheets(db, erpCompanyId, changeSet): Promise<{ ingested, skipped }>`, mirroring `ingestServiceOrders`'s structure (erp_refs match, insert-or-update, line delete-reinsert). Add `deriveWorksheetStatusFromErp` (co-located or in worksheet-status.ts). Add fake-ERP `wsvc.json` fixture (anonymized: incl. one OKFlag="1"→Synced, SVONr referencing a svovc.json order's SerNr, a line with a SerialNr matching svoservc.json, one line ItemType "Warranty"). Register in fake-erp FIXTURES (WSVc already in NO_UPDATES_AFTER).

Tests (DB-backed): insert-new creates worksheet + erp_refs worksheet/primary/WSVc row + orderId resolved from SVONr; unresolved SVONr → skipped (counted, not inserted, no throw); status per flags (OKFlag=1→Synced, all-0→Draft, Invalid=1→Rejected, PrelOK=1→Done); worksheet_rows created with chargeType/serviceItemId resolution; re-ingest replaces rows + is idempotent (no dup worksheet via erp_refs match). Unit test `deriveWorksheetStatusFromErp`.

## Verify: tsc clean; full suite + `--coverage` exit 0 (90% gates). Then a SEPARATE live-proof step extends `tests/live/erp-contract.test.ts` (seed customers→units→orders→worksheets, assert worksheets + worksheet_rows ingested, log counts) and runs `pnpm test:live`.
