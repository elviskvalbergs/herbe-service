// lib/seed/scenarios/baseline.test.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql as sqlOp } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { seedBaseline } from './baseline'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('baseline seed scenario', () => {
  it('creates 2 tenants (each with one erp_company) and is byte-identical across two runs', async () => {
    await seedBaseline(db)
    const firstTenants = await db.select().from(schema.tenants)
    const firstCompanies = await db.select().from(schema.erpCompanies)

    await db.execute(sqlOp`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`)
    await seedBaseline(db)
    const secondTenants = await db.select().from(schema.tenants)
    const secondCompanies = await db.select().from(schema.erpCompanies)

    expect(firstTenants).toEqual(secondTenants)
    expect(firstTenants.length).toBe(2)

    expect(firstCompanies).toEqual(secondCompanies)
    expect(firstCompanies.length).toBe(2)
  })
})
