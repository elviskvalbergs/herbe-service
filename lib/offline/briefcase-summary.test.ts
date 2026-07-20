// lib/offline/briefcase-summary.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), same
// convention as lib/settings/user-prefs.test.ts and
// lib/sync/scope-membership.test.ts (whose enterScope/exitScope helpers this
// file reuses to seed realistic scope_membership rows rather than
// hand-crafting the trigger-managed membershipSeq column).
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { enterScope, exitScope } from '@/lib/sync/scope-membership'
import { getBriefcaseSummary } from './briefcase-summary'

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

async function makeTenantAndUser(slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email: `${slug}@herbe-service.test` }).returning()
  return { tenantId: tenant.id, userId: user.id }
}

async function insertOutboxOp(tenantId: string, status: 'pending' | 'applied' | 'failed') {
  await db.insert(schema.outboxOps).values({
    id: crypto.randomUUID(),
    tenantId,
    entity: 'serviceOrder',
    op: 'create',
    payloadJson: {},
    status,
  })
}

describe('getBriefcaseSummary', () => {
  it('returns zero counts for a fresh user/tenant with no rows', async () => {
    const { tenantId, userId } = await makeTenantAndUser('briefcase-empty')

    const buckets = await getBriefcaseSummary(db, { userId, tenantId })

    expect(buckets).toEqual([
      { label: 'Assigned to you', count: 0 },
      { label: 'Pending sync', count: 0 },
    ])
  })

  it('counts only non-purged scope_membership rows for the given user', async () => {
    const { tenantId, userId } = await makeTenantAndUser('briefcase-scope')
    const { userId: otherUserId } = await makeTenantAndUser('briefcase-scope-other')

    await enterScope(db, { userId, entityType: 'note', entityId: 'n1' })
    await enterScope(db, { userId, entityType: 'note', entityId: 'n2' })
    await enterScope(db, { userId, entityType: 'note', entityId: 'n3' })
    await exitScope(db, { userId, entityType: 'note', entityId: 'n3' }) // purged — must not count

    await enterScope(db, { userId: otherUserId, entityType: 'note', entityId: 'n4' }) // another user's row — must not count

    const buckets = await getBriefcaseSummary(db, { userId, tenantId })

    expect(buckets.find((b) => b.label === 'Assigned to you')?.count).toBe(2)
  })

  it('counts only pending outbox_ops rows for the given tenant', async () => {
    const { tenantId, userId } = await makeTenantAndUser('briefcase-outbox')
    const { tenantId: otherTenantId } = await makeTenantAndUser('briefcase-outbox-other')

    await insertOutboxOp(tenantId, 'pending')
    await insertOutboxOp(tenantId, 'pending')
    await insertOutboxOp(tenantId, 'applied') // must not count
    await insertOutboxOp(tenantId, 'failed') // must not count

    await insertOutboxOp(otherTenantId, 'pending') // another tenant's op — must not count

    const buckets = await getBriefcaseSummary(db, { userId, tenantId })

    expect(buckets.find((b) => b.label === 'Pending sync')?.count).toBe(2)
  })
})
