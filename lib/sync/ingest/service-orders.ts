// lib/sync/ingest/service-orders.ts
//
// Cache -> domain mapping for the SVOVc register (service order headers).
// Structurally different from ingestServiceItems: service_orders has no
// scalar erpRef column (0010_service_orders.sql) — the ERP ref lives in
// erp_refs (purpose 'primary', register 'SVOVc'), so matching a re-ingested
// order back to its row uses the erp_refs reverse lookup
// (findEntityIdByErpRef) instead of onConflictDoUpdate.
//
// customerId is NOT NULL on service_orders — an order whose CustCode
// doesn't resolve to a known customer is skipped (counted, never inserted
// with a placeholder, never thrown; customers ingest runs first and a
// skipped order is picked up on a later run).
//
// Status (docs/superpowers/plans/2026-07-15-service-phase1-svovc-orders.md
// decision 4): on INSERT it's derived via deriveOrderStatus. On UPDATE,
// DoneMark=1 forces 'Closed' (ERP-terminal, highest precedence) and
// otherwise the existing status is left untouched — this ingest has none of
// the manualState/booking/worksheet facets needed to re-derive from, and
// must never downgrade a locally-advanced status.
//
// Line rows (Task B): each header's rows[] reconciles into service_order_rows
// via reconcileServiceOrderRows (delete-and-reinsert — see that function's
// comment for why). Line ItemType is parsed by parseItemTypeLabel
// (lib/domain/charge-type.ts), which reads the English label string this
// tenant returns rather than the raw string-set-31 integer.
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ChangeSet } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import { deriveOrderStatus } from '@/lib/domain/order-status'
import { insertServiceOrder, setOrderStatus } from '@/lib/domain/stores/service-orders'
import { findEntityIdByErpRef, putErpRef } from '@/lib/domain/stores/erp-refs'
import { parseItemTypeLabel } from '@/lib/domain/charge-type'

// Standard Books returns dates as ISO-ish 'YYYY-MM-DD' strings; empty/blank
// means "no date". Best-effort: null on anything unparseable, don't over-parse.
function parseBooksDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  return Number.isNaN(d.getTime()) ? null : d
}

// Books marks a boolean flag as the string or int 1.
function isBooksTrue(value: unknown): boolean {
  return value === '1' || value === 1
}

export interface IngestServiceOrdersResult {
  ingested: number
  skipped: number
}

export interface IngestServiceOrdersOpts {
  siteNameByDelCode?: Map<string, string>
}

// DelAddrVc is a code->name lookup, not an entity (no sites table) — build a
// transient DelCode->Name map from a DelAddrVc pull for ingestServiceOrders
// to resolve SVOVc.DelAddrCode against. Rows missing either DelCode or Name
// are skipped; there's nothing usable to key or display.
export function buildDelAddrSiteMap(rows: Record<string, unknown>[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of rows) {
    if (typeof row.DelCode !== 'string' || !row.DelCode) continue
    if (typeof row.Name !== 'string' || !row.Name) continue
    map.set(String(row.DelCode), String(row.Name))
  }
  return map
}

// service_order_rows has no per-row ERP key (no SerNr-equivalent identity on
// a line), so a re-ingest can't onConflict against anything — delete every
// existing line for the order and reinsert from the header's current
// rows[], making the reconciliation idempotent by replacement rather than
// by matching. A header with no rows[] (or an empty one) leaves the order
// with zero line rows after the delete.
async function reconcileServiceOrderRows(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
  orderId: string,
  lines: unknown,
): Promise<void> {
  await db.delete(schema.serviceOrderRows).where(eq(schema.serviceOrderRows.orderId, orderId))

  const rows = Array.isArray(lines) ? (lines as Record<string, unknown>[]) : []

  for (const line of rows) {
    // Best-effort FK, tolerated dangling (same idiom as SVOSerVc's MotherNr
    // resolution in service-items.ts): a line whose SerialNr doesn't resolve
    // to a known service_items row gets a null serviceItemId, never a throw.
    const serialNr = line.SerialNr ? String(line.SerialNr) : ''
    let serviceItemId: string | null = null
    if (serialNr) {
      const [item] = await db
        .select({ id: schema.serviceItems.id })
        .from(schema.serviceItems)
        .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.serialNr, serialNr)))
      serviceItemId = item?.id ?? null
    }

    const { charge, needsReview } = parseItemTypeLabel(line.ItemType)
    const symptom = String(line.StandProblem || line.Spec || '') || null
    const workType = String(line.ArtCode || '') || null

    // Only include keys that have a value — chargeTypeReviewNeeded is the
    // one exception, recorded whenever the charge-type parse needed review
    // (never written when false, since "no flag" already reads as "fine").
    const coverage: Record<string, unknown> = {}
    if (line.ContractNr) coverage.contractNr = line.ContractNr
    if (line.DiagnosticCode) coverage.diagnosticCode = line.DiagnosticCode
    if (needsReview) coverage.chargeTypeReviewNeeded = true

    await db.insert(schema.serviceOrderRows).values({
      orderId,
      serviceItemId,
      coverage,
      symptom,
      workType,
      chargeType: charge,
    })
  }
}

