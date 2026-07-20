// app/api/push/test/route.ts
//
// POST /api/push/test — manually verifies the push plumbing end to end
// (Task 9 brief). Ops-utility route, not a user-facing feature: an
// operator/ops-script hits this directly, so it follows the same
// admin-bearer-secret convention as app/api/admin/run-migrations/route.ts
// and app/api/admin/ext-tokens/route.ts — ADMIN_MIGRATIONS_SECRET compared
// via lib/api/cronAuth.ts's constant-time bearerMatches, not a session-based
// role check. Reuses ADMIN_MIGRATIONS_SECRET (the repo's single
// admin-operations bearer secret) so no separate secret is provisioned.
import { db } from '@/lib/db'
import { bearerMatches } from '@/lib/api/cronAuth'
import { sendPushToUser } from '@/lib/push/send'

function authorized(request: Request): boolean {
  const secret = process.env.ADMIN_MIGRATIONS_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization')
  return bearerMatches(header, secret)
}

interface TestPushBody {
  userId?: unknown
  payload?: unknown
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: TestPushBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }

  const { userId, payload } = body
  if (typeof userId !== 'string' || userId.length === 0) {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }

  try {
    const result = await sendPushToUser(db, userId, payload ?? { title: 'herbe.service test push' })
    return Response.json({ status: 'ok', ...result })
  } catch (err) {
    return Response.json({ status: 'error', message: String(err) }, { status: 500 })
  }
}
