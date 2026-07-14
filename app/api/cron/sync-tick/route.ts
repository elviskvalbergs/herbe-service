// app/api/cron/sync-tick/route.ts
//
// The single Vercel-cron dispatcher (vercel.json: every minute). Fans out
// internally to every active erp_companies row instead of registering one
// cron entry per cadence (Vercel's cron floor is 1 minute, one schedule per
// route). Phase 0 scope: the CUVc (customers) pull only — the outbox drain
// is Task 13's own fan-out branch here.
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { acquireCronLock, releaseCronLock } from '@/lib/cronLock'
import { bearerMatches } from '@/lib/api/cronAuth'
import { getAdapter } from '@herbe/erp-core'
import { ingestCustomers } from '@/lib/sync/ingest/customers'
import '@/lib/erp/standard-books/adapter' // registers 'standard_books'

const REGISTER = 'CUVc'

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
    const results: Array<{ companyId: string; status: string }> = []

    for (const company of companies) {
      try {
        const adapter = getAdapter(company.adapterType, company.adapterConfigJson)

        const [state] = await db
          .select()
          .from(schema.erpSyncState)
          .where(and(eq(schema.erpSyncState.erpCompanyId, company.id), eq(schema.erpSyncState.register, REGISTER)))

        if (!state) {
          // First tick for this company+register: discover whether it
          // supports updates_after and persist the result so later ticks
          // don't re-probe on every run (only some registers support it).
          const supportsIncremental = await adapter.probeIncrementalSupport(REGISTER)
          await db.insert(schema.erpSyncState).values({
            erpCompanyId: company.id,
            register: REGISTER,
            syncCursor: '0',
            syncStatus: supportsIncremental ? 'idle' : 'error',
            errorMessage: supportsIncremental
              ? null
              : 'updates_after not supported — needs windowed scan (Phase 1)',
          })
          if (!supportsIncremental) {
            results.push({ companyId: company.id, status: 'skipped: updates_after not supported' })
            continue
          }
        } else if (state.syncStatus === 'error') {
          // Already known not to support updates_after from a prior probe.
          results.push({ companyId: company.id, status: 'skipped: updates_after not supported' })
          continue
        }

        const cursor = state?.syncCursor ?? '0'
        const changeSet = await adapter.pullChanges(REGISTER, cursor)
        await ingestCustomers(db, company.id, changeSet)

        await db
          .insert(schema.erpSyncState)
          .values({
            erpCompanyId: company.id,
            register: REGISTER,
            syncCursor: changeSet.cursor,
            lastSyncAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [schema.erpSyncState.erpCompanyId, schema.erpSyncState.register],
            set: { syncCursor: changeSet.cursor, lastSyncAt: new Date() },
          })

        results.push({ companyId: company.id, status: 'ok' })
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
