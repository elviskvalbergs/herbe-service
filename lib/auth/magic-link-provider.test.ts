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

async function makeUser(email: string, role = 'technician') {
  const [user] = await db.insert(schema.users).values({ tenantId, email, role }).returning()
  return user
}

describe('magic link auth', () => {
  it('consumes a valid token once for an existing user, then rejects reuse', async () => {
    const user = await makeUser('office.eva@herbe-service.test')
    const { token } = await issueMagicLinkToken(db, { tenantId, email: user.email })

    const first = await authorizeMagicLink(db, { token })
    expect(first?.id).toBe(user.id)
    expect(first?.email).toBe('office.eva@herbe-service.test')
    expect(first?.tenantId).toBe(tenantId)
    expect(first?.role).toBe('technician')
    expect(first?.sessionVersion).toBe(1)

    const second = await authorizeMagicLink(db, { token })
    expect(second).toBeNull() // single-use
  })

  // FIX-2: a magic link authenticates an existing user; it never provisions
  // one. A valid token for an unknown email is still consumed (single-use),
  // but authorize returns null and no user row is created.
  it('does not provision a user: a valid token for an unknown email is consumed but grants nothing', async () => {
    const email = 'ghost@herbe-service.test'
    const { token } = await issueMagicLinkToken(db, { tenantId, email })

    const result = await authorizeMagicLink(db, { token })
    expect(result).toBeNull()

    const users = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.email, email)))
    expect(users).toHaveLength(0)

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const [row] = await db.select().from(schema.magicLinkTokens).where(eq(schema.magicLinkTokens.tokenHash, tokenHash))
    expect(row.consumedAt).not.toBeNull()
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
    const user = await makeUser('concurrent@herbe-service.test')
    const { token } = await issueMagicLinkToken(db, { tenantId, email: user.email })

    const results = await Promise.all(Array.from({ length: 20 }, () => authorizeMagicLink(db, { token })))

    const winners = results.filter((r) => r !== null)
    expect(winners).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(19)
    expect(winners[0]?.id).toBe(user.id)
    expect(winners[0]?.email).toBe('concurrent@herbe-service.test')
    expect(winners[0]?.tenantId).toBe(tenantId)

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

  it('repeated sign-ins for an existing user resolve to the same user row (no duplicate provisioning)', async () => {
    const user = await makeUser('repeat-signin@herbe-service.test')

    const { token: token1 } = await issueMagicLinkToken(db, { tenantId, email: user.email })
    const first = await authorizeMagicLink(db, { token: token1 })

    const { token: token2 } = await issueMagicLinkToken(db, { tenantId, email: user.email })
    const second = await authorizeMagicLink(db, { token: token2 })

    expect(first?.id).toBe(user.id)
    expect(second?.id).toBe(user.id)
    expect(second?.sessionVersion).toBe(first?.sessionVersion)

    const rows = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.email, user.email)))
    expect(rows).toHaveLength(1)
  })
})
