// app/api/push/unsubscribe/route.ts
//
// WS1 Task 9 (push infra, docs/superpowers/sdd/task-9-brief.md): removes
// the caller's own subscription by endpoint. Session-gated via
// getVerifiedSession, same as subscribe. Deletes are scoped to
// endpoint + userId together — never just endpoint — so a caller can never
// remove another user's subscription by supplying/guessing an endpoint
// value it doesn't own.
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import * as schema from '@/drizzle/schema'

interface UnsubscribeBody {
  endpoint?: unknown
}

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })

  let body: UnsubscribeBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }

  const { endpoint } = body
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }

  await db
    .delete(schema.pushSubscriptions)
    .where(and(eq(schema.pushSubscriptions.endpoint, endpoint), eq(schema.pushSubscriptions.userId, session.user.id)))

  return Response.json({ status: 'ok' })
}
