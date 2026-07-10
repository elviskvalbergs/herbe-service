// __tests__/db/tenancy.test.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle>

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

describe('tenancy schema', () => {
  it('scopes an erp_companies row to a tenant', async () => {
    const [tenant] = await db.insert(schema.tenants).values({ slug: 'acme', name: 'Acme FS' }).returning()

    const [company] = await db
      .insert(schema.erpCompanies)
      .values({
        tenantId: tenant.id,
        displayName: 'Acme main company',
        adapterType: 'standard_books',
        adapterConfigJson: {},
      })
      .returning()

    expect(company.tenantId).toBe(tenant.id)
  })

  it('rejects an erp_sync_state row for an unknown company (FK enforced)', async () => {
    await expect(
      db.insert(schema.erpSyncState).values({
        erpCompanyId: '00000000-0000-0000-0000-000000000000',
        register: 'CUVc',
        syncCursor: '0',
      }),
    ).rejects.toThrow()
  })
})
