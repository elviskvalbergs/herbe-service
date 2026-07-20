// app/(field)/more/page.test.tsx
//
// Task 7: More gets its own DB-backed test now that it has real content
// (previously covered by the generic field-stub-pages.test.tsx describe.each
// — see that file's header comment). Same session-gate seams/mocks as that
// file (auth mocked at the module seam, next/navigation's redirect mocked to
// throw so the `redirect()` call is observable). Bucket-count correctness
// itself (purged scope_membership rows excluded, non-pending outbox_ops
// excluded, tenant/user scoping) is covered exhaustively in
// lib/offline/briefcase-summary.test.ts — this file only proves the page
// wires the signed-in session's userId/tenantId into that loader and passes
// its result through to <BriefcaseSummary> untouched. The page now also
// renders <LocaleSwitcher> (components/locale-switcher.tsx) in its own
// section; that component is referenced here only as an element *type*,
// never invoked, so its useLocale()/useRouter() hooks never run — but
// importing the page still transitively imports the real 'next-intl'
// barrel, which crashes under this project's forced 'react-server' resolve
// condition (see components/locale-switcher.test.ts for the full
// explanation), so it's stubbed here purely to make the module graph
// loadable, same as the next/navigation stub below.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { enterScope } from '@/lib/sync/scope-membership'
import { BriefcaseSummary } from '@/components/briefcase-summary'
import { LocaleSwitcher } from '@/components/locale-switcher'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirectMock(url) }))
vi.mock('next-intl', () => ({ useLocale: () => 'en' }))

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

describe('MorePage', () => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: Page } = await import('./page')

    await expect(Page()).rejects.toThrow('REDIRECT:/login')
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it('renders the briefcase section fed by the signed-in user/tenant\'s real counts', async () => {
    const user = await makeUser('more-page-briefcase', 'more-briefcase@herbe-service.test')
    await enterScope(db, { userId: user.id, entityType: 'note', entityId: 'n1' })
    authMock.mockResolvedValue(sessionFor(user))

    const { default: Page } = await import('./page')
    const element = (await Page()) as {
      type: string
      props: {
        children: [
          { props: { children: string } },
          { type: string; props: { children: [{ props: { children: string } }, { type: unknown; props: { buckets: unknown } }] } },
          { type: string; props: { children: [{ props: { children: string } }, { type: unknown; props: Record<string, never> }] } },
          { props: { children: string } },
        ]
      }
    }
    const [heading, briefcaseSection, languageSection] = element.props.children

    expect(element.type).toBe('main')
    expect(heading.props.children).toBe('More')
    expect(briefcaseSection.type).toBe('section')

    const [sectionHeading, summary] = briefcaseSection.props.children
    expect(sectionHeading.props.children).toBe('Your briefcase')
    expect(summary.type).toBe(BriefcaseSummary)
    expect(summary.props.buckets).toEqual([
      { label: 'Assigned to you', count: 1 },
      { label: 'Pending sync', count: 0 },
    ])

    expect(languageSection.type).toBe('section')
    const [languageHeading, switcher] = languageSection.props.children
    expect(languageHeading.props.children).toBe('Language')
    expect(switcher.type).toBe(LocaleSwitcher)
  })
})
