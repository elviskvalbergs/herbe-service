// lib/sync/push/gather.test.ts
//
// DB + fake-ERP tests for the gather layer's own edge cases (WS4 outbound
// slice, docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
// decisions 5/7) that the saga-level happy paths in engine.test.ts don't
// reach on their own: not-found guards, the missing-order-ref and
// not-yet-visible-in-ERP errors, the MainStockBlock location fallback, and
// mapping actual worksheet rows/time/distance entries into the builder
// input shape.
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeErpServer } from '@herbe/fake-erp'
import { ErpPermanentError, ErpTransientError } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { createStandardBooksAdapter } from '@/lib/erp/standard-books/adapter'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { insertServiceItem } from '@/lib/domain/stores/service-items'
import { insertWorksheet } from '@/lib/domain/stores/worksheets'
import { putErpRef } from '@/lib/domain/stores/erp-refs'
import { gatherSvoCreateInput, gatherWsCreateInput } from './gather'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string
let customerId: string

function adapterFor(url: string) {
  return createStandardBooksAdapter({
    baseUrl: url,
    companyNumber: '1',
    auth: { kind: 'basic', username: 'test', password: 'test' },
  })
}

async function seedOrderWithErpRef(companyId: string, custId: string, orderErpRef: string) {
  const order = await insertServiceOrder(db, { tenantId, erpCompanyId: companyId, customerId: custId })
  await putErpRef(db, {
    tenantId,
    entityType: 'service_order',
    entityId: order.id,
    purpose: 'primary',
    register: 'SVOVc',
    recordRef: orderErpRef,
    erpCompanyId: companyId,
  })
  return order.id
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  erpCompanyId = company.id
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: 'CUST001', name: 'Test Client', changeSeq: BigInt(0) })
    .returning()
  customerId = customer.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('gatherSvoCreateInput', () => {
  it('throws ErpPermanentError for an unknown orderId', async () => {
    await expect(
      gatherSvoCreateInput(db, tenantId, erpCompanyId, randomUUID(), new Date()),
    ).rejects.toMatchObject({ name: 'ErpPermanentError' })
  })

  it('resolves customerErpRef to null when the order customer is soft-deleted (not found)', async () => {
    const [deadCustomer] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId, erpRef: 'CUST-GONE', name: 'Gone', changeSeq: BigInt(0) })
      .returning()
    const order = await insertServiceOrder(db, { tenantId, erpCompanyId, customerId: deadCustomer.id })
    await db.update(schema.customers).set({ deletedAt: new Date() }).where(eq(schema.customers.id, deadCustomer.id))

    const input = await gatherSvoCreateInput(db, tenantId, erpCompanyId, order.id, new Date())
    expect(input.customerErpRef).toBeNull()
  })
})

