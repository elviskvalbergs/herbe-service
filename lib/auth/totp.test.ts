import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { TOTP, Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { consumeRecoveryCode, confirmTotpEnrollment, disableTotp, enrollTotp, verifyTotp } from './totp'

// session-guard.ts imports `auth` from '@/lib/auth' at module scope, whose
// real implementation calls next-auth's NextAuth(config) and transitively
// `next/server` — unresolvable under Vitest (see session-guard.test.ts's
// identical mock). bumpSessionVersion (what totp.ts actually calls) never
// touches `auth` itself, but the module-level import still has to resolve.
const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  process.env.MASTER_ENCRYPTION_KEY ||= '0123456789abcdef'.repeat(4)
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeAdminUser() {
  const [tenant] = await db.insert(schema.tenants).values({ slug: `totp-${Date.now()}-${Math.random()}`, name: 'x' }).returning()
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId: tenant.id, email: 'admin@example.test', role: 'admin' })
    .returning()
  return user
}

function currentCodeFor(secretBase32: string, email: string, timestamp?: number): string {
  const totp = new TOTP({ issuer: 'herbe.service', label: email, issuerInLabel: true, secret: Secret.fromBase32(secretBase32), algorithm: 'SHA1', digits: 6, period: 30 })
  return totp.generate({ timestamp })
}

describe('TOTP enrollment + verification', () => {
  it('enrollTotp issues an otpauth URI, a base32 secret, and 10 dash-grouped recovery codes; mfaEnabled stays false', async () => {
    const user = await makeAdminUser()
    const result = await enrollTotp(db, user.id, user.email)

    expect(result.otpauthUri).toContain('otpauth://totp/')
    expect(result.recoveryCodes).toHaveLength(10)
    for (const code of result.recoveryCodes) {
      expect(code).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/)
    }

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.mfaEnabled).toBe(false)
    expect(row.mfaSecretEncrypted).toBeTruthy()
  })

  it('confirmTotpEnrollment activates mfaEnabled only with a valid current code', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)

    expect(await confirmTotpEnrollment(db, user.id, '000000')).toBe(false)
    let [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.mfaEnabled).toBe(false)

    const validCode = currentCodeFor(enrolled.secretBase32, user.email)
    expect(await confirmTotpEnrollment(db, user.id, validCode)).toBe(true)
    ;[row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.mfaEnabled).toBe(true)
  })

  it('verifyTotp accepts a valid code once and rejects the identical code on replay', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const code = currentCodeFor(enrolled.secretBase32, user.email)
    expect(await verifyTotp(db, user.id, code, { bumpSession: false })).toBe(true)
    expect(await verifyTotp(db, user.id, code, { bumpSession: false })).toBe(false)
  })

  it('verifyTotp rejects one of two truly concurrent submissions of the identical valid code', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const code = currentCodeFor(enrolled.secretBase32, user.email)
    const [first, second] = await Promise.all([
      verifyTotp(db, user.id, code, { bumpSession: false }),
      verifyTotp(db, user.id, code, { bumpSession: false }),
    ])

    // Order isn't guaranteed under real concurrency — only that exactly one wins.
    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('verifyTotp bumps session_version by default, but not when bumpSession:false', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    await verifyTotp(db, user.id, currentCodeFor(enrolled.secretBase32, user.email), { bumpSession: false })
    let [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.sessionVersion).toBe(1)

    // A code from the next 30s period, not a resubmit of the same one above —
    // the replay guard (correctly) rejects an identical code/epoch, which
    // would otherwise make this assertion indistinguishable from that bug.
    await verifyTotp(db, user.id, currentCodeFor(enrolled.secretBase32, user.email, Date.now() + 30_000))
    ;[row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.sessionVersion).toBe(2)
  })

  it('consumeRecoveryCode accepts a valid code once and rejects it on reuse', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const [code] = enrolled.recoveryCodes
    expect(await consumeRecoveryCode(db, user.id, code)).toBe(true)
    expect(await consumeRecoveryCode(db, user.id, code)).toBe(false)
  })

  it('consumeRecoveryCode rejects one of two truly concurrent consumptions of the identical code', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const [code] = enrolled.recoveryCodes
    const [first, second] = await Promise.all([
      consumeRecoveryCode(db, user.id, code),
      consumeRecoveryCode(db, user.id, code),
    ])

    // Order isn't guaranteed under real concurrency — only that exactly one wins.
    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('disableTotp clears the secret, flips mfaEnabled false, and bumps session_version', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const ok = await disableTotp(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))
    expect(ok).toBe(true)

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.mfaEnabled).toBe(false)
    expect(row.mfaSecretEncrypted).toBeNull()
    expect(row.sessionVersion).toBe(2)
  })

  it('disableTotp accepts a recovery code instead of a TOTP code', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const ok = await disableTotp(db, user.id, enrolled.recoveryCodes[1])
    expect(ok).toBe(true)
  })
})
