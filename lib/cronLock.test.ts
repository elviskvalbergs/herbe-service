// lib/cronLock.test.ts
//
// Table-based cron lock, proven against a real local Postgres via the test
// harness (lib/test-support/db.ts) — not Testcontainers, not advisory locks
// (Supabase's pooler doesn't hold those reliably). `@/lib/cronLock` imports
// `@/lib/db`, which reads DATABASE_URL at module-load time, so DATABASE_URL
// must be pointed at the harness DB *before* the first dynamic import below.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

let testDb: TestDatabase

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url
})

afterAll(async () => {
  const { sql } = await import('@/lib/db')
  await sql.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('cron lock', () => {
  it('grants the lock once, denies a second concurrent acquire, releases cleanly, then re-acquires', async () => {
    const { acquireCronLock, releaseCronLock } = await import('./cronLock')

    expect(await acquireCronLock('sync-tick', 60)).toBe(true)
    expect(await acquireCronLock('sync-tick', 60)).toBe(false)

    await releaseCronLock('sync-tick')
    expect(await acquireCronLock('sync-tick', 60)).toBe(true)

    await releaseCronLock('sync-tick')
  })

  it('re-acquires once the previous holder\'s ttl has expired, without an explicit release', async () => {
    const { acquireCronLock, releaseCronLock } = await import('./cronLock')

    expect(await acquireCronLock('ttl-check', -1)).toBe(true) // already-expired lock
    expect(await acquireCronLock('ttl-check', 60)).toBe(true) // stale lock is stolen

    await releaseCronLock('ttl-check')
  })
})
