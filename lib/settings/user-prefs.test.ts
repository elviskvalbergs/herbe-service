// lib/settings/user-prefs.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), same
// pattern as lib/domain/stores/erp-refs.test.ts.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { getUserPrefs, setUserPrefs } from './user-prefs'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeUser(email: string) {
  const [user] = await db.insert(schema.users).values({ tenantId, email, role: 'technician' }).returning()
  return user
}

describe('getUserPrefs', () => {
  it('returns the default locale/displayScheme for a freshly created user', async () => {
    const user = await makeUser('defaults@herbe-service.test')

    const prefs = await getUserPrefs(db, user.id)

    expect(prefs).toEqual({ locale: 'lv', displayScheme: 'standard' })
  })

  it('rejects an unknown userId', async () => {
    await expect(getUserPrefs(db, crypto.randomUUID())).rejects.toThrow()
  })
})

describe('setUserPrefs', () => {
  it('round-trips a full update through getUserPrefs', async () => {
    const user = await makeUser('roundtrip@herbe-service.test')

    const updated = await setUserPrefs(db, user.id, { locale: 'en', displayScheme: 'dark' })
    expect(updated).toEqual({ locale: 'en', displayScheme: 'dark' })

    const fetched = await getUserPrefs(db, user.id)
    expect(fetched).toEqual({ locale: 'en', displayScheme: 'dark' })
  })

  it('applies a partial update, leaving the other field unchanged', async () => {
    const user = await makeUser('partial@herbe-service.test')
    await setUserPrefs(db, user.id, { locale: 'et', displayScheme: 'sunlight' })

    const updated = await setUserPrefs(db, user.id, { displayScheme: 'dark' })

    expect(updated).toEqual({ locale: 'et', displayScheme: 'dark' })
  })

  it('rejects an invalid locale code without persisting anything', async () => {
    const user = await makeUser('bad-locale@herbe-service.test')

    await expect(setUserPrefs(db, user.id, { locale: 'xx' })).rejects.toThrow()

    const prefs = await getUserPrefs(db, user.id)
    expect(prefs).toEqual({ locale: 'lv', displayScheme: 'standard' })
  })

  it('rejects an invalid display scheme without persisting anything', async () => {
    const user = await makeUser('bad-scheme@herbe-service.test')

    await expect(setUserPrefs(db, user.id, { displayScheme: 'neon' })).rejects.toThrow()

    const prefs = await getUserPrefs(db, user.id)
    expect(prefs).toEqual({ locale: 'lv', displayScheme: 'standard' })
  })
})
