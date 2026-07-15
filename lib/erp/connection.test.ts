// lib/erp/connection.test.ts
//
// DB-backed: seeds a tenant + erp_companies row with real encrypted creds and
// asserts buildAdapterForConnection turns it into a live ErpAdapter. Uses the
// local-Postgres test harness (lib/test-support/db.ts), not Testcontainers —
// see docs/superpowers/plans/2026-07-08-phase-0-foundations.md.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { encryptErpCredentials } from './credentials'
import { buildAdapterForConnection } from './connection'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  process.env.MASTER_ENCRYPTION_KEY = 'test-only-throwaway-key-not-a-real-secret-value'

  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('buildAdapterForConnection', () => {
  it('turns a stored erp_companies row into a live standard_books adapter', async () => {
    const [tenant] = await db.insert(schema.tenants).values({ slug: 'conn-t1', name: 'Conn T1' }).returning()
    const [company] = await db
      .insert(schema.erpCompanies)
      .values({
        tenantId: tenant.id,
        displayName: 'Conn C1',
        adapterType: 'standard_books',
        adapterConfigJson: { baseUrl: 'http://x', companyNumber: '1' },
        apiCredsEncrypted: encryptErpCredentials({ username: 'u', password: 'p' }).toString('base64'),
      })
      .returning()

    const adapter = await buildAdapterForConnection(db, company.id)

    expect(adapter.capabilities()).toEqual({
      supportsIncrementalSync: true,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    })
  })

  it('throws for an unknown erp company id', async () => {
    await expect(buildAdapterForConnection(db, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /unknown erp company/,
    )
  })
})
