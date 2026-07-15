// tests/unit/api/admin/ext-tokens-route.test.ts
//
// Task 10: DB-backed tests for POST /api/admin/ext-tokens, against a real
// local Postgres (same bootstrap as tests/unit/api/ext/tokens-store.test.ts).
// `@/app/api/admin/ext-tokens/route` transitively imports `@/lib/db`, which
// reads DATABASE_URL at module-load time, so DATABASE_URL must point at the
// harness DB *before* the route module is first dynamically imported (same
// constraint documented in tests/unit/api/ext/service-items-routes.test.ts).
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { hashToken } from '@/lib/security/tokens'
import { findExtTokenByHash } from '@/lib/api/ext/tokens-store'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/ext-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'ext-tokens-admin-t1', name: 'Ext Tokens Admin T1' }).returning()
  tenantId = tenant.id

  const [erpCompany] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'Ext Tokens Admin Co', adapterType: 'standard_books' })
    .returning()
  erpCompanyId = erpCompany.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('POST /api/admin/ext-tokens', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 401 (plain text) when the bearer header is missing', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/ext-tokens/route')

    const res = await POST(makeRequest({ erpCompanyId, name: 'Token' }))

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('Unauthorized')
  })

  it('returns 401 when the bearer is wrong', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/ext-tokens/route')

    const res = await POST(makeRequest({ erpCompanyId, name: 'Token' }, { authorization: 'Bearer wrong-secret' }))

    expect(res.status).toBe(401)
  })

  it('returns 401 when ADMIN_MIGRATIONS_SECRET is unset', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', '')
    const { POST } = await import('@/app/api/admin/ext-tokens/route')

    const res = await POST(makeRequest({ erpCompanyId, name: 'Token' }, { authorization: 'Bearer anything' }))

    expect(res.status).toBe(401)
  })

  it('returns 400 for a malformed JSON body', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/ext-tokens/route')

    const res = await POST(
      new Request('http://localhost/api/admin/ext-tokens', {
        method: 'POST',
        headers: { authorization: 'Bearer the-secret', 'content-type': 'application/json' },
        body: '{not json',
      }),
    )

    expect(res.status).toBe(400)
  })

  it('returns 400 when erpCompanyId is missing or not a uuid', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/ext-tokens/route')

    const res = await POST(makeRequest({ erpCompanyId: 'not-a-uuid', name: 'Token' }, { authorization: 'Bearer the-secret' }))

    expect(res.status).toBe(400)
  })

  it('returns 400 when name is missing', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/ext-tokens/route')

    const res = await POST(makeRequest({ erpCompanyId }, { authorization: 'Bearer the-secret' }))

    expect(res.status).toBe(400)
  })

  it('returns 400 when customerCodes is not an array of strings', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/ext-tokens/route')

    const res = await POST(
      makeRequest({ erpCompanyId, name: 'Token', customerCodes: [1, 2] }, { authorization: 'Bearer the-secret' }),
    )

    expect(res.status).toBe(400)
  })

  it('returns 404 for a well-formed but nonexistent erpCompanyId', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/ext-tokens/route')

    const res = await POST(
      makeRequest(
        { erpCompanyId: '00000000-0000-0000-0000-000000000000', name: 'Token' },
        { authorization: 'Bearer the-secret' },
      ),
    )

    expect(res.status).toBe(404)
  })

  it('mints a token, derives tenantId from the erpCompany, and returns the raw token once', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('@/app/api/admin/ext-tokens/route')

    const res = await POST(
      makeRequest(
        { erpCompanyId, name: 'Ops Mint Token', customerCodes: ['CUST-A'] },
        { authorization: 'Bearer the-secret' },
      ),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(typeof body.id).toBe('string')
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBeGreaterThan(0)
    // Never returns the hash, only the raw token — and the raw token really
    // does verify against the persisted row.
    expect(body).not.toHaveProperty('tokenHash')
    expect(body).not.toHaveProperty('raw')

    const found = await findExtTokenByHash(db, hashToken(body.token))
    expect(found).not.toBeNull()
    expect(found?.id).toBe(body.id)
    expect(found?.tenantId).toBe(tenantId)
    expect(found?.erpCompanyId).toBe(erpCompanyId)
    expect(found?.customerCodes).toEqual(['CUST-A'])
  })
})
