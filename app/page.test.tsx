// app/page.test.tsx
//
// `@/app/page` transitively imports `@/lib/db`, which reads DATABASE_URL at
// module-load time, so DATABASE_URL must point at the harness DB *before*
// the page is first dynamically imported (same convention as
// app/api/settings/route.test.ts). The page calls `getVerifiedSession`
// (lib/auth/session-guard), which itself calls `auth()` from `@/lib/auth` —
// that's the seam under mock here, not session-guard itself.
//
// `next/navigation`'s `redirect()` never returns in real Next.js — it
// throws a special value that Next's rendering internals catch. The mock
// below re-creates that (throws, tagged with the target URL) so control
// flow after a redirect() call is exercised the same way it is in
// production: nothing after it runs. This also sidesteps `next/navigation`'s
// barrel import crashing under this project's forced 'react-server' resolve
// condition (see components/locale-switcher.test.ts for the same issue with
// the real module).
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { Role } from '@/lib/auth/roles'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirectMock(url) }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
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

async function makeUser(tenantSlug: string, email: string, role: Role) {
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

async function makeCompany(tenantId: string, displayName: string, opts: { active?: boolean; createdAt?: Date } = {}) {
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({
      tenantId,
      displayName,
      adapterType: 'standard_books',
      active: opts.active ?? true,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning()
  return company
}

describe('Home (/) role-based routing', () => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: Home } = await import('./page')

    await expect(Home()).rejects.toThrow('REDIRECT:/login')
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it.each<Role>(['technician', 'team_lead'])('redirects %s to /today', async (role) => {
    const user = await makeUser(`root-field-${role}`, `${role}@herbe-service.test`, role)
    authMock.mockResolvedValue(sessionFor(user))
    const { default: Home } = await import('./page')

    await expect(Home()).rejects.toThrow('REDIRECT:/today')
    expect(redirectMock).toHaveBeenCalledWith('/today')
  })

  it.each<Role>(['dispatcher', 'back_office', 'admin'])('redirects %s to their tenant default company', async (role) => {
    const user = await makeUser(`root-office-${role}`, `${role}@herbe-service.test`, role)
    const company = await makeCompany(user.tenantId, 'Main Co')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: Home } = await import('./page')

    await expect(Home()).rejects.toThrow(`REDIRECT:/c/${company.id}`)
    expect(redirectMock).toHaveBeenCalledWith(`/c/${company.id}`)
  })

  it('picks the oldest active company when a tenant has more than one', async () => {
    const user = await makeUser('root-multi-company', 'multi@herbe-service.test', 'admin')
    const older = await makeCompany(user.tenantId, 'Older Co', { createdAt: new Date('2026-01-01T00:00:00Z') })
    await makeCompany(user.tenantId, 'Newer Co', { createdAt: new Date('2026-06-01T00:00:00Z') })
    authMock.mockResolvedValue(sessionFor(user))
    const { default: Home } = await import('./page')

    await expect(Home()).rejects.toThrow(`REDIRECT:/c/${older.id}`)
  })

  it('ignores inactive companies and an unrelated tenant when resolving the default', async () => {
    const other = await makeUser('root-other-tenant', 'other@herbe-service.test', 'admin')
    await makeCompany(other.tenantId, 'Other Tenant Co')

    const user = await makeUser('root-inactive-company', 'inactive@herbe-service.test', 'back_office')
    await makeCompany(user.tenantId, 'Inactive Co', { active: false })
    const active = await makeCompany(user.tenantId, 'Active Co')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: Home } = await import('./page')

    await expect(Home()).rejects.toThrow(`REDIRECT:/c/${active.id}`)
  })

  it('renders a no-company-access message instead of redirecting when the tenant has zero active companies', async () => {
    const user = await makeUser('root-no-company', 'no-company@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: Home } = await import('./page')

    const element = (await Home()) as { type: { name: string } }

    expect(redirectMock).not.toHaveBeenCalled()
    // Home() returns <NoCompanyAccess /> unevaluated (RSC returns an
    // element tree, not rendered output) — its `.type` is the component
    // function itself, identified here by name rather than rendering it.
    expect(element.type.name).toBe('NoCompanyAccess')
  })
})
