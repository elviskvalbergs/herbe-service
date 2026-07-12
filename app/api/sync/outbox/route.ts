// app/api/sync/outbox/route.ts
//
// Task 13: the one Phase-0 outbound round-trip. Idempotent by the client-
// generated `id` (drizzle/schema.ts outboxOps) — a retried POST for an id
// that already has a row is answered from that row without re-pushing to the
// ERP, so a double-tap or a retried network call can never create a
// duplicate Service Order.
//
// Phase 0 simplification: any pre-existing row (applied OR failed) short-
// circuits as "already_applied" — retrying a *failed* op is Task 13's out-
// of-scope push-queue-per-order / DLQ work (Phase 1, 04-erp-sync.md).
//
// Task 16b: tenantId is taken ONLY from the authenticated session
// (session.user.tenantId), never from the request body — two reviews
// flagged that trusting a client-supplied tenantId let any authenticated
// user write into another tenant (IDOR). A session with no tenantId claim
// is rejected rather than falling through to an unscoped query.
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { getAdapter } from '@herbe/erp-core'
import { pushServiceOrderCreate } from '@/lib/erp/standard-books/push-service-order'
import { auth } from '@/lib/auth'
import '@/lib/erp/standard-books/adapter' // registers 'standard_books'

export async function POST(request: Request) {
  const session = await auth()
  const tenantId = session?.user?.tenantId
  if (!tenantId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const body = await request.json()

  const [existing] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, body.id))
  if (existing) {
    // The id PK is global, not scoped to tenant — a foreign op id must never
    // confirm existence or leak another tenant's erpRef back to the caller.
    if (existing.tenantId !== tenantId) {
      return new Response('Conflict', { status: 409 })
    }
    return Response.json({ status: 'already_applied', erpRef: existing.erpRef })
  }

  await db.insert(schema.outboxOps).values({
    id: body.id,
    tenantId,
    entity: body.entity,
    op: body.op,
    payloadJson: body.payload,
  })

  try {
    // Phase 0 spike: hardcode the single-company lookup for the tenant —
    // Phase 1's push-queue-per-order generalizes this to N companies and N
    // entity types.
    const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.tenantId, tenantId))
    const adapter = getAdapter(company.adapterType, company.adapterConfigJson)

    const { erpRef } = await pushServiceOrderCreate(adapter, body.payload)

    await db
      .update(schema.outboxOps)
      .set({ status: 'applied', erpRef, appliedAt: new Date() })
      .where(eq(schema.outboxOps.id, body.id))

    return Response.json({ status: 'applied', erpRef })
  } catch (err) {
    await db
      .update(schema.outboxOps)
      .set({ status: 'failed', errorMessage: String(err) })
      .where(eq(schema.outboxOps.id, body.id))

    return Response.json({ status: 'failed', error: String(err) }, { status: 502 })
  }
}
