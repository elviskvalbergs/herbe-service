// app/api/push/test/route.test.ts
//
// DB-backed tests for POST /api/push/test, same bootstrap as
// tests/unit/api/admin/ext-tokens-route.test.ts (the sibling admin-bearer
// route this one copies its auth convention from). `web-push` is mocked so
// no real network Push request is ever attempted.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

const sendNotificationMock = vi.fn()
const setVapidDetailsMock = vi.fn()
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetailsMock(...args),
  },
}))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/push/test', {
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
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeUser(tenantSlug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug: tenantSlug, name: tenantSlug }).returning()
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId: tenant.id, email: `${tenantSlug}@herbe-service.test`, role: 'technician' })
    .returning()
  return user
}

describe('POST /api/push/test', () => {
  beforeEach(() => {
    vi.stubEnv('VAPID_PUBLIC_KEY', 'test-public-key')
    vi.stubEnv('VAPID_PRIVATE_KEY', 'test-private-key')
    vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@herbe-service.test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    sendNotificationMock.mockReset()
    setVapidDetailsMock.mockReset()
  })

  it('returns 401 (plain text) when the bearer header is missing', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('./route')

    const res = await POST(makeRequest({ userId: 'irrelevant' }))

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('Unauthorized')
    expect(sendNotificationMock).not.toHaveBeenCalled()
  })

  it('returns 401 when the bearer is wrong', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('./route')

    const res = await POST(makeRequest({ userId: 'irrelevant' }, { authorization: 'Bearer wrong-secret' }))

    expect(res.status).toBe(401)
  })

  it('returns 401 when ADMIN_MIGRATIONS_SECRET is unset', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', '')
    const { POST } = await import('./route')

    const res = await POST(makeRequest({ userId: 'irrelevant' }, { authorization: 'Bearer anything' }))

    expect(res.status).toBe(401)
  })

  it('returns 400 for a malformed JSON body', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('./route')

    const res = await POST(
      new Request('http://localhost/api/push/test', {
        method: 'POST',
        headers: { authorization: 'Bearer the-secret', 'content-type': 'application/json' },
        body: '{not json',
      }),
    )

    expect(res.status).toBe(400)
  })

  it('returns 400 when userId is missing', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const { POST } = await import('./route')

    const res = await POST(makeRequest({}, { authorization: 'Bearer the-secret' }))

    expect(res.status).toBe(400)
  })

  it("sends a push to the target user's subscriptions when authorized", async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    const user = await makeUser('push-test-route-ok')
    await db.insert(schema.pushSubscriptions).values({
      userId: user.id,
      endpoint: 'https://push.example/test-route-ok',
      p256dh: 'p',
      auth: 'a',
    })
    sendNotificationMock.mockResolvedValue({ statusCode: 201 })

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ userId: user.id, payload: { title: 'Ping' } }, { authorization: 'Bearer the-secret' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok', sent: 1, removed: 0, failed: 0 })
    expect(sendNotificationMock).toHaveBeenCalledTimes(1)
    expect(sendNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://push.example/test-route-ok' }),
      JSON.stringify({ title: 'Ping' }),
    )
  })

  it('returns 500 when sendPushToUser throws (e.g. VAPID keys misconfigured)', async () => {
    vi.stubEnv('ADMIN_MIGRATIONS_SECRET', 'the-secret')
    vi.stubEnv('VAPID_PUBLIC_KEY', '')
    const user = await makeUser('push-test-route-500')

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ userId: user.id }, { authorization: 'Bearer the-secret' }))

    expect(res.status).toBe(500)
  })
})
