// app/(field)/field-stub-pages.test.tsx
//
// Covers the field-shell tab stubs (Jobs/Scan) that Task 5 creates as honest
// "coming soon" chrome — same session-gate shape as
// app/(field)/today/page.tsx (getVerifiedSession -> redirect('/login') when
// absent), no branch logic of their own beyond that. Consolidated into one
// test file (one test database) rather than near-identical page.test.tsx
// files, since there's nothing page-specific to isolate beyond the title
// text — same seams/mocks as app/page.test.tsx. More and Inbox were in this
// list too until Task 7 (briefcase) and Task 8 (conflict inbox) gave them
// real content — they now have their own DB-backed test files
// (app/(field)/more/page.test.tsx, app/(field)/inbox/page.test.tsx).
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
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email, role: 'technician' }).returning()
  return user
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

const STUB_PAGES = [
  { name: 'JobsPage', modulePath: './jobs/page', title: 'Jobs' },
  { name: 'ScanPage', modulePath: './scan/page', title: 'Scan' },
] as const

describe.each(STUB_PAGES)('$name (field shell tab stub)', ({ modulePath, title }) => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: Page } = await import(/* @vite-ignore */ modulePath)

    await expect(Page()).rejects.toThrow('REDIRECT:/login')
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it('renders an honest coming-soon placeholder for an authenticated user', async () => {
    const user = await makeUser(`stub-${title.toLowerCase()}`, `${title.toLowerCase()}@herbe-service.test`)
    authMock.mockResolvedValue(sessionFor(user))
    const { default: Page } = await import(/* @vite-ignore */ modulePath)

    const element = (await Page()) as { type: string; props: { children: [{ props: { children: string } }, { props: { children: string } }] } }
    const [heading, body] = element.props.children

    expect(element.type).toBe('main')
    expect(heading.props.children).toBe(title)
    expect(body.props.children).toBe('Coming soon.')
  })
})
