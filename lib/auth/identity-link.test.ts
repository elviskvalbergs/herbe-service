import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { matchUsersByEmail } from './identity-link'
import type { ErpAdapter } from '@herbe/erp-core'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

function fakeAdapter(rows: Record<string, unknown>[]): ErpAdapter {
  return {
    capabilities: () => ({
      supportsIncrementalSync: true,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullFullList: async () => rows,
    pullChanges: async () => ({ upserts: [], deletedRefs: [], cursor: '0' }),
    listLiveRefs: async () => [],
    pushCreate: async () => ({ erpRef: '' }),
    probeIncrementalSupport: async () => false,
  }
}

async function makeTenantAndCompany() {
  const [tenant] = await db.insert(schema.tenants).values({ slug: `il-${Date.now()}-${Math.random()}`, name: 'x' }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: 'x', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  return { tenantId: tenant.id, erpCompanyId: company.id }
}

describe('matchUsersByEmail', () => {
  it('links a user whose email matches a UserVc row, case-insensitively', async () => {
    const { tenantId, erpCompanyId } = await makeTenantAndCompany()
    await db.insert(schema.users).values({ tenantId, email: 'Tech.One@Example.test' })
    const adapter = fakeAdapter([{ Code: 'EMP001', emailAddr: 'tech.one@example.test', Closed: 0, TerminatedFlag: 0 }])

    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId, adapter })

    expect(result).toEqual({ linked: 1, alreadyLinked: 0, noMatch: 0 })
    const links = await db.select().from(schema.identityLinks).where(eq(schema.identityLinks.tenantId, tenantId))
    expect(links).toHaveLength(1)
    expect(links[0].externalId).toBe('EMP001')
    expect(links[0].provider).toBe('erp')
  })

  it('does not re-link an already-linked user and reports it separately', async () => {
    const { tenantId, erpCompanyId } = await makeTenantAndCompany()
    const [user] = await db.insert(schema.users).values({ tenantId, email: 'tech.two@example.test' }).returning()
    await db.insert(schema.identityLinks).values({ tenantId, userId: user.id, provider: 'erp', erpCompanyId, externalId: 'EMP002', linkedBy: 'auto-match:email' })
    const adapter = fakeAdapter([{ Code: 'EMP002', emailAddr: 'tech.two@example.test', Closed: 0, TerminatedFlag: 0 }])

    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId, adapter })
    expect(result).toEqual({ linked: 0, alreadyLinked: 1, noMatch: 0 })
  })

  it('does not match a closed/terminated UserVc row', async () => {
    const { tenantId, erpCompanyId } = await makeTenantAndCompany()
    await db.insert(schema.users).values({ tenantId, email: 'former@example.test' })
    const adapter = fakeAdapter([{ Code: 'EMP003', emailAddr: 'former@example.test', Closed: 1, TerminatedFlag: 1 }])

    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId, adapter })
    expect(result).toEqual({ linked: 0, alreadyLinked: 0, noMatch: 1 })
  })

  it('reports no-match for a user with no corresponding UserVc email', async () => {
    const { tenantId, erpCompanyId } = await makeTenantAndCompany()
    await db.insert(schema.users).values({ tenantId, email: 'nobody@example.test' })
    const adapter = fakeAdapter([{ Code: 'EMP001', emailAddr: 'tech.one@example.test', Closed: 0, TerminatedFlag: 0 }])

    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId, adapter })
    expect(result).toEqual({ linked: 0, alreadyLinked: 0, noMatch: 1 })
  })

  it('links only one user when two different emails map to the same ERP code (within-run dedup)', async () => {
    const { tenantId, erpCompanyId } = await makeTenantAndCompany()
    await db.insert(schema.users).values([
      { tenantId, email: 'user-a@example.test' },
      { tenantId, email: 'user-b@example.test' },
    ])
    // Two UserVc rows with the SAME Code but different emails — causes both users to map to 'EMP001'
    const adapter = fakeAdapter([
      { Code: 'EMP001', emailAddr: 'user-a@example.test', Closed: 0, TerminatedFlag: 0 },
      { Code: 'EMP001', emailAddr: 'user-b@example.test', Closed: 0, TerminatedFlag: 0 },
    ])

    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId, adapter })

    // Exactly one linked, one no-match; no double-link
    expect(result.linked).toBe(1)
    expect(result.noMatch).toBe(1)
    expect(result.alreadyLinked).toBe(0)

    // Only one identity link row exists, and it references 'EMP001'
    const links = await db.select().from(schema.identityLinks).where(eq(schema.identityLinks.tenantId, tenantId))
    expect(links).toHaveLength(1)
    expect(links[0].externalId).toBe('EMP001')
  })
})
