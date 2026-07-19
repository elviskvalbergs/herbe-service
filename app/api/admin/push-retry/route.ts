// app/api/admin/push-retry/route.ts
//
// POST /api/admin/push-retry — the DLQ re-entry point for the ERP push queue
// (WS4 outbound slice, docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
// decision 11): resets one 'dead' erp_push_steps row (+ its group) back to
// pending/attempts=0 via lib/sync/push/store.ts's resetDeadStep, so the next
// push-tick cron resumes it instead of it sitting dead forever.
//
// Mirrors app/api/admin/run-migrations/route.ts and app/api/admin/ext-tokens/
// route.ts's bearer-secret convention exactly: ADMIN_MIGRATIONS_SECRET (the
// repo's single admin-operations secret), constant-time compare via
// bearerMatches, and fail-closed 401 when the secret is unset (never treat a
// missing secret as "no auth required"). Error bodies are static strings —
// never String(err) — so this route can't leak internals to whoever holds
// the admin secret's caller-facing response.
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { bearerMatches } from '@/lib/api/cronAuth'
import { resetDeadStep } from '@/lib/sync/push/store'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function authorized(request: Request): boolean {
  const secret = process.env.ADMIN_MIGRATIONS_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization')
  return bearerMatches(header, secret)
}

interface PushRetryRequestBody {
  stepId?: unknown
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: PushRetryRequestBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON body' }, { status: 400 })
  }

  const { stepId } = body
  if (typeof stepId !== 'string' || !UUID_RE.test(stepId)) {
    return Response.json({ status: 'error', message: 'stepId (uuid) is required' }, { status: 400 })
  }

  const [step] = await db.select().from(schema.erpPushSteps).where(eq(schema.erpPushSteps.id, stepId))
  if (!step) {
    return Response.json({ status: 'error', message: 'step not found' }, { status: 404 })
  }
  if (step.status !== 'dead') {
    return Response.json({ status: 'error', message: 'step is not dead' }, { status: 409 })
  }

  await resetDeadStep(db, stepId)

  return Response.json({ status: 'reset', stepId })
}
