// app/(field)/jobs/[id]/page.test.tsx
//
// Task 5: same DB-backed harness/mock-seam convention as
// app/(office)/c/[companyId]/orders/page.test.tsx — session/redirect,
// notFound(), and next-intl/server's getTranslations stubbed to echo the
// message key back.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { Role } from '@/lib/auth/roles'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { insertWorksheet, setWorksheetStatus } from '@/lib/domain/stores/worksheets'
import { WorksheetStepper } from '@/components/worksheet-stepper'

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

describe('JobDetailPage (field shell — F4 execution screen)', () => {
  beforeEach(() => {
    authMock.mockReset()
    redirectMock.mockClear()
    notFoundMock.mockClear()
  })

  it('redirects to /login when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: JobDetailPage } = await import('./page')

    await expect(JobDetailPage({ params: Promise.resolve({ id: 'x' }) })).rejects.toThrow('REDIRECT:/login')
    expect(redirectMock).toHaveBeenCalledWith('/login')
  })

  it('redirects a non-field role (dispatcher) to / (FIX-9)', async () => {
    const tenant = await makeTenant('job-detail-dispatcher-tenant')
    const user = await makeUser(tenant.id, 'dispatch@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: JobDetailPage } = await import('./page')

    await expect(JobDetailPage({ params: Promise.resolve({ id: 'x' }) })).rejects.toThrow('REDIRECT:/')
    expect(redirectMock).toHaveBeenCalledWith('/')
  })

  it('calls notFound() for a worksheet id that does not exist', async () => {
    const tenant = await makeTenant('job-detail-missing-tenant')
    const technician = await makeUser(tenant.id, 'tech-missing@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(technician))
    const { default: JobDetailPage } = await import('./page')

    await expect(
      JobDetailPage({ params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) }),
    ).rejects.toThrow('NOT_FOUND')
    expect(notFoundMock).toHaveBeenCalled()
  })

  it("calls notFound() for a worksheet belonging to a different tenant", async () => {
    const tenantA = await makeTenant('job-detail-foreign-tenant-a')
    const tenantB = await makeTenant('job-detail-foreign-tenant-b')
    const companyB = await makeCompany(tenantB.id, 'job-detail-foreign-company-b')
    const customerB = await makeCustomer(tenantB.id, companyB.id, 'foreign', 'Foreign Co')
    const orderB = await insertServiceOrder(db, { tenantId: tenantB.id, customerId: customerB.id })
    const technicianB = await makeUser(tenantB.id, 'tech-b@herbe-service.test', 'technician')
    const worksheetB = await insertWorksheet(db, {
      tenantId: tenantB.id,
      orderId: orderB.id,
      technicianUserId: technicianB.id,
    })

    const technicianA = await makeUser(tenantA.id, 'tech-a@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(technicianA))
    const { default: JobDetailPage } = await import('./page')

    await expect(JobDetailPage({ params: Promise.resolve({ id: worksheetB.id }) })).rejects.toThrow('NOT_FOUND')
    expect(notFoundMock).toHaveBeenCalled()
  })

  it("calls notFound() for a worksheet assigned to a DIFFERENT technician", async () => {
    const tenant = await makeTenant('job-detail-not-mine-tenant')
    const company = await makeCompany(tenant.id, 'job-detail-not-mine-company')
    const customer = await makeCustomer(tenant.id, company.id, 'not-mine', 'Not Mine Co')
    const order = await insertServiceOrder(db, { tenantId: tenant.id, customerId: customer.id })
    const ownerTechnician = await makeUser(tenant.id, 'tech-owner@herbe-service.test', 'technician')
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      orderId: order.id,
      technicianUserId: ownerTechnician.id,
    })

    const otherTechnician = await makeUser(tenant.id, 'tech-intruder@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(otherTechnician))
    const { default: JobDetailPage } = await import('./page')

    await expect(JobDetailPage({ params: Promise.resolve({ id: worksheet.id }) })).rejects.toThrow('NOT_FOUND')
    expect(notFoundMock).toHaveBeenCalled()
  })

  it('renders the worksheet summary and stepper for its own technician', async () => {
    const tenant = await makeTenant('job-detail-ok-tenant')
    const company = await makeCompany(tenant.id, 'job-detail-ok-company')
    const customer = await makeCustomer(tenant.id, company.id, 'ok', 'Acme OU')
    const order = await insertServiceOrder(db, {
      tenantId: tenant.id,
      customerId: customer.id,
      description: 'Leaking radiator, unit 3',
    })
    const technician = await makeUser(tenant.id, 'tech-ok@herbe-service.test', 'technician')
    const worksheet = await insertWorksheet(db, {
      tenantId: tenant.id,
      orderId: order.id,
      technicianUserId: technician.id,
      workDescription: 'Replaced valve',
    })
    await setWorksheetStatus(db, tenant.id, worksheet.id, 'In progress')

    authMock.mockResolvedValue(sessionFor(technician))
    const { default: JobDetailPage } = await import('./page')

    const element = (await JobDetailPage({ params: Promise.resolve({ id: worksheet.id }) })) as El<{
      children: [El<{ href: string; children: string }>, El<{ children: string }>, El<{ children: string }>, El<{ children: string }>, El]
    }>
    const [backLink, heading, orderSummary, status, stepper] = element.props.children

    expect(backLink.props.href).toBe('/jobs')
    expect(backLink.props.children).toBe('back_to_list')
    expect(heading.props.children).toBe('Acme OU')
    expect(orderSummary.props.children).toBe('Leaking radiator, unit 3')
    expect(status.props.children).toBe('status_in_progress')

    expect(stepper.type).toBe(WorksheetStepper)
    const stepperProps = stepper.props as {
      worksheetId: string
      status: string
      workDescription: string
      labels: Record<string, string>
    }
    expect(stepperProps.worksheetId).toBe(worksheet.id)
    expect(stepperProps.status).toBe('In progress')
    expect(stepperProps.workDescription).toBe('Replaced valve')
    expect(stepperProps.labels).toEqual({
      workDescriptionLabel: 'work_description_label',
      actionAccept: 'action_accept',
      actionStart: 'action_start',
      actionPause: 'action_pause',
      actionDone: 'action_done',
      errorGeneric: 'error_generic',
    })
  })
})
