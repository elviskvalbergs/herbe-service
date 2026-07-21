// lib/auth/rate-limit.test.ts
//
// FIX-7: DB-backed tests for lib/auth/rate-limit.ts against a real local
// Postgres (same bootstrap as tests/unit/api/ext/rate-limit.test.ts).
// auth_rate_limit has no FK (migration 0025), so the key is just an opaque
// string. NOW is passed explicitly so the fixed window is deterministic.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { checkAuthRateLimit, clientIpFrom } from './rate-limit'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

const WINDOW_MS = 60_000
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

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

describe('checkAuthRateLimit', () => {
  // POLICY in lib/auth/rate-limit.ts — kept in sync here deliberately so a
  // policy change fails this test loudly rather than passing silently.
  it("allows up to the magic-link cap (5), then blocks with a bounded retryAfterSec", async () => {
    const key = 'ip1|tenant1|a@x.test'
    for (let i = 0; i < 5; i++) {
      expect((await checkAuthRateLimit(db, key, 'magic-link', NOW)).allowed).toBe(true)
    }
    const blocked = await checkAuthRateLimit(db, key, 'magic-link', NOW)
    expect(blocked.allowed).toBe(false)
    if (!blocked.allowed) {
      expect(blocked.retryAfterSec).toBeGreaterThan(0)
      expect(blocked.retryAfterSec).toBeLessThanOrEqual(60)
    }
  })

  it('resets once the next window starts', async () => {
    const key = 'ip2|tenant1|b@x.test'
    for (let i = 0; i < 5; i++) await checkAuthRateLimit(db, key, 'magic-link', NOW)
    expect((await checkAuthRateLimit(db, key, 'magic-link', NOW)).allowed).toBe(false)
    expect((await checkAuthRateLimit(db, key, 'magic-link', NOW + WINDOW_MS)).allowed).toBe(true)
  })

  it('gives independent buckets per key', async () => {
    const keyA = 'ipA|t|c@x.test'
    const keyB = 'ipB|t|c@x.test'
    for (let i = 0; i < 5; i++) await checkAuthRateLimit(db, keyA, 'magic-link', NOW)
    expect((await checkAuthRateLimit(db, keyA, 'magic-link', NOW)).allowed).toBe(false)
    expect((await checkAuthRateLimit(db, keyB, 'magic-link', NOW)).allowed).toBe(true)
  })

  it('gives independent buckets per endpoint and applies the login cap (10)', async () => {
    const key = 'ipL|t|d@x.test'
    for (let i = 0; i < 10; i++) {
      expect((await checkAuthRateLimit(db, key, 'login', NOW)).allowed).toBe(true)
    }
    expect((await checkAuthRateLimit(db, key, 'login', NOW)).allowed).toBe(false)
    // Same key, different endpoint has its own bucket.
    expect((await checkAuthRateLimit(db, key, 'magic-link', NOW)).allowed).toBe(true)
  })

  it('falls back to the default policy (10/min) for an unlisted endpoint', async () => {
    const key = 'ipD|t|e@x.test'
    for (let i = 0; i < 10; i++) {
      expect((await checkAuthRateLimit(db, key, 'some-unlisted', NOW)).allowed).toBe(true)
    }
    expect((await checkAuthRateLimit(db, key, 'some-unlisted', NOW)).allowed).toBe(false)
  })
})

describe('clientIpFrom', () => {
  it('takes the left-most x-forwarded-for hop', () => {
    const req = new Request('http://x', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } })
    expect(clientIpFrom(req)).toBe('203.0.113.7')
  })

  it('falls back to x-real-ip, then to a constant', () => {
    const withReal = new Request('http://x', { headers: { 'x-real-ip': '198.51.100.9' } })
    expect(clientIpFrom(withReal)).toBe('198.51.100.9')
    expect(clientIpFrom(new Request('http://x'))).toBe('unknown')
    expect(clientIpFrom(undefined)).toBe('unknown')
  })
})
