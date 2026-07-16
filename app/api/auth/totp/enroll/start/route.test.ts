// app/api/auth/totp/enroll/start/route.test.ts
//
// Same DATABASE_URL-at-import-time / auth() mock convention as
// app/api/auth/devices/route.test.ts. MASTER_ENCRYPTION_KEY is needed
// because enrollTotp/confirmTotpEnrollment (called both directly here and
// via the route) envelope-encrypt the MFA secret — same fallback value as
// lib/auth/totp.test.ts.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { Secret, TOTP } from 'otpauth'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { confirmTotpEnrollment, enrollTotp } from '@/lib/auth/totp'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  process.env.MASTER_ENCRYPTION_KEY ||= '0123456789abcdef'.repeat(4)
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

async function makeUser(tenantSlug: string, email: string, role: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug: tenantSlug, name: tenantSlug }).returning()
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email, role }).returning()
  return user
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/auth/totp/enroll/start', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function currentCodeFor(secretBase32: string, email: string): string {
  const totp = new TOTP({ issuer: 'herbe.service', label: email, issuerInLabel: true, secret: Secret.fromBase32(secretBase32), algorithm: 'SHA1', digits: 6, period: 30 })
  return totp.generate()
}

describe('POST /api/auth/totp/enroll/start', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const { POST } = await import('./route')
    const res = await POST(makeRequest({}))

    expect(res.status).toBe(401)
  })

  it('rejects a non-admin caller with 403', async () => {
    const user = await makeUser('totp-start-non-admin', 'tech@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({}))

    expect(res.status).toBe(403)
  })

  it('issues a fresh enrollment (otpauthUri/secretBase32/10 recovery codes) when MFA is not yet enabled', async () => {
    const user = await makeUser('totp-start-fresh', 'admin-fresh@herbe-service.test', 'admin')
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({}))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.otpauthUri).toContain('otpauth://totp/')
    expect(typeof body.secretBase32).toBe('string')
    expect(body.recoveryCodes).toHaveLength(10)
  })

  it('requires a valid currentCode to re-enroll once MFA is already enabled, then issues a new secret', async () => {
    const user = await makeUser('totp-start-reenroll', 'admin-reenroll@herbe-service.test', 'admin')
    const firstEnrollment = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(firstEnrollment.secretBase32, user.email))
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')

    const withoutCode = await POST(makeRequest({}))
    expect(withoutCode.status).toBe(403)

    const validCode = currentCodeFor(firstEnrollment.secretBase32, user.email)
    const withCode = await POST(makeRequest({ currentCode: validCode }))
    const body = await withCode.json()

    expect(withCode.status).toBe(200)
    expect(body.secretBase32).not.toBe(firstEnrollment.secretBase32)
  })
})
