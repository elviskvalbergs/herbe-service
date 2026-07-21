// app/(office)/c/[companyId]/worksheets/page.test.tsx
//
// Task 6: same DB-backed harness/mock-seam convention as
// app/(office)/c/[companyId]/orders/page.test.tsx — `next-intl/server`'s
// `getTranslations` is stubbed to echo the message key back rather than
// exercising the real request-locale -> message-catalog pipeline; this file
// only asserts THIS page's own wiring: session/capability/tenant gating,
// which store it reads, and what it hands to <WorksheetApprovalQueue>.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { Role } from '@/lib/auth/roles'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { insertWorksheet, setWorksheetStatus } from '@/lib/domain/stores/worksheets'
import { WorksheetApprovalQueue } from '@/components/worksheet-approval-queue'

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

describe('WorksheetsPage (O4 approval queue)', () => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
    notFoundMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: WorksheetsPage } = await import('./page')

    await expect(WorksheetsPage({ params: Promise.resolve({ companyId: 'x' }) })).rejects.toThrow('REDIRECT:/login')
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it("calls notFound() for a role without 'worksheet:approve' (technician) — FIX-13 at the page", async () => {
    const tenant = await makeTenant('worksheets-page-403-tenant')
    const user = await makeUser(tenant.id, 'tech@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: WorksheetsPage } = await import('./page')

    await expect(WorksheetsPage({ params: Promise.resolve({ companyId: 'x' }) })).rejects.toThrow('NOT_FOUND')
    expect(notFoundMock).toHaveBeenCalled()
  })

  it('calls notFound() for a companyId belonging to a different tenant', async () => {
    const tenantA = await makeTenant('worksheets-page-404-tenant-a')
    const tenantB = await makeTenant('worksheets-page-404-tenant-b')
    const companyB = await makeCompany(tenantB.id, 'worksheets-page-404-company-b')
    const dispatcherA = await makeUser(tenantA.id, 'dispatcher@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcherA))
    const { default: WorksheetsPage } = await import('./page')

    await expect(WorksheetsPage({ params: Promise.resolve({ companyId: companyB.id }) })).rejects.toThrow('NOT_FOUND')
    expect(notFoundMock).toHaveBeenCalled()
  })

  it('renders Done worksheets for this company fed with order/customer/technician display data', async () => {
    const tenant = await makeTenant('worksheets-page-ok-tenant')
    const company = await makeCompany(tenant.id, 'worksheets-page-ok-company')
    const [customer] = await db
      .insert(schema.customers)
      .values({ tenantId: tenant.id, erpCompanyId: company.id, erpRef: 'CUST-1', name: 'Acme OU', changeSeq: BigInt(0) })
      .returning()
    const order = await insertServiceOrder(db, { tenantId: tenant.id, erpCompanyId: company.id, customerId: customer.id })
    const technicianUser = await makeUser(tenant.id, 'tech@herbe-service.test', 'technician')
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      erpCompanyId: company.id,
      orderId: order.id,
      technicianUserId: technicianUser.id,
      workDescription: 'Replaced the pump',
    })
    await setWorksheetStatus(db, tenant.id, worksheet.id, 'Done')

    // A worksheet for a DIFFERENT company must not leak into this list.
    const otherCompany = await makeCompany(tenant.id, 'worksheets-page-ok-other-company')
    const [otherCustomer] = await db
      .insert(schema.customers)
      .values({ tenantId: tenant.id, erpCompanyId: otherCompany.id, erpRef: 'CUST-2', name: 'Other OU', changeSeq: BigInt(0) })
      .returning()
    const otherOrder = await insertServiceOrder(db, { tenantId: tenant.id, erpCompanyId: otherCompany.id, customerId: otherCustomer.id })
    const otherWorksheet = await insertWorksheet(db, { tenantId: tenant.id, erpCompanyId: otherCompany.id, orderId: otherOrder.id })
    await setWorksheetStatus(db, tenant.id, otherWorksheet.id, 'Done')

    const dispatcher = await makeUser(tenant.id, 'dispatcher@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcher))

    const { default: WorksheetsPage } = await import('./page')
    const element = (await WorksheetsPage({ params: Promise.resolve({ companyId: company.id }) })) as El<{
      children: [El<{ children: string }>, El<Record<string, unknown>>]
    }>

    expect(element.type).toBe('main')
    const [heading, queue] = element.props.children
    expect(heading.props.children).toBe('title')

    expect(queue.type).toBe(WorksheetApprovalQueue)
    const queueProps = queue.props as {
      items: { id: string; orderNumber: string | null; customerName: string; technicianEmail: string | null; workDescription: string | null }[]
      labels: Record<string, string>
    }
    expect(queueProps.items).toEqual([
      {
        id: worksheet.id,
        orderNumber: null,
        customerName: 'Acme OU',
        technicianEmail: 'tech@herbe-service.test',
        workDescription: 'Replaced the pump',
      },
    ])
    expect(queueProps.labels).toEqual({
      columnOrder: 'column_order',
      columnCustomer: 'column_customer',
      columnTechnician: 'column_technician',
      columnWorkDescription: 'column_work_description',
      approveLabel: 'approve_label',
      approvingLabel: 'approving_label',
      errorGeneric: 'error_generic',
      emptyState: 'empty_state',
    })
  })
})
