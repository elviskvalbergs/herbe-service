// app/(field)/jobs/page.test.tsx
//
// Task 5: same DB-backed harness/mock-seam convention as
// app/(field)/today/page.test.tsx (session/redirect) and
// app/(office)/c/[companyId]/orders/page.test.tsx (getTranslations stub —
// echoes the message key back rather than exercising the real
// request-locale -> message-catalog pipeline, already proven end-to-end for
// the 'app' namespace by app/layout.test.tsx).
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { Role } from '@/lib/auth/roles'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { insertWorksheet, setWorksheetStatus } from '@/lib/domain/stores/worksheets'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirectMock(url) }))

vi.mock('next-intl/server', () => ({
  getTranslations: async (_namespace: string) => (key: string) => key,
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

async function makeCompany(tenantId: string, slug: string) {
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: slug, adapterType: 'standard_books' })
    .returning()
  return company
}

async function makeCustomer(tenantId: string, erpCompanyId: string, slug: string, name: string) {
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: `CUST-${slug}`, name, changeSeq: BigInt(0) })
    .returning()
  return customer
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

type El<P = Record<string, unknown>> = { type: unknown; props: P }

describe('JobsPage (field shell — my jobs list)', () => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: JobsPage } = await import('./page')

    await expect(JobsPage()).rejects.toThrow('REDIRECT:/login')
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it('redirects a non-field role (dispatcher) to / (FIX-9)', async () => {
    const tenant = await makeTenant('jobs-page-dispatcher-tenant')
    const user = await makeUser(tenant.id, 'dispatch@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: JobsPage } = await import('./page')

    await expect(JobsPage()).rejects.toThrow('REDIRECT:/')
    expect(redirectMock).toHaveBeenCalledWith('/')
  })

  it('shows an empty state when the technician has no worksheets', async () => {
    const tenant = await makeTenant('jobs-page-empty-tenant')
    const technician = await makeUser(tenant.id, 'tech-empty@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(technician))
    const { default: JobsPage } = await import('./page')

    const element = (await JobsPage()) as El<{ children: [El<{ children: string }>, El<{ children: string }>] }>
    const [heading, empty] = element.props.children

    expect(heading.props.children).toBe('jobs_title')
    expect(empty.props.children).toBe('jobs_empty')
  })

  it("lists only the technician's own worksheets, with customer/order summary and status, linking to the detail page", async () => {
    const tenant = await makeTenant('jobs-page-list-tenant')
    const company = await makeCompany(tenant.id, 'jobs-page-list-company')
    const customer = await makeCustomer(tenant.id, company.id, 'jobs-list', 'Acme OU')
    const order = await insertServiceOrder(db, {
      tenantId: tenant.id,
      customerId: customer.id,
      description: 'Leaking radiator',
    })
    const technician = await makeUser(tenant.id, 'tech-list@herbe-service.test', 'technician')
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      orderId: order.id,
      technicianUserId: technician.id,
    })
    await setWorksheetStatus(db, tenant.id, worksheet.id, 'Assigned')

    // Another technician's worksheet on the same order must not leak into
    // this technician's list.
    const otherTechnician = await makeUser(tenant.id, 'tech-other@herbe-service.test', 'technician')
    await insertWorksheet(db, { tenantId: tenant.id, orderId: order.id, technicianUserId: otherTechnician.id })

    authMock.mockResolvedValue(sessionFor(technician))
    const { default: JobsPage } = await import('./page')

    const element = (await JobsPage()) as El<{
      children: [El, El<{ children: El<{ children: El<{ href: string; children: El<{ children: string }>[] }> }>[] }>]
    }>
    const [, list] = element.props.children
    const items = list.props.children
    expect(items).toHaveLength(1)

    const link = items[0].props.children
    expect(link.props.href).toBe(`/jobs/${worksheet.id}`)

    const [customerNameEl, orderSummaryEl, statusEl] = link.props.children
    expect(customerNameEl.props.children).toBe('Acme OU')
    expect(orderSummaryEl.props.children).toBe('Leaking radiator')
    expect(statusEl.props.children).toBe('status_assigned')
  })
})
