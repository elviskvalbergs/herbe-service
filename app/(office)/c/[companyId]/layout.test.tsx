// app/(office)/c/[companyId]/layout.test.tsx
//
// DB-backed, same seams/harness as app/(office)/c/[companyId]/page.test.tsx
// and app/page.test.tsx: `@/lib/db` reads DATABASE_URL at module-load time,
// `getVerifiedSession` calls `auth()` from `@/lib/auth` (mocked here), and
// `next/navigation`'s `redirect()`/`notFound()` are stubbed to throw (neither
// ever returns in real Next.js).
//
// OfficeLayout is an async server component with no hooks of its own — like
// app/(field)/layout.tsx's FieldLayout, it's tested by calling it directly
// and asserting on the returned element tree. Its children (OfficeNavList,
// CompanySwitcher, the shadcn Sheet family) are referenced only as element
// *types*/props, never invoked, so their own hook usage never runs — same
// pattern as app/(field)/layout.test.tsx.
//
// `@/components/ui/sheet` is mocked wholesale rather than mocking `radix-ui`
// piece by piece: it's vendored boilerplate (see that file's header comment)
// with no logic of this task's own to verify, and its real Dialog primitive
// crashes on import under this project's forced 'react-server' resolve
// condition (same class of issue as next/navigation/next/link/lucide-react —
// see components/locale-switcher.test.ts) — mocking our own module sidesteps
// that without re-implementing Radix's API surface in the mock.
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
const notFoundMock = vi.fn(() => {
  throw new Error('NOT_FOUND')
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
  notFound: () => notFoundMock(),
  usePathname: () => '/c/co-1/orders',
}))
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => props }))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: () => null,
  SheetTrigger: () => null,
  SheetContent: () => null,
  SheetTitle: () => null,
  SheetDescription: () => null,
}))

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

async function makeTenant(slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  return tenant
}

async function makeUser(tenantId: string, email: string, role: Role) {
  const [user] = await db.insert(schema.users).values({ tenantId, email, role }).returning()
  return user
}

async function makeCompany(tenantId: string, displayName: string, opts: { active?: boolean } = {}) {
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName, adapterType: 'standard_books', active: opts.active ?? true })
    .returning()
  return company
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

type El<P = Record<string, unknown>> = { type: unknown; props: P }

