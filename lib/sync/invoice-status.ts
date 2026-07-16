// lib/sync/invoice-status.ts
//
// WS4 outbound slice, Decision 10 (docs/superpowers/plans/2026-07-16-service-
// phase1-erp-outbound.md): the invoiced-status readback sweep. For every
// order that has a primary SVOVc erp_ref and isn't already in one of the
// three ERP-terminal-for-this-purpose statuses, ask the ERP (via
// WebExcellentAPI getrecordlinks — Decision 9) whether an IVVc (invoice)
// record now links back to it; if one does, the order flips to 'Invoiced'
// the same way ingestServiceOrders (lib/sync/ingest/service-orders.ts)
// flips DoneMark orders to 'Closed' — a direct setOrderStatus call,
// bypassing the manual-transition rules in domain/order-status.ts, because
// this is an ERP-owned state arriving through sync, not a user action.
//
// Excluding Invoiced/Closed/Cancelled orders from the candidate query (rather
// than checking status again per-row) is also what keeps this idempotent and
// keeps the "Closed outranks Invoiced" precedence from docs/02-data-model.md:
// a Closed order is simply never a candidate here.
import { and, eq, isNull, notInArray } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ErpAdapter } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import { setOrderStatus } from '@/lib/domain/stores/service-orders'
import { putErpRef } from '@/lib/domain/stores/erp-refs'

export interface SweepInvoiceStatusResult {
  checked: number
  invoiced: number
}

export async function sweepInvoiceStatus(
  db: PostgresJsDatabase<typeof schema>,
  adapter: ErpAdapter,
  erpCompanyId: string,
): Promise<SweepInvoiceStatusResult> {
  const candidates = await db
    .select({
      orderId: schema.serviceOrders.id,
      tenantId: schema.serviceOrders.tenantId,
      recordRef: schema.erpRefs.recordRef,
    })
    .from(schema.serviceOrders)
    .innerJoin(
      schema.erpRefs,
      and(
        eq(schema.erpRefs.entityType, 'service_order'),
        eq(schema.erpRefs.entityId, schema.serviceOrders.id),
        eq(schema.erpRefs.purpose, 'primary'),
        eq(schema.erpRefs.register, 'SVOVc'),
      ),
    )
    .where(
      and(
        eq(schema.serviceOrders.erpCompanyId, erpCompanyId),
        isNull(schema.serviceOrders.deletedAt),
        notInArray(schema.serviceOrders.status, ['Invoiced', 'Closed', 'Cancelled']),
      ),
    )

  let invoiced = 0

  for (const candidate of candidates) {
    const links = await adapter.getRecordLinks('SVOVc', candidate.recordRef)
    const invoiceLink = links.find((link) => link.register === 'IVVc')
    if (!invoiceLink) continue

    await setOrderStatus(db, candidate.tenantId, candidate.orderId, 'Invoiced')
    await putErpRef(db, {
      tenantId: candidate.tenantId,
      entityType: 'service_order',
      entityId: candidate.orderId,
      purpose: 'invoice',
      register: 'IVVc',
      recordRef: invoiceLink.id,
      erpCompanyId,
    })
    invoiced++
  }

  return { checked: candidates.length, invoiced }
}
