// lib/sync/invoice-status.test.ts
//
// DB-backed tests for sweepInvoiceStatus (WS4 outbound slice, Decision 10),
// mirroring the local-Postgres harness idiom used across lib/sync/ingest/*
// and lib/sync/push/*.test.ts. The ERP side is a hand-built stub — this
// module's only ERP call is adapter.getRecordLinks, already covered end to
// end (XML parsing + wire format) by lib/erp/standard-books/excellent-api.test.ts
// and the adapter-delegation tests in adapter.test.ts, so here the stub just
// records which (register, serNr) pairs it was asked about and returns
// canned links per test.
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ErpAdapter } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { insertServiceOrder, setOrderStatus, getServiceOrderById } from '@/lib/domain/stores/service-orders'
import { putErpRef, getErpRefs } from '@/lib/domain/stores/erp-refs'
import type { OrderStatus } from '@/lib/domain/types'
import { sweepInvoiceStatus } from './invoice-status'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'invoice-sweep', name: 'Invoice Sweep' }).returning()
  tenantId = tenant.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function insertCompany(displayName: string): Promise<string> {
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName, adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  return company.id
}

async function insertCustomer(erpCompanyId: string): Promise<string> {
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: `CUST-${randomUUID()}`, name: 'Test Customer', changeSeq: BigInt(0) })
    .returning()
  return customer.id
}

// Seeds a service order with a primary SVOVc erp_ref, at the given status.
async function seedOrder(
  erpCompanyId: string,
  customerId: string,
  svoSerNr: string,
  status: OrderStatus,
): Promise<string> {
  const order = await insertServiceOrder(db, { tenantId, erpCompanyId, customerId })
  await setOrderStatus(db, tenantId, order.id, status)
  await putErpRef(db, {
    tenantId,
    entityType: 'service_order',
    entityId: order.id,
    purpose: 'primary',
    register: 'SVOVc',
    recordRef: svoSerNr,
    erpCompanyId,
  })
  return order.id
}

// Minimal ErpAdapter stub: only getRecordLinks is exercised by
// sweepInvoiceStatus, every other method throws if accidentally called.
// Also records every (register, serNr) it was asked about, so tests can
// assert which orders were (and weren't) checked.
function stubAdapter(linksBySerNr: Map<string, { register: string; id: string }[]>): {
  adapter: ErpAdapter
  calls: Array<{ register: string; serNr: string }>
} {
  const calls: Array<{ register: string; serNr: string }> = []
  const notImplemented = (method: string) => {
    throw new Error(`${method} must not be called by sweepInvoiceStatus`)
  }
  const adapter: ErpAdapter = {
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: true,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => notImplemented('pullChanges'),
    pushCreate: async () => notImplemented('pushCreate'),
    pushUpdate: async () => notImplemented('pushUpdate'),
    fetchRecords: async () => notImplemented('fetchRecords'),
    probeIncrementalSupport: async () => notImplemented('probeIncrementalSupport'),
    pullFullList: async () => notImplemented('pullFullList'),
    listLiveRefs: async () => notImplemented('listLiveRefs'),
    async getRecordLinks(register: string, serNr: string) {
      calls.push({ register, serNr })
      return linksBySerNr.get(serNr) ?? []
    },
  }
  return { adapter, calls }
}