describe('OfficeLayout', () => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
    notFoundMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: OfficeLayout } = await import('./layout')

    await expect(
      OfficeLayout({ children: null, params: Promise.resolve({ companyId: 'irrelevant' }) }),
    ).rejects.toThrow('REDIRECT:/login')
    expect(redirectMock).toHaveBeenCalledWith('/login')
    expect(notFoundMock).not.toHaveBeenCalled()
  })

  it.each(['technician', 'team_lead'] as const)('redirects %s to / — not an office-shell role', async (role) => {
    const tenant = await makeTenant(`office-layout-${role}`)
    const user = await makeUser(tenant.id, `${role}@herbe-service.test`, role)
    authMock.mockResolvedValue(sessionFor(user))
    const { default: OfficeLayout } = await import('./layout')

    await expect(
      OfficeLayout({ children: null, params: Promise.resolve({ companyId: 'irrelevant' }) }),
    ).rejects.toThrow('REDIRECT:/')
    expect(redirectMock).toHaveBeenCalledWith('/')
  })

  it('404s when :companyId does not exist at all — no information leak vs. a foreign tenant', async () => {
    const tenant = await makeTenant('office-layout-missing-company')
    const user = await makeUser(tenant.id, 'admin@herbe-service.test', 'admin')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: OfficeLayout } = await import('./layout')

    await expect(
      OfficeLayout({ children: null, params: Promise.resolve({ companyId: '00000000-0000-0000-0000-000000000000' }) }),
    ).rejects.toThrow('NOT_FOUND')
  })

  it('404s when :companyId belongs to a different tenant', async () => {
    const ownTenant = await makeTenant('office-layout-own-tenant')
    const otherTenant = await makeTenant('office-layout-other-tenant')
    const user = await makeUser(ownTenant.id, 'admin@herbe-service.test', 'admin')
    const foreignCompany = await makeCompany(otherTenant.id, 'Foreign Co')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: OfficeLayout } = await import('./layout')

    await expect(
      OfficeLayout({ children: null, params: Promise.resolve({ companyId: foreignCompany.id }) }),
    ).rejects.toThrow('NOT_FOUND')
  })

  it('404s when :companyId belongs to the caller\'s own tenant but is deactivated — same outcome as missing/foreign', async () => {
    const tenant = await makeTenant('office-layout-inactive-company')
    const user = await makeUser(tenant.id, 'admin@herbe-service.test', 'admin')
    const inactiveCompany = await makeCompany(tenant.id, 'Deactivated Co', { active: false })
    authMock.mockResolvedValue(sessionFor(user))
    const { default: OfficeLayout } = await import('./layout')

    await expect(
      OfficeLayout({ children: null, params: Promise.resolve({ companyId: inactiveCompany.id }) }),
    ).rejects.toThrow('NOT_FOUND')
  })

  it.each(['dispatcher', 'back_office', 'admin'] as const)(
    'renders the shell for the office role %s owning the company',
    async (role) => {
      const tenant = await makeTenant(`office-layout-role-${role}`)
      const user = await makeUser(tenant.id, `${role}@herbe-service.test`, role)
      const company = await makeCompany(tenant.id, 'Solo Co')
      authMock.mockResolvedValue(sessionFor(user))
      const { default: OfficeLayout } = await import('./layout')

      const element = (await OfficeLayout({
        children: 'child-marker',
        params: Promise.resolve({ companyId: company.id }),
      })) as El<{ children: [El, El, El] }>

      const [, , main] = element.props.children
      expect((main as El<{ children: unknown }>).type).toBe('main')
      expect((main as El<{ children: unknown }>).props.children).toBe('child-marker')
    },
  )

  it('passes only the single active company to the switcher for a single-company tenant (hidden per doc07)', async () => {
    const tenant = await makeTenant('office-layout-single-company')
    const user = await makeUser(tenant.id, 'admin@herbe-service.test', 'admin')
    const company = await makeCompany(tenant.id, 'Solo Co')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: OfficeLayout } = await import('./layout')
    const { CompanySwitcher } = await import('@/components/company-switcher')
    const { OfficeNavList } = await import('@/components/office-nav')

    const element = (await OfficeLayout({
      children: null,
      params: Promise.resolve({ companyId: company.id }),
    })) as El<{ children: [El<{ children: [El, El<{ companies: unknown[]; activeCompanyId: string }>, El<{ role: string; companyId: string }>] }>, El, El] }>

    const [aside] = element.props.children
    expect(aside.type).toBe('aside')
    const [, switcherEl, navEl] = aside.props.children
    expect(switcherEl.type).toBe(CompanySwitcher)
    expect(switcherEl.props.companies).toHaveLength(1)
    expect(switcherEl.props.activeCompanyId).toBe(company.id)
    expect(navEl.type).toBe(OfficeNavList)
    expect(navEl.props.role).toBe('admin')
    expect(navEl.props.companyId).toBe(company.id)
  })

  it('passes every active company (in createdAt order) for a multi-company tenant, excluding inactive ones', async () => {
    const tenant = await makeTenant('office-layout-multi-company')
    const user = await makeUser(tenant.id, 'admin@herbe-service.test', 'admin')
    const first = await makeCompany(tenant.id, 'First Co')
    const second = await makeCompany(tenant.id, 'Second Co')
    await makeCompany(tenant.id, 'Deactivated Co', { active: false })
    authMock.mockResolvedValue(sessionFor(user))
    const { default: OfficeLayout } = await import('./layout')
    const { CompanySwitcher } = await import('@/components/company-switcher')

    const element = (await OfficeLayout({
      children: null,
      params: Promise.resolve({ companyId: second.id }),
    })) as El<{ children: [El<{ children: [El, El<{ companies: { id: string; displayName: string }[] }>, El] }>, El, El] }>

    const [aside] = element.props.children
    const [, switcherEl] = aside.props.children
    expect(switcherEl.type).toBe(CompanySwitcher)
    expect(switcherEl.props.companies.map((c) => c.id)).toEqual([first.id, second.id])
  })

  it('renders the mobile Sheet drawer alongside the desktop aside', async () => {
    const tenant = await makeTenant('office-layout-sheet')
    const user = await makeUser(tenant.id, 'admin@herbe-service.test', 'admin')
    const company = await makeCompany(tenant.id, 'Solo Co')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: OfficeLayout } = await import('./layout')
    const { Sheet, SheetTrigger, SheetContent } = await import('@/components/ui/sheet')

    const element = (await OfficeLayout({
      children: null,
      params: Promise.resolve({ companyId: company.id }),
    })) as El<{ children: [El, El<{ children: [El, El] }>, El] }>

    const [, sheet] = element.props.children
    expect(sheet.type).toBe(Sheet)
    const [trigger, content] = sheet.props.children
    expect(trigger.type).toBe(SheetTrigger)
    expect(content.type).toBe(SheetContent)
  })
})
