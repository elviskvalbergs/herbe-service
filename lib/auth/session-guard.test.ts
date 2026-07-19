import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeUser() {
  const [tenant] = await db.insert(schema.tenants).values({ slug: `sg-${Date.now()}-${Math.random()}`, name: 'x' }).returning()
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email: 'a@b.test' }).returning()
  return user
}

describe('getVerifiedSession', () => {
  beforeEach(() => authMock.mockReset())

  it('returns the session when sessionVersion matches the stored value', async () => {
    const { getVerifiedSession } = await import('./session-guard')
    const user = await makeUser()
    authMock.mockResolvedValue({ user: { id: user.id, sessionVersion: 1 }, expires: '2099-01-01T00:00:00.000Z' })

    const session = await getVerifiedSession(db)
    expect(session?.user.id).toBe(user.id)
  })

  it('returns null when the token sessionVersion is stale', async () => {
    const { getVerifiedSession, bumpSessionVersion } = await import('./session-guard')
    const user = await makeUser()
    authMock.mockResolvedValue({ user: { id: user.id, sessionVersion: 1 }, expires: '2099-01-01T00:00:00.000Z' })
    await bumpSessionVersion(db, user.id)

    expect(await getVerifiedSession(db)).toBeNull()
  })

  it('returns null when there is no session', async () => {
    const { getVerifiedSession } = await import('./session-guard')
    authMock.mockResolvedValue(null)
    expect(await getVerifiedSession(db)).toBeNull()
  })
})
