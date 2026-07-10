// lib/sync/ingest/customers.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), not
// Testcontainers — see docs/superpowers/plans/2026-07-08-phase-0-foundations.md
// "Test Database Harness" section, which supersedes Testcontainers everywhere.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { ingestCustomers } from './customers'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let erpCompanyId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  erpCompanyId = company.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('ingestCustomers', () => {
  it('upserts a customer and assigns it a monotonic changeSeq', async () => {
    await ingestCustomers(db, erpCompanyId, {
      upserts: [{ Code: 'CUST001', Name: 'Test Client OÜ' }],
      deletedRefs: [],
      cursor: '1001',
    })

    const [row] = await db.select().from(schema.customers).where(eq(schema.customers.erpRef, 'CUST001'))
    expect(row.name).toBe('Test Client OÜ')
    expect(row.changeSeq).toBeGreaterThan(BigInt(0))
  })

  it('re-ingesting the same erpRef updates in place and bumps changeSeq again', async () => {
    const [before] = await db.select().from(schema.customers).where(eq(schema.customers.erpRef, 'CUST001'))

    await ingestCustomers(db, erpCompanyId, {
      upserts: [{ Code: 'CUST001', Name: 'Renamed Client OÜ' }],
      deletedRefs: [],
      cursor: '1002',
    })

    const rows = await db.select().from(schema.customers).where(eq(schema.customers.erpRef, 'CUST001'))
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Renamed Client OÜ')
    expect(rows[0].changeSeq).toBeGreaterThan(before.changeSeq)
  })

  it('throws for an unknown erpCompanyId', async () => {
    await expect(
      ingestCustomers(db, '00000000-0000-0000-0000-000000000000', {
        upserts: [{ Code: 'CUST999', Name: 'Nobody' }],
        deletedRefs: [],
        cursor: '1',
      }),
    ).rejects.toThrow(/unknown erpCompanyId/)
  })
})
