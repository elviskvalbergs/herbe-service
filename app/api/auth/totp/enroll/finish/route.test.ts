// app/api/auth/totp/enroll/finish/route.test.ts
//
// Same DATABASE_URL-at-import-time / auth() mock convention as
// app/api/auth/devices/route.test.ts, plus the MASTER_ENCRYPTION_KEY
// fallback from lib/auth/totp.test.ts (enrollTotp envelope-encrypts the
// secret).
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { Secret, TOTP } from 'otpauth'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { enrollTotp } from '@/lib/auth/totp'

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
  return new Request('http://localhost/api/auth/totp/enroll/finish', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function currentCodeFor(secretBase32: string, email: string): string {
  const totp = new TOTP({ issuer: 'herbe.service', label: email, issuerInLabel: true, secret: Secret.fromBase32(secretBase32), algorithm: 'SHA1', digits: 6, period: 30 })
  return totp.generate()
}

describe('POST /api/auth/totp/enroll/finish', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401', async () => {
    authMock.mockResolvedValue(null)

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ code: '000000' }))

    expect(res.status).toBe(401)
  })

  it('rejects a non-admin caller with 403', async () => {
    const user = await makeUser('totp-finish-non-admin', 'tech@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ code: '000000' }))

    expect(res.status).toBe(403)
  })

  it('rejects a wrong code with 400 invalid_code and leaves mfaEnabled false', async () => {
    const user = await makeUser('totp-finish-wrong', 'admin-wrong@herbe-service.test', 'admin')
    await enrollTotp(db, user.id, user.email)
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ code: '000000' }))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('invalid_code')

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.mfaEnabled).toBe(false)
  })

  it('accepts a correct code, returns 200, and flips mfaEnabled true in the DB', async () => {
    const user = await makeUser('totp-finish-ok', 'admin-ok@herbe-service.test', 'admin')
    const enrolled = await enrollTotp(db, user.id, user.email)
    authMock.mockResolvedValue(sessionFor(user))

    const { POST } = await import('./route')
    const res = await POST(makeRequest({ code: currentCodeFor(enrolled.secretBase32, user.email) }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.mfaEnabled).toBe(true)
  })
})
