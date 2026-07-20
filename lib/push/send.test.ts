// lib/push/send.test.ts
//
// DB-backed tests against a real local Postgres (same bootstrap as
// tests/unit/api/admin/ext-tokens-route.test.ts); `web-push` itself is
// mocked so no real network Push request is ever attempted.
import { eq } from 'drizzle-orm'
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

describe('sendPushToUser', () => {
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

  it('throws when VAPID env vars are not fully set', async () => {
    vi.unstubAllEnvs()
    vi.stubEnv('VAPID_PUBLIC_KEY', '')
    vi.stubEnv('VAPID_PRIVATE_KEY', '')
    vi.stubEnv('VAPID_SUBJECT', '')

    const { sendPushToUser } = await import('./send')
    await expect(sendPushToUser(db, 'irrelevant-user-id', { title: 'hi' })).rejects.toThrow(/VAPID/)
    expect(sendNotificationMock).not.toHaveBeenCalled()
  })

  it('sends to every subscription for the user', async () => {
    const user = await makeUser('push-send-all')
    await db.insert(schema.pushSubscriptions).values([
      { userId: user.id, endpoint: 'https://push.example/all-1', p256dh: 'p1', auth: 'a1' },
      { userId: user.id, endpoint: 'https://push.example/all-2', p256dh: 'p2', auth: 'a2' },
    ])
    sendNotificationMock.mockResolvedValue({ statusCode: 201 })

    const { sendPushToUser } = await import('./send')
    const result = await sendPushToUser(db, user.id, { title: 'Hello' })

    expect(result).toEqual({ sent: 2, removed: 0, failed: 0 })
    expect(sendNotificationMock).toHaveBeenCalledTimes(2)
    expect(setVapidDetailsMock).toHaveBeenCalledWith('mailto:ops@herbe-service.test', 'test-public-key', 'test-private-key')
  })

  it('only sends to the target user, never another user\'s subscriptions', async () => {
    const userA = await makeUser('push-send-scope-a')
    const userB = await makeUser('push-send-scope-b')
    await db.insert(schema.pushSubscriptions).values([
      { userId: userA.id, endpoint: 'https://push.example/scope-a', p256dh: 'p1', auth: 'a1' },
      { userId: userB.id, endpoint: 'https://push.example/scope-b', p256dh: 'p2', auth: 'a2' },
    ])
    sendNotificationMock.mockResolvedValue({ statusCode: 201 })

    const { sendPushToUser } = await import('./send')
    const result = await sendPushToUser(db, userA.id, { title: 'Hello' })

    expect(result).toEqual({ sent: 1, removed: 0, failed: 0 })
    expect(sendNotificationMock).toHaveBeenCalledTimes(1)
    expect(sendNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://push.example/scope-a' }), expect.any(String))
  })

  it('removes a subscription that responds 410 Gone, keeps the others', async () => {
    const user = await makeUser('push-send-410')
    await db.insert(schema.pushSubscriptions).values([
      { userId: user.id, endpoint: 'https://push.example/gone-410', p256dh: 'p1', auth: 'a1' },
      { userId: user.id, endpoint: 'https://push.example/alive', p256dh: 'p2', auth: 'a2' },
    ])
    sendNotificationMock.mockImplementation((subscription: { endpoint: string }) => {
      if (subscription.endpoint.endsWith('gone-410')) {
        return Promise.reject(Object.assign(new Error('Gone'), { statusCode: 410 }))
      }
      return Promise.resolve({ statusCode: 201 })
    })

    const { sendPushToUser } = await import('./send')
    const result = await sendPushToUser(db, user.id, { title: 'Hi' })

    expect(result).toEqual({ sent: 1, removed: 1, failed: 0 })

    const remaining = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, user.id))
    expect(remaining).toHaveLength(1)
    expect(remaining[0].endpoint).toBe('https://push.example/alive')
  })

  it('removes a subscription that responds 404 Not Found', async () => {
    const user = await makeUser('push-send-404')
    await db.insert(schema.pushSubscriptions).values({
      userId: user.id,
      endpoint: 'https://push.example/gone-404',
      p256dh: 'p1',
      auth: 'a1',
    })
    sendNotificationMock.mockRejectedValue(Object.assign(new Error('Not Found'), { statusCode: 404 }))

    const { sendPushToUser } = await import('./send')
    const result = await sendPushToUser(db, user.id, { title: 'Hi' })

    expect(result).toEqual({ sent: 0, removed: 1, failed: 0 })

    const remaining = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, user.id))
    expect(remaining).toHaveLength(0)
  })

  it('counts a non-410/404 failure without deleting the subscription or stopping delivery to others', async () => {
    const user = await makeUser('push-send-5xx')
    await db.insert(schema.pushSubscriptions).values([
      { userId: user.id, endpoint: 'https://push.example/flaky', p256dh: 'p1', auth: 'a1' },
      { userId: user.id, endpoint: 'https://push.example/ok', p256dh: 'p2', auth: 'a2' },
    ])
    sendNotificationMock.mockImplementation((subscription: { endpoint: string }) => {
      if (subscription.endpoint.endsWith('flaky')) {
        return Promise.reject(Object.assign(new Error('Service Unavailable'), { statusCode: 503 }))
      }
      return Promise.resolve({ statusCode: 201 })
    })

    const { sendPushToUser } = await import('./send')
    const result = await sendPushToUser(db, user.id, { title: 'Hi' })

    expect(result).toEqual({ sent: 1, removed: 0, failed: 1 })

    const remaining = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, user.id))
    expect(remaining).toHaveLength(2)
  })

  it('continues to all subscriptions and reports a full failed count when every send fails identically (e.g. systemic VAPID misconfiguration)', async () => {
    const user = await makeUser('push-send-uniform-failure')
    await db.insert(schema.pushSubscriptions).values([
      { userId: user.id, endpoint: 'https://push.example/uniform-1', p256dh: 'p1', auth: 'a1' },
      { userId: user.id, endpoint: 'https://push.example/uniform-2', p256dh: 'p2', auth: 'a2' },
      { userId: user.id, endpoint: 'https://push.example/uniform-3', p256dh: 'p3', auth: 'a3' },
    ])
    sendNotificationMock.mockRejectedValue(Object.assign(new Error('Bad Request'), { statusCode: 400 }))

    const { sendPushToUser } = await import('./send')
    const result = await sendPushToUser(db, user.id, { title: 'Hi' })

    expect(result).toEqual({ sent: 0, removed: 0, failed: 3 })
    expect(sendNotificationMock).toHaveBeenCalledTimes(3)

    const remaining = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, user.id))
    expect(remaining).toHaveLength(3)
  })
})
