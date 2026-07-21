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

async function makeUser(email: string) {
  await db.insert(schema.users).values({ tenantId, email }).returning()
}

describe('POST /api/auth/magic-link/request', () => {
  it('returns 200 and issues a DB-backed token for an existing user', async () => {
    await makeUser('office.eva@herbe-service.test')
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

  // FIX-2: an unknown email gets the exact same 200 as a known one
  // (anti-enumeration at the response level) but NO token is issued — the
  // route never provisions, and the old behavior (inserting a token row for
  // any email) let an unauthenticated caller flood the token table.
  it('returns 200 for an unknown email but issues no token (FIX-2, anti-enumeration)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ tenantId, email: 'nobody-at-all@herbe-service.test' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })
    expect(logSpy).not.toHaveBeenCalled()

    const rows = await db
      .select()
      .from(schema.magicLinkTokens)
      .where(and(eq(schema.magicLinkTokens.tenantId, tenantId), eq(schema.magicLinkTokens.email, 'nobody-at-all@herbe-service.test')))
    expect(rows).toHaveLength(0)
  })

  // The console.log below is a Phase-0 stand-in for real email delivery, but
  // the token it prints is a live bearer credential — logging it in
  // production would leak account access through log aggregation. This test
  // proves the route still issues and persists the token correctly, it just
  // never prints it once VERCEL_ENV/NODE_ENV says production.
  it('does not log the token or email in production, but still issues and stores the token for an existing user', async () => {
    await makeUser('prod-user@herbe-service.test')
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

  // FIX-7: repeated requests for the same IP+tenant+email are throttled
  // (policy 'magic-link' = 5/min). Fake Date pins the fixed window so the
  // boundary can't roll over mid-test.
  it('rate-limits repeated requests for the same identity with 429 + Retry-After (FIX-7)', async () => {
    await makeUser('rl-user@herbe-service.test')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 9, 0, 0)))

    try {
      const { POST } = await import('./route')
      for (let i = 0; i < 5; i++) {
        const res = await POST(makeRequest({ tenantId, email: 'rl-user@herbe-service.test' }))
        expect(res.status).toBe(200)
      }

      const blocked = await POST(makeRequest({ tenantId, email: 'rl-user@herbe-service.test' }))
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('Retry-After')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
