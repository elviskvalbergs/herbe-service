// app/api/cron/documents-tick/route.ts
//
// Vercel cron dispatcher for the WS12 document render queue (docs/superpowers/
// plans/2026-07-20-service-phase1-ws12-documents.md decision 8). Mirrors
// app/api/cron/push-tick/route.ts's auth/lock shape exactly — CRON_SECRET
// bearer check, a dedicated cron_locks key so this tick never overlaps itself.
// Simpler than push-tick: NO ERP, no per-company fan-out. processRenderJobs
// claims due jobs GLOBALLY and isolates each job in its own try/catch, so
// there is nothing to fan out over here.
import { db } from '@/lib/db'
import { acquireCronLock, releaseCronLock } from '@/lib/cronLock'
import { bearerMatches } from '@/lib/api/cronAuth'
import { processRenderJobs } from '@/lib/documents/render/engine'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || !bearerMatches(request.headers.get('authorization'), secret)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const gotLock = await acquireCronLock('documents-tick', 55)
  if (!gotLock) {
    return Response.json({ status: 'skipped', reason: 'lock held' })
  }

  try {
    const summary = await processRenderJobs(db, { now: new Date() })
    return Response.json({ status: 'ok', summary })
  } finally {
    await releaseCronLock('documents-tick')
  }
}
