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
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ChangeSet } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import { deriveOrderStatus } from '@/lib/domain/order-status'
import { insertServiceOrder, setOrderStatus } from '@/lib/domain/stores/service-orders'
import { findEntityIdByErpRef, putErpRef } from '@/lib/domain/stores/erp-refs'

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

export async function ingestServiceOrders(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
  changeSet: ChangeSet<Record<string, unknown>>,
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

    const existingId = await findEntityIdByErpRef(db, {
      erpCompanyId,
      entityType: 'service_order',
      purpose: 'primary',
      recordRef: erpRef,
    })

    if (existingId) {
      await db
        .update(schema.serviceOrders)
        .set({ customerId, description, contactName, requestedAt, promisedDate })
        .where(
          and(eq(schema.serviceOrders.id, existingId), eq(schema.serviceOrders.tenantId, company.tenantId)),
        )

      if (done) {
        await setOrderStatus(db, company.tenantId, existingId, 'Closed')
      }
      // else: leave status unchanged — never downgrade a locally-advanced status.
    } else {
      const order = await insertServiceOrder(db, {
        tenantId: company.tenantId,
        erpCompanyId,
        customerId,
        orderNumber: erpRef,
        description,
        contactName,
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
    }

    ingested++
  }

  return { ingested, skipped }
}
