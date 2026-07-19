import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ErpAdapter } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

function isBooksTrue(value: unknown): boolean {
  return value === 1 || value === '1' || value === true
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed ? trimmed : null
}

export interface MatchSummary {
  linked: number
  alreadyLinked: number
  noMatch: number
}

// Matches unlinked users (by tenant) against the ERP's UserVc register by
// email, and inserts an identity_links row (provider 'erp') for each match.
// Never logs email/PII — only the returned counts are meant to be logged by
// callers (docs/24 §3 "log counts only, never row values").
export async function matchUsersByEmail(
  db: Db,
  opts: { tenantId: string; erpCompanyId: string; adapter: ErpAdapter },
): Promise<MatchSummary> {
  const rows = await opts.adapter.pullFullList('UserVc')

  const emailToCode = new Map<string, string>()
  for (const row of rows) {
    if (isBooksTrue((row as Record<string, unknown>).Closed)) continue
    if (isBooksTrue((row as Record<string, unknown>).TerminatedFlag)) continue
    const code = (row as Record<string, unknown>).Code
    if (typeof code !== 'string' || !code) continue
    const email =
      normalizeEmail((row as Record<string, unknown>).LoginEmailAddr) ??
      normalizeEmail((row as Record<string, unknown>).emailAddr)
    if (!email) continue
    emailToCode.set(email, code)
  }

  const existingLinks = await db
    .select({ userId: schema.identityLinks.userId, externalId: schema.identityLinks.externalId })
    .from(schema.identityLinks)
    .where(and(eq(schema.identityLinks.erpCompanyId, opts.erpCompanyId), eq(schema.identityLinks.provider, 'erp')))

  const alreadyLinkedUserIds = new Set(existingLinks.map((l) => l.userId))
  const usedCodes = new Set(existingLinks.map((l) => l.externalId))

  const tenantUsers = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.tenantId, opts.tenantId))
  const unlinkedUsers = tenantUsers.filter((u) => !alreadyLinkedUserIds.has(u.id))

  let linked = 0
  let noMatch = 0
  for (const user of unlinkedUsers) {
    const email = normalizeEmail(user.email)
    const code = email ? emailToCode.get(email) : undefined
    if (!code || usedCodes.has(code)) {
      noMatch++
      continue
    }
    await db.insert(schema.identityLinks).values({
      tenantId: opts.tenantId,
      userId: user.id,
      provider: 'erp',
      erpCompanyId: opts.erpCompanyId,
      externalId: code,
      linkedBy: 'auto-match:email',
    })
    usedCodes.add(code)
    linked++
  }

  return { linked, alreadyLinked: alreadyLinkedUserIds.size, noMatch }
}
