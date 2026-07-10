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
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { getAdapter } from '@herbe/erp-core'
import { pushServiceOrderCreate } from '@/lib/erp/standard-books/push-service-order'
import { auth } from '@/lib/auth'
import '@/lib/erp/standard-books/adapter' // registers 'standard_books'

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const body = await request.json()

  const [existing] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, body.id))
  if (existing) {
    return Response.json({ status: 'already_applied', erpRef: existing.erpRef })
  }

  await db.insert(schema.outboxOps).values({
    id: body.id,
    tenantId: body.tenantId,
    entity: body.entity,
    op: body.op,
    payloadJson: body.payload,
  })

  try {
    // Phase 0 spike: hardcode the single-company lookup for the tenant —
    // Phase 1's push-queue-per-order generalizes this to N companies and N
    // entity types.
    const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.tenantId, body.tenantId))
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
