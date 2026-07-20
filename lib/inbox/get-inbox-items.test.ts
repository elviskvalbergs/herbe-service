// lib/inbox/get-inbox-items.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts) — same
// convention as lib/offline/briefcase-summary.test.ts.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { getInboxItemsForUser } from './get-inbox-items'

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

async function makeTenant(slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  return tenant.id
}

async function insertOutboxOp(
  tenantId: string,
  opts: { status: 'pending' | 'applied' | 'failed'; entity?: string; op?: string; errorMessage?: string; createdAt?: Date },
) {
  const [row] = await db
    .insert(schema.outboxOps)
    .values({
      id: crypto.randomUUID(),
      tenantId,
      entity: opts.entity ?? 'serviceOrder',
      op: opts.op ?? 'create',
      payloadJson: {},
      status: opts.status,
      errorMessage: opts.errorMessage,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning()
  return row
}

describe('getInboxItemsForUser', () => {
  it('returns an empty array for a tenant with no failed ops', async () => {
    const tenantId = await makeTenant('inbox-empty')

    const items = await getInboxItemsForUser(db, tenantId)

    expect(items).toEqual([])
  })

  it('returns only rows with status "failed", excluding pending and applied', async () => {
    const tenantId = await makeTenant('inbox-mixed-status')
    const failed = await insertOutboxOp(tenantId, { status: 'failed', errorMessage: 'ERP timeout' })
    await insertOutboxOp(tenantId, { status: 'pending' })
    await insertOutboxOp(tenantId, { status: 'applied' })

    const items = await getInboxItemsForUser(db, tenantId)

    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      id: failed.id,
      entity: failed.entity,
      op: failed.op,
      errorMessage: 'ERP timeout',
      createdAt: failed.createdAt,
    })
  })

  it('does not return another tenant\'s failed ops', async () => {
    const tenantId = await makeTenant('inbox-tenant-a')
    const otherTenantId = await makeTenant('inbox-tenant-b')
    await insertOutboxOp(otherTenantId, { status: 'failed' })

    const items = await getInboxItemsForUser(db, tenantId)

    expect(items).toEqual([])
  })

  it('sorts multiple failed ops by createdAt, most recent first', async () => {
    const tenantId = await makeTenant('inbox-sort')
    const older = await insertOutboxOp(tenantId, {
      status: 'failed',
      entity: 'serviceOrder',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    const newer = await insertOutboxOp(tenantId, {
      status: 'failed',
      entity: 'serviceOrder',
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
    })

    const items = await getInboxItemsForUser(db, tenantId)

    expect(items.map((i) => i.id)).toEqual([newer.id, older.id])
  })
})
