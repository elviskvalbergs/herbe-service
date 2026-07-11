// lib/auth/magic-link-provider.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), not
// Testcontainers — same convention as the rest of the suite (e.g.
// __tests__/db/tenancy.test.ts).
import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { authorizeMagicLink, issueMagicLinkToken } from './magic-link-provider'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
  const [tenant] = await db.insert(schema.tenants).values({ slug: 'auth-t1', name: 'Auth T1' }).returning()
  tenantId = tenant.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('magic link auth', () => {
  it('consumes a valid token once, self-registers the user, then rejects reuse', async () => {
    const { token } = await issueMagicLinkToken(db, { tenantId, email: 'office.eva@herbe-service.test' })

    const first = await authorizeMagicLink(db, { token })
    expect(first?.email).toBe('office.eva@herbe-service.test')
    expect(first?.id).toEqual(expect.any(String))

    const second = await authorizeMagicLink(db, { token })
    expect(second).toBeNull() // single-use
  })

  it('under concurrent authorize calls with the same token, exactly one wins (atomic single-use)', async () => {
    // Fires 20 concurrent calls rather than 2: on a fast local Postgres over a
    // pooled connection, 2 concurrent calls don't reliably overlap on the
    // SELECT-then-UPDATE window (empirically ~0/10 trigger here — one call's
    // connection tends to finish its full round trip before the other's
    // connection is even established). 20 concurrent callers reliably produce
    // overlapping in-flight requests, so this fails consistently against the
    // old two-statement implementation (many false "winners") and passes
    // consistently against the atomic single-UPDATE...RETURNING version
    // (always exactly one winner, verified over repeated runs).
    const { token } = await issueMagicLinkToken(db, { tenantId, email: 'concurrent@herbe-service.test' })

    const results = await Promise.all(Array.from({ length: 20 }, () => authorizeMagicLink(db, { token })))

    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(19)
    expect(winners[0]?.email).toBe('concurrent@herbe-service.test')

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const [row] = await db.select().from(schema.magicLinkTokens).where(eq(schema.magicLinkTokens.tokenHash, tokenHash))
    expect(row.consumedAt).not.toBeNull()
  })

  it('rejects an expired token', async () => {
    const tokenHash = crypto.createHash('sha256').update('expired-token').digest('hex')
    await db.insert(schema.magicLinkTokens).values({
      tokenHash,
      tenantId,
      email: 'expired@herbe-service.test',
      expiresAt: new Date(Date.now() - 1000),
    })

    const result = await authorizeMagicLink(db, { token: 'expired-token' })
    expect(result).toBeNull()
  })

  it('rejects a token that was never issued', async () => {
    const result = await authorizeMagicLink(db, { token: 'never-issued-token' })
    expect(result).toBeNull()
  })

  it('stores only the SHA-256 hash of the token — the raw token is never persisted', async () => {
    const { token } = await issueMagicLinkToken(db, { tenantId, email: 'hash-check@herbe-service.test' })
    const expectedHash = crypto.createHash('sha256').update(token).digest('hex')

    const [row] = await db.select().from(schema.magicLinkTokens).where(eq(schema.magicLinkTokens.tokenHash, expectedHash))

    expect(row).toBeDefined()
    expect(row.tokenHash).toBe(expectedHash)
    expect(row.tokenHash).not.toBe(token)
    // The raw token must not appear anywhere in the persisted row.
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('self-registers only once: a second later sign-in resolves to the same user row', async () => {
    const email = 'repeat-signin@herbe-service.test'
    const { token: token1 } = await issueMagicLinkToken(db, { tenantId, email })
    const first = await authorizeMagicLink(db, { token: token1 })

    const { token: token2 } = await issueMagicLinkToken(db, { tenantId, email })
    const second = await authorizeMagicLink(db, { token: token2 })

    expect(second?.id).toBe(first?.id)

    const rows = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.email, email)))
    expect(rows).toHaveLength(1)
  })
})
