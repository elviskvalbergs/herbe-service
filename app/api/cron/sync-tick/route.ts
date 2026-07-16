// app/api/cron/sync-tick/route.ts
//
// The single Vercel-cron dispatcher (vercel.json: every minute). Fans out
// internally to every active erp_companies row instead of registering one
// cron entry per cadence (Vercel's cron floor is 1 minute, one schedule per
// route). Each company's full register sync is driven by syncConnection —
// see lib/sync/sync-connection.ts for the per-register sequence and
// sync_state bookkeeping. buildAdapterForConnection turns the stored,
// encrypted creds on the erp_companies row into a live adapter.
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { acquireCronLock, releaseCronLock } from '@/lib/cronLock'
import { bearerMatches } from '@/lib/api/cronAuth'
import { buildAdapterForConnection } from '@/lib/erp/connection'
import { syncConnection, type SyncSummary } from '@/lib/sync/sync-connection'
import '@/lib/erp/standard-books/adapter' // registers 'standard_books'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || !bearerMatches(request.headers.get('authorization'), secret)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const gotLock = await acquireCronLock('sync-tick', 55)
  if (!gotLock) {
    return Response.json({ status: 'skipped', reason: 'lock held' })
  }

  try {
    const companies = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.active, true))
    const results: Array<{ companyId: string; status: string; summary?: SyncSummary }> = []

    for (const company of companies) {
      try {
        const adapter = await buildAdapterForConnection(db, company.id)
        const summary = await syncConnection(db, adapter, company.id)
        results.push({ companyId: company.id, status: 'ok', summary })
      } catch (err) {
        // A single company's failure must not abort the rest of the tick.
        results.push({ companyId: company.id, status: `error: ${String(err)}` })
      }
    }

    return Response.json({ status: 'ok', results })
  } finally {
    await releaseCronLock('sync-tick')
  }
}
