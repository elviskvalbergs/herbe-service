// tests/unit/domain/service-items-store.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), same
// bootstrap as __tests__/db/tenancy.test.ts / lib/sync/ingest/customers.test.ts.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { getChildren, getServiceItemById, insertServiceItem, scanServiceItemsForTenant } from '@/lib/domain/stores/service-items'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let otherTenantId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
  const [other] = await db.insert(schema.tenants).values({ slug: 't2', name: 'T2' }).returning()
  otherTenantId = other.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('service-items store', () => {
  it('inserts a system node and reads it back scoped by tenant', async () => {
    const sys = await insertServiceItem(db, { tenantId, kind: 'system', name: 'Store 14', labelId: 'L-sys-1' })
    const got = await getServiceItemById(db, tenantId, sys.id)
    expect(got?.kind).toBe('system')
    // cross-tenant read returns null
    expect(await getServiceItemById(db, otherTenantId, sys.id)).toBeNull()
  })

  it('nests a unit under a system and lists children', async () => {
    const sys = await insertServiceItem(db, { tenantId, kind: 'system', name: 'Zone 2', labelId: 'L-sys-2' })
    const unit = await insertServiceItem(db, {
      tenantId,
      kind: 'unit',
      name: 'AHU-2',
      serialNr: 'SN9',
      parentId: sys.id,
      labelId: 'L-unit-1',
    })
    const kids = await getChildren(db, tenantId, sys.id)
    expect(kids.map((k) => k.id)).toContain(unit.id)
  })

  it('scans all items for a tenant, excluding other tenants', async () => {
    // Own tenants (not the shared tenantId/otherTenantId) so the count assertion
    // below isn't affected by rows inserted by earlier tests in this file.
    const [scanTenant] = await db.insert(schema.tenants).values({ slug: 'scan-t1', name: 'Scan T1' }).returning()
    const [scanOtherTenant] = await db.insert(schema.tenants).values({ slug: 'scan-t2', name: 'Scan T2' }).returning()

    const sys = await insertServiceItem(db, {
      tenantId: scanTenant.id,
      kind: 'system',
      name: 'Scan System',
      labelId: 'L-scan-sys-1',
    })
    const unit = await insertServiceItem(db, {
      tenantId: scanTenant.id,
      kind: 'unit',
      name: 'Scan Unit',
      serialNr: 'SN-scan-1',
      parentId: sys.id,
      labelId: 'L-scan-unit-1',
    })
    await insertServiceItem(db, {
      tenantId: scanOtherTenant.id,
      kind: 'system',
      name: 'Other Tenant System',
      labelId: 'L-scan-other-1',
    })

    const rows = await scanServiceItemsForTenant(db, scanTenant.id)
    expect(rows.map((r) => r.id).sort()).toEqual([sys.id, unit.id].sort())
    // Note: the store exposes no soft-delete/tombstone function to exercise here
    // (insertServiceItem / getServiceItemById / scanServiceItemsForTenant / getChildren
    // only) — the deletedAt-exclusion half of this test is skipped per the task note.
  })

  it('inserts an item with customerId and reads it back', async () => {
    const [erpCompany] = await db
      .insert(schema.erpCompanies)
      .values({ tenantId, displayName: 'Store Test Co', adapterType: 'standard_books' })
      .returning()
    const [customer] = await db
      .insert(schema.customers)
      .values({ tenantId, erpCompanyId: erpCompany.id, erpRef: 'CUST-1', name: 'Store Test Customer', changeSeq: BigInt(0) })
      .returning()

    const unit = await insertServiceItem(db, {
      tenantId,
      kind: 'unit',
      name: 'Customer-linked Unit',
      labelId: 'L-cust-unit-1',
      customerId: customer.id,
    })

    const got = await getServiceItemById(db, tenantId, unit.id)
    expect(got?.customerId).toBe(customer.id)
  })
})
