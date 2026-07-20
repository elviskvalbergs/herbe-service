// app/(field)/today/page.test.tsx
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

describe('TodayPage (field shell)', () => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: TodayPage } = await import('./page')

    await expect(TodayPage()).rejects.toThrow('REDIRECT:/login')
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it('does not show the team-lead switch note for a technician', async () => {
    const user = await makeUser('today-technician', 'tech@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: TodayPage } = await import('./page')

    const element = (await TodayPage()) as { props: { children: unknown[] } }
    const [, , switchNote] = element.props.children

    expect(switchNote).toBeNull()
  })

  it('shows the team-lead switch note for a team_lead', async () => {
    const user = await makeUser('today-team-lead', 'lead@herbe-service.test', 'team_lead')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: TodayPage } = await import('./page')

    const element = (await TodayPage()) as { props: { children: unknown[] } }
    const [, , switchNote] = element.props.children as [unknown, unknown, { props: Record<string, unknown> }]

    expect(switchNote).not.toBeNull()
    expect(switchNote.props['data-testid']).toBe('team-lead-switch-note')
  })
})
