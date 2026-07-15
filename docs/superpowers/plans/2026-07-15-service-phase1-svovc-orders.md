# herbe.service — SVOVc → service_orders ingest (WS3)

Branch: `feature/service-phase1-svovc-orders` (cut from `preview` @ 934a2f1).
Worktree: `/Users/elviskvalbergs/AI/herbe-service/.claude/worktrees/phase1-plan`.
Grounding: `hs job tmp/svovc-digest.md` (schema/store/module file:line) + live probe (real SVOVc shape).

The core register. Structurally different from SVOSerVc: **no scalar `erpRef` on `service_orders`** — the ERP ref lives in `erp_refs` (purpose `'primary'`, register `'SVOVc'`), so matching a re-ingested order needs a reverse lookup that doesn't exist yet. No-delta register (updates_after→404): consumers pass a `ChangeSet` assembled from a full/windowed pull (as `pullFullList` already does for SVOSerVc).

## Decisions (resolved up front — do not re-litigate mid-build)
1. **orderNumber** = `String(SerNr)` — the ERP order number is the recognizable app-facing number. (Column is nullable; mapper falls back to `id` when null, but we set it.)
2. **customerId is NOT NULL** — resolve by `(erpCompanyId, CustCode)` against `customers`; if it doesn't resolve, **SKIP that order and count it** (do NOT insert with a placeholder, do NOT crash the batch). Customers ingest runs first; skipped orders are picked up on a later run. `ingestServiceOrders` returns `{ ingested, skipped }`.
3. **erp_refs reverse lookup** — build `findEntityIdByErpRef(db, { erpCompanyId, entityType, purpose, recordRef }): Promise<string | null>` in `lib/domain/stores/erp-refs.ts`, plus a migration adding an index on `erp_refs (erp_company_id, entity_type, purpose, record_ref)`. This is how re-ingest matches an existing order (no scalar erpRef to onConflict against). Prerequisite, part of Task A.
4. **status** — the ingest IS the ERP sync pipeline `setErpOwnedState`'s comment says doesn't exist. On INSERT: `deriveOrderStatus({ manualState: null, erpState: DoneMark==1 ? 'Closed' : null, cancelled: false, bookingCount: 0, worksheets: [] })`. On UPDATE (existing order): if `DoneMark==1` set `status='Closed'` (ERP terminal, highest precedence); otherwise **leave status unchanged** (no manualState/booking facets are persisted to re-derive from, and the ingest must never downgrade a locally-advanced status). Never set `Invoiced` (needs an IVVc link via WebExcellentAPI — out of scope). `DoneMark` reads as string/int `1`.
5. **siteName** = `null` for now — `DelAddrVc` isn't ingested yet (defer, exactly as SVOSerVc deferred `modelId`). Do NOT do an N+1 live DelAddrVc fetch inside the loop.
6. **key-sweep for SVOVc is DEFERRED** — `keySweepReconcile` is table-`erpRef`-column based; `service_orders` has none. Order deletion detection needs an erp_refs-based sweep, a separate concern. Do NOT widen the key-sweep `Register` union for SVOVc in this slice.

## Task A — header ingest (`ingestServiceOrders`)
Prereq: the erp_refs reverse-lookup fn + index (decision 3).

`lib/sync/ingest/service-orders.ts` — `ingestServiceOrders(db, erpCompanyId, changeSet): Promise<{ ingested: number; skipped: number }>`, adapting `ingestServiceItems`:
- load erpCompanies row for tenantId.
- per header row: `erpRef = String(row.SerNr ?? '')`, skip empty.
- resolve `customerId` by `(erpCompanyId, CustCode)`; if unresolved → `skipped++`, continue.
- `findEntityIdByErpRef(...'service_order','primary', erpRef)`:
  - found → UPDATE that order's ERP-owned fields (customerId, description, contactName, requestedAt, promisedDate) + status per decision 4.
  - not found → `insertServiceOrder({ tenantId, erpCompanyId, customerId, orderNumber: erpRef, description, contactName, requestedAt, promisedDate })`, set status per decision 4 (insert path), then `putErpRef({ tenantId, entityType:'service_order', entityId: order.id, purpose:'primary', register:'SVOVc', recordRef: erpRef, erpCompanyId })`.
- field mapping: `description` = non-empty `CustComplaint1..4` joined (the customer fault report); `contactName` = `CustContact || OurContact || null`; `requestedAt` = `parseBooksDate(RegDate || TransDate)`; `promisedDate` = `parseBooksDate(PlanShipDate)`. Reuse `parseBooksDate`/`isBooksTrue` (copy the helpers as service-items.ts does, or extract to a shared `lib/sync/ingest/books.ts` — implementer's call, keep it simple).
- idempotent: re-ingesting the same SerNr updates the same order (via reverse lookup), never double-inserts.

Tests (`lib/sync/ingest/service-orders.test.ts`, DB-backed): insert-new + re-ingest-updates (no dup); DoneMark=1 → Closed on insert AND on update; DoneMark≠1 on update leaves an advanced status untouched; unresolved CustCode → skipped (counted, not inserted, no throw); erp_refs `primary` row created with register SVOVc. Plus a unit test for `findEntityIdByErpRef`. Add a fake-ERP `svovc.json` fixture (anonymized headers incl. one DoneMark=1, a CustCode matching a seeded customer, and a `rows[]` block for Task B) + register it (SVOVc already in NO_UPDATES_AFTER).
Live: extend `tests/live/erp-contract.test.ts` — seed customers first (pull CUVc → ingestCustomers), then `pullFullList('SVOVc')` → `ingestServiceOrders` → assert orders ingested > 0 and skipped count logged (counts only, no values).

## Task B — line rows (`service_order_rows`) + charge-type
Depends on Task A + a charge-type-label decision (resolve before building B):
- `service_order_rows` has no per-row ERP key → **delete-and-reinsert** the order's rows each ingest.
- resolve `serviceItemId` by `(erpCompanyId, SerialNr)` against `service_items` (best-effort null, like SVOSerVc's MotherNr).
- `symptom` = `StandProblem`/`Spec`; `workType` = `ArtCode`; `coverage` jsonb from contract fields.
- **chargeType**: line `ItemType` reads as a localized label string; `itemTypeToChargeType` takes an integer. Decision pending — likely add `parseItemTypeLabel(label)` to `charge-type.ts` mapping known en/lv string-set-31 labels → the enum, unmapped → `invoiceable` + needsReview.

## Verify (each task)
tsc clean; new tests + full suite green (PG env); `--coverage` exit 0; `test:live` green against the real ERP. Commit per task.