describe('sweepInvoiceStatus', () => {
  it('flips exactly the orders whose SVOVc has an IVVc link, and writes the invoice erp_ref', async () => {
    const erpCompanyId = await insertCompany('Sweep Co A')
    const customerId = await insertCustomer(erpCompanyId)

    const orderNoInvoice = await seedOrder(erpCompanyId, customerId, '1001', 'New')
    const orderWithInvoice = await seedOrder(erpCompanyId, customerId, '1002', 'New')
    const anotherNoInvoice = await seedOrder(erpCompanyId, customerId, '1003', 'Confirmed')

    const { adapter, calls } = stubAdapter(
      new Map([['1002', [{ register: 'IVVc', id: '500123' }]]]),
    )

    const result = await sweepInvoiceStatus(db, adapter, erpCompanyId)

    expect(result).toEqual({ checked: 3, invoiced: 1 })
    expect(calls.sort((a, b) => a.serNr.localeCompare(b.serNr))).toEqual([
      { register: 'SVOVc', serNr: '1001' },
      { register: 'SVOVc', serNr: '1002' },
      { register: 'SVOVc', serNr: '1003' },
    ])

    const flipped = await getServiceOrderById(db, tenantId, orderWithInvoice)
    expect(flipped?.status).toBe('Invoiced')
    const flippedRefs = await getErpRefs(db, tenantId, 'service_order', orderWithInvoice)
    expect(flippedRefs).toContainEqual(
      expect.objectContaining({ purpose: 'invoice', register: 'IVVc', recordRef: '500123' }),
    )

    const untouched1 = await getServiceOrderById(db, tenantId, orderNoInvoice)
    expect(untouched1?.status).toBe('New')
    const untouched2 = await getServiceOrderById(db, tenantId, anotherNoInvoice)
    expect(untouched2?.status).toBe('Confirmed')
  })

  it('ignores links to registers other than IVVc', async () => {
    const erpCompanyId = await insertCompany('Sweep Co B')
    const customerId = await insertCustomer(erpCompanyId)
    const orderId = await seedOrder(erpCompanyId, customerId, '2001', 'New')

    const { adapter } = stubAdapter(
      new Map([['2001', [{ register: 'WSVc', id: '999' }, { register: 'ActVc', id: '111' }]]]),
    )

    const result = await sweepInvoiceStatus(db, adapter, erpCompanyId)

    expect(result).toEqual({ checked: 1, invoiced: 0 })
    const order = await getServiceOrderById(db, tenantId, orderId)
    expect(order?.status).toBe('New')
    const refs = await getErpRefs(db, tenantId, 'service_order', orderId)
    expect(refs.find((r) => r.purpose === 'invoice')).toBeUndefined()
  })

  it('never checks orders already Invoiced, Closed, or Cancelled', async () => {
    const erpCompanyId = await insertCompany('Sweep Co C')
    const customerId = await insertCustomer(erpCompanyId)

    await seedOrder(erpCompanyId, customerId, '3001', 'Invoiced')
    await seedOrder(erpCompanyId, customerId, '3002', 'Closed')
    await seedOrder(erpCompanyId, customerId, '3003', 'Cancelled')
    await seedOrder(erpCompanyId, customerId, '3004', 'New')

    const { adapter, calls } = stubAdapter(new Map())

    const result = await sweepInvoiceStatus(db, adapter, erpCompanyId)

    expect(result).toEqual({ checked: 1, invoiced: 0 })
    expect(calls).toEqual([{ register: 'SVOVc', serNr: '3004' }])
  })

  it('scopes candidates to the given erpCompanyId — a different company\'s orders are never touched', async () => {
    const companyA = await insertCompany('Sweep Co D1')
    const companyB = await insertCompany('Sweep Co D2')
    const customerA = await insertCustomer(companyA)
    const customerB = await insertCustomer(companyB)

    await seedOrder(companyA, customerA, '4001', 'New')
    await seedOrder(companyB, customerB, '4001', 'New') // same SerNr, different company — must not collide

    const { adapter, calls } = stubAdapter(new Map([['4001', [{ register: 'IVVc', id: '1' }]]]))

    const result = await sweepInvoiceStatus(db, adapter, companyA)

    expect(result).toEqual({ checked: 1, invoiced: 1 })
    expect(calls).toHaveLength(1)
  })

  it('returns {checked: 0, invoiced: 0} when there are no candidate orders', async () => {
    const erpCompanyId = await insertCompany('Sweep Co E')
    const { adapter } = stubAdapter(new Map())

    const result = await sweepInvoiceStatus(db, adapter, erpCompanyId)

    expect(result).toEqual({ checked: 0, invoiced: 0 })
  })
})
