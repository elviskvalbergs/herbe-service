// tests/unit/domain/history-store.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), same
// bootstrap as tests/unit/domain/service-items-store.test.ts /
// tests/unit/domain/orders-worksheets-store.test.ts. DB-backed — CI-only,
// skipped locally (no local Postgres; see docs/testing/README.md).
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { insertServiceItem } from '@/lib/domain/stores/service-items'
import { insertServiceOrder } from '@/lib/domain/stores/service-orders'
import { insertWorksheet } from '@/lib/domain/stores/worksheets'
import { getHistoryForItem, upsertHistoryEvents } from '@/lib/domain/stores/history'
import { projectWorksheetApproved } from '@/lib/domain/history-projector'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let otherTenantId: string
let customerId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
  const [other] = await db.insert(schema.tenants).values({ slug: 't2', name: 'T2' }).returning()
  otherTenantId = other.id

  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId: company.id, erpRef: 'CUST001', name: 'Test Client OÜ', changeSeq: BigInt(0) })
    .returning()
  customerId = customer.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('history store', () => {
  it('upsertHistoryEvents twice for the same worksheet revision writes one row (idempotent)', async () => {
    const item = await insertServiceItem(db, { tenantId, kind: 'unit', name: 'AHU-1', labelId: 'L-hist-1' })
    const order = await insertServiceOrder(db, { tenantId, customerId })
    const worksheet = await insertWorksheet(db, { tenantId, orderId: order.id })

    const events = projectWorksheetApproved({
      worksheetId: worksheet.id,
      orderId: order.id,
      revision: 0,
      at: '2026-07-01T00:00:00Z',
      primaryItemId: item.id,
      summary: 'Serviced',
    })

    await upsertHistoryEvents(db, tenantId, events)
    await upsertHistoryEvents(db, tenantId, events) // re-run: same deterministic keys

    const rows = await getHistoryForItem(db, tenantId, item.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('work_done')

    // cross-tenant read returns nothing
    expect(await getHistoryForItem(db, otherTenantId, item.id)).toHaveLength(0)
  })

  it('getHistoryForItem returns events ordered chronologically by at, not insertion order', async () => {
    const item = await insertServiceItem(db, { tenantId, kind: 'unit', name: 'AHU-2', labelId: 'L-hist-2' })

    // Inserted latest-first so a WHERE-only (no ORDER BY) query would return
    // them out of chronological order.
    await upsertHistoryEvents(db, tenantId, [
      {
        serviceItemId: item.id,
        key: 'test:order:latest',
        at: '2026-07-03T00:00:00Z',
        kind: 'work_done',
        summary: 'Latest',
      },
      {
        serviceItemId: item.id,
        key: 'test:order:earliest',
        at: '2026-07-01T00:00:00Z',
        kind: 'work_done',
        summary: 'Earliest',
      },
      {
        serviceItemId: item.id,
        key: 'test:order:middle',
        at: '2026-07-02T00:00:00Z',
        kind: 'work_done',
        summary: 'Middle',
      },
    ])

    const rows = await getHistoryForItem(db, tenantId, item.id)
    expect(rows.map((r) => r.summary)).toEqual(['Earliest', 'Middle', 'Latest'])
  })
})
