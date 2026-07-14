// tests/unit/api/ext/tokens-store.test.ts
//
// Task 4 (docs/superpowers/sdd/task-4-brief.md): DB-backed tests for
// lib/api/ext/tokens-store.ts, against a real local Postgres (same
// bootstrap as tests/unit/domain/customer-scoped-reads.test.ts).
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { hashToken } from '@/lib/security/tokens'
import { findExtTokenByHash, mintExtToken, revokeExtToken, touchExtToken } from '@/lib/api/ext/tokens-store'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'ext-tokens-t1', name: 'Ext Tokens T1' }).returning()
  tenantId = tenant.id

  const [erpCompany] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'Ext Tokens Co', adapterType: 'standard_books' })
    .returning()
  erpCompanyId = erpCompany.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('mintExtToken', () => {
  it('returns a raw token and persists only its hash', async () => {
    const { id, raw } = await mintExtToken(db, { tenantId, erpCompanyId, name: 'Mint Test Token' })
    expect(typeof raw).toBe('string')
    expect(raw.length).toBeGreaterThan(0)

    const found = await findExtTokenByHash(db, hashToken(raw))
    expect(found).not.toBeNull()
    expect(found?.id).toBe(id)
    expect(found?.tokenHash).not.toBe(raw)
    expect(found?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('defaults customerCodes to []', async () => {
    const { raw } = await mintExtToken(db, { tenantId, erpCompanyId, name: 'No Codes Token' })
    const found = await findExtTokenByHash(db, hashToken(raw))
    expect(found?.customerCodes).toEqual([])
  })

  it('persists provided customerCodes', async () => {
    const { raw } = await mintExtToken(db, {
      tenantId,
      erpCompanyId,
      name: 'Scoped Token',
      customerCodes: ['CUST-A', 'CUST-B'],
    })
    const found = await findExtTokenByHash(db, hashToken(raw))
    expect(found?.customerCodes).toEqual(['CUST-A', 'CUST-B'])
  })
})

describe('findExtTokenByHash', () => {
  it('returns null for an unknown hash', async () => {
    const found = await findExtTokenByHash(db, 'a'.repeat(64))
    expect(found).toBeNull()
  })
})

describe('touchExtToken', () => {
  it('sets lastUsedAt', async () => {
    const { id, raw } = await mintExtToken(db, { tenantId, erpCompanyId, name: 'Touch Token' })
    const before = await findExtTokenByHash(db, hashToken(raw))
    expect(before?.lastUsedAt).toBeNull()

    await touchExtToken(db, id)

    const after = await findExtTokenByHash(db, hashToken(raw))
    expect(after?.lastUsedAt).not.toBeNull()
  })
})

describe('revokeExtToken', () => {
  it('sets revokedAt', async () => {
    const { id, raw } = await mintExtToken(db, { tenantId, erpCompanyId, name: 'Revoke Token' })
    const before = await findExtTokenByHash(db, hashToken(raw))
    expect(before?.revokedAt).toBeNull()

    await revokeExtToken(db, id)

    const after = await findExtTokenByHash(db, hashToken(raw))
    expect(after?.revokedAt).not.toBeNull()
  })
})