export async function ingestServiceOrders(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
  changeSet: ChangeSet<Record<string, unknown>>,
  opts?: IngestServiceOrdersOpts,
): Promise<IngestServiceOrdersResult> {
  const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.id, erpCompanyId))
  if (!company) {
    throw new Error(`ingestServiceOrders: unknown erpCompanyId ${erpCompanyId}`)
  }

  let ingested = 0
  let skipped = 0

  for (const row of changeSet.upserts) {
    const erpRef = String(row.SerNr ?? '')
    if (!erpRef) continue // skip rows with no SerNr — nothing to key on

    // Deferred FK: resolve the owning customer by (erpCompanyId, CustCode).
    // customerId is NOT NULL on service_orders, so an unresolved customer
    // means this order can't be ingested yet — skip and count it rather
    // than inserting a placeholder or throwing.
    const custCode = row.CustCode ? String(row.CustCode) : ''
    let customerId: string | null = null
    if (custCode) {
      const [customer] = await db
        .select({ id: schema.customers.id })
        .from(schema.customers)
        .where(and(eq(schema.customers.erpCompanyId, erpCompanyId), eq(schema.customers.erpRef, custCode)))
      customerId = customer?.id ?? null
    }
    if (!customerId) {
      skipped++
      continue
    }

    const description = [row.CustComplaint1, row.CustComplaint2, row.CustComplaint3, row.CustComplaint4]
      .map((v) => (v ? String(v) : ''))
      .filter((v) => v !== '')
      .join('\n')
    const contactName = String(row.CustContact || row.OurContact || '') || undefined
    const requestedAt = parseBooksDate(row.RegDate || row.TransDate)
    const promisedDate = parseBooksDate(row.PlanShipDate)
    const done = isBooksTrue(row.DoneMark)
    const siteName = opts?.siteNameByDelCode?.get(String(row.DelAddrCode ?? '')) ?? null

    const existingId = await findEntityIdByErpRef(db, {
      erpCompanyId,
      entityType: 'service_order',
      purpose: 'primary',
      recordRef: erpRef,
    })

    let orderId: string

    if (existingId) {
      await db
        .update(schema.serviceOrders)
        .set({ customerId, description, contactName, requestedAt, promisedDate, siteName })
        .where(
          and(eq(schema.serviceOrders.id, existingId), eq(schema.serviceOrders.tenantId, company.tenantId)),
        )

      if (done) {
        await setOrderStatus(db, company.tenantId, existingId, 'Closed')
      }
      // else: leave status unchanged — never downgrade a locally-advanced status.
      orderId = existingId
    } else {
      const order = await insertServiceOrder(db, {
        tenantId: company.tenantId,
        erpCompanyId,
        customerId,
        orderNumber: erpRef,
        description,
        contactName,
        siteName: siteName ?? undefined,
        requestedAt: requestedAt ?? undefined,
        promisedDate: promisedDate ?? undefined,
      })

      const derived = deriveOrderStatus({
        manualState: null,
        erpState: done ? 'Closed' : null,
        cancelled: false,
        bookingCount: 0,
        worksheets: [],
      })
      await setOrderStatus(db, company.tenantId, order.id, derived)

      await putErpRef(db, {
        tenantId: company.tenantId,
        entityType: 'service_order',
        entityId: order.id,
        purpose: 'primary',
        register: 'SVOVc',
        recordRef: erpRef,
        erpCompanyId,
      })

      orderId = order.id
    }

    await reconcileServiceOrderRows(db, erpCompanyId, orderId, row.rows)

    ingested++
  }

  return { ingested, skipped }
}
