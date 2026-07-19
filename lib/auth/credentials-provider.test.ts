import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { TOTP, Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { hashPassword } from './password'
import { enrollTotp, confirmTotpEnrollment } from './totp'
import { authorizeCredentials } from './credentials-provider'

// Same workaround as totp.test.ts: totp.ts -> session-guard.ts imports `auth`
// from '@/lib/auth' at module scope, whose real implementation transitively
// requires `next/server`, which Vitest can't resolve. Nothing under test
// here calls auth() either.
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

async function makeUser(opts: { role: string; password?: string }) {
  const [tenant] = await db.insert(schema.tenants).values({ slug: `cred-${Date.now()}-${Math.random()}`, name: 'x' }).returning()
  const passwordHash = opts.password ? await hashPassword(opts.password) : null
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId: tenant.id, email: 'user@example.test', role: opts.role, passwordHash })
    .returning()
  return { user, tenantId: tenant.id }
}

function currentCodeFor(secretBase32: string, email: string): string {
  const totp = new TOTP({ issuer: 'herbe.service', label: email, issuerInLabel: true, secret: Secret.fromBase32(secretBase32), algorithm: 'SHA1', digits: 6, period: 30 })
  return totp.generate()
}

describe('authorizeCredentials', () => {
  it('returns the user for a correct admin password with no MFA enabled', async () => {
    const { user, tenantId } = await makeUser({ role: 'admin', password: 'correct horse battery staple' })
    const result = await authorizeCredentials(db, { tenantId, email: user.email, password: 'correct horse battery staple' })
    expect(result).toEqual({ id: user.id, email: user.email, tenantId, role: 'admin', sessionVersion: 1 })
  })

  it('returns null for a wrong password', async () => {
    const { user, tenantId } = await makeUser({ role: 'admin', password: 'correct horse battery staple' })
    expect(await authorizeCredentials(db, { tenantId, email: user.email, password: 'wrong' })).toBeNull()
  })

  it('returns null for an email with no corresponding user', async () => {
    const { tenantId } = await makeUser({ role: 'admin', password: 'x' })
    expect(await authorizeCredentials(db, { tenantId, email: 'nobody@example.test', password: 'anything' })).toBeNull()
  })

  it('returns null for a user with no password set', async () => {
    const { user, tenantId } = await makeUser({ role: 'admin' })
    expect(await authorizeCredentials(db, { tenantId, email: user.email, password: 'anything' })).toBeNull()
  })

  it('returns null for a non-admin role even with the correct password', async () => {
    const { user, tenantId } = await makeUser({ role: 'technician', password: 'correct horse battery staple' })
    expect(await authorizeCredentials(db, { tenantId, email: user.email, password: 'correct horse battery staple' })).toBeNull()
  })

  it('requires a valid totp code when MFA is enabled, and rejects a missing/wrong one', async () => {
    const { user, tenantId } = await makeUser({ role: 'admin', password: 'correct horse battery staple' })
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    expect(await authorizeCredentials(db, { tenantId, email: user.email, password: 'correct horse battery staple' })).toBeNull()
    expect(await authorizeCredentials(db, { tenantId, email: user.email, password: 'correct horse battery staple', totp: '000000' })).toBeNull()

    const result = await authorizeCredentials(db, {
      tenantId,
      email: user.email,
      password: 'correct horse battery staple',
      totp: currentCodeFor(enrolled.secretBase32, user.email),
    })
    expect(result?.id).toBe(user.id)
  })

  it('accepts a recovery code in place of a totp code when MFA is enabled', async () => {
    const { user, tenantId } = await makeUser({ role: 'admin', password: 'correct horse battery staple' })
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const result = await authorizeCredentials(db, {
      tenantId,
      email: user.email,
      password: 'correct horse battery staple',
      totp: enrolled.recoveryCodes[0],
    })
    expect(result?.id).toBe(user.id)
  })
})
