// app/api/sync/outbox/route.ts
//
// Task 13: the one Phase-0 outbound round-trip. Idempotent by the client-
// generated `id` (drizzle/schema.ts outboxOps) — a retried POST for an id
// that already has a row is answered from that row without re-pushing to the
// ERP, so a double-tap or a retried network call can never create a
// duplicate Service Order.
//
// Phase 0 simplification: any pre-existing row (applied OR failed) short-
// circuits as "already_applied" — this POST never re-attempts a *failed* op.
// Task 8 adds a dedicated retry path for that
// (app/api/sync/outbox/[id]/retry/route.ts), sharing this route's push logic
// via lib/sync/outbox-push.ts rather than reusing this idempotency check.
//
// Task 16b: tenantId is taken ONLY from the authenticated session
// (session.user.tenantId), never from the request body — two reviews
// flagged that trusting a client-supplied tenantId let any authenticated
// user write into another tenant (IDOR). A session with no tenantId claim
// is rejected rather than falling through to an unscoped query.
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { attemptOutboxPush } from '@/lib/sync/outbox-push'
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

  const result = await attemptOutboxPush(db, tenantId, body.id, body.payload)
  if (result.status === 'applied') {
    return Response.json(result)
  }
  return Response.json(result, { status: 502 })
}
