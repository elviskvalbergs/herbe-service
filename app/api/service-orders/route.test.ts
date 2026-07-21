// app/api/service-orders/route.test.ts
//
// Task 4: WS5-minimal booking. Same DB-backed harness/mock-seam convention as
// app/api/auth/users/[id]/sign-out-everywhere/route.test.ts — DATABASE_URL
// must be set before `./route` is dynamically imported, and `@/lib/auth`'s
// `auth()` is the mocked seam `getVerifiedSession` reaches through.
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { Role } from '@/lib/auth/roles'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

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

async function makeCustomer(tenantId: string, erpCompanyId: string, slug: string) {
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: `CUST-${slug}`, name: slug, changeSeq: BigInt(0) })
    .returning()
  return customer
}

async function makeUser(tenantId: string, email: string, role: Role = 'dispatcher') {
  const [user] = await db.insert(schema.users).values({ tenantId, email, role }).returning()
  return user
}

// Links a technician's identity_links row so listLinkedTechnicians (and thus
// the route's own technician-linked check) finds them.
async function linkTechnician(tenantId: string, userId: string, erpCompanyId: string, externalId: string) {
  await db.insert(schema.identityLinks).values({
    tenantId,
    userId,
    provider: 'erp',
    erpCompanyId,
    externalId,
    linkedBy: 'test-setup',
  })
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

function bookingRequest(body: unknown) {
  return new Request('http://localhost/api/service-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/service-orders', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('rejects an unauthenticated request with 401, writing nothing', async () => {
    authMock.mockResolvedValue(null)

    const { POST } = await import('./route')
    const res = await POST(bookingRequest({}))

    expect(res.status).toBe(401)
    expect(await db.select().from(schema.serviceOrders)).toHaveLength(0)
  })

  it("forbids a role without 'order:view_all' (technician) with 403", async () => {
    const tenant = await makeTenant('booking-403-tenant')
    const company = await makeCompany(tenant.id, 'booking-403-company')
    const customer = await makeCustomer(tenant.id, company.id, 'booking-403-customer')
    const technicianUser = await makeUser(tenant.id, 'tech-403@herbe-service.test', 'technician')
    await linkTechnician(tenant.id, technicianUser.id, company.id, 'EM-403')

    const actor = await makeUser(tenant.id, 'actor-403@herbe-service.test', 'technician')
    authMock.mockResolvedValue(sessionFor(actor))

    const { POST } = await import('./route')
    const res = await POST(
      bookingRequest({
        erpCompanyId: company.id,
        customerId: customer.id,
        technicianUserId: technicianUser.id,
        description: 'should never be created',
      }),
    )

    expect(res.status).toBe(403)
    expect(await db.select().from(schema.serviceOrders)).toHaveLength(0)
  })

  it('creates a ServiceOrder + an Assigned Worksheet linked to the technician, and derives order status Planned', async () => {
    const tenant = await makeTenant('booking-ok-tenant')
    const company = await makeCompany(tenant.id, 'booking-ok-company')
    const customer = await makeCustomer(tenant.id, company.id, 'booking-ok-customer')
    const technicianUser = await makeUser(tenant.id, 'tech-ok@herbe-service.test', 'technician')
    await linkTechnician(tenant.id, technicianUser.id, company.id, 'EM-OK')

    const dispatcher = await makeUser(tenant.id, 'dispatcher-ok@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcher))

    const { POST } = await import('./route')
    const res = await POST(
      bookingRequest({
        erpCompanyId: company.id,
        customerId: customer.id,
        technicianUserId: technicianUser.id,
        description: 'Leaking radiator, unit 3',
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(typeof body.orderId).toBe('string')
    expect(typeof body.worksheetId).toBe('string')

    const [order] = await db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.id, body.orderId))
    expect(order).toMatchObject({
      tenantId: tenant.id,
      erpCompanyId: company.id,
      customerId: customer.id,
      description: 'Leaking radiator, unit 3',
      status: 'Planned',
    })

    const [worksheet] = await db.select().from(schema.worksheets).where(eq(schema.worksheets.id, body.worksheetId))
    expect(worksheet).toMatchObject({
      tenantId: tenant.id,
      erpCompanyId: company.id,
      orderId: order.id,
      technicianUserId: technicianUser.id,
      status: 'Assigned',
    })
  })

  it("returns 404 for an erpCompanyId the session's tenant doesn't own, without leaking existence", async () => {
    const tenantA = await makeTenant('booking-404-tenant-a')
    const tenantB = await makeTenant('booking-404-tenant-b')
    const companyB = await makeCompany(tenantB.id, 'booking-404-company-b')
    const customerB = await makeCustomer(tenantB.id, companyB.id, 'booking-404-customer-b')
    const technicianB = await makeUser(tenantB.id, 'tech-404-b@herbe-service.test', 'technician')
    await linkTechnician(tenantB.id, technicianB.id, companyB.id, 'EM-404-B')

    const dispatcherA = await makeUser(tenantA.id, 'dispatcher-404-a@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcherA))

    const { POST } = await import('./route')
    const res = await POST(
      bookingRequest({
        erpCompanyId: companyB.id,
        customerId: customerB.id,
        technicianUserId: technicianB.id,
        description: 'cross-tenant IDOR attempt',
      }),
    )

    expect(res.status).toBe(404)
    expect(await db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.tenantId, tenantA.id))).toHaveLength(0)
  })

  it('rejects a technician with no identity_links entry for this ERP company with 400 (would dead-end at approval)', async () => {
    const tenant = await makeTenant('booking-unlinked-tenant')
    const company = await makeCompany(tenant.id, 'booking-unlinked-company')
    const customer = await makeCustomer(tenant.id, company.id, 'booking-unlinked-customer')
    // Real technician/team_lead role, but deliberately NOT linked via identity_links.
    const unlinkedTechnician = await makeUser(tenant.id, 'tech-unlinked@herbe-service.test', 'technician')

    const dispatcher = await makeUser(tenant.id, 'dispatcher-unlinked@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcher))

    const { POST } = await import('./route')
    const res = await POST(
      bookingRequest({
        erpCompanyId: company.id,
        customerId: customer.id,
        technicianUserId: unlinkedTechnician.id,
        description: 'should not be bookable',
      }),
    )

    expect(res.status).toBe(400)
    expect(await db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.tenantId, tenant.id))).toHaveLength(0)
  })

  it('rejects a customerId that belongs to a different ERP company within the same tenant with 400', async () => {
    const tenant = await makeTenant('booking-wrong-company-tenant')
    const company = await makeCompany(tenant.id, 'booking-wrong-company-a')
    const otherCompany = await makeCompany(tenant.id, 'booking-wrong-company-b')
    const customerFromOtherCompany = await makeCustomer(tenant.id, otherCompany.id, 'booking-wrong-company-customer')
    const technicianUser = await makeUser(tenant.id, 'tech-wrong-company@herbe-service.test', 'technician')
    await linkTechnician(tenant.id, technicianUser.id, company.id, 'EM-WRONG-COMPANY')

    const dispatcher = await makeUser(tenant.id, 'dispatcher-wrong-company@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcher))

    const { POST } = await import('./route')
    const res = await POST(
      bookingRequest({
        erpCompanyId: company.id,
        customerId: customerFromOtherCompany.id,
        technicianUserId: technicianUser.id,
        description: 'customer belongs to the wrong company',
      }),
    )

    expect(res.status).toBe(400)
    expect(await db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.tenantId, tenant.id))).toHaveLength(0)
  })

  it('rejects a request missing required fields with 400 before writing anything', async () => {
    const tenant = await makeTenant('booking-missing-fields-tenant')
    const dispatcher = await makeUser(tenant.id, 'dispatcher-missing@herbe-service.test', 'dispatcher')
    authMock.mockResolvedValue(sessionFor(dispatcher))

    const { POST } = await import('./route')
    const res = await POST(bookingRequest({ erpCompanyId: 'x' }))

    expect(res.status).toBe(400)
    expect(await db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.tenantId, tenant.id))).toHaveLength(0)
  })
})