describe('gatherWsCreateInput', () => {
  let server: Awaited<ReturnType<typeof startFakeErpServer>> | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('throws ErpPermanentError for an unknown worksheetId', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    await expect(
      gatherWsCreateInput(db, adapter, tenantId, erpCompanyId, randomUUID()),
    ).rejects.toMatchObject({ name: 'ErpPermanentError' })
  })

  it('throws ErpPermanentError when the order has no primary SVOVc erp_ref yet', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const order = await insertServiceOrder(db, { tenantId, erpCompanyId, customerId })
    const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId, orderId: order.id })

    await expect(
      gatherWsCreateInput(db, adapter, tenantId, erpCompanyId, worksheet.id),
    ).rejects.toMatchObject({ name: 'ErpPermanentError', message: expect.stringMatching(/order-create step must run/i) })
  })

  it('throws ErpTransientError when the order erp_ref points to a SerNr not yet visible in the ERP', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await seedOrderWithErpRef(erpCompanyId, customerId, '999999')
    const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId, orderId })

    await expect(
      gatherWsCreateInput(db, adapter, tenantId, erpCompanyId, worksheet.id),
    ).rejects.toMatchObject({ name: 'ErpTransientError', message: expect.stringMatching(/not yet visible/i) })
  })

  it('falls back to MainStockBlock when push.mainServiceLocation is not configured, and defaults to empty when that is also absent', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await seedOrderWithErpRef(erpCompanyId, customerId, '5001') // 5001 is a live SVOVc fixture row
    const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId, orderId })

    // No push config at all yet — MainStockBlock has no rows either.
    const noLocation = await gatherWsCreateInput(db, adapter, tenantId, erpCompanyId, worksheet.id)
    expect(noLocation.location).toBe('')

    // Seed a MainStockBlock record directly against the fake ERP (its POST
    // handler is register-agnostic — only the standard-books adapter
    // restricts pushCreate to SVOVc/WSVc, so this goes over plain fetch).
    // Form-urlencoded set_field.<Field>=<value> is the real wire format
    // (docs/09-REST-API-REFERENCE.md, confirmed live in Task 7) — the fake
    // ERP's POST handler now expects this, not a JSON body.
    await fetch(`${server.url}/api/1/MainStockBlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'set_field.MainStock=VAN-MAIN',
    })

    const withFallback = await gatherWsCreateInput(db, adapter, tenantId, erpCompanyId, worksheet.id)
    expect(withFallback.location).toBe('VAN-MAIN')
  })

  it('maps worksheet rows (linked and unlinked to a service item), time entries, and distance entries', async () => {
    server = await startFakeErpServer({ port: 0 })
    const adapter = adapterFor(server.url)

    const orderId = await seedOrderWithErpRef(erpCompanyId, customerId, '5001')
    const technicianUserId = (
      await db.insert(schema.users).values({ tenantId, email: `tech-${randomUUID()}@example.com` }).returning()
    )[0].id
    await putErpRef(db, {
      tenantId,
      entityType: 'user',
      entityId: technicianUserId,
      purpose: 'primary',
      register: 'UserVc',
      recordRef: 'TECH1',
      erpCompanyId,
    })
    const worksheet = await insertWorksheet(db, { tenantId, erpCompanyId, orderId, technicianUserId })

    const item = await insertServiceItem(db, {
      tenantId,
      erpCompanyId,
      kind: 'unit',
      name: 'Linked Unit',
      labelId: `lbl-${randomUUID()}`,
      attributes: { itemCode: 'PART1' }, // lowercase — matches ingestServiceItems' actual attribute key
    })

    await db.insert(schema.worksheetRows).values([
      {
        worksheetId: worksheet.id,
        serviceItemId: item.id,
        description: 'Linked row',
        quantity: '2',
        serial: 'SN-1',
        chargeType: 'invoiceable',
        price: '10.5',
        sum: '21',
      },
      {
        worksheetId: worksheet.id,
        serviceItemId: null,
        description: 'Unlinked row',
        chargeType: 'warranty',
      },
    ])
    await db.insert(schema.timeEntries).values([
      { worksheetId: worksheet.id, kind: 'work', minutes: 45 },
      { worksheetId: worksheet.id, kind: 'work', minutes: null },
    ])
    await db.insert(schema.distanceEntries).values([
      { worksheetId: worksheet.id, km: '12.5', billable: true },
      { worksheetId: worksheet.id, km: null, billable: false },
    ])

    const input = await gatherWsCreateInput(db, adapter, tenantId, erpCompanyId, worksheet.id)

    expect(input.emCode).toBe('TECH1')
    expect(input.rows).toHaveLength(2)
    expect(input.rows).toContainEqual({
      itemCode: 'PART1',
      description: 'Linked row',
      quantity: 2,
      price: 10.5,
      sum: 21,
      serial: 'SN-1',
      chargeType: 'invoiceable',
    })
    expect(input.rows).toContainEqual({
      itemCode: null,
      description: 'Unlinked row',
      quantity: null,
      price: null,
      sum: null,
      serial: null,
      chargeType: 'warranty',
    })

    expect(input.timeEntries).toEqual(expect.arrayContaining([{ minutes: 45 }, { minutes: null }]))
    expect(input.distanceEntries).toEqual(
      expect.arrayContaining([
        { km: 12.5, billable: true },
        { km: null, billable: false },
      ]),
    )
  })
})
