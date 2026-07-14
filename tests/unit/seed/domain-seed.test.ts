// tests/unit/seed/domain-seed.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), same
// bootstrap as tests/unit/domain/orders-worksheets-store.test.ts /
// lib/sync/ingest/customers.test.ts. DB-backed — see the environment note
// in the task brief: no local Postgres, so this only runs in CI.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { seedBaseline } from '@/lib/seed'

const REQUIRED_ORDER_STATUSES = [
  'New',
  'Planned',
  'In progress',
  'Work done',
  'Confirmed',
  'Invoiced',
  'Cancelled',
] as const

describe('seedDomain (exercised via seedBaseline)', () => {
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeAll(async () => {
    testDb = await createTestDatabase()
    await runMigrations(testDb.url)
    sql = postgres(testDb.url)
    db = drizzle(sql, { schema })
    await seedBaseline(db)
  }, 60_000)

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
  })

  it('seeds a system node with a unit child and a lot child', async () => {
    const items = await db.select().from(schema.serviceItems)
    const systems = items.filter((i) => i.kind === 'system')
    expect(systems.length).toBeGreaterThanOrEqual(1)

    for (const system of systems) {
      const children = items.filter((i) => i.parentId === system.id)
      expect(children.some((c) => c.kind === 'unit')).toBe(true)
      expect(children.some((c) => c.kind === 'lot')).toBe(true)
    }
  })

  it('seeds a service order in every required status', async () => {
    const orders = await db.select().from(schema.serviceOrders)
    const statuses = new Set(orders.map((o) => o.status))

    for (const status of REQUIRED_ORDER_STATUSES) {
      expect(statuses.has(status)).toBe(true)
    }
  })

  it('seeds a signed worksheet, a Rejected worksheet, and a crew job', async () => {
    const worksheets = await db.select().from(schema.worksheets)

    const signed = worksheets.filter((w) => w.signedOnSite && w.signatureLockedAt !== null)
    expect(signed.length).toBeGreaterThanOrEqual(1)

    const rejected = worksheets.filter((w) => w.status === 'Rejected')
    expect(rejected.length).toBeGreaterThanOrEqual(1)

    const crewCounts = new Map<string, number>()
    for (const w of worksheets) {
      if (!w.crewGroupId) continue
      crewCounts.set(w.crewGroupId, (crewCounts.get(w.crewGroupId) ?? 0) + 1)
    }
    expect([...crewCounts.values()].some((count) => count >= 2)).toBe(true)
  })

  it('is deterministic: re-seeding a fresh DB reproduces identical business-key data', async () => {
    const testDb2 = await createTestDatabase()
    const sql2 = postgres(testDb2.url)
    try {
      await runMigrations(testDb2.url)
      const db2 = drizzle(sql2, { schema })
      await seedBaseline(db2)

      // Ids from the store-backed inserts (service items/orders/worksheets)
      // are server-random on each run — same as every other test of these
      // stores, which always captures the returned `.id` rather than
      // asserting a fixed value. What seedDomain fixes directly — labelId,
      // orderNumber, crewGroupId, and the customer row's own id — must
      // match byte-for-byte across a fresh re-seed.
      const labels1 = (await db.select().from(schema.serviceItems)).map((i) => i.labelId).sort()
      const labels2 = (await db2.select().from(schema.serviceItems)).map((i) => i.labelId).sort()
      expect(labels2).toEqual(labels1)

      const orderNumbers1 = (await db.select().from(schema.serviceOrders)).map((o) => o.orderNumber).sort()
      const orderNumbers2 = (await db2.select().from(schema.serviceOrders)).map((o) => o.orderNumber).sort()
      expect(orderNumbers2).toEqual(orderNumbers1)

      const customerIds1 = (await db.select().from(schema.customers)).map((c) => c.id).sort()
      const customerIds2 = (await db2.select().from(schema.customers)).map((c) => c.id).sort()
      expect(customerIds2).toEqual(customerIds1)

      const crewGroups1 = (await db.select().from(schema.worksheets))
        .map((w) => w.crewGroupId)
        .filter((id): id is string => id !== null)
        .sort()
      const crewGroups2 = (await db2.select().from(schema.worksheets))
        .map((w) => w.crewGroupId)
        .filter((id): id is string => id !== null)
        .sort()
      expect(crewGroups2).toEqual(crewGroups1)

      const tenantIds1 = (await db.select().from(schema.tenants)).map((t) => t.id).sort()
      const tenantIds2 = (await db2.select().from(schema.tenants)).map((t) => t.id).sort()
      expect(tenantIds2).toEqual(tenantIds1)

      const technicianIds1 = (await db.select().from(schema.users)).map((u) => u.id).sort()
      const technicianIds2 = (await db2.select().from(schema.users)).map((u) => u.id).sort()
      expect(technicianIds2).toEqual(technicianIds1)
    } finally {
      await sql2.end({ timeout: 5 })
      await testDb2.cleanup()
    }
  }, 60_000)
})
