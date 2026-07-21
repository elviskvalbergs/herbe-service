// app/(office)/c/[companyId]/orders/page.test.tsx
//
// Task 4: same DB-backed harness/mock-seam convention as
// app/(field)/today/page.test.tsx. `next-intl/server`'s `getTranslations` is
// stubbed to echo the message key back rather than exercising the real
// request-locale -> message-catalog pipeline (already proven end-to-end for
// the 'app' namespace by app/layout.test.tsx) — this file only asserts THIS
// page's own wiring: session/capability/tenant gating, which stores it
// reads, and what it hands to <NewBookingForm>.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { Role } from '@/lib/auth/roles'
import { NewBookingForm } from '@/components/new-booking-form'

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
}))

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

async function makeCompany(tenantId: string, slug: string, active = true) {
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: slug, adapterType: 'standard_books', active })
    .returning()
  return company
}

async function makeUser(tenantId: string, email: string, role: Role) {
  const [user] = await db.insert(schema.users).values({ tenantId, email, role }).returning()
  return user
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

type El<P> = { type: unknown; props: P }

describe('OrdersPage (office shell booking form)', () => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
    notFoundMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: OrdersPage } = await import('./page')

    await expect(OrdersPage({ params: Promise.resolve({ companyId: 'x' }) })).rejects.toThrow('REDIRECT:/login')
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it("calls notFound() for a role without 'order:view_all' (technician)", async () => {
    const tenant = await makeTenant('orders-page-403-tenant')
    const user = await makeUser(tenant.id, 'tech@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: OrdersPage } = await import('./page')

    await expect(OrdersPage({ params: Promise.resolve({ companyId: 'x' }) })).rejects.toThrow('NOT_FOUND')
    expect(notFoundMock).toHaveBeenCalled()
  })

  it("calls notFound() for a companyId belonging to a different tenant", async () => {
    const tenantA = await makeTenant('orders-page-404-tenant-a')
    const tenantB = await makeTenant('orders-page-404-tenant-b')
    const companyB = await makeCompany(tenantB.id, 'orders-page-404-company-b')
    const dispatcherA = await makeUser(tenantA.id, 'dispatcher@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcherA))
    const { default: OrdersPage } = await import('./page')

    await expect(OrdersPage({ params: Promise.resolve({ companyId: companyB.id }) })).rejects.toThrow('NOT_FOUND')
    expect(notFoundMock).toHaveBeenCalled()
  })

  it('renders the booking form fed by this company\'s customers and linked technicians', async () => {
    const tenant = await makeTenant('orders-page-ok-tenant')
    const company = await makeCompany(tenant.id, 'orders-page-ok-company')
    const [customer] = await db
      .insert(schema.customers)
      .values({ tenantId: tenant.id, erpCompanyId: company.id, erpRef: 'CUST-1', name: 'Acme OU', changeSeq: BigInt(0) })
      .returning()
    const technicianUser = await makeUser(tenant.id, 'tech@herbe-service.test', 'technician')
    await db.insert(schema.identityLinks).values({
      tenantId: tenant.id,
      userId: technicianUser.id,
      provider: 'erp',
      erpCompanyId: company.id,
      externalId: 'EM-1',
      linkedBy: 'test-setup',
    })
    const dispatcher = await makeUser(tenant.id, 'dispatcher@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcher))

    const { default: OrdersPage } = await import('./page')
    const element = (await OrdersPage({ params: Promise.resolve({ companyId: company.id }) })) as El<{
      children: [El<{ children: string }>, El<Record<string, unknown>>]
    }>

    expect(element.type).toBe('main')
    const [heading, form] = element.props.children
    expect(heading.props.children).toBe('title')

    expect(form.type).toBe(NewBookingForm)
    const formProps = form.props as {
      companyId: string
      customers: { id: string; name: string }[]
      technicians: { id: string; email: string }[]
      labels: Record<string, string>
    }
    expect(formProps.companyId).toBe(company.id)
    expect(formProps.customers).toEqual([{ id: customer.id, name: 'Acme OU' }])
    expect(formProps.technicians).toEqual([{ id: technicianUser.id, email: 'tech@herbe-service.test' }])
    expect(formProps.labels).toEqual({
      customerLabel: 'customer_label',
      customerPlaceholder: 'customer_placeholder',
      technicianLabel: 'technician_label',
      technicianPlaceholder: 'technician_placeholder',
      descriptionLabel: 'description_label',
      submitLabel: 'submit_label',
      errorGeneric: 'error_generic',
    })
  })
})
