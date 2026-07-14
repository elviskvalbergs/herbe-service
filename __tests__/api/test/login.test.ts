// __tests__/api/test/login.test.ts
//
// `@/app/api/test/login/route` transitively imports `@/lib/db` (via
// issueMagicLinkToken's caller), which reads DATABASE_URL at module-load
// time — so DATABASE_URL must point at the harness DB *before* the route is
// first dynamically imported (same convention as
// app/api/sync/outbox/route.test.ts).
//
// `signIn` from '@/lib/auth' is mocked at the module seam: Auth.js v5's
// server-side `signIn()` calls `next/headers`' `cookies()`/`headers()`,
// which require the Next.js request-scoped AsyncLocalStorage that only
// exists inside a real Next.js server request — not in a bare Vitest call to
// `POST(request)`. Real end-to-end coverage of `signIn` itself belongs to
// Task 19's Playwright suite; this test proves the route's own logic (guard
// order, token issuance, calling signIn with the issued token).
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

const signInMock = vi.fn()
vi.mock('@/lib/auth', () => ({ signIn: (...args: unknown[]) => signInMock(...args) }))

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
  const [tenant] = await db.insert(schema.tenants).values({ slug: 'test-login-t1', name: 'Test Login T1' }).returning()
  tenantId = tenant.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/test/login', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/test/login', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    signInMock.mockReset()
  })

  it('returns 404 when isTestAuthEnabled() is false (guard: TEST_AUTH unset)', async () => {
    vi.stubEnv('TEST_AUTH', undefined)

    const { POST } = await import('@/app/api/test/login/route')
    const res = await POST(makeRequest({ personaKey: 'tech', tenantId }))

    expect(res.status).toBe(404)
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('returns 404 in production even if TEST_AUTH=1 (double guard, not reachable)', async () => {
    vi.stubEnv('TEST_AUTH', '1')
    vi.stubEnv('VERCEL_ENV', 'production')

    const { POST } = await import('@/app/api/test/login/route')
    const res = await POST(makeRequest({ personaKey: 'tech', tenantId }))

    expect(res.status).toBe(404)
  })

  it('returns 400 for an unknown personaKey when the guard is open', async () => {
    vi.stubEnv('TEST_AUTH', '1')
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('NODE_ENV', 'test')

    const { POST } = await import('@/app/api/test/login/route')
    const res = await POST(makeRequest({ personaKey: 'not-a-real-persona', tenantId }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body).toEqual({ error: 'unknown persona' })
    expect(signInMock).not.toHaveBeenCalled()
  })

  // Carry-over #2 (Task 14 review requirement): a bare `PERSONAS[personaKey]`
  // lookup resolves '__proto__'/'constructor' to a truthy prototype object
  // even though they were never defined as personas — which, now that this
  // route mints a real session, would let an attacker sign in as a
  // fabricated identity. Both keys must be rejected the same as any other
  // unknown persona.
  it.each(['__proto__', 'constructor', 'toString'])(
    'returns 400 for the prototype-pollution persona key %s, without calling signIn',
    async (personaKey) => {
      vi.stubEnv('TEST_AUTH', '1')
      vi.stubEnv('VERCEL_ENV', 'preview')
      vi.stubEnv('NODE_ENV', 'test')

      const { POST } = await import('@/app/api/test/login/route')
      const res = await POST(makeRequest({ personaKey, tenantId }))
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body).toEqual({ error: 'unknown persona' })
      expect(signInMock).not.toHaveBeenCalled()
    },
  )

  // Carry-over #1 (Task 14): the Task 8 stub is finished — a known persona
  // issues a real, DB-backed magic-link token and hands it to signIn().
  it('issues a magic-link token for a known persona and calls signIn with it', async () => {
    vi.stubEnv('TEST_AUTH', '1')
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.stubEnv('NODE_ENV', 'test')
    signInMock.mockResolvedValue(undefined)

    const { POST } = await import('@/app/api/test/login/route')
    const res = await POST(makeRequest({ personaKey: 'office', tenantId }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })

    expect(signInMock).toHaveBeenCalledTimes(1)
    const [provider, options] = signInMock.mock.calls[0]
    expect(provider).toBe('magic_link')
    expect(options).toMatchObject({ redirect: false })
    const issuedToken = options.token as string
    expect(issuedToken).toMatch(/^[0-9a-f]{64}$/)

    // The token minted for this call was persisted for the persona's own
    // tenant + email — proof the route wired issueMagicLinkToken correctly,
    // independent of the mocked signIn().
    const rows = await db.select().from(schema.magicLinkTokens).where(eq(schema.magicLinkTokens.tenantId, tenantId))
    expect(rows.some((r) => r.email === 'office.eva@herbe-service.test')).toBe(true)
  })
})
