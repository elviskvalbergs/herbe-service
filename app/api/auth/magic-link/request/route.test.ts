// app/api/auth/magic-link/request/route.test.ts
//
// `@/app/api/auth/magic-link/request/route` transitively imports `@/lib/db`,
// which reads DATABASE_URL at module-load time, so DATABASE_URL must point
// at the harness DB *before* the route is first dynamically imported (same
// convention as app/api/sync/outbox/route.test.ts).
import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
  const [tenant] = await db.insert(schema.tenants).values({ slug: 'magic-link-t1', name: 'Magic Link T1' }).returning()
  tenantId = tenant.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/auth/magic-link/request', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/auth/magic-link/request', () => {
  it('returns 200 and issues a DB-backed token for a known-shaped email', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ tenantId, email: 'office.eva@herbe-service.test' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })

    const loggedLine = logSpy.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('office.eva@herbe-service.test'))
    expect(loggedLine).toBeDefined()
    const token = loggedLine!.match(/token=([0-9a-f]{64})/)?.[1]
    expect(token).toBeDefined()

    const expectedHash = crypto.createHash('sha256').update(token!).digest('hex')
    const [row] = await db.select().from(schema.magicLinkTokens).where(eq(schema.magicLinkTokens.tokenHash, expectedHash))
    expect(row?.email).toBe('office.eva@herbe-service.test')
    expect(row?.tenantId).toBe(tenantId)
  })

  // Anti-enumeration: an email with no corresponding user gets the exact
  // same 200 response as a known one — the caller can never learn from the
  // response alone whether the address exists.
  it('returns 200 for an email with no corresponding user (anti-enumeration)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ tenantId, email: 'nobody-at-all@herbe-service.test' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })

    const rows = await db
      .select()
      .from(schema.magicLinkTokens)
      .where(and(eq(schema.magicLinkTokens.tenantId, tenantId), eq(schema.magicLinkTokens.email, 'nobody-at-all@herbe-service.test')))
    expect(rows).toHaveLength(1)
  })

  // The console.log below is a Phase-0 stand-in for real email delivery, but
  // the token it prints is a live bearer credential — logging it in
  // production would leak account access through log aggregation. This test
  // proves the route still issues and persists the token correctly, it just
  // never prints it once VERCEL_ENV/NODE_ENV says production.
  it('does not log the token or email in production, but still issues and stores the token', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const originalVercelEnv = process.env.VERCEL_ENV
    process.env.VERCEL_ENV = 'production'

    try {
      const { POST } = await import('./route')
      const res = await POST(makeRequest({ tenantId, email: 'prod-user@herbe-service.test' }))
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toEqual({ status: 'ok' })
      expect(logSpy).not.toHaveBeenCalled()

      const rows = await db
        .select()
        .from(schema.magicLinkTokens)
        .where(and(eq(schema.magicLinkTokens.tenantId, tenantId), eq(schema.magicLinkTokens.email, 'prod-user@herbe-service.test')))
      expect(rows).toHaveLength(1)
    } finally {
      if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = originalVercelEnv
    }
  })
})
