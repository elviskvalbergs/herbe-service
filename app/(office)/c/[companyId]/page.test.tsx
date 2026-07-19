// app/(office)/c/[companyId]/page.test.tsx
//
// Same seams/mocks as app/page.test.tsx: `@/lib/db` reads DATABASE_URL at
// module-load time, `getVerifiedSession` calls `auth()` from `@/lib/auth`
// (mocked here), and `next/navigation`'s `redirect()` is stubbed to throw
// (it never returns in real Next.js).
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

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

async function makeUser(tenantSlug: string, email: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug: tenantSlug, name: tenantSlug }).returning()
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email, role: 'admin' }).returning()
  return user
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

describe('CompanyHomePage (office shell placeholder)', () => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: CompanyHomePage } = await import('./page')

    await expect(CompanyHomePage({ params: Promise.resolve({ companyId: 'irrelevant' }) })).rejects.toThrow(
      'REDIRECT:/login',
    )
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it('renders the companyId from the route params for an authenticated user', async () => {
    const user = await makeUser('office-company-home', 'admin@herbe-service.test')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: CompanyHomePage } = await import('./page')

    const element = (await CompanyHomePage({ params: Promise.resolve({ companyId: 'company-abc' }) })) as {
      type: string
      props: { children: [unknown, { props: { children: string } }] }
    }

    expect(element.type).toBe('main')
    expect(element.props.children[1].props.children).toContain('company-abc')
  })
})
