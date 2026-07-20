// lib/sync/outbox-push.ts
//
// Shared "attempt the ERP push for one outbox_ops row and record the
// resulting status" logic — extracted from app/api/sync/outbox/route.ts's
// try/catch so Task 8's retry route
// (app/api/sync/outbox/[id]/retry/route.ts) attempts the exact same push
// instead of duplicating it. Phase 0 scope unchanged from the original
// route: hardcodes the single-company-per-tenant lookup and the one entity
// type (SVOVc create via pushServiceOrderCreate) — not broadened here.
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import { getAdapter } from '@herbe/erp-core'
import { pushServiceOrderCreate, type ServiceOrderCreatePayload } from '@/lib/erp/standard-books/push-service-order'

type Db = PostgresJsDatabase<typeof schema>

export type OutboxPushResult = { status: 'applied'; erpRef: string } | { status: 'failed'; error: string }

// Caller must have already ensured the row exists (inserted, or reset to
// 'pending') before calling — this only performs the push and writes back
// the applied/failed outcome onto that row.
export async function attemptOutboxPush(
  db: Db,
  tenantId: string,
  opId: string,
  payload: unknown,
): Promise<OutboxPushResult> {
  try {
    // Phase 0 spike: hardcode the single-company lookup for the tenant —
    // Phase 1's push-queue-per-order generalizes this to N companies and N
    // entity types.
    const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.tenantId, tenantId))
    const adapter = getAdapter(company.adapterType, company.adapterConfigJson)

    const { erpRef } = await pushServiceOrderCreate(adapter, payload as ServiceOrderCreatePayload)

    await db
      .update(schema.outboxOps)
      .set({ status: 'applied', erpRef, appliedAt: new Date() })
      .where(eq(schema.outboxOps.id, opId))

    return { status: 'applied', erpRef }
  } catch (err) {
    await db
      .update(schema.outboxOps)
      .set({ status: 'failed', errorMessage: String(err) })
      .where(eq(schema.outboxOps.id, opId))

    return { status: 'failed', error: String(err) }
  }
}
