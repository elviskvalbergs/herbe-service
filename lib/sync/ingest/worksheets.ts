// lib/sync/ingest/worksheets.ts
//
// Cache -> domain mapping for the WSVc register (worksheet/job-card
// headers). Like service_orders, worksheets has no scalar erpRef column
// (0011_worksheets.sql) — the ERP ref lives in erp_refs (purpose 'primary',
// register 'WSVc'), so matching a re-ingested worksheet back to its row
// uses the erp_refs reverse lookup (findEntityIdByErpRef) instead of
// onConflictDoUpdate.
//
// orderId is NOT NULL on worksheets — resolved via SVONr against the
// service_order's own primary/SVOVc erp_ref. An order that hasn't ingested
// yet means this worksheet can't be linked: skip it (counted, never
// inserted with a placeholder, never thrown) so a later sync run picks it
// up once the order exists.
//
// technicianUserId is left undefined here — deferred, no EMCode -> user
// resolution exists yet (consistent with service_orders deferring siteName
// and service_items deferring modelId).
//
// Status (docs/superpowers/plans/2026-07-15-service-phase1-wsvc-worksheets.md
// decision 4): derived directly from ERP flags on both insert and update via
// deriveWorksheetStatusFromErp — worksheets are ERP-owned on this inbound
// path and there is no locally-advanced status to protect yet (unlike
// service_orders' DoneMark handling in service-orders.ts).
//
// Line rows: each header's rows[] reconciles into worksheet_rows via
// reconcileWorksheetRows (delete-and-reinsert, same idiom as
// reconcileServiceOrderRows in service-orders.ts — no per-row ERP key).
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ChangeSet } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import type { WorksheetStatus } from '@/lib/domain/types'
import { insertWorksheet, setWorksheetStatus } from '@/lib/domain/stores/worksheets'
import { findEntityIdByErpRef, putErpRef } from '@/lib/domain/stores/erp-refs'
import { parseItemTypeLabel } from '@/lib/domain/charge-type'

// Books marks a boolean flag as the string or int 1 (same idiom as
// isBooksTrue in service-orders.ts).
function isBooksTrue(value: unknown): boolean {
  return value === '1' || value === 1
}

/**
 * Maps WSVc's status flags to a WorksheetStatus, precedence highest first:
 * Invalid (rejected by ERP) > OKFlag (synced/approved) > PrelOK (done,
 * pending approval) > default Draft. Grounded by a live probe of 3 WSVc
 * records (plan decision 4). Flags arrive as string/int '1' (or 1), same as
 * DoneMark on SVOVc.
 */
export function deriveWorksheetStatusFromErp(row: {
  OKFlag?: unknown
  PrelOK?: unknown
  Invalid?: unknown
}): WorksheetStatus {
  if (isBooksTrue(row.Invalid)) return 'Rejected'
  if (isBooksTrue(row.OKFlag)) return 'Synced'
  if (isBooksTrue(row.PrelOK)) return 'Done'
  return 'Draft'
}

export interface IngestWorksheetsResult {
  ingested: number
  skipped: number
}

// worksheet_rows has no per-row ERP key, so a re-ingest can't onConflict
// against anything — delete every existing line for the worksheet and
// reinsert from the header's current rows[], same idiom as
// reconcileServiceOrderRows.
async function reconcileWorksheetRows(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
  worksheetId: string,
  headerLocation: unknown,
  lines: unknown,
): Promise<void> {
  await db.delete(schema.worksheetRows).where(eq(schema.worksheetRows.worksheetId, worksheetId))

  const rows = Array.isArray(lines) ? (lines as Record<string, unknown>[]) : []

  for (const line of rows) {
    // Best-effort FK, tolerated dangling (same idiom as reconcileServiceOrderRows's
    // SerialNr resolution): a line whose SerialNr doesn't resolve to a known
    // service_items row gets a null serviceItemId, never a throw.
    const serialNr = line.SerialNr ? String(line.SerialNr) : ''
    let serviceItemId: string | null = null
    if (serialNr) {
      const [item] = await db
        .select({ id: schema.serviceItems.id })
        .from(schema.serviceItems)
        .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.serialNr, serialNr)))
      serviceItemId = item?.id ?? null
    }

    const { charge } = parseItemTypeLabel(line.ItemType)

    await db.insert(schema.worksheetRows).values({
      worksheetId,
      serviceItemId,
      description: String(line.Spec || '') || null,
      quantity: line.Quant != null ? String(line.Quant) : null,
      unit: String(line.UsageUnit || '') || null,
      serial: serialNr || null,
      chargeType: charge,
      stockLocation: String(line.PosCode || headerLocation || '') || null,
      price: line.Price != null ? String(line.Price) : null,
      sum: line.Sum != null ? String(line.Sum) : null,
    })
  }
}

export async function ingestWorksheets(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
  changeSet: ChangeSet<Record<string, unknown>>,
): Promise<IngestWorksheetsResult> {
  const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.id, erpCompanyId))
  if (!company) {
    throw new Error(`ingestWorksheets: unknown erpCompanyId ${erpCompanyId}`)
  }

  let ingested = 0
  let skipped = 0

  for (const row of changeSet.upserts) {
    const erpRef = String(row.SerNr ?? '')
    if (!erpRef) continue // skip rows with no SerNr — nothing to key on

    // Deferred FK: resolve the owning order by its own primary/SVOVc
    // erp_ref. orderId is NOT NULL on worksheets, so an unresolved order
    // means this worksheet can't be ingested yet — skip and count it
    // rather than inserting a placeholder or throwing.
    const svoNr = String(row.SVONr ?? '')
    let orderId: string | null = null
    if (svoNr) {
      orderId = await findEntityIdByErpRef(db, {
        erpCompanyId,
        entityType: 'service_order',
        purpose: 'primary',
        recordRef: svoNr,
      })
    }
    if (!orderId) {
      skipped++
      continue
    }

    const workDescription = [row.Comment1, row.Comment2, row.Comment3, row.Comment4]
      .map((v) => (v ? String(v) : ''))
      .filter((v) => v !== '')
      .join('\n')
    const status = deriveWorksheetStatusFromErp(row)

    const existingId = await findEntityIdByErpRef(db, {
      erpCompanyId,
      entityType: 'worksheet',
      purpose: 'primary',
      recordRef: erpRef,
    })

    let worksheetId: string

    if (existingId) {
      await db
        .update(schema.worksheets)
        .set({ workDescription })
        .where(and(eq(schema.worksheets.id, existingId), eq(schema.worksheets.tenantId, company.tenantId)))

      await setWorksheetStatus(db, company.tenantId, existingId, status)
      worksheetId = existingId
    } else {
      const worksheet = await insertWorksheet(db, {
        tenantId: company.tenantId,
        erpCompanyId,
        orderId,
        technicianUserId: undefined,
        workDescription,
      })

      await setWorksheetStatus(db, company.tenantId, worksheet.id, status)

      await putErpRef(db, {
        tenantId: company.tenantId,
        entityType: 'worksheet',
        entityId: worksheet.id,
        purpose: 'primary',
        register: 'WSVc',
        recordRef: erpRef,
        erpCompanyId,
      })

      worksheetId = worksheet.id
    }

    await reconcileWorksheetRows(db, erpCompanyId, worksheetId, row.Location, row.rows)

    ingested++
  }

  return { ingested, skipped }
}
