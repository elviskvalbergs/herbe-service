// app/api/cron/identity-rematch/route.ts
//
// Daily re-match: for every active erp_companies row, links any still-
// unlinked users by email against that connection's UserVc register
// (lib/auth/identity-link.ts). Mirrors app/api/cron/sync-tick/route.ts's
// per-company error isolation — one company's ERP being unreachable must
// not block the others.
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { acquireCronLock, releaseCronLock } from '@/lib/cronLock'
import { bearerMatches } from '@/lib/api/cronAuth'
import { buildAdapterForConnection } from '@/lib/erp/connection'
import { matchUsersByEmail } from '@/lib/auth/identity-link'
import '@/lib/erp/standard-books/adapter'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || !bearerMatches(request.headers.get('authorization'), secret)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const gotLock = await acquireCronLock('identity-rematch', 300)
  if (!gotLock) {
    return Response.json({ status: 'skipped', reason: 'lock held' })
  }

  try {
    const companies = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.active, true))
    const results: Array<{ companyId: string; status: string; summary?: Awaited<ReturnType<typeof matchUsersByEmail>> }> = []

    for (const company of companies) {
      try {
        const adapter = await buildAdapterForConnection(db, company.id)
        const summary = await matchUsersByEmail(db, { tenantId: company.tenantId, erpCompanyId: company.id, adapter })
        results.push({ companyId: company.id, status: 'ok', summary })
      } catch (err) {
        results.push({ companyId: company.id, status: `error: ${String(err)}` })
      }
    }

    return Response.json({ status: 'ok', results })
  } finally {
    await releaseCronLock('identity-rematch')
  }
}
