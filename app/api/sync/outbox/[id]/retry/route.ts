// app/api/sync/outbox/[id]/retry/route.ts
//
// Task 8 (conflict inbox retry). The original POST /api/sync/outbox's
// idempotency check short-circuits ANY pre-existing row — applied OR
// failed — as `already_applied` without re-pushing (confirmed by reading
// that route directly; see its header comment). So retrying a failed op
// needs a distinct mechanism: reset the row to 'pending' and re-invoke the
// same push logic (lib/sync/outbox-push.ts's attemptOutboxPush, shared with
// the original route rather than duplicated).
//
// Tenant-scoping follows the same rule as the original route (Task 16b):
// tenantId comes only from the session. An op id belonging to another
// tenant (or not existing at all) is answered as a flat 404 — this route
// resolves an id from the URL path to an existing resource, so the
// ordinary "don't confirm another tenant's resource exists" 404 applies
// (unlike the original route's 409, which is about denying reuse of a
// client-supplied id for a NEW write — a different situation).
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { attemptOutboxPush } from '@/lib/sync/outbox-push'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import '@/lib/erp/standard-books/adapter' // registers 'standard_books'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getVerifiedSession(db)
  const tenantId = session?.user?.tenantId
  if (!tenantId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params

  const [existing] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, id))
  if (!existing || existing.tenantId !== tenantId) {
    return new Response('Not Found', { status: 404 })
  }

  if (existing.status !== 'failed') {
    return Response.json(
      { status: 'invalid_state', error: `op is '${existing.status}', only a 'failed' op can be retried` },
      { status: 409 },
    )
  }

  await db.update(schema.outboxOps).set({ status: 'pending', errorMessage: null }).where(eq(schema.outboxOps.id, id))

  const result = await attemptOutboxPush(db, tenantId, id, existing.payloadJson)
  if (result.status === 'applied') {
    return Response.json(result)
  }
  return Response.json(result, { status: 502 })
}
