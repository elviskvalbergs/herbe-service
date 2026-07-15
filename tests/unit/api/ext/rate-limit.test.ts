// tests/unit/api/ext/rate-limit.test.ts
//
// Task 6 (docs/superpowers/sdd/task-6-brief.md): DB-backed tests for
// lib/api/ext/rate-limit.ts, against a real local Postgres (same bootstrap
// as tests/unit/api/ext/tokens-store.test.ts). ext_rate_limit has no FK
// (see migration 0015), so tokenId here is just a random uuid, not a real
// ext_tokens row.
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { checkExtRateLimit } from '@/lib/api/ext/rate-limit'

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

// POLICY['service-items'].maxPerMinute / POLICY['orders'].maxPerMinute in
// lib/api/ext/rate-limit.ts — kept in sync here deliberately (a policy
// change should make this test fail loudly, not silently pass).
const MAX_PER_MINUTE = 120
const WINDOW_MS = 60_000
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

describe('checkExtRateLimit', () => {
  it('allows up to maxPerMinute calls, then blocks with a bounded retryAfterSec', async () => {
    const tokenId = randomUUID()
    for (let i = 0; i < MAX_PER_MINUTE; i++) {
      const result = await checkExtRateLimit(db, tokenId, 'service-items', NOW)
      expect(result.allowed).toBe(true)
    }

    const blocked = await checkExtRateLimit(db, tokenId, 'service-items', NOW)
    expect(blocked.allowed).toBe(false)
    if (!blocked.allowed) {
      expect(blocked.retryAfterSec).toBeGreaterThan(0)
      expect(blocked.retryAfterSec).toBeLessThanOrEqual(60)
    }
  }, 30_000)

  it('resets once the next window starts', async () => {
    const tokenId = randomUUID()
    for (let i = 0; i < MAX_PER_MINUTE; i++) {
      await checkExtRateLimit(db, tokenId, 'service-items', NOW)
    }
    const blocked = await checkExtRateLimit(db, tokenId, 'service-items', NOW)
    expect(blocked.allowed).toBe(false)

    const nextWindow = await checkExtRateLimit(db, tokenId, 'service-items', NOW + WINDOW_MS)
    expect(nextWindow.allowed).toBe(true)
  }, 30_000)

  it('gives independent buckets per tokenId', async () => {
    const tokenA = randomUUID()
    const tokenB = randomUUID()
    for (let i = 0; i < MAX_PER_MINUTE; i++) {
      await checkExtRateLimit(db, tokenA, 'orders', NOW)
    }
    const blockedA = await checkExtRateLimit(db, tokenA, 'orders', NOW)
    expect(blockedA.allowed).toBe(false)

    const allowedB = await checkExtRateLimit(db, tokenB, 'orders', NOW)
    expect(allowedB.allowed).toBe(true)
  }, 30_000)

  it('gives independent buckets per endpoint for the same tokenId', async () => {
    const tokenId = randomUUID()
    for (let i = 0; i < MAX_PER_MINUTE; i++) {
      await checkExtRateLimit(db, tokenId, 'service-items', NOW)
    }
    const blocked = await checkExtRateLimit(db, tokenId, 'service-items', NOW)
    expect(blocked.allowed).toBe(false)

    const otherEndpoint = await checkExtRateLimit(db, tokenId, 'orders', NOW)
    expect(otherEndpoint.allowed).toBe(true)
  }, 30_000)

  it('falls back to the default policy for an endpoint not in POLICY', async () => {
    const tokenId = randomUUID()
    const result = await checkExtRateLimit(db, tokenId, 'some-unlisted-endpoint', NOW)
    expect(result.allowed).toBe(true)
  })
})
