// app/api/push/subscribe/route.ts
//
// WS1 Task 9 (push infra, docs/superpowers/sdd/task-9-brief.md): POST body
// is a PushSubscriptionJSON from the client's `PushManager.subscribe()`
// (Task 10 wires the client side). Session-gated via getVerifiedSession,
// same as app/api/settings/route.ts — this is a per-user action, unlike
// the admin-bearer-gated /api/push/test route.
//
// Upserts by `endpoint`: the Push API spec guarantees endpoint uniqueness
// per subscription, so a browser that re-subscribes (e.g. after clearing
// storage, or a key rotation) just refreshes its row instead of creating a
// duplicate.
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import * as schema from '@/drizzle/schema'

interface SubscribeBody {
  endpoint?: unknown
  keys?: { p256dh?: unknown; auth?: unknown }
}

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })

  let body: SubscribeBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }

  const { endpoint, keys } = body
  const p256dh = keys?.p256dh
  const auth = keys?.auth
  if (typeof endpoint !== 'string' || endpoint.length === 0 || typeof p256dh !== 'string' || typeof auth !== 'string') {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }

  await db
    .insert(schema.pushSubscriptions)
    .values({ userId: session.user.id, endpoint, p256dh, auth })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: { userId: session.user.id, p256dh, auth },
    })

  return Response.json({ status: 'ok' })
}
