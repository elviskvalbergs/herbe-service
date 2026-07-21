// tests/unit/domain/worksheet-transitions.test.ts
//
// Task 3 (docs/superpowers/sdd/task-3-brief.md): DB-backed tests for
// transitionWorksheet — the non-approval status-change helper the
// booking/execution routes (Tasks 4-6) will call. Uses the local-Postgres
// test harness (lib/test-support/db.ts), same bootstrap as
// tests/unit/domain/orders-worksheets-store.test.ts.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { getWorksheetById, insertWorksheet, setWorksheetStatus } from '@/lib/domain/stores/worksheets'
import { transitionWorksheet } from '@/lib/domain/worksheet-transitions'
import { DomainTransitionError } from '@/lib/domain/worksheet-status'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let customerId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'wst-t1', name: 'WST T1' }).returning()
  tenantId = tenant.id

  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'WST Co', adapterType: 'standard_books' })
    .returning()
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId: company.id, erpRef: 'WST-CUST-1', name: 'WST Customer', changeSeq: BigInt(0) })
    .returning()
  customerId = customer.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('transitionWorksheet', () => {
  it('applies a legal transition and persists the new status', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    const worksheet = await insertWorksheet(db, { tenantId, orderId: order.id })
    expect(worksheet.status).toBe('Draft')

    await transitionWorksheet(db, tenantId, worksheet.id, 'Assigned')

    const got = await getWorksheetById(db, tenantId, worksheet.id)
    expect(got?.status).toBe('Assigned')
  })

  it('throws DomainTransitionError on an illegal transition and leaves status unchanged', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    const worksheet = await insertWorksheet(db, { tenantId, orderId: order.id })

    await expect(transitionWorksheet(db, tenantId, worksheet.id, 'Synced')).rejects.toThrow(DomainTransitionError)

    const got = await getWorksheetById(db, tenantId, worksheet.id)
    expect(got?.status).toBe('Draft')
  })

  it('refuses to transition to Approved — that path belongs to approveWorksheet only', async () => {
    const order = await insertServiceOrder(db, { tenantId, customerId })
    const worksheet = await insertWorksheet(db, { tenantId, orderId: order.id })
    await setWorksheetStatus(db, tenantId, worksheet.id, 'Done')

    await expect(transitionWorksheet(db, tenantId, worksheet.id, 'Approved')).rejects.toThrow(
      DomainTransitionError,
    )

    const got = await getWorksheetById(db, tenantId, worksheet.id)
    expect(got?.status).toBe('Done')
  })
})
