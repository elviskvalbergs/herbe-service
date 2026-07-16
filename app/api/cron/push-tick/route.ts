// app/api/cron/push-tick/route.ts
//
// Vercel cron dispatcher for the ERP push queue (WS4 outbound slice, docs/
// superpowers/plans/2026-07-16-service-phase1-erp-outbound.md decision 11).
// Mirrors app/api/cron/sync-tick/route.ts's auth/lock/fan-out shape exactly
// — CRON_SECRET bearer check, a dedicated cron_locks key so this tick never
// overlaps itself, fan-out over every active erp_companies row with its own
// try/catch so one company's failure can't abort the rest of the tick. The
// only difference from sync-tick is which per-company function runs:
// processPushQueue drains that company's ERP push queue instead of pulling
// inbound changes.
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { acquireCronLock, releaseCronLock } from '@/lib/cronLock'
import { bearerMatches } from '@/lib/api/cronAuth'
import { buildAdapterForConnection } from '@/lib/erp/connection'
import { processPushQueue, type PushSummary } from '@/lib/sync/push/engine'
import '@/lib/erp/standard-books/adapter' // registers 'standard_books'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || !bearerMatches(request.headers.get('authorization'), secret)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const gotLock = await acquireCronLock('push-tick', 55)
  if (!gotLock) {
    return Response.json({ status: 'skipped', reason: 'lock held' })
  }

  try {
    const companies = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.active, true))
    const results: Array<{ erpCompanyId: string; summary?: PushSummary; error?: string }> = []

    for (const company of companies) {
      try {
        const adapter = await buildAdapterForConnection(db, company.id)
        const summary = await processPushQueue(db, adapter, company.id)
        results.push({ erpCompanyId: company.id, summary })
      } catch (err) {
        // A single company's failure must not abort the rest of the tick.
        results.push({ erpCompanyId: company.id, error: String(err) })
      }
    }

    return Response.json({ status: 'ok', results })
  } finally {
    await releaseCronLock('push-tick')
  }
}
